import express from "express";
import { chromium } from "playwright";
import pLimit from "p-limit";
import pdf from "pdf-parse";
import { EmbedQuery, EmbedChunk, CreateChunks, SendWebhook } from "./utils.js";
import { URL } from "url";

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────
const CFG = {
    SCRAPE_TIMEOUT: 20_000,
    MAX_RETRIES: 3,
    RETRY_BASE_MS: 400,
    MAX_CONTEXT_LEN: 15_000,
    SIMILARITY_THRESHOLD: 0.35,
    DEDUP_THRESHOLD: 0.92,
    PAGE_DEDUP_THRESHOLD: 0.88,
    LINK_SCORE_THRESHOLD: 0.30,
    CACHE_TTL: 300_000,
    CACHE_MAX: 200,
    BROWSER_POOL_SIZE: parseInt(process.env.BROWSER_POOL) || 4,
    GLOBAL_CONCURRENCY: parseInt(process.env.SCRAPE_CONCURRENCY) || 7,
    DOM_CONCURRENCY: 4,
    EMBED_BATCH_SIZE: 24,

    // Nested crawl — hard cap at 2, configurable down
    CRAWL_DEPTH: Math.min(parseInt(process.env.CRAWL_DEPTH) || 1, 2),
    LINKS_PER_PAGE: parseInt(process.env.LINKS_PER_PAGE) || 5,

    // Image limits — per-request quota to cap compute cost
    IMAGES_PER_PAGE: 2,   // max analyzed per page (not just fetched)
    MAX_IMAGES_PER_REQ: parseInt(process.env.MAX_IMAGES) || 6,  // hard ceiling across entire crawl

    VISION_ENDPOINT: process.env.VISION_ENDPOINT || "https://i-feel-eureka-vision.hf.space/v1/chat/completions",
    HF_TOKEN: process.env.HF_TOKEN || "",
};

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────
const cosine = (a, b) => {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
    const d = Math.sqrt(na) * Math.sqrt(nb);
    return d === 0 ? 0 : dot / d;
};

const PRIVATE_IP_RE = [
    /^localhost$/i, /^127\./, /^0\.0\.0\.0$/, /^::1$/,
    /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
    /^169\.254\./, /^fc00:/i, /^fe80:/i,
];

function isSafeUrl(raw) {
    try {
        const u = new URL(raw);
        if (!["http:", "https:"].includes(u.protocol)) return false;
        const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
        return !PRIVATE_IP_RE.some(r => r.test(h));
    } catch { return false; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function retry(fn, attempts = CFG.MAX_RETRIES, baseMs = CFG.RETRY_BASE_MS) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (err) {
            if (i === attempts - 1) throw err;
            console.warn(`Retry ${i + 1}/${attempts - 1}: ${err.message}`);
            await sleep(baseMs * 2 ** i);
        }
    }
}

const isDocUrl = url => /\.(pdf|docx?|xlsx?|pptx?|csv|txt)(\?.*)?$/i.test(url);
const isImageUrl = url => /\.(jpe?g|png|webp|bmp|tiff?)(\?.*)?$/i.test(url);
const isJunkImg = url => /icon|logo|avatar|badge|pixel|track|spinner|button|arrow|close|menu|emoji/i.test(url);

// ─────────────────────────────────────────────────────────────────
// Vision — server-side, Buffer-based
// imageQuota = { used: number, max: number } — per-request, passed by ref
// ─────────────────────────────────────────────────────────────────
const VISION_PROMPT =
    "Extract ALL key facts from this image. Include numbers, names, technical details, tables, charts, and every important data point. Respond in JSON format.";

async function analyzeImageFromUrl(imageUrl, imageQuota) {
    if (imageQuota.used >= imageQuota.max) return null; // quota exhausted for this request
    try {
        const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(10_000) });
        if (!imgRes.ok) return null;

        const buffer = await imgRes.arrayBuffer();
        const base64 = Buffer.from(buffer).toString("base64");
        const rawType = imgRes.headers.get("content-type") || "";
        const mime = rawType.startsWith("image/") ? rawType.split(";")[0] : "image/jpeg";

        imageQuota.used++; // increment before the call so concurrent requests don't over-shoot

        const res = await fetch(CFG.VISION_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${CFG.HF_TOKEN}` },
            body: JSON.stringify({
                model: "minicpm-v2.6",
                messages: [{
                    role: "user",
                    content: [
                        { type: "text", text: VISION_PROMPT },
                        { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
                    ],
                }],
                max_tokens: 512, temperature: 0.2, stream: false,
            }),
            signal: AbortSignal.timeout(30_000),
        });

        if (!res.ok) { console.warn(`Vision API ${res.status} for ${imageUrl}`); imageQuota.used--; return null; }
        const data = await res.json();
        return data?.choices?.[0]?.message?.content || null;
    } catch (err) {
        console.error(`Image analysis failed [${imageUrl}]: ${err.message}`);
        imageQuota.used--;
        return null;
    }
}

// Returns { analysis: string, count: number } — caller uses count for webhook message
async function analyzePageImages(imageSrcs, pageBaseUrl, imageQuota) {
    if (!imageSrcs.length || imageQuota.used >= imageQuota.max) return { analysis: "", count: 0 };

    const resolved = imageSrcs
        .map(src => { try { return new URL(src, pageBaseUrl).href; } catch { return null; } })
        .filter(u => u && isSafeUrl(u) && !isJunkImg(u) && isImageUrl(u))
        .slice(0, CFG.IMAGES_PER_PAGE); // per-page cap

    if (!resolved.length) return { analysis: "", count: 0 };

    const limiter = pLimit(2);
    const analyses = await Promise.all(resolved.map(u => limiter(() => analyzeImageFromUrl(u, imageQuota))));
    const valid = analyses.filter(Boolean);
    if (!valid.length) return { analysis: "", count: 0 };

    return {
        analysis: "\n\n[IMAGE ANALYSIS]\n" + valid.map((r, i) => `[Image ${i + 1}]: ${r}`).join("\n---\n"),
        count: valid.length,
    };
}

// ─────────────────────────────────────────────────────────────────
// Document parser
// ─────────────────────────────────────────────────────────────────
async function parseDocumentFromUrl(docUrl) {
    try {
        const res = await fetch(docUrl, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) return null;
        const ext = new URL(docUrl).pathname.split(".").pop().toLowerCase();
        if (ext === "pdf") {
            const buffer = Buffer.from(await res.arrayBuffer());
            const parsed = await pdf(buffer);
            const text = parsed.text?.replace(/\n{3,}/g, "\n\n").trim();
            return text?.length > 100 ? text : null;
        }
        if (["csv", "txt", "md"].includes(ext)) {
            const text = await res.text();
            return text.length > 100 ? text.replace(/\n{3,}/g, "\n\n").trim() : null;
        }
        return null;
    } catch (err) {
        console.error(`Document parse failed [${docUrl}]: ${err.message}`);
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────
// Browser pool
// ─────────────────────────────────────────────────────────────────
const LAUNCH_ARGS = [
    "--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu",
    "--disable-software-rasterizer", "--disable-dev-shm-usage",
    "--disable-font-subpixel-positioning", "--disable-logging",
    "--disable-breakpad", "--disable-crash-reporter",
];
const LAUNCH_ENV = { ...process.env, FONTCONFIG_PATH: "/dev/null", FONTCONFIG_FILE: "/dev/null" };
const pool = [];

async function launchBrowser() {
    const b = await chromium.launch({ headless: true, args: LAUNCH_ARGS, env: LAUNCH_ENV });
    b.on("disconnected", () => {
        const i = pool.indexOf(b);
        if (i !== -1) pool.splice(i, 1);
        console.warn("Browser died — relaunching");
        launchBrowser().then(nb => pool.push(nb)).catch(console.error);
    });
    return b;
}

async function initPool() {
    const browsers = await Promise.all(Array.from({ length: CFG.BROWSER_POOL_SIZE }, launchBrowser));
    pool.push(...browsers);
    console.log(`Browser pool ready (${pool.length} instances)`);
}

function pickBrowser() {
    const live = pool.filter(b => b.isConnected());
    if (!live.length) throw new Error("All browsers disconnected");
    return live[Math.floor(Math.random() * live.length)];
}

// ─────────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────────
const mdCache = new Map();
function cacheGet(url) {
    const e = mdCache.get(url);
    if (!e) return null;
    if (Date.now() - e.ts > CFG.CACHE_TTL) { mdCache.delete(url); return null; }
    return e.data;
}
function cacheSet(url, data) {
    if (mdCache.size >= CFG.CACHE_MAX) mdCache.delete(mdCache.keys().next().value);
    mdCache.set(url, { data, ts: Date.now() });
}

// ─────────────────────────────────────────────────────────────────
// Scraper
// ─────────────────────────────────────────────────────────────────
const BLOCKED_RESOURCES = new Set(["stylesheet", "font", "media", "websocket"]);

async function scrapeWithPlaywright(url) {
    return retry(async () => {
        const ctx = await pickBrowser().newContext({
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
            viewport: { width: 1280, height: 800 },
            ignoreHTTPSErrors: true,
        });
        const page = await ctx.newPage();
        await page.route("**/*", route =>
            BLOCKED_RESOURCES.has(route.request().resourceType()) ? route.abort() : route.continue()
        );
        try {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: CFG.SCRAPE_TIMEOUT });
            const { text, links, images } = await page.evaluate(() => {
                document.querySelectorAll(
                    "script,style,nav,footer,header,aside,noscript,[aria-hidden='true'],.ad,.ads,.advertisement,.cookie-banner,.popup,.modal,.sidebar"
                ).forEach(el => el.remove());
                const SELECTORS = ["main", "[role='main']", "article", ".article", ".post-content", ".entry-content", ".content", "#content", "#main"];
                let text = "";
                for (const sel of SELECTORS) {
                    const el = document.querySelector(sel);
                    if (el?.innerText?.length > 200) { text = el.innerText.trim(); break; }
                }
                if (!text) text = document.body?.innerText?.trim() ?? "";
                const links = Array.from(document.querySelectorAll("a[href]"))
                    .map(a => ({ href: a.href, text: (a.innerText || a.title || a.getAttribute("aria-label") || "").trim().slice(0, 200) }))
                    .filter(l => l.href.startsWith("http") && l.text.length > 2);
                const images = Array.from(document.querySelectorAll("img[src]"))
                    .filter(img => {
                        const w = img.naturalWidth || img.width || parseInt(img.getAttribute("width") || "0");
                        const h = img.naturalHeight || img.height || parseInt(img.getAttribute("height") || "0");
                        return (w === 0 || w >= 100) && (h === 0 || h >= 100);
                    })
                    .map(img => img.src)
                    .filter(src => src?.startsWith("http"));
                return { text, links, images };
            });
            if (!text || text.length < 100) return null;
            return { text: text.replace(/\n{3,}/g, "\n\n").trim(), links, images };
        } finally {
            await page.close().catch(() => { });
            await ctx.close().catch(() => { });
        }
    }, 2);
}

async function fetchPageData(url) {
    const cached = cacheGet(url);
    if (cached) return cached;
    const data = await scrapeWithPlaywright(url).catch(err => {
        console.error(`Scrape failed [${url}]: ${err.message}`);
        return null;
    });
    if (data) cacheSet(url, data);
    return data;
}

// ─────────────────────────────────────────────────────────────────
// Embedding
// ─────────────────────────────────────────────────────────────────
async function embedBatch(chunks) {
    return retry(async () => {
        const emb = await EmbedChunk(chunks);
        if (!emb || emb.length !== chunks.length)
            throw new Error(`Expected ${chunks.length} embeddings, got ${emb?.length ?? 0}`);
        return emb;
    });
}

// ─────────────────────────────────────────────────────────────────
// Content processor
// ─────────────────────────────────────────────────────────────────
async function processContent({ text, url, queryEmbedding, imageAnalysis = "" }) {
    const combined = imageAnalysis ? `${text}\n\n${imageAnalysis}` : text;
    const clean = combined.replace(/\n{3,}/g, "\n\n").trim();
    if (clean.length < 200) return null;

    const chunks = await CreateChunks(clean);
    if (!chunks?.length) return null;

    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    let title = url;
    if (lines[0]?.startsWith("# ")) title = lines[0].slice(2).trim();
    else if (lines[0]?.length > 5 && lines[0].length < 180) title = lines[0];

    const prefixed = chunks.map(c => `title: ${title} | text: ${c}`);
    const allEmb = [];
    for (let i = 0; i < prefixed.length; i += CFG.EMBED_BATCH_SIZE) {
        const batch = prefixed.slice(i, i + CFG.EMBED_BATCH_SIZE);
        const embs = await embedBatch(batch).catch(err => {
            console.error(`Embed failed at ${url} offset ${i}: ${err.message}`);
            return null;
        });
        if (!embs) return null;
        allEmb.push(...embs);
    }

    const scored = chunks
        .map((chunk, idx) => ({ idx, chunk, score: cosine(queryEmbedding, allEmb[idx]) }))
        .filter(c => c.score >= CFG.SIMILARITY_THRESHOLD)
        .sort((a, b) => b.score - a.score);
    if (!scored.length) return null;

    const deduped = [];
    for (const item of scored) {
        const isDup = deduped.some(d => cosine(allEmb[item.idx], allEmb[d.idx]) > CFG.DEDUP_THRESHOLD);
        if (!isDup) deduped.push(item);
    }

    const selected = new Set();
    let ctxLen = 0;
    for (const item of deduped) {
        if (ctxLen >= CFG.MAX_CONTEXT_LEN) break;
        const neighbours = [-1, 0, 1].map(d => item.idx + d).filter(i => i >= 0 && i < chunks.length && !selected.has(i));
        const addLen = neighbours.reduce((s, i) => s + chunks[i].length, 0);
        if (ctxLen + addLen > CFG.MAX_CONTEXT_LEN) break;
        neighbours.forEach(i => { selected.add(i); ctxLen += chunks[i].length; });
    }

    const sortedIdx = [...selected].sort((a, b) => a - b);
    let context = "", prev = -2;
    for (const idx of sortedIdx) {
        if (prev !== -2 && idx - prev > 1) context += "\n\n[...]\n\n";
        context += chunks[idx] + "\n";
        prev = idx;
    }
    if (!context) return null;

    return {
        title,
        favicon: `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}`,
        url,
        markdown: context,
        score: scored[0].score,
        fingerprint: allEmb[0],
        stats: {
            chunksSelected: selected.size,
            chunksTotal: chunks.length,
            dupsRemoved: scored.length - deduped.length,
            hasImages: imageAnalysis.length > 0,
        },
    };
}

// ─────────────────────────────────────────────────────────────────
// Link scorer
// ─────────────────────────────────────────────────────────────────
async function scoreAndFilterLinks(links, queryEmbedding, visited) {
    if (!links.length) return { pageLinks: [], docLinks: [] };
    const unique = links.reduce((acc, l) => { if (!acc.find(x => x.href === l.href)) acc.push(l); return acc; }, []);
    const candidates = unique.filter(l => isSafeUrl(l.href) && !visited.has(l.href) && l.text?.length > 2);
    if (!candidates.length) return { pageLinks: [], docLinks: [] };

    const docCandidates = candidates.filter(l => isDocUrl(l.href));
    const pageCandidates = candidates.filter(l => !isDocUrl(l.href));

    let pageLinks = [];
    if (pageCandidates.length) {
        const texts = pageCandidates.map(l => l.text.slice(0, 200));
        const embs = await embedBatch(texts).catch(() => null);
        if (embs) {
            pageLinks = pageCandidates
                .map((l, i) => ({ href: l.href, score: cosine(queryEmbedding, embs[i]) }))
                .filter(l => l.score >= CFG.LINK_SCORE_THRESHOLD)
                .sort((a, b) => b.score - a.score)
                .slice(0, CFG.LINKS_PER_PAGE)
                .map(l => l.href);
        }
    }
    const docLinks = docCandidates.slice(0, 3).map(l => l.href);
    return { pageLinks, docLinks };
}

// ─────────────────────────────────────────────────────────────────
// Core crawl unit
// imageQuota shared by ref across all recursive calls in a request
// ─────────────────────────────────────────────────────────────────
async function crawlUrl({ url, queryEmbedding, depth, visited, seenFingerprints, results, imageQuota, globalLimiter, userId, messageId, webhookUrl }) {
    if (visited.has(url)) return;
    visited.add(url);
    if (!isSafeUrl(url)) return;

    let text, links = [], imageAnalysis = "";

    if (isDocUrl(url)) {
        if (userId) await SendWebhook(url, "PARSING_DOCUMENT", userId, messageId, webhookUrl);
        const docText = await parseDocumentFromUrl(url);
        if (!docText) return;
        text = docText;

    } else {
        if (userId) await SendWebhook(url, "LINK_READ", userId, messageId, webhookUrl);
        const pageData = await fetchPageData(url);
        if (!pageData) return;
        ({ text, links } = pageData);
        const images = pageData.images || [];

        // Only fire webhook + run analysis if images exist AND quota remains
        if (images.length > 0 && imageQuota.used < imageQuota.max) {
            if (userId) await SendWebhook(url, "ANALYZING_IMAGES", userId, messageId, webhookUrl);
            const { analysis } = await analyzePageImages(images, url, imageQuota);
            imageAnalysis = analysis;
        }
    }

    const result = await processContent({ text, url, queryEmbedding, imageAnalysis });
    if (result) {
        const isDupPage = seenFingerprints.some(fp => cosine(fp, result.fingerprint) > CFG.PAGE_DEDUP_THRESHOLD);
        if (!isDupPage) {
            seenFingerprints.push(result.fingerprint);
            const { fingerprint, ...clientResult } = result;
            results.push(clientResult);
            if (userId) await SendWebhook(url, "PAGE_READ", userId, messageId, webhookUrl);
        } else {
            console.log(`[dedup] Skipped: ${url}`);
        }
    }

    // Hard depth ceiling enforced here
    if (depth >= CFG.CRAWL_DEPTH) return;

    const { pageLinks, docLinks } = await scoreAndFilterLinks(links, queryEmbedding, visited);
    const nextUrls = [...new Set([...pageLinks, ...docLinks])];

    // Only fire LINKS_DISCOVERED if there are actually links to follow
    if (nextUrls.length > 0) {
        if (userId) await SendWebhook(
            `${nextUrls.length}::${nextUrls.slice(0, 3).join(",")}`, // first 3 URLs as preview
            "LINKS_DISCOVERED",
            userId, messageId, webhookUrl
        );

        await Promise.all(nextUrls.map(nextUrl =>
            globalLimiter(async () => {
                const domLimiter = getDomainLimiter(new URL(nextUrl).hostname);
                return domLimiter(() =>
                    crawlUrl({ url: nextUrl, queryEmbedding, depth: depth + 1, visited, seenFingerprints, results, imageQuota, globalLimiter, userId, messageId, webhookUrl })
                );
            })
        ));
    }
}

// ─────────────────────────────────────────────────────────────────
// Domain limiters
// ─────────────────────────────────────────────────────────────────
const domainLimiters = new Map();
function getDomainLimiter(domain) {
    if (!domainLimiters.has(domain)) domainLimiters.set(domain, pLimit(CFG.DOM_CONCURRENCY));
    return domainLimiters.get(domain);
}

// ─────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({
    status: "ok",
    browserPool: pool.filter(b => b.isConnected()).length,
    cacheSize: mdCache.size,
    config: { crawlDepth: CFG.CRAWL_DEPTH, linksPerPage: CFG.LINKS_PER_PAGE, imagesPerPage: CFG.IMAGES_PER_PAGE, maxImagesPerReq: CFG.MAX_IMAGES_PER_REQ, globalConcurrency: CFG.GLOBAL_CONCURRENCY },
}));

app.post("/api/search", async (req, res) => {
    const { source, prompt, user_id, message_id, webhook_url } = req.body;
    if (!source || !prompt) return res.status(400).json({ error: "Missing source or prompt" });

    const allLinks = Array.isArray(source) ? source : [source];
    const links = allLinks.filter(u => { try { return isSafeUrl(u); } catch { return false; } });
    const rejected = allLinks.length - links.length;
    if (!links.length) return res.status(400).json({ error: "No valid/safe URLs provided" });

    const userId = user_id ?? null;
    const messageId = message_id ?? null;
    if (!userId && links.length > 3) return res.status(400).json({ message: "Public users limited to 3 URLs" });

    try {
        const queryEmbedding = await retry(() => EmbedQuery(`task: search result | query: ${prompt}`));
        if (!queryEmbedding?.length) return res.status(500).json({ error: "Query embedding failed" });

        if (userId) await SendWebhook("no_link", "GENERATED_EMBEDDINGS", userId, messageId, webhook_url);

        const globalLimiter = pLimit(CFG.GLOBAL_CONCURRENCY);
        const visited = new Set();
        const seenFingerprints = [];
        const results = [];
        const imageQuota = { used: 0, max: CFG.MAX_IMAGES_PER_REQ }; // per-request, shared by ref

        await Promise.all(links.map(url =>
            globalLimiter(async () => {
                const domLimiter = getDomainLimiter(new URL(url).hostname);
                return domLimiter(() =>
                    crawlUrl({ url, queryEmbedding, depth: 0, visited, seenFingerprints, results, imageQuota, globalLimiter, userId, messageId, webhookUrl: webhook_url })
                );
            })
        ));

        results.sort((a, b) => b.score - a.score);
        if (userId) await SendWebhook("no_link", "SCRAPE_COMPLETE", userId, messageId, webhook_url);

        return res.status(200).json({
            results,
            meta: { requested: links.length, returned: results.length, rejected, depth: CFG.CRAWL_DEPTH, imagesAnalyzed: imageQuota.used },
        });

    } catch (err) {
        console.error("Pipeline error:", err);
        if (userId) await SendWebhook("no_link", "ERROR_OCCURRED", userId, messageId, webhook_url);
        return res.status(500).json({ error: "Pipeline failed", details: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 7860;
app.listen(PORT, "0.0.0.0", async () => {
    await initPool();
    console.log(`🚀 Scraper :${PORT} | pool=${CFG.BROWSER_POOL_SIZE} | depth=${CFG.CRAWL_DEPTH} | maxImages=${CFG.MAX_IMAGES_PER_REQ}`);
});

const shutdown = async () => {
    await Promise.all(pool.map(b => b.close().catch(() => { })));
    process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
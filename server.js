import express from "express";
import { chromium } from "playwright";
import pLimit from "p-limit";
import { EmbedQuery, EmbedChunk, CreateChunks, SendWebhook } from "./utils.js";
import { URL } from "url";

const app = express();
app.use(express.json());

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function cosineSimilarity(vecA, vecB) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function isSafeUrl(urlString) {
    try {
        const url = new URL(urlString);
        if (!["http:", "https:"].includes(url.protocol)) return false;
        const hostname = url.hostname.toLowerCase();
        const blocked = [
            "localhost", "127.0.0.1", "0.0.0.0",
            "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
            "169.254.0.0/16", "::1"
        ];
        if (blocked.some(b => hostname === b || hostname.endsWith(`.${b}`))) return false;
        return true;
    } catch {
        return false;
    }
}

// ------------------------------------------------------------------
// Global Playwright browser with aggressive launch args to avoid Skia crash
// ------------------------------------------------------------------
let browser = null;
let browserPromise = null;

async function getBrowser() {
    if (browser && browser.isConnected()) return browser;
    if (browserPromise) return browserPromise;

    browserPromise = (async () => {
        console.log("Launching Playwright browser (aggressive mode)");
        const newBrowser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',                      // avoid GPU crashes
                '--disable-software-rasterizer',
                '--disable-dev-shm-usage',            // avoid /dev/shm issues
                '--disable-font-subpixel-positioning', // workaround for Skia error
                '--disable-logging',
                '--disable-breakpad',
                '--disable-crash-reporter',
                '--disable-features=LayoutNG,NetworkService,ShadowDomV0',
                '--disable-blink-features=AutomationControlled',
            ],
            env: {
                ...process.env,
                // Force disable fontconfig to avoid missing fonts crash
                FONTCONFIG_PATH: '/dev/null',
                FONTCONFIG_FILE: '/dev/null',
            }
        });
        // If browser crashes, reset so next call relaunches
        newBrowser.on('disconnected', () => {
            console.warn("Browser disconnected, will relaunch on next request");
            browser = null;
            browserPromise = null;
        });
        browser = newBrowser;
        browserPromise = null;
        return browser;
    })();
    return browserPromise;
}

// Graceful shutdown
process.on('SIGINT', async () => { if (browser) await browser.close(); process.exit(); });
process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(); });

// ------------------------------------------------------------------
// Markdown cache (5 min)
// ------------------------------------------------------------------
const markdownCache = new Map();

// ------------------------------------------------------------------
// Scrape a single URL – isolated context, crash recovery per page
// ------------------------------------------------------------------
async function scrapeWithPlaywright(url) {
    const browserInstance = await getBrowser();
    // Create a fresh context for isolation
    const context = await browserInstance.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 },
        ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    try {
        // Aggressive: shorter timeout, don't wait for full network idle
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
        const text = await page.evaluate(() => {
            const clone = document.body.cloneNode(true);
            const scripts = clone.querySelectorAll("script, style");
            scripts.forEach(el => el.remove());
            return clone.innerText || "";
        });
        const markdown = text.replace(/\n{3,}/g, "\n\n").trim();
        if (!markdown || markdown.length < 100) return null;
        return markdown;
    } catch (err) {
        console.error(`Playwright error for ${url}:`, err.message);
        return null;  // fail fast, no retry
    } finally {
        await page.close().catch(() => { });
        await context.close().catch(() => { });
    }
}

async function fetchRawMarkdown(url) {
    const now = Date.now();
    const cached = markdownCache.get(url);
    if (cached && (now - cached.timestamp) < 300000) {
        return cached.markdown;
    }
    const markdown = await scrapeWithPlaywright(url);
    if (markdown) {
        markdownCache.set(url, { markdown, timestamp: now });
    }
    return markdown;
}

// ------------------------------------------------------------------
// Process markdown (unchanged, but no title extraction change)
// ------------------------------------------------------------------
async function processMarkdown({ markdown, url, hostname, queryEmbedding }) {
    const cleanedText = markdown.replace(/\n{3,}/g, "\n\n").trim();
    if (cleanedText.length < 200) return null;

    const chunks = await CreateChunks(cleanedText);
    if (!chunks || !chunks.length) return null;

    let title = "";
    const firstLine = markdown.split("\n")[0];
    if (firstLine && firstLine.startsWith("# ")) title = firstLine.slice(2);
    else if (firstLine) title = firstLine.slice(0, 100);
    else title = url;

    const prefixedChunks = chunks.map(chunk => `title: ${title || "none"} | text: ${chunk}`);

    const allEmbeddings = [];
    const BATCH_SIZE = 24;
    for (let i = 0; i < prefixedChunks.length; i += BATCH_SIZE) {
        const batch = prefixedChunks.slice(i, i + BATCH_SIZE);
        const batchEmb = await EmbedChunk(batch);
        if (batchEmb && batchEmb.length) allEmbeddings.push(...batchEmb);
    }
    if (allEmbeddings.length !== prefixedChunks.length) return null;

    const scoredChunks = chunks.map((chunk, idx) => ({
        idx,
        chunk,
        score: cosineSimilarity(queryEmbedding, allEmbeddings[idx]),
    }));

    const relevant = scoredChunks.filter(item => item.score >= 0.35).sort((a, b) => b.score - a.score);
    if (!relevant.length) return null;

    const selectedIndices = new Set();
    let currentLength = 0;
    const MAX_CONTEXT_LEN = 15000;
    for (const item of relevant) {
        if (currentLength + item.chunk.length > MAX_CONTEXT_LEN) break;
        const neighbours = [item.idx - 1, item.idx, item.idx + 1]
            .filter(i => i >= 0 && i < chunks.length && !selectedIndices.has(i));
        const addedLen = neighbours.reduce((sum, i) => sum + chunks[i].length, 0);
        if (currentLength + addedLen > MAX_CONTEXT_LEN) break;
        neighbours.forEach(i => selectedIndices.add(i));
        currentLength += addedLen;
    }

    const sortedIndices = Array.from(selectedIndices).sort((a, b) => a - b);
    let finalContext = "";
    let lastIdx = -2;
    for (const idx of sortedIndices) {
        if (lastIdx !== -2 && idx - lastIdx > 1) finalContext += "\n\n[...]\n\n";
        finalContext += chunks[idx] + "\n";
        lastIdx = idx;
    }

    if (!finalContext) return null;

    return {
        title,
        favicon: `https://www.google.com/s2/favicons?domain=${hostname}`,
        url,
        markdown: finalContext,
        score: relevant[0]?.score || 0,
    };
}

// ------------------------------------------------------------------
// Concurrency – aggressive: higher limits, no delays, no robots.txt
// ------------------------------------------------------------------
const domainLimiters = new Map();

function getDomainLimiter(domain) {
    if (!domainLimiters.has(domain)) {
        domainLimiters.set(domain, pLimit(4)); // up to 4 concurrent per domain
    }
    return domainLimiters.get(domain);
}

async function scrapeUrl(url, queryEmbedding) {
    if (!isSafeUrl(url)) return null;
    // Robots.txt check REMOVED (aggressive mode)
    const markdown = await fetchRawMarkdown(url);
    if (!markdown) return null;
    const hostname = new URL(url).hostname;
    return await processMarkdown({ markdown, url, hostname, queryEmbedding });
}

// ------------------------------------------------------------------
// Health check
// ------------------------------------------------------------------
app.get("/", (req, res) => res.send("Antinode Scrape API - AGGRESSIVE MODE (no robots.txt, no delays)"));

// ------------------------------------------------------------------
// Main endpoint – high concurrency
// ------------------------------------------------------------------
app.post("/api/search", async (req, res) => {
    const { source, prompt, user_id, message_id, webhook_url } = req.body;

    if (!source || !prompt) {
        return res.status(400).json({ error: "Missing 'source' or 'prompt'." });
    }

    const links = Array.isArray(source) ? source : [source];
    const userId = user_id || null;
    const messageId = message_id || null;

    if (!userId && links.length > 3) {
        return res.status(400).json({ message: "Public users limited to 3 URLs" });
    }

    try {
        const prefixedPrompt = `task: search result | query: ${prompt}`;
        const queryEmbedding = await EmbedQuery(prefixedPrompt);
        if (!queryEmbedding || queryEmbedding.length === 0) {
            return res.status(500).json({ error: "Failed to embed query." });
        }

        if (userId) {
            await SendWebhook("Embedded your search query", "GENERATED_EMBEDDINGS", userId, messageId, webhook_url);
        }

        const globalConcurrency = parseInt(process.env.SCRAPE_CONCURRENCY) || 8; // higher
        const globalLimiter = pLimit(globalConcurrency);

        const tasks = links.map(url =>
            globalLimiter(async () => {
                const domain = new URL(url).hostname;
                const domainLimiter = getDomainLimiter(domain);
                const result = await domainLimiter(async () => {
                    // No politeDelay
                    if (userId) {
                        await SendWebhook(`Scraping: ${url}`, "FETCHING_URL", userId, messageId, webhook_url);
                    }
                    return await scrapeUrl(url, queryEmbedding);
                });
                if (result && userId) {
                    await SendWebhook(result.markdown.slice(0, 500), "PAGE_READ", userId, messageId, webhook_url);
                }
                return result;
            })
        );

        const results = await Promise.all(tasks);
        const dataset = results.filter(r => r !== null);

        if (userId) {
            await SendWebhook("no_link", "SCRAPE_COMPLETE", userId, messageId, webhook_url);
        }

        return res.status(200).json(dataset);
    } catch (error) {
        console.error("Pipeline Error:", error);
        if (userId) {
            await SendWebhook("no_link", "ERROR_OCCURRED", userId, messageId, webhook_url);
        }
        return res.status(500).json({
            error: "Scraping failed",
            details: error.message,
        });
    }
});

// ------------------------------------------------------------------
// Start server
// ------------------------------------------------------------------
const PORT = process.env.PORT || 7860;
app.listen(PORT, "0.0.0.0", async () => {
    await getBrowser(); // pre-launch
    console.log(`🚀 AGGRESSIVE Playwright scraper running on port ${PORT}`);
});
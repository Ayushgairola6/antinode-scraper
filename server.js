import express from "express";
import { chromium } from "playwright";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { EmbedQuery, EmbedChunk, CreateChunks, SendWebhook } from "./utils.js";

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

// ------------------------------------------------------------------
// Health check
// ------------------------------------------------------------------
app.get("/", (req, res) => res.send("Antinode Scrape API is live 🚀 (Playwright)"));

// ------------------------------------------------------------------
// Persistent browser (reused across all requests)
// ------------------------------------------------------------------
let persistentBrowser = null;

async function getBrowser() {
    if (!persistentBrowser) {
        console.log("Launching persistent Playwright browser...");
        persistentBrowser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
            ],
        });
        // Warm up
        const page = await persistentBrowser.newPage();
        await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
        await page.close();
        console.log("Playwright browser ready");
    }
    return persistentBrowser;
}

// ------------------------------------------------------------------
// Content processor (unchanged)
// ------------------------------------------------------------------
async function processPageContent({ html, url, hostname, queryEmbedding, turndown }) {
    const dom = new JSDOM(html, { url });
    const document = dom.window.document;

    const NOISE_SELECTORS = [
        "header", "footer", "nav", "aside", ".sidebar",
        "dialog", '[role="dialog"]', '[aria-modal="true"]',
        ".modal", ".popup", ".overlay",
        ".cookie-banner", ".consent-banner", "#onetrust-consent-sdk",
        ".social-share", ".related-posts", ".comments",
        ".advertisement", ".sponsored", "noscript", "style"
    ];
    document.querySelectorAll(NOISE_SELECTORS.join(",")).forEach(el => el.remove());

    const reader = new Readability(document);
    const article = reader.parse();

    let markdown = "";
    if (article?.content) {
        markdown = turndown.turndown(article.content);
    } else {
        const main = document.querySelector(
            'article, main, [role="main"], .post-content, .entry-content'
        );
        markdown = turndown.turndown(main ? main.innerHTML : document.body.innerHTML);
    }
    dom.window.close();

    const cleanedText = markdown.replace(/\n{3,}/g, "\n\n").trim();
    if (cleanedText.length < 200) return null;

    const chunks = await CreateChunks(cleanedText);
    if (!chunks || !chunks.length) return null;

    const allEmbeddings = [];
    const BATCH_SIZE = 12;
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE);
        const batchEmb = await EmbedChunk(batch);
        if (batchEmb && batchEmb.length) allEmbeddings.push(...batchEmb);
    }
    if (allEmbeddings.length !== chunks.length) return null;

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
        title: article?.title || document.querySelector("title")?.textContent || hostname,
        favicon: `https://www.google.com/s2/favicons?domain=${hostname}`,
        url,
        markdown: finalContext,
        score: relevant[0]?.score || 0,
    };
}

// ------------------------------------------------------------------
// Scrape a single URL (Playwright only)
// ------------------------------------------------------------------
async function scrapeUrl(url, queryEmbedding, turndown) {
    const browser = await getBrowser();
    let page = null;
    try {
        page = await browser.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const html = await page.content();
        const hostname = new URL(url).hostname;
        return await processPageContent({ html, url, hostname, queryEmbedding, turndown });
    } catch (err) {
        console.error(`Scrape failed for ${url}:`, err.message);
        return null;
    } finally {
        if (page) await page.close().catch(() => { });
    }
}

// ------------------------------------------------------------------
// Main endpoint
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
        const queryEmbedding = await EmbedQuery(prompt);
        if (!queryEmbedding || queryEmbedding.length === 0) {
            return res.status(500).json({ error: "Failed to embed query." });
        }

        if (userId) {
            await SendWebhook("Embedded your search query", "GENERATED_EMBEDDINGS", userId, messageId, webhook_url);
        }

        const turndown = new TurndownService({ headingStyle: "atx" });
        turndown.remove(["img", "iframe", "script", "style", "noscript", "svg", "form"]);

        const dataset = [];

        // Process URLs sequentially (add concurrency if needed)
        for (const url of links) {
            if (userId) {
                await SendWebhook(`Scraping: ${url}`, "FETCHING_URL", userId, messageId, webhook_url);
            }
            const result = await scrapeUrl(url, queryEmbedding, turndown);
            if (result) {
                dataset.push(result);
                if (userId) {
                    await SendWebhook(result.markdown.slice(0, 500), "PAGE_READ", userId, messageId, webhook_url);
                }
            }
        }

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
    // Pre-warm the browser
    await getBrowser();
    console.log(`🚀 Playwright-only scraper running on port ${PORT} (persistent browser)`);
});
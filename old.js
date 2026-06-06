// import express from "express";
// import { PlaywrightCrawler, Configuration, MemoryStorage, log } from "crawlee";
// import { chromium } from "playwright";
// import { Readability } from "@mozilla/readability";
// import { JSDOM } from "jsdom";
// import TurndownService from "turndown";
// import { EmbedQuery, EmbedChunk, CreateChunks, SendWebhook } from "./utils.js";

// const app = express();
// app.use(express.json());

// // ------------------------------------------------------------------
// // Helpers
// // ------------------------------------------------------------------
// function cosineSimilarity(vecA, vecB) {
//     let dot = 0, normA = 0, normB = 0;
//     for (let i = 0; i < vecA.length; i++) {
//         dot += vecA[i] * vecB[i];
//         normA += vecA[i] * vecA[i];
//         normB += vecB[i] * vecB[i];
//     }
//     return dot / (Math.sqrt(normA) * Math.sqrt(normB));
// }

// // ------------------------------------------------------------------
// // Health check
// // ------------------------------------------------------------------
// app.get("/", (req, res) => res.send("Antinode Scrape API is live 🚀 (Playwright)"));

// // ------------------------------------------------------------------
// // Main search endpoint (uses Playwright for dynamic content)
// // ------------------------------------------------------------------
// app.post("/api/search", async (req, res) => {
//     const { source, prompt, user_id, message_id } = req.body;

//     if (!source || !prompt) {
//         return res.status(400).json({ error: "Missing 'source' (links) or 'prompt'." });
//     }

//     const links = Array.isArray(source) ? source : [source];

//     // Public users limited to 3 URLs (resource protection)
//     if (!user_id && links.length > 3) {
//         return res.status(400).json({ message: "Because of our limited resources you can only scrape 3 URLs at a time." });
//     }

//     const userId = user_id || null;
//     const MessageId = message_id || null;

//     try {
//         // ----- Embed query -----
//         const queryEmbedding = await EmbedQuery(prompt);
//         if (!queryEmbedding || queryEmbedding.length === 0) {
//             return res.status(500).json({ error: "Failed to embed query." });
//         }

//         // ----- Dataset for this request -----
//         const dataset = [];

//         // ----- Turndown service for HTML -> Markdown -----
//         const turndown = new TurndownService({ headingStyle: "atx" });
//         turndown.remove(["img", "iframe", "script", "style", "noscript", "svg", "form"]);

//         // ----- Shared function: extract content from DOM (Readability + chunking + embedding) -----
//         async function processPageContent({ html, url, hostname }) {
//             const dom = new JSDOM(html, { url });
//             const document = dom.window.document;

//             // Remove noise
//             const NOISE_SELECTORS = [
//                 "header", "footer", "nav", "aside", ".sidebar",
//                 "dialog", '[role="dialog"]', '[aria-modal="true"]',
//                 ".modal", ".popup", ".overlay",
//                 ".cookie-banner", ".consent-banner", "#onetrust-consent-sdk",
//                 ".social-share", ".related-posts", ".comments",
//                 ".advertisement", ".sponsored", "noscript", "style"
//             ];
//             document.querySelectorAll(NOISE_SELECTORS.join(",")).forEach(el => el.remove());

//             const reader = new Readability(document);
//             const article = reader.parse();

//             let markdown = "";
//             if (article?.content) {
//                 markdown = turndown.turndown(article.content);
//             } else {
//                 const main = document.querySelector(
//                     'article, main, [role="main"], .post-content, .entry-content'
//                 );
//                 markdown = turndown.turndown(main ? main.innerHTML : document.body.innerHTML);
//             }
//             dom.window.close();

//             // Clean & chunk
//             const cleanedText = markdown.replace(/\n{3,}/g, "\n\n").trim();
//             if (cleanedText.length < 200) return null;

//             const chunks = await CreateChunks(cleanedText);
//             if (!chunks.length) return null;

//             // Embed document chunks
//             const allEmbeddings = [];
//             const BATCH_SIZE = 12;
//             for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
//                 const batch = chunks.slice(i, i + BATCH_SIZE);
//                 const batchEmb = await EmbedChunk(batch);
//                 allEmbeddings.push(...batchEmb);
//             }

//             // Score vs query
//             const scoredChunks = chunks.map((chunk, idx) => ({
//                 idx,
//                 chunk,
//                 score: cosineSimilarity(queryEmbedding, allEmbeddings[idx]),
//             }));

//             const relevant = scoredChunks
//                 .filter(item => item.score >= 0.35)
//                 .sort((a, b) => b.score - a.score);

//             if (!relevant.length) return null;

//             // Build final context (include neighbours)
//             const selectedIndices = new Set();
//             let currentLength = 0;
//             const MAX_CONTEXT_LEN = 15000;
//             for (const item of relevant) {
//                 if (currentLength + item.chunk.length > MAX_CONTEXT_LEN) break;
//                 const neighbours = [item.idx - 1, item.idx, item.idx + 1]
//                     .filter(i => i >= 0 && i < chunks.length && !selectedIndices.has(i));
//                 const addedLen = neighbours.reduce((sum, i) => sum + chunks[i].length, 0);
//                 if (currentLength + addedLen > MAX_CONTEXT_LEN) break;
//                 neighbours.forEach(i => selectedIndices.add(i));
//                 currentLength += addedLen;
//             }

//             const sortedIndices = Array.from(selectedIndices).sort((a, b) => a - b);
//             let finalContext = "";
//             let lastIdx = -2;
//             for (const idx of sortedIndices) {
//                 if (lastIdx !== -2 && idx - lastIdx > 1) finalContext += "\n\n[...]\n\n";
//                 finalContext += chunks[idx] + "\n";
//                 lastIdx = idx;
//             }

//             if (!finalContext) return null;

//             return {
//                 title: article?.title || document.querySelector("title")?.textContent || hostname,
//                 favicon: `https://www.google.com/s2/favicons?domain=${hostname}`,
//                 url,
//                 markdown: finalContext,
//                 score: relevant[0]?.score || 0,
//             };
//         }

//         // ----- Configure PlaywrightCrawler (optimized for Hugging Face Docker space) -----
//         log.setLevel(log.LEVELS.OFF); // Reduce console noise

//         const crawler = new PlaywrightCrawler({
//             launchContext: {
//                 // Use the installed playwright chromium
//                 launcher: chromium,
//                 launchOptions: {
//                     headless: true,
//                     args: [
//                         '--no-sandbox',
//                         '--disable-setuid-sandbox',
//                         '--disable-dev-shm-usage',
//                         '--disable-accelerated-2d-canvas',
//                         '--disable-gpu',
//                         '--disable-web-security', // sometimes needed for CORS
//                     ],
//                 },
//             },
//             // Lower concurrency for HF spaces (limited resources)
//             minConcurrency: 1,
//             maxConcurrency: 2,
//             maxRequestRetries: 1,
//             requestHandlerTimeoutSecs: 120,
//             // Pre‑navigation hook: wait for network to be relatively idle
//             preNavigationHooks: [
//                 async ({ page }) => {
//                     await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
//                 },
//             ],
//             async requestHandler({ request, page }) {
//                 const hostname = new URL(request.url).hostname;
//                 const url = request.url;

//                 // Send webhook for app users
//                 if (userId) {
//                     await SendWebhook(hostname, "LINK_READ", userId, MessageId);
//                 }

//                 // Wait for main content to appear (adjust selector as needed)
//                 await page.waitForSelector('article, main, .post-content, .entry-content, body', { timeout: 10000 })
//                     .catch(() => { }); // continue anyway

//                 // Optional: scroll to load lazy content (helpful for infinite scroll)
//                 await page.evaluate(async () => {
//                     await new Promise((resolve) => {
//                         let totalHeight = 0;
//                         const distance = 500;
//                         const timer = setInterval(() => {
//                             const scrollHeight = document.body.scrollHeight;
//                             window.scrollBy(0, distance);
//                             totalHeight += distance;
//                             if (totalHeight >= scrollHeight) {
//                                 clearInterval(timer);
//                                 resolve();
//                             }
//                         }, 200);
//                     });
//                 }).catch(() => { }); // ignore if scroll fails

//                 // Get fully rendered HTML
//                 const html = await page.content();

//                 // Process the page content
//                 const result = await processPageContent({ html, url, hostname });

//                 if (result) {
//                     dataset.push(result);
//                     // Send a snippet to webhook for app users
//                     if (userId) {
//                         await SendWebhook(result.markdown.slice(0, 500), "PAGE_READ", userId, MessageId);
//                     }
//                 }
//             },
//         }, new Configuration({
//             persistStorage: false,
//             storageClient: new MemoryStorage({ persistStorage: false }),
//         }));

//         // Run the crawler on the provided links
//         await crawler.run(links);

//         // Final webhook (only for app)
//         if (userId) {
//             SendWebhook("no_link", "SCRAPE_COMPLETE", userId, MessageId).catch(() => { });
//         }

//         return res.status(200).json(dataset);
//     } catch (error) {
//         console.error("Pipeline Error:", error);
//         if (userId) {
//             await SendWebhook("no_link", "ERROR_OCCURRED", userId, MessageId);
//         }
//         return res.status(500).json({
//             error: "Scraping failed",
//             details: error.message,
//         });
//     }
// });

// // ------------------------------------------------------------------
// // Start server
// // ------------------------------------------------------------------
// const PORT = process.env.PORT || 7860;
// app.listen(PORT, "0.0.0.0", () => {
//     console.log(`🚀 Server running on port ${PORT} with PlaywrightCrawler`);
// });


import express from "express";
import { exec } from "child_process";
import { promisify } from "util";
import pLimit from "p-limit";
import { EmbedQuery, EmbedChunk, CreateChunks, SendWebhook } from "./utils.js";

const execAsync = promisify(exec);
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
app.get("/", (req, res) => res.send("Antinode Scrape API is live 🚀 (Lightpanda fetch + concurrency)"));

// ------------------------------------------------------------------
// Process markdown from Lightpanda (chunking + embedding)
// ------------------------------------------------------------------
async function processMarkdown({ markdown, url, hostname, queryEmbedding }) {
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

    let title = "";
    const firstLine = markdown.split("\n")[0];
    if (firstLine && firstLine.startsWith("# ")) title = firstLine.slice(2);
    else if (firstLine) title = firstLine.slice(0, 100);
    else title = url;

    return {
        title,
        favicon: `https://www.google.com/s2/favicons?domain=${hostname}`,
        url,
        markdown: finalContext,
        score: relevant[0]?.score || 0,
    };
}

// ------------------------------------------------------------------
// Scrape a single URL using Lightpanda fetch (direct markdown)
// ------------------------------------------------------------------
async function scrapeUrl(url, queryEmbedding) {
    const lightpandaBin = process.env.LIGHTPANDA_EXECUTABLE_PATH || "./lightpanda";
    const command = `${lightpandaBin} fetch --dump markdown "${url}"`;
    try {
        const { stdout, stderr } = await execAsync(command, { timeout: 30000 });
        if (stderr) console.warn(`Lightpanda fetch stderr for ${url}: ${stderr}`);
        const markdown = stdout.trim();
        if (!markdown || markdown.length < 100) return null;
        const hostname = new URL(url).hostname;
        return await processMarkdown({ markdown, url, hostname, queryEmbedding });
    } catch (err) {
        console.error(`Lightpanda fetch failed for ${url}:`, err.message);
        return null;
    }
}

// ------------------------------------------------------------------
// Main endpoint – now with concurrent scraping
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

        // Concurrency limit – adjust based on your memory. 3 is safe for 512MB Render.
        const concurrency = process.env.SCRAPE_CONCURRENCY ? parseInt(process.env.SCRAPE_CONCURRENCY) : 3;
        const limit = pLimit(concurrency);

        // Create an array of promises, each limited by pLimit
        const tasks = links.map(url =>
            limit(async () => {
                if (userId) {
                    await SendWebhook(`Scraping: ${url}`, "FETCHING_URL", userId, messageId, webhook_url);
                }
                const result = await scrapeUrl(url, queryEmbedding);
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
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Lightpanda fetch scraper running on port ${PORT}`);
});
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

// ------------------------------------------------------------------
// Embedding helpers
// ------------------------------------------------------------------
const EMBEDDING_URL =
    process.env.EMBEDDING_URL || "https://i-feel-eureka-embeddings.hf.space/api/embed";

/**
 * Embed a single query string.
 * @param {string} queryText – the user’s search prompt
 * @returns {number[]} 1024‑dim vector
 */
export async function EmbedQuery(queryText) {
    const result = await EmbedChunk(queryText);  // returns array of vectors
    return result?.[0] || [];
}

/**
 * Embed one or more strings.
 * @param {string|string[]} chunk – single string or array of strings
 * @returns {number[][]} array of embedding vectors (each 1024‑dim)
 */
export async function EmbedChunk(chunk) {
    try {

        const input = typeof chunk === "string" ? [chunk] : chunk;
        if (!input || input.length === 0) return [];

        const response = await fetch(EMBEDDING_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "mxbai-embed-large",
                input: input,
            }),
            signal: AbortSignal.timeout(8000_000),

        });

        if (!response.ok) {
            console.error("Embedding request failed:", response.status);
            return [];
        }

        const data = await response.json();
        return data.embeddings || [];
    } catch (error) {
        console.error("EmbedChunk error:", error);
        return [];
    }
}

// ------------------------------------------------------------------
// Webhook sender (only if user_id is present)
// ------------------------------------------------------------------
/**
 * Send a webhook event. Does nothing if `user_id` is missing.
 */
export async function SendWebhook(link, message, user_id, MessageId, WEBHOOK_URL) {
    if (!user_id || !WEBHOOK_URL) {
        console.log('user_id or webhook_url was missingin the web hooksending function', user_id, WEBHOOK_URL)
        return
    };                         // ← skip for public users
    console.log("webhook emitted")

    try {
        const url = WEBHOOK_URL

        await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                message,
                link,
                user_id,
                MessageId,
            }),
        });
    } catch (error) {
        console.error("Webhook error:", error);
    }
}

// ------------------------------------------------------------------
// Safe chunk creation
// ------------------------------------------------------------------
/**
 * Split a cleaned markdown string into token‑safe chunks.
 * (Uses a simple character‑based splitter; adjust as needed.)
 */
export async function CreateChunks(markdown) {
    const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: 800,
        chunkOverlap: 100,
    });
    return splitter.splitText(markdown);
}
// Kindered@hf2026
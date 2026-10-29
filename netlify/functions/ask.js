// netlify/functions/ask.js
// Valate backend — AgentRouter.org is the only AI provider.
//
// Netlify environment variables:
//   AGENTROUTER_API_KEY  (required) your AgentRouter token — server-side only
//   AGENTROUTER_MODEL    (optional) model ID, defaults to gpt-6-astra
//   AGENTROUTER_API_URL  (optional) overrides the endpoint below
//
// AgentRouter docs: "OpenAI Compatible" provider, base URL https://agentrouter.org/v1.
// The chat path /chat/completions is the standard OpenAI-compatible path appended to that base URL.
// Request shape: Authorization: Bearer <key>, model + messages[].
// If it ever differs, only buildRequest() / extractText() need changing.

const MAX_HISTORY_MESSAGES = 20;
const MAX_CHARS_PER_MESSAGE = 3000;
const MAX_MEMORY_ITEMS = 30;
const MAX_CHARS_PER_MEMORY = 300;
const DEFAULT_MODEL = "gpt-6-astra";
const DEFAULT_API_URL = "https://agentrouter.org/v1/chat/completions";

const BASE_SYSTEM_PROMPT = "You are Valate, a helpful AI assistant. Pay close attention to the earlier turns of this conversation so you correctly understand follow-up or continuation requests such as 'make another one', 'make it shorter', 'change the ending', 'do the same but for X', 'continue', or 'what about the second one'. " +
    "Format every response in clean, well-structured Markdown, the way a modern AI chat assistant would: break your answer into short paragraphs (2-4 sentences) instead of a single wall of text, use ## or ### headings to separate distinct sections in longer answers, use bullet or numbered lists for anything list-like, use **bold** to highlight key terms, and use fenced code blocks for any code. Leave a blank line between paragraphs, headings, and list blocks so the response is easy to scan. Keep simple, short answers to a sentence or two without forcing unnecessary structure.";

const TITLE_SYSTEM_PROMPT = "Generate a short chat title (3 to 6 words) that specifically captures what this conversation is about, based on the user's message and the assistant's reply. Reply with ONLY the title text itself — no quotes, no punctuation at the end, no labels like 'Title:', no explanation.";

exports.handler = async (event) => {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

    let prompt, history, memory, mode;
    try {
        const body = JSON.parse(event.body);
        prompt = body.prompt;
        history = Array.isArray(body.history) ? body.history : [];
        memory = Array.isArray(body.memory) ? body.memory : [];
        mode = body.mode === "title" ? "title" : "chat";
    } catch (e) {
        return { statusCode: 400, body: "Invalid request body." };
    }

    if (typeof prompt !== "string" || !prompt.trim()) return { statusCode: 400, body: "Prompt is empty." };

    const trimmedHistory = history
        .slice(-MAX_HISTORY_MESSAGES)
        .filter(m => m && typeof m.text === "string" && m.text.trim())
        .map(m => ({ role: m.role === "user" ? "user" : "ai", text: m.text.slice(0, MAX_CHARS_PER_MESSAGE) }));

    if (mode === "title") {
        try {
            const title = await callAgentRouter(prompt, trimmedHistory, TITLE_SYSTEM_PROMPT, { maxTokens: 40 });
            return { statusCode: 200, headers: { "Content-Type": "text/plain" }, body: title };
        } catch (err) {
            console.error("AgentRouter title call failed:", err.message);
            return { statusCode: 502, headers: { "Content-Type": "text/plain" }, body: "" };
        }
    }

    const memoryLines = memory
        .filter(m => typeof m === "string" && m.trim())
        .slice(0, MAX_MEMORY_ITEMS)
        .map(m => `- ${m.trim().slice(0, MAX_CHARS_PER_MEMORY)}`);

    const systemPrompt = memoryLines.length
        ? `${BASE_SYSTEM_PROMPT}\n\nThings you know about this user (use naturally, don't just list them back):\n${memoryLines.join("\n")}`
        : BASE_SYSTEM_PROMPT;

    try {
        const aiResponse = await callAgentRouter(prompt, trimmedHistory, systemPrompt, { maxTokens: 2048 });
        return { statusCode: 200, headers: { "Content-Type": "text/plain" }, body: aiResponse };
    } catch (err) {
        console.error("AgentRouter call failed:", err.message, err.details || "");
        return {
            statusCode: err.statusCode && err.statusCode >= 400 ? err.statusCode : 502,
            headers: { "Content-Type": "text/plain" },
            body: formatError(err)
        };
    }
};

function formatError(err) {
    let msg = "Error: " + err.message;
    if (err.details) msg += "\n\nDetails: " + err.details;
    return msg;
}

function makeError(message, statusCode, details) {
    const e = new Error(message);
    e.statusCode = statusCode;
    e.details = details;
    return e;
}

// ---- Provider-specific request/response shape (change here only if AgentRouter's docs differ) ----

function buildRequest(model, systemPrompt, history, prompt, maxTokens) {
    const messages = [{ role: "system", content: systemPrompt }];
    history.forEach(m => messages.push({ role: m.role === "user" ? "user" : "assistant", content: m.text }));
    messages.push({ role: "user", content: prompt });
    return { model, messages, max_tokens: maxTokens };
}

function extractText(data) {
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) return content.map(p => (p && p.text) || "").join("").trim();
    return "";
}

// ---- Shared call + retry logic ----

async function callAgentRouter(prompt, history, systemPrompt, options = {}) {
    const { maxTokens = 2048 } = options;

    const API_KEY = process.env.AGENTROUTER_API_KEY;
    if (!API_KEY) throw makeError("AGENTROUTER_API_KEY is missing in Netlify environment variables (add it, then redeploy).", 500);

    const API_URL = process.env.AGENTROUTER_API_URL || DEFAULT_API_URL;

    const model = process.env.AGENTROUTER_MODEL || DEFAULT_MODEL;
    const requestBody = buildRequest(model, systemPrompt, history, prompt, maxTokens);

    const data = await fetchWithRetry(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
        body: JSON.stringify(requestBody)
    });

    const text = extractText(data);
    if (!text) throw makeError("AgentRouter returned an empty response.", 502, "Raw reply: " + JSON.stringify(data).slice(0, 500));
    return text;
}

async function fetchWithRetry(url, options, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000); // stay under Netlify's ~10s function limit
        let response;
        try {
            response = await fetch(url, { ...options, signal: controller.signal });
        } catch (err) {
            clearTimeout(timeout);
            if (err.name === "AbortError") {
                if (attempt === retries) throw makeError("AgentRouter did not respond in time (timed out after 8s).", 504);
                continue;
            }
            throw makeError("Could not reach AgentRouter: " + err.message, 502, "URL: " + safeUrl(url));
        }
        clearTimeout(timeout);

        // Read as text first — upstream error pages (outages, proxies) aren't always JSON.
        const raw = await response.text();
        let data;
        let isJson = true;
        try { data = raw ? JSON.parse(raw) : {}; } catch { isJson = false; data = {}; }

        // A web page (HTML) instead of JSON means a firewall/bot-check page or a wrong URL — not a real AI answer.
        if (!isJson) {
            const looksHtml = /<\s*(!doctype|html|meta|head|body|script)/i.test(raw);
            const waf = /waf|captcha|challenge|cloudflare|aliyun/i.test(raw);
            const snippet = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) || raw.slice(0, 300);
            if (looksHtml) {
                throw makeError(
                    waf
                        ? `AgentRouter's firewall returned a bot-check page (HTTP ${response.status}) instead of an AI answer. Requests from Netlify's servers are being blocked, or AGENTROUTER_API_URL is not the API endpoint.`
                        : `AgentRouter returned a web page (HTTP ${response.status}) instead of API data. AGENTROUTER_API_URL is probably not the API endpoint.`,
                    502,
                    "URL: " + safeUrl(url) + " | Page text: " + snippet
                );
            }
            data = { error: { message: raw.slice(0, 200) || `Empty response (${response.status})` } };
        }

        if (response.ok) return data;

        const retryable = response.status === 429 || response.status === 503 || response.status === 529;
        if (!retryable || attempt === retries) {
            const msg = (data.error && (data.error.message || data.error)) || data.message || "";
            const shown = typeof msg === "string" ? msg : JSON.stringify(msg);
            throw makeError(
                `AgentRouter returned HTTP ${response.status}` + (shown ? `: ${shown.slice(0, 300)}` : ""),
                response.status,
                "Raw reply: " + raw.slice(0, 500)
            );
        }
        await new Promise(res => setTimeout(res, 500 * Math.pow(2, attempt)));
    }
}

function safeUrl(u) {
    try { const x = new URL(u); return x.origin + x.pathname; } catch { return "(invalid AGENTROUTER_API_URL)"; }
}
    

// netlify/functions/ask.js
//
// Routes chat requests to either Gemini or Claude depending on the
// "model" field sent from the frontend. Both providers receive the
// same recent conversation history so switching models mid-chat
// keeps full context (e.g. "make another one" after switching).
//
// Required Netlify environment variables:
//   GEMINI_API_KEY  - existing Gemini key
//   CLAUDE_API_KEY  - Anthropic API key

const MAX_HISTORY_MESSAGES = 20;    // ~10 turns of back-and-forth
const MAX_CHARS_PER_MESSAGE = 3000; // stops one giant message from blowing up context size

const SYSTEM_PROMPT = "You are Valate, a helpful AI assistant. Pay close attention to the earlier turns of this conversation so you correctly understand follow-up or continuation requests such as 'make another one', 'make it shorter', 'change the ending', 'do the same but for X', 'continue', or 'what about the second one'. Answer in clean Markdown.";

exports.handler = async (event) => {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

    let prompt, history, model;
    try {
        const body = JSON.parse(event.body);
        prompt = body.prompt;
        history = Array.isArray(body.history) ? body.history : [];
        model = body.model === 'claude' ? 'claude' : 'gemini'; // default/fallback to gemini on anything unexpected
    } catch (e) {
        return { statusCode: 400, body: "Invalid request body." };
    }

    if (!prompt || !prompt.trim()) return { statusCode: 400, body: "Prompt is empty." };

    // Trim + cap history once, shared by both providers.
    const trimmedHistory = history
        .slice(-MAX_HISTORY_MESSAGES)
        .filter(m => m && typeof m.text === "string" && m.text.trim())
        .map(m => ({
            role: m.role === 'user' ? 'user' : 'ai', // normalize
            text: m.text.slice(0, MAX_CHARS_PER_MESSAGE)
        }));

    try {
        const aiResponse = model === 'claude'
            ? await callClaude(prompt, trimmedHistory)
            : await callGemini(prompt, trimmedHistory);

        return {
            statusCode: 200,
            headers: { "Content-Type": "text/plain" },
            body: aiResponse
        };
    } catch (err) {
        console.error(`${model} call failed:`, err.message);
        return {
            statusCode: 502,
            headers: { "Content-Type": "text/plain" },
            body: `The ${model === 'claude' ? 'Claude' : 'Gemini'} model is unavailable right now (${err.message}). Please try again, or switch models from the menu.`
        };
    }
};

// ---------- Gemini ----------

async function callGemini(prompt, history) {
    const API_KEY = process.env.GEMINI_API_KEY;
    if (!API_KEY) throw new Error("GEMINI_API_KEY missing in Netlify environment variables.");

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`;

    const contents = history.map(m => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.text }]
    }));
    contents.push({ role: 'user', parts: [{ text: prompt }] });

    const requestBody = {
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        tools: [{ google_search: {} }] // web search / grounding
    };

    const data = await fetchWithRetry(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
    });

    return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response from AI.";
}

// ---------- Claude ----------

async function callClaude(prompt, history) {
    const API_KEY = process.env.CLAUDE_API_KEY;
    if (!API_KEY) throw new Error("CLAUDE_API_KEY missing in Netlify environment variables.");

    const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5-20250929";
    const url = "https://api.anthropic.com/v1/messages";

    const messages = history.map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.text
    }));
    messages.push({ role: 'user', content: prompt });

    const requestBody = {
        model: CLAUDE_MODEL,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages,
        tools: [{ type: "web_search_20250305", name: "web_search" }] // web search
    };

    const data = await fetchWithRetry(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": API_KEY,
            "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(requestBody)
    });

    const textBlocks = (data.content || []).filter(b => b.type === "text").map(b => b.text);
    return textBlocks.join("\n\n") || "No response from AI.";
}

// ---------- Shared retry helper ----------

async function fetchWithRetry(url, options, retries = 3) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        const response = await fetch(url, options);
        const data = await response.json();

        if (response.ok) return data;

        // 429 = rate limited, 503/529 = overloaded — worth retrying
        const retryable = response.status === 429 || response.status === 503 || response.status === 529;
        if (!retryable || attempt === retries) {
            const message = data.error?.message || `API Error ${response.status}`;
            throw new Error(message);
        }

        const waitMs = 500 * Math.pow(2, attempt); // 500ms, 1s, 2s...
        await new Promise(res => setTimeout(res, waitMs));
    }
}

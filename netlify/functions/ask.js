// netlify/functions/ask.js
const MAX_HISTORY_MESSAGES = 20;
const MAX_CHARS_PER_MESSAGE = 3000;
const MAX_MEMORY_ITEMS = 30;
const MAX_CHARS_PER_MEMORY = 300;

const BASE_SYSTEM_PROMPT = "You are Valate, a helpful AI assistant. Pay close attention to the earlier turns of this conversation so you correctly understand follow-up or continuation requests such as 'make another one', 'make it shorter', 'change the ending', 'do the same but for X', 'continue', or 'what about the second one'. Answer in clean Markdown.";

exports.handler = async (event) => {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

    let prompt, history, model, memory;
    try {
        const body = JSON.parse(event.body);
        prompt = body.prompt;
        history = Array.isArray(body.history) ? body.history : [];
        memory = Array.isArray(body.memory) ? body.memory : [];
        model = body.model === 'claude' ? 'claude' : 'gemini';
    } catch (e) {
        return { statusCode: 400, body: "Invalid request body." };
    }

    if (!prompt || !prompt.trim()) return { statusCode: 400, body: "Prompt is empty." };

    const trimmedHistory = history
        .slice(-MAX_HISTORY_MESSAGES)
        .filter(m => m && typeof m.text === "string" && m.text.trim())
        .map(m => ({ role: m.role === 'user' ? 'user' : 'ai', text: m.text.slice(0, MAX_CHARS_PER_MESSAGE) }));

    const memoryLines = memory
        .filter(m => typeof m === 'string' && m.trim())
        .slice(0, MAX_MEMORY_ITEMS)
        .map(m => `- ${m.trim().slice(0, MAX_CHARS_PER_MEMORY)}`);

    const systemPrompt = memoryLines.length
        ? `${BASE_SYSTEM_PROMPT}\n\nThings you know about this user (use naturally, don't just list them back):\n${memoryLines.join("\n")}`
        : BASE_SYSTEM_PROMPT;

    try {
        const aiResponse = model === 'claude'
            ? await callClaude(prompt, trimmedHistory, systemPrompt)
            : await callGemini(prompt, trimmedHistory, systemPrompt);

        return { statusCode: 200, headers: { "Content-Type": "text/plain" }, body: aiResponse };
    } catch (err) {
        console.error(`${model} call failed:`, err.message);
        return {
            statusCode: 502,
            headers: { "Content-Type": "text/plain" },
            body: `The ${model === 'claude' ? 'Claude' : 'Gemini'} model is unavailable right now (${err.message}). Please try again, or switch models from the menu.`
        };
    }
};

async function callGemini(prompt, history, systemPrompt) {
    const API_KEY = process.env.GEMINI_API_KEY;
    if (!API_KEY) throw new Error("GEMINI_API_KEY missing in Netlify environment variables.");

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`;

    const contents = history.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] }));
    contents.push({ role: 'user', parts: [{ text: prompt }] });

    const requestBody = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        tools: [{ google_search: {} }]
    };

    const data = await fetchWithRetry(url, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody)
    });

    return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response from AI.";
}

async function callClaude(prompt, history, systemPrompt) {
    const API_KEY = process.env.CLAUDE_API_KEY;
    if (!API_KEY) throw new Error("CLAUDE_API_KEY missing in Netlify environment variables.");

    const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5-20250929";
    const url = "https://api.anthropic.com/v1/messages";

    const messages = history.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }));
    messages.push({ role: 'user', content: prompt });

    const requestBody = {
        model: CLAUDE_MODEL, max_tokens: 2048, system: systemPrompt, messages,
        tools: [{ type: "web_search_20250305", name: "web_search" }]
    };

    const data = await fetchWithRetry(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(requestBody)
    });

    const textBlocks = (data.content || []).filter(b => b.type === "text").map(b => b.text);
    return textBlocks.join("\n\n") || "No response from AI.";
}

async function fetchWithRetry(url, options, retries = 3) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        const response = await fetch(url, options);
        const data = await response.json();
        if (response.ok) return data;
        const retryable = response.status === 429 || response.status === 503 || response.status === 529;
        if (!retryable || attempt === retries) throw new Error(data.error?.message || `API Error ${response.status}`);
        await new Promise(res => setTimeout(res, 500 * Math.pow(2, attempt)));
    }
}

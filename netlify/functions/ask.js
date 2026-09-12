// netlify/functions/ask.js
exports.handler = async (event) => {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

    try {
        const { prompt } = JSON.parse(event.body);
        const API_KEY = process.env.GEMINI_API_KEY;

        if (!prompt) return { statusCode: 400, body: "Prompt is empty." };
        if (!API_KEY) return { statusCode: 500, body: "API Key missing in Netlify." };

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`;

        const body = {
            contents: [{
                parts: [{ text: `You are a helpful AI. Answer in clean Markdown.\n\nUser: ${prompt}` }]
            }],
            tools: [{ google_search: {} }] // enables real web browsing/grounding
        };

        const aiResponse = await callWithRetry(url, body);

        return {
            statusCode: 200,
            headers: { "Content-Type": "text/plain" },
            body: aiResponse
        };

    } catch (err) {
        console.error("System Crash:", err.message);
        return { statusCode: 500, body: "The AI is busy right now — please try again in a few seconds." };
    }
};

async function callWithRetry(url, body, retries = 3) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });

        const data = await response.json();

        if (response.ok) {
            return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response from AI.";
        }

        // 429 = rate limited, 503 = overloaded — both are worth retrying
        const retryable = response.status === 429 || response.status === 503;
        if (!retryable || attempt === retries) {
            throw new Error(data.error?.message || `API Error ${response.status}`);
        }

        const waitMs = 500 * Math.pow(2, attempt); // 500ms, 1s, 2s...
        await new Promise(res => setTimeout(res, waitMs));
    }
}

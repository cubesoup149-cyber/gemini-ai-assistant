// netlify/functions/ask.js
global.rateLimitStore = global.rateLimitStore || {};

exports.handler = async (event) => {
    // 1. Debug log to confirm deployment
    console.log("--- SYSTEM START: USING v1/gemini-2.0-flash ---");

    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

    const ip = event.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();
    if (global.rateLimitStore[ip] && now - global.rateLimitStore[ip] < 1000) {
        return { statusCode: 429, body: "Rate limit exceeded. Slow down." };
    }
    global.rateLimitStore[ip] = now;

    try {
        const { prompt } = JSON.parse(event.body);
        const API_KEY = process.env.GEMINI_API_KEY;

        if (!prompt) return { statusCode: 400, body: "Prompt cannot be empty." };
        if (!API_KEY) return { statusCode: 500, body: "Server configuration error: API Key missing." };

        // 2. Updated to v1 and gemini-2.0-flash for max stability
        const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=${API_KEY}`;

        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                systemInstruction: {
                    parts: [{ text: "You are an elite developer assistant. Provide structured, accurate, markdown-formatted answers." }]
                }
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error("--- GEMINI API ERROR LOG ---", errorText);
            return { 
                statusCode: response.status, 
                body: `Gemini API Error: ${errorText}` 
            };
        }

        const encoder = new TextEncoder();
        const decoder = new TextDecoder();

        const stream = new ReadableStream({
            async start(controller) {
                const reader = response.body.getReader();
                let buffer = "";

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop();

                    for (const line of lines) {
                        if (line.startsWith("data: ")) {
                            try {
                                const json = JSON.parse(line.substring(6));
                                const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
                                if (text) controller.enqueue(encoder.encode(text));
                            } catch (e) { /* skip malformed JSON lines */ }
                        }
                    }
                }
                controller.close();
            }
        });

        return {
            statusCode: 200,
            headers: {
                "Content-Type": "text/plain; charset=utf-8",
                "Transfer-Encoding": "chunked"
            },
            body: stream
        };

    } catch (err) {
        console.error("Critical Function Failure:", err.message);
        return { statusCode: 500, body: `Server Crash: ${err.message}` };
    }
};

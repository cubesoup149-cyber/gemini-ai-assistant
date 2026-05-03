// netlify/functions/ask.js
global.rateLimitStore = global.rateLimitStore || {};

exports.handler = async (event) => {
    console.log("--- SYSTEM RECOVERY: SWITCHED TO STABLE 1.5 FLASH ---");

    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

    const ip = event.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();
    if (global.rateLimitStore[ip] && now - global.rateLimitStore[ip] < 1000) {
        return { statusCode: 429, body: "Slow down! Rate limit active." };
    }
    global.rateLimitStore[ip] = now;

    try {
        const { prompt } = JSON.parse(event.body);
        const API_KEY = process.env.GEMINI_API_KEY;

        if (!prompt) return { statusCode: 400, body: "Prompt is empty." };
        if (!API_KEY) return { statusCode: 500, body: "API Key missing in Netlify settings." };

        // SWITCHED: Using v1beta and gemini-1.5-flash for maximum free-tier availability
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?alt=sse&key=${API_KEY}`;

        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{
                    role: "user",
                    parts: [{
                        text: `Context: You are a smart AI assistant. Give clear, structured answers using markdown. Use short paragraphs and code blocks where helpful.\n\nUser Question: ${prompt}`
                    }]
                }]
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error("--- API ERROR ---", errorText);
            return { statusCode: response.status, body: `API Error: ${errorText}` };
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
                            } catch (e) { /* ignore partial JSON */ }
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
        console.error("Critical Failure:", err.message);
        return { statusCode: 500, body: `Server Crash: ${err.message}` };
    }
};

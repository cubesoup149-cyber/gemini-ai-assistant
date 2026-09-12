// netlify/functions/ask.js
exports.handler = async (event) => {
    // 1. Basic Setup
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

    try {
        const { prompt, history } = JSON.parse(event.body);
        const API_KEY = process.env.GEMINI_API_KEY;

        if (!prompt) return { statusCode: 400, body: "Prompt is empty." };
        if (!API_KEY) return { statusCode: 500, body: "API Key missing in Netlify." };

        // Using v1beta so systemInstruction (Valate's persona) is supported.
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`;

        // 2. Build the multi-turn conversation Gemini expects.
        // Gemini uses role: "user" / "model" to tell the two speakers apart —
        // that's what lets it understand "make another one", "shorter", "continue", etc.
        const MAX_HISTORY_MESSAGES = 20;   // ~10 turns of back-and-forth
        const MAX_CHARS_PER_MESSAGE = 3000; // stops one giant message from blowing up context size

        const contents = [];

        if (Array.isArray(history)) {
            const recentHistory = history.slice(-MAX_HISTORY_MESSAGES);
            for (const msg of recentHistory) {
                if (!msg || typeof msg.text !== "string" || !msg.text.trim()) continue;
                const role = msg.role === 'user' ? 'user' : 'model'; // 'ai' -> Gemini's 'model'
                const text = msg.text.slice(0, MAX_CHARS_PER_MESSAGE);
                contents.push({ role, parts: [{ text }] });
            }
        }

        // The newest message always goes last.
        contents.push({ role: 'user', parts: [{ text: prompt }] });

        // 3. Call Gemini with history + persona
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                systemInstruction: {
                    parts: [{
                        text: "You are Valate, a helpful AI assistant. Pay close attention to the earlier turns of this conversation so you correctly understand follow-up or continuation requests such as 'make another one', 'make it shorter', 'change the ending', 'do the same but for X', 'continue', or 'what about the second one'. Answer in clean Markdown."
                    }]
                },
                contents
            })
        });

        const data = await response.json();

        // 4. Check for API Errors (like Quota or Key issues)
        if (!response.ok) {
            console.error("Gemini API Error:", data);
            return {
                statusCode: response.status,
                body: JSON.stringify({ error: data.error?.message || "API Error" })
            };
        }

        // 5. Extract the text
        const aiResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || "No response from AI.";

        // 6. Return a STRING, not an object.
        return {
            statusCode: 200,
            headers: { "Content-Type": "text/plain" },
            body: aiResponse
        };

    } catch (err) {
        console.error("System Crash:", err.message);
        return {
            statusCode: 500,
            body: "System Error: " + err.message
        };
    }
};

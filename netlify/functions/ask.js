// netlify/functions/ask.js
exports.handler = async (event) => {
    // 1. Basic Setup
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
    
    try {
        const { prompt } = JSON.parse(event.body);
        const API_KEY = process.env.GEMINI_API_KEY;

        if (!prompt) return { statusCode: 400, body: "Prompt is empty." };
        if (!API_KEY) return { statusCode: 500, body: "API Key missing in Netlify." };

        // 2. Use the 2026 Stable Model (Gemini 2.5 Flash)
        // Note: 1.5 is retired, and 2.0 is in maintenance. 2.5 is the current workhorse.
        const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${API_KEY}`;

        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{
                    parts: [{
                        text: `You are a helpful AI. Answer in clean Markdown.\n\nUser: ${prompt}`
                    }]
                }]
            })
        });

        const data = await response.json();

        // 3. Check for API Errors (like Quota or Key issues)
        if (!response.ok) {
            console.error("Gemini API Error:", data);
            return { 
                statusCode: response.status, 
                body: JSON.stringify({ error: data.error?.message || "API Error" }) 
            };
        }

        // 4. Extract the text
        const aiResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || "No response from AI.";

        // 5. THE FIX: Return a STRING, not an object.
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

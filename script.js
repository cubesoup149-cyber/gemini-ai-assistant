const chatForm = document.getElementById('chat-form');
const userInput = document.getElementById('user-input');
const messagesContainer = document.getElementById('messages');
const typingIndicator = document.getElementById('typing-indicator');
const sendBtn = document.getElementById('send-btn');

let isLoading = false;

// 1. Markdown & Highlighting Config
marked.setOptions({
    highlight: function(code, lang) {
        if (lang && hljs.getLanguage(lang)) {
            return hljs.highlight(code, { language: lang }).value;
        }
        return hljs.highlightAuto(code).value;
    },
    breaks: true,
    gfm: true
});

// 2. Textarea Auto-resize
userInput.addEventListener("input", function() {
    this.style.height = "auto";
    this.style.height = this.scrollHeight + "px";
});

function scrollToBottom() {
    const container = document.getElementById('chat-container');
    container.scrollTop = container.scrollHeight;
}

// 3. Submit Handler with Stream Reader
chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const prompt = userInput.value.trim();
    if (!prompt || isLoading) return;

    // Lock UI State
    isLoading = true;
    sendBtn.disabled = true;
    userInput.value = '';
    userInput.style.height = "auto";

    // User Bubble
    const userDiv = document.createElement('div');
    userDiv.className = 'message user-bubble';
    userDiv.textContent = prompt;
    messagesContainer.appendChild(userDiv);
    scrollToBottom();

    typingIndicator.classList.remove('hidden');

    // AI Bubble Placeholder
    const aiDiv = document.createElement('div');
    aiDiv.className = 'message ai-bubble';
    messagesContainer.appendChild(aiDiv);

    try {
        const response = await fetch('/.netlify/functions/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt })
        });

        // Handle errors before attempting to read stream
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(errorText || 'Request failed');
        }

        // --- TRUE STREAMING LOGIC ---
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = "";

        typingIndicator.classList.add('hidden'); // Hide loader as soon as data starts

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            fullText += chunk;

            // Render Markdown & Dynamic Highlighting
            aiDiv.innerHTML = marked.parse(fullText);
            aiDiv.querySelectorAll('pre code').forEach((block) => {
                hljs.highlightElement(block);
            });

            scrollToBottom();
        }

        // Final Copy Button
        const copyBtn = document.createElement("button");
        copyBtn.textContent = "Copy Output";
        copyBtn.classList.add("copy-btn");
        copyBtn.onclick = () => {
            navigator.clipboard.writeText(fullText);
            copyBtn.textContent = "Copied!";
            setTimeout(() => copyBtn.textContent = "Copy Output", 2000);
        };
        aiDiv.appendChild(copyBtn);

    } catch (error) {
        typingIndicator.classList.add('hidden');
        aiDiv.innerHTML = `<span style="color: #ef4444;"><b>System Error:</b> ${error.message}</span>`;
    } finally {
        isLoading = false;
        sendBtn.disabled = false;
        userInput.focus();
    }
});

// Shift + Enter Handling
userInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        chatForm.dispatchEvent(new Event("submit"));
    }
});
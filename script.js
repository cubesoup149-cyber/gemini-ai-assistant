const DEFAULT_MODEL = 'gemini'; // 'gemini' | 'claude'
const MAX_HISTORY_MESSAGES = 20; // ~10 back-and-forth turns — keeps context relevant + cheap

let state = {
    chats: JSON.parse(localStorage.getItem('VALATEA_CHATS')) || [],
    activeChatId: null,
    isTempMode: false,
    isGenerating: false,
    tempMessages: [],       // in-memory only conversation history for Temporary Chat
    tempModel: DEFAULT_MODEL, // in-memory only model choice for Temporary Chat
    pendingModel: DEFAULT_MODEL // model chosen before a new (not-yet-saved) chat has its first message
};

window.addEventListener('load', () => {
    setTimeout(() => {
        const splash = document.getElementById('splash-screen');
        const app = document.getElementById('main-app');
        if (splash) splash.style.opacity = '0';
        setTimeout(() => {
            if (splash) splash.style.display = 'none';
            if (app) app.classList.add('visible');
        }, 500);
    }, 1200);
});

const chatContainer = document.getElementById('chat-container');
const userInput = document.getElementById('user-input');

function typeWriter(text, element, callback) {
    let i = 0;
    const speed = 4; // Faster typing for better UX
    function step() {
        if (i <= text.length) {
            element.innerHTML = marked.parse(text.slice(0, i));
            chatContainer.scrollTop = chatContainer.scrollHeight;
            element.querySelectorAll('pre code').forEach(el => {
                if (!el.dataset.highlighted) { hljs.highlightElement(el); el.dataset.highlighted = 'true'; }
            });
            i += speed;
            requestAnimationFrame(step);
        } else {
            element.innerHTML = marked.parse(text);
            if (callback) callback();
        }
    }
    requestAnimationFrame(step);
}

function getActiveChat() {
    return state.chats.find(c => c.id === state.activeChatId);
}

// --- Model selection (per chat, persisted; per-temp-session, in-memory only) ---

function getActiveModel() {
    if (state.isTempMode) return state.tempModel || DEFAULT_MODEL;
    const chat = getActiveChat();
    if (chat && chat.model) return chat.model;
    return state.pendingModel || DEFAULT_MODEL;
}

function setActiveModel(model) {
    if (model !== 'gemini' && model !== 'claude') return;

    if (state.isTempMode) {
        state.tempModel = model;
    } else {
        const chat = getActiveChat();
        if (chat) {
            chat.model = model;
            localStorage.setItem('VALATEA_CHATS', JSON.stringify(state.chats));
        } else {
            state.pendingModel = model;
        }
    }
    updateModelMenuUI();
}

function updateModelMenuUI() {
    const model = getActiveModel();
    const geminiBtn = document.getElementById('model-gemini-btn');
    const claudeBtn = document.getElementById('model-claude-btn');
    if (geminiBtn) geminiBtn.classList.toggle('active-model', model === 'gemini');
    if (claudeBtn) claudeBtn.classList.toggle('active-model', model === 'claude');
}

// --- Conversation history helpers ---

function getHistoryForRequest() {
    const messages = state.isTempMode
        ? state.tempMessages
        : (getActiveChat()?.messages || []);
    return messages.slice(-MAX_HISTORY_MESSAGES);
}

function recordExchange(userText, aiText, modelUsed) {
    if (state.isTempMode) {
        state.tempMessages.push({ role: 'user', text: userText }, { role: 'ai', text: aiText });
        return;
    }
    if (!state.activeChatId) {
        state.activeChatId = 'chat_' + Date.now();
        state.chats.unshift({
            id: state.activeChatId,
            title: userText.substring(0, 25),
            messages: [],
            model: modelUsed || state.pendingModel || DEFAULT_MODEL,
            timestamp: Date.now()
        });
    }
    const chat = getActiveChat();
    if (!chat.model) chat.model = modelUsed || DEFAULT_MODEL; // backfill for chats saved before this feature
    chat.messages.push({ role: 'user', text: userText }, { role: 'ai', text: aiText });
    localStorage.setItem('VALATEA_CHATS', JSON.stringify(state.chats));
    renderSidebar();
}

async function handleSendMessage() {
    const text = userInput.value.trim();
    if (!text || state.isGenerating) return;

    state.isGenerating = true;
    userInput.value = '';
    userInput.style.height = 'auto';

    // Snapshot history + model BEFORE adding this new message.
    const history = getHistoryForRequest();
    const model = getActiveModel();

    addMessage(text, 'user');
    const typingDiv = showTyping();

    try {
        const response = await fetch('/.netlify/functions/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: text, history, model })
        });

        const aiText = await response.text();
        typingDiv.remove();

        if (!response.ok) {
            // Show the backend's error text but keep the conversation intact
            // so a failed model switch / API hiccup doesn't lose context.
            addMessage(aiText || "Something went wrong. Please try again.", 'ai');
            state.isGenerating = false;
            return;
        }

        const aiDiv = addMessage('', 'ai');
        const contentDiv = aiDiv.querySelector('.content');

        typeWriter(aiText, contentDiv, () => {
            state.isGenerating = false;
            recordExchange(text, aiText, model);
        });
    } catch (err) {
        if (typingDiv) typingDiv.remove();
        addMessage("Connection error. Try again.", 'ai');
        state.isGenerating = false;
    }
}

function addMessage(text, role) {
    const div = document.createElement('div');
    div.className = `msg ${role}-msg`;
    div.innerHTML = `<div class="content">${role === 'ai' && text ? marked.parse(text) : text}</div>`;
    chatContainer.appendChild(div);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    return div;
}

function showTyping() {
    const div = document.createElement('div');
    div.className = 'msg ai-msg';
    div.innerHTML = `<div class="content"><div class="typing-dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div></div>`;
    chatContainer.appendChild(div);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    return div;
}

function updateUI() {
    chatContainer.innerHTML = '';
    if (state.isTempMode) {
        addSystemNotice("This chat won't appear in your chat history and won't be used to train our models. For safety reasons, we may keep a copy of this chat for up to 30 days.");
    } else {
        const chat = getActiveChat();
        if (chat) chat.messages.forEach(m => addMessage(m.text, m.role === 'user' ? 'user' : 'ai'));
        else addSystemNotice("How can I help you today?");
    }
    renderSidebar();
    updateModelMenuUI();
}

function addSystemNotice(text) {
    const div = document.createElement('div');
    div.className = 'system-msg';
    div.innerText = text;
    chatContainer.appendChild(div);
}

function renderSidebar() {
    const list = document.getElementById('chat-list');
    list.innerHTML = '';
    state.chats.forEach(chat => {
        const item = document.createElement('div');
        item.className = `chat-item ${chat.id === state.activeChatId ? 'active' : ''}`;
        item.innerText = chat.title;
        item.onclick = () => {
            if (state.isGenerating) return;
            state.activeChatId = chat.id;
            state.isTempMode = false;
            state.tempMessages = [];
            updateUI();
            toggleSidebar();
        };
        list.appendChild(item);
    });
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('mobile-overlay').classList.toggle('active');
}

document.getElementById('menu-toggle').onclick = toggleSidebar;
document.getElementById('mobile-overlay').onclick = toggleSidebar;
document.getElementById('dots-btn').onclick = (e) => {
    e.stopPropagation();
    updateModelMenuUI();
    document.getElementById('context-menu').classList.toggle('show');
};
document.addEventListener('click', () => document.getElementById('context-menu').classList.remove('show'));

document.getElementById('sidebar-new-chat').onclick = () => {
    if (state.isGenerating) return;
    state.isTempMode = false;
    state.activeChatId = null;
    state.tempMessages = [];
    state.pendingModel = DEFAULT_MODEL;
    updateUI();
    toggleSidebar();
};

document.getElementById('menu-new-chat').onclick = () => {
    if (state.isGenerating) return;
    state.isTempMode = false;
    state.activeChatId = null;
    state.tempMessages = [];
    state.pendingModel = DEFAULT_MODEL;
    updateUI();
};

document.getElementById('temp-toggle-btn').onclick = () => {
    if (state.isGenerating) return;
    state.isTempMode = !state.isTempMode;
    state.activeChatId = null;
    state.tempMessages = [];
    state.tempModel = DEFAULT_MODEL; // always start Temporary Chat's memory + model fresh
    updateUI();
};

document.getElementById('delete-chat-btn').onclick = () => {
    state.chats = state.chats.filter(c => c.id !== state.activeChatId);
    state.activeChatId = null;
    localStorage.setItem('VALATEA_CHATS', JSON.stringify(state.chats));
    updateUI();
};

document.getElementById('model-gemini-btn').onclick = () => {
    setActiveModel('gemini');
    document.getElementById('context-menu').classList.remove('show');
};

document.getElementById('model-claude-btn').onclick = () => {
    setActiveModel('claude');
    document.getElementById('context-menu').classList.remove('show');
};

document.getElementById('send-btn').onclick = handleSendMessage;
userInput.oninput = function() { this.style.height = 'auto'; this.style.height = this.scrollHeight + 'px'; };
userInput.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } };

updateUI();

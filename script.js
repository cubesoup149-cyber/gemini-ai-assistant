let state = {
    chats: JSON.parse(localStorage.getItem('VALATEA_CHATS')) || [],
    activeChatId: null,
    isTempMode: false,
    swipeStart: null,
    pendingChat: { title: 'New Chat', messages: [] }
};

function runStartup() {
    const splash = document.getElementById('splash-screen');
    const app = document.getElementById('main-app');
    setTimeout(() => {
        splash.style.opacity = '0';
        splash.style.visibility = 'hidden';
        app.classList.add('app-visible');
    }, 1500);
}

const chatContainer = document.getElementById('chat-container');
const chatList = document.getElementById('chat-list');
const sidebar = document.getElementById('sidebar');
const overlay = document.getElementById('mobile-overlay');
const userInput = document.getElementById('user-input');
const contextMenu = document.getElementById('context-menu');

function init() {
    renderSidebar();
    startNewSession();
    setupGestures();
    runStartup();
}

// ... Rest of the existing logic (startNewSession, handleSendMessage, etc.)
function startNewSession() {
    state.activeChatId = null;
    state.pendingChat = { title: 'New Chat', messages: [] };
    updateUI();
}

function handleNewChatClick() {
    state.isTempMode = false;
    startNewSession();
    closeSidebar();
    contextMenu.classList.remove('show');
}

function toggleTempMode() {
    state.isTempMode = !state.isTempMode;
    startNewSession();
    contextMenu.classList.remove('show');
}

async function handleSendMessage() {
    const text = userInput.value.trim();
    if (!text) return;

    addMessageToUI(text, 'user');
    userInput.value = '';
    userInput.style.height = 'auto';

    if (!state.isTempMode) {
        if (!state.activeChatId) {
            const newId = 'chat_' + Date.now();
            const newChat = {
                id: newId,
                title: text.substring(0, 25),
                messages: [{ role: 'user', text }],
                timestamp: Date.now(),
                isPinned: false
            };
            state.chats.unshift(newChat);
            state.activeChatId = newId;
        } else {
            const chat = state.chats.find(c => c.id === state.activeChatId);
            if (chat) chat.messages.push({ role: 'user', text });
        }
    } else {
        state.pendingChat.messages.push({ role: 'user', text });
    }

    try {
        const response = await fetch('/.netlify/functions/ask', {
            method: 'POST',
            body: JSON.stringify({ prompt: text })
        });
        const aiText = await response.text();
        addMessageToUI(aiText, 'ai');

        if (!state.isTempMode) {
            const chat = state.chats.find(c => c.id === state.activeChatId);
            if (chat) { chat.messages.push({ role: 'ai', text: aiText }); save(); renderSidebar(); }
        } else {
            state.pendingChat.messages.push({ role: 'ai', text: aiText });
        }
    } catch (e) {
        addMessageToUI("Service error.", 'ai');
    }
}

function updateUI() {
    clearChatUI();
    if (state.isTempMode) {
        addSystemNoticeToUI("This chat won't appear in your chat history and won't be used to train our models. For safety reasons, we may keep a copy of this chat for up to 30 days.");
        state.pendingChat.messages.forEach(m => addMessageToUI(m.text, m.role === 'user' ? 'user' : 'ai'));
    } else {
        const chat = state.chats.find(c => c.id === state.activeChatId);
        if (chat) chat.messages.forEach(m => addMessageToUI(m.text, m.role === 'user' ? 'user' : 'ai'));
    }
    document.getElementById('temp-toggle-btn').innerText = state.isTempMode ? "Exit Temporary Chat" : "Temporary Chat";
    renderSidebar();
}

function addSystemNoticeToUI(text) {
    const noticeDiv = document.createElement('div');
    noticeDiv.className = 'system-msg';
    noticeDiv.innerHTML = `<div class="notice-content">${text}</div>`;
    chatContainer.appendChild(noticeDiv);
}

function addMessageToUI(text, role) {
    const div = document.createElement('div');
    div.className = `msg ${role}-msg`;
    const content = role === 'ai' ? marked.parse(text) : text;
    div.innerHTML = `<div class="content">${content}</div>`;
    chatContainer.appendChild(div);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    div.querySelectorAll('pre code').forEach(el => hljs.highlightElement(el));
}

function renderSidebar() {
    chatList.innerHTML = '';
    state.chats.filter(c => c.messages.length > 0)
               .sort((a,b) => b.isPinned - a.isPinned || b.timestamp - a.timestamp)
               .forEach(chat => {
        const item = document.createElement('div');
        item.className = `chat-item ${chat.id === state.activeChatId ? 'active' : ''}`;
        item.innerText = chat.title;
        item.onclick = () => { state.activeChatId = chat.id; state.isTempMode = false; updateUI(); closeSidebar(); };
        chatList.appendChild(item);
    });
}

function save() { localStorage.setItem('VALATEA_CHATS', JSON.stringify(state.chats)); }
function clearChatUI() { chatContainer.innerHTML = ''; }
function openSidebar() { sidebar.classList.add('open'); overlay.classList.add('active'); }
function closeSidebar() { sidebar.classList.remove('open'); overlay.classList.remove('active'); }

function deleteCurrentChat() {
    state.chats = state.chats.filter(c => c.id !== state.activeChatId);
    save();
    startNewSession();
}

function renameCurrentChat() {
    const chat = state.chats.find(c => c.id === state.activeChatId);
    const n = prompt("New title:", chat ? chat.title : "");
    if (chat && n) { chat.title = n; save(); renderSidebar(); }
}

function togglePinCurrentChat() {
    const chat = state.chats.find(c => c.id === state.activeChatId);
    if (chat) { chat.isPinned = !chat.isPinned; save(); renderSidebar(); }
}

function shareCurrentChat() {
    const chat = state.chats.find(c => c.id === state.activeChatId);
    if (!chat) return;
    const shareUrl = `${window.location.origin}?share=${btoa(JSON.stringify(chat))}`;
    navigator.clipboard.writeText(shareUrl);
    alert("Shareable link copied to clipboard!");
}

function setupGestures() {
    document.addEventListener('touchstart', e => state.swipeStart = e.touches[0].clientX);
    document.addEventListener('touchend', e => {
        if (!state.swipeStart) return;
        const diff = e.changedTouches[0].clientX - state.swipeStart;
        if (diff > 80) openSidebar();
        if (diff < -80) closeSidebar();
        state.swipeStart = null;
    });
}

document.getElementById('menu-toggle').onclick = openSidebar;
overlay.onclick = closeSidebar;
document.getElementById('dots-btn').onclick = (e) => { e.stopPropagation(); contextMenu.classList.toggle('show'); };
document.addEventListener('click', () => contextMenu.classList.remove('show'));
document.getElementById('sidebar-new-chat').onclick = handleNewChatClick;
document.getElementById('send-btn').onclick = handleSendMessage;
userInput.oninput = function() { this.style.height = 'auto'; this.style.height = this.scrollHeight + 'px'; };
userInput.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } };

init();

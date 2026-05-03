let state = {
    chats: JSON.parse(localStorage.getItem('VALATEA_CHATS')) || [],
    activeChatId: null,
    isTempMode: false,
    isGenerating: false
};

// 1. Splash Logic
window.addEventListener('load', () => {
    setTimeout(() => {
        const splash = document.getElementById('splash-screen');
        const app = document.getElementById('main-app');
        if (splash) {
            splash.style.opacity = '0';
            setTimeout(() => {
                splash.style.display = 'none';
                if (app) app.classList.add('visible');
            }, 500);
        }
    }, 1200);
});

const chatContainer = document.getElementById('chat-container');
const userInput = document.getElementById('user-input');

// 2. Messaging Engine
async function handleSendMessage() {
    const text = userInput.value.trim();
    if (!text || state.isGenerating) return;

    state.isGenerating = true;
    userInput.value = '';
    userInput.style.height = 'auto';
    
    addMessage(text, 'user');
    const aiDiv = addMessage('', 'ai');
    const contentDiv = aiDiv.querySelector('.content');

    try {
        const response = await fetch('/.netlify/functions/ask', {
            method: 'POST',
            body: JSON.stringify({ prompt: text })
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const json = JSON.parse(line.replace('data: ', ''));
                        fullText += json.candidates[0].content.parts[0].text;
                        contentDiv.innerHTML = marked.parse(fullText);
                        contentDiv.querySelectorAll('pre code').forEach(el => hljs.highlightElement(el));
                        chatContainer.scrollTop = chatContainer.scrollHeight;
                    } catch(e) {}
                }
            }
        }

        if (!state.isTempMode) {
            if (!state.activeChatId) {
                state.activeChatId = 'chat_' + Date.now();
                state.chats.unshift({ id: state.activeChatId, title: text.substring(0,25), messages: [], timestamp: Date.now() });
            }
            const chat = state.chats.find(c => c.id === state.activeChatId);
            chat.messages.push({ role: 'user', text }, { role: 'ai', text: fullText });
            localStorage.setItem('VALATEA_CHATS', JSON.stringify(state.chats));
            renderSidebar();
        }
    } catch (err) {
        contentDiv.innerText = "Connection lost.";
    } finally {
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

function updateUI() {
    chatContainer.innerHTML = '';
    if (state.isTempMode) {
        addSystemNotice("Temporary Chat: History not saved.");
    } else {
        const chat = state.chats.find(c => c.id === state.activeChatId);
        if (chat) chat.messages.forEach(m => addMessage(m.text, m.role === 'user' ? 'user' : 'ai'));
        else addSystemNotice("How can I help you today?");
    }
    renderSidebar();
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
        item.onclick = () => { state.activeChatId = chat.id; state.isTempMode = false; updateUI(); toggleSidebar(); };
        list.appendChild(item);
    });
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('mobile-overlay').classList.toggle('active');
}

// Listeners
document.getElementById('menu-toggle').onclick = toggleSidebar;
document.getElementById('mobile-overlay').onclick = toggleSidebar;
document.getElementById('dots-btn').onclick = (e) => { e.stopPropagation(); document.getElementById('context-menu').classList.toggle('show'); };
document.addEventListener('click', () => document.getElementById('context-menu').classList.remove('show'));

document.getElementById('sidebar-new-chat').onclick = () => { state.isTempMode = false; state.activeChatId = null; updateUI(); toggleSidebar(); };
document.getElementById('menu-new-chat').onclick = () => { state.isTempMode = false; state.activeChatId = null; updateUI(); };
document.getElementById('temp-toggle-btn').onclick = () => { state.isTempMode = !state.isTempMode; state.activeChatId = null; updateUI(); };
document.getElementById('delete-chat-btn').onclick = () => { state.chats = state.chats.filter(c => c.id !== state.activeChatId); state.activeChatId = null; localStorage.setItem('VALATEA_CHATS', JSON.stringify(state.chats)); updateUI(); };

document.getElementById('send-btn').onclick = handleSendMessage;
userInput.oninput = function() { this.style.height = 'auto'; this.style.height = this.scrollHeight + 'px'; };
userInput.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } };

updateUI();
    

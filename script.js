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
        if (splash) splash.style.opacity = '0';
        setTimeout(() => {
            if (splash) splash.style.display = 'none';
            if (app) app.classList.add('visible');
        }, 500);
    }, 1200);
});

const chatContainer = document.getElementById('chat-container');
const userInput = document.getElementById('user-input');

// 2. Typewriter Effect
function typeWriter(text, element, callback) {
    let i = 0;
    const speed = 3; // Characters per frame
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

// 3. Messaging
async function handleSendMessage() {
    const text = userInput.value.trim();
    if (!text || state.isGenerating) return;

    state.isGenerating = true;
    userInput.value = '';
    userInput.style.height = 'auto';
    
    addMessage(text, 'user');
    const typingDiv = showTyping();

    try {
        const response = await fetch('/.netlify/functions/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: text })
        });
        const aiText = await response.text();
        typingDiv.remove();

        const aiDiv = addMessage('', 'ai');
        const contentDiv = aiDiv.querySelector('.content');
        
        typeWriter(aiText, contentDiv, () => {
            state.isGenerating = false;
            if (!state.isTempMode) {
                if (!state.activeChatId) {
                    state.activeChatId = 'chat_' + Date.now();
                    state.chats.unshift({ id: state.activeChatId, title: text.substring(0,25), messages: [], timestamp: Date.now() });
                }
                const chat = state.chats.find(c => c.id === state.activeChatId);
                chat.messages.push({ role: 'user', text }, { role: 'ai', text: aiText });
                localStorage.setItem('VALATEA_CHATS', JSON.stringify(state.chats));
                renderSidebar();
            }
        });
    } catch (err) {
        if(typingDiv) typingDiv.remove();
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
    div.innerHTML = `<div class="typing-dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>`;
    chatContainer.appendChild(div);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    return div;
}

function updateUI() {
    chatContainer.innerHTML = '';
    if (state.isTempMode) {
        addSystemNotice("This chat won't appear in your chat history and won't be used to train our models. For safety reasons, we may keep a copy of this chat for up to 30 days.");
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
        item.onclick = () => { if(state.isGenerating) return; state.activeChatId = chat.id; state.isTempMode = false; updateUI(); toggleSidebar(); };
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
document.getElementById('sidebar-new-chat').onclick = () => { if(state.isGenerating) return; state.isTempMode = false; state.activeChatId = null; updateUI(); toggleSidebar(); };
document.getElementById('menu-new-chat').onclick = () => { if(state.isGenerating) return; state.isTempMode = false; state.activeChatId = null; updateUI(); };
document.getElementById('temp-toggle-btn').onclick = () => { if(state.isGenerating) return; state.isTempMode = !state.isTempMode; state.activeChatId = null; updateUI(); };
document.getElementById('delete-chat-btn').onclick = () => { state.chats = state.chats.filter(c => c.id !== state.activeChatId); state.activeChatId = null; localStorage.setItem('VALATEA_CHATS', JSON.stringify(state.chats)); updateUI(); };
document.getElementById('send-btn').onclick = handleSendMessage;
userInput.oninput = function() { this.style.height = 'auto'; this.style.height = this.scrollHeight + 'px'; };
userInput.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } };

updateUI();

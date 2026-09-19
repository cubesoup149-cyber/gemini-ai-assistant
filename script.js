import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
    getAuth, onAuthStateChanged, signInWithEmailAndPassword,
    createUserWithEmailAndPassword, GoogleAuthProvider, signInWithPopup, signOut
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
    getFirestore, collection, doc, setDoc, addDoc, deleteDoc, getDocs, query, orderBy
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyDOwrUbMzQ1vNmzLRrN-JcYUgmYKJWtuLs",
    authDomain: "valate-df5da.firebaseapp.com",
    projectId: "valate-df5da",
    storageBucket: "valate-df5da.firebasestorage.app",
    messagingSenderId: "528974725565",
    appId: "1:528974725565:web:2eaa13f69ff1480f6912d4"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

const DEFAULT_MODEL = 'gemini';
const MAX_HISTORY_MESSAGES = 20;
const REMEMBER_REGEX = /^(?:please\s+)?(?:remember(?: that)?|don't forget(?: that)?|note that)[:,]?\s*(.+)/i;

// --- Settings (accent color, text size, message density) ---
const SETTINGS_KEY = 'valate_settings';
const DEFAULT_SETTINGS = { accentA: '#7c5cff', accentB: '#00d4ff', fontSize: 15, density: 'comfortable' };

function loadSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
        if (saved && typeof saved === 'object') return { ...DEFAULT_SETTINGS, ...saved };
    } catch (e) { /* ignore malformed storage */ }
    return { ...DEFAULT_SETTINGS };
}
function saveSettings(settings) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* storage unavailable */ }
}
function applySettings(settings) {
    const root = document.documentElement.style;
    root.setProperty('--accent-a', settings.accentA);
    root.setProperty('--accent-b', settings.accentB);
    root.setProperty('--msg-font-size', settings.fontSize + 'px');
    root.setProperty('--msg-gap', settings.density === 'compact' ? '0.9rem' : '1.4rem');
    document.body.classList.toggle('density-compact', settings.density === 'compact');
}
let settings = loadSettings();
applySettings(settings);

const mdRenderer = new marked.Renderer();
mdRenderer.link = function (href, title, text) {
    const safeTitle = title ? ` title="${title}"` : '';
    return `<a href="${href}"${safeTitle} target="_blank" rel="noopener noreferrer">${text}</a>`;
};
marked.setOptions({ renderer: mdRenderer, gfm: true, breaks: true });

let state = {
    chats: [],
    memories: [],
    activeChatId: null,
    isTempMode: false,
    isGenerating: false,
    tempMessages: [],
    tempModel: DEFAULT_MODEL,
    pendingModel: DEFAULT_MODEL
};

let currentUser = null;
let authMode = 'signin';

const chatContainer = document.getElementById('chat-container');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');

window.addEventListener('load', () => {
    setTimeout(() => {
        const splash = document.getElementById('splash-screen');
        if (splash) {
            splash.style.opacity = '0';
            setTimeout(() => { splash.style.display = 'none'; }, 500);
        }
    }, 1200);
});

// --- Auth screen ---
function showAuthScreen() {
    document.getElementById('main-app').classList.remove('visible');
    document.getElementById('auth-screen').classList.add('show');
}
function showApp() {
    document.getElementById('auth-screen').classList.remove('show');
    document.getElementById('main-app').classList.add('visible');
}
function setAuthMode(mode) {
    authMode = mode;
    hideAuthError();
    document.getElementById('auth-title').textContent = mode === 'signup' ? 'Create your account' : 'Welcome back';
    document.getElementById('auth-submit-btn').textContent = mode === 'signup' ? 'Sign Up' : 'Sign In';
    document.getElementById('auth-toggle-text').textContent = mode === 'signup' ? 'Already have an account?' : "Don't have an account?";
    document.getElementById('auth-toggle-btn').textContent = mode === 'signup' ? 'Sign In' : 'Sign Up';
}
function showAuthError(message) {
    const el = document.getElementById('auth-error');
    el.textContent = message;
    el.classList.add('show');
}
function hideAuthError() {
    const el = document.getElementById('auth-error');
    el.classList.remove('show');
    el.textContent = '';
}
function friendlyAuthError(err) {
    const code = err.code || '';
    if (code.includes('wrong-password') || code.includes('invalid-credential')) return 'Incorrect email or password.';
    if (code.includes('user-not-found')) return 'No account found with that email.';
    if (code.includes('email-already-in-use')) return 'An account with this email already exists.';
    if (code.includes('weak-password')) return 'Password should be at least 6 characters.';
    if (code.includes('invalid-email')) return 'Please enter a valid email address.';
    if (code.includes('popup-closed-by-user')) return 'Sign-in was cancelled.';
    return 'Something went wrong. Please try again.';
}

// --- Firestore: chats ---
function chatsCollectionRef() { return collection(db, 'users', currentUser.uid, 'chats'); }
async function loadUserChats() {
    try {
        const q = query(chatsCollectionRef(), orderBy('timestamp', 'desc'));
        const snap = await getDocs(q);
        state.chats = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
        console.error('Failed to load chats:', err);
        state.chats = [];
    }
}
async function saveChatToFirestore(chat) {
    if (!currentUser) return;
    try {
        await setDoc(doc(db, 'users', currentUser.uid, 'chats', chat.id), {
            title: chat.title, model: chat.model, timestamp: chat.timestamp, messages: chat.messages
        });
    } catch (err) { console.error('Failed to save chat:', err); }
}
async function deleteChatFromFirestore(chatId) {
    if (!currentUser) return;
    try { await deleteDoc(doc(db, 'users', currentUser.uid, 'chats', chatId)); }
    catch (err) { console.error('Failed to delete chat:', err); }
}

// --- Firestore: memories ---
function memoriesCollectionRef() { return collection(db, 'users', currentUser.uid, 'memories'); }
async function loadUserMemories() {
    try {
        const q = query(memoriesCollectionRef(), orderBy('timestamp', 'desc'));
        const snap = await getDocs(q);
        state.memories = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
        console.error('Failed to load memories:', err);
        state.memories = [];
    }
}
async function addMemory(text) {
    if (!currentUser || !text || !text.trim()) return;
    const trimmed = text.trim().slice(0, 500);
    try {
        const docRef = await addDoc(memoriesCollectionRef(), { text: trimmed, timestamp: Date.now() });
        state.memories.unshift({ id: docRef.id, text: trimmed, timestamp: Date.now() });
        renderMemoryList();
    } catch (err) { console.error('Failed to add memory:', err); }
}
async function removeMemory(id) {
    try {
        await deleteDoc(doc(db, 'users', currentUser.uid, 'memories', id));
        state.memories = state.memories.filter(m => m.id !== id);
        renderMemoryList();
    } catch (err) { console.error('Failed to delete memory:', err); }
}
function renderMemoryList() {
    const list = document.getElementById('memory-list');
    const empty = document.getElementById('memory-empty');
    list.innerHTML = '';
    if (state.memories.length === 0) {
        empty.style.display = 'block';
        return;
    }
    empty.style.display = 'none';
    state.memories.forEach(mem => {
        const li = document.createElement('li');
        const span = document.createElement('span');
        span.className = 'mem-text';
        span.textContent = mem.text;
        const btn = document.createElement('button');
        btn.textContent = 'Remove';
        btn.onclick = () => removeMemory(mem.id);
        li.appendChild(span);
        li.appendChild(btn);
        list.appendChild(li);
    });
}
function showUserSettingsModal(tab) {
    renderMemoryList();
    refreshSettingsUI();
    if (tab) setSettingsTab(tab);
    document.getElementById('usersettings-modal').classList.add('show');
}
function hideUserSettingsModal() { document.getElementById('usersettings-modal').classList.remove('show'); }
function setSettingsTab(tab) {
    document.querySelectorAll('.settings-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.settings-tab-panel').forEach(panel => {
        panel.hidden = panel.dataset.panel !== tab;
    });
}
function showMemoryToast() {
    const toast = document.createElement('div');
    toast.className = 'memory-toast';
    toast.textContent = 'Saved to memory';
    chatContainer.appendChild(toast);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    setTimeout(() => toast.remove(), 2500);
}

// --- Auth state ---
onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (user) {
        document.getElementById('user-email-display').textContent = user.email || user.displayName || 'Signed in';
        await Promise.all([loadUserChats(), loadUserMemories()]);
        state.activeChatId = null;
        state.isTempMode = false;
        state.tempMessages = [];
        updateUI();
        showApp();
    } else {
        state.chats = [];
        state.memories = [];
        state.activeChatId = null;
        state.isTempMode = false;
        state.tempMessages = [];
        document.getElementById('user-email-display').textContent = '';
        chatContainer.innerHTML = '';
        renderSidebar();
        showAuthScreen();
    }
});

// --- Copy buttons on code blocks ---
function enhanceCodeBlocks(container) {
    container.querySelectorAll('pre').forEach(pre => {
        if (pre.querySelector('.copy-btn')) return;
        const codeEl = pre.querySelector('code');
        if (!codeEl) return;
        const btn = document.createElement('button');
        btn.className = 'copy-btn';
        btn.textContent = 'Copy';
        btn.onclick = () => {
            navigator.clipboard.writeText(codeEl.innerText).then(() => {
                btn.textContent = 'Copied!';
                setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
            });
        };
        pre.appendChild(btn);
    });
}

// --- Typewriter ---
function typeWriter(text, element, callback) {
    let i = 0;
    const speed = 4;
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
            element.querySelectorAll('pre code').forEach(el => {
                if (!el.dataset.highlighted) { hljs.highlightElement(el); el.dataset.highlighted = 'true'; }
            });
            enhanceCodeBlocks(element);
            if (callback) callback();
        }
    }
    requestAnimationFrame(step);
}

function getActiveChat() { return state.chats.find(c => c.id === state.activeChatId); }

// --- Model selection ---
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
        if (chat) { chat.model = model; saveChatToFirestore(chat); }
        else { state.pendingModel = model; }
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

// --- Conversation history ---
function getHistoryForRequest() {
    const messages = state.isTempMode ? state.tempMessages : (getActiveChat()?.messages || []);
    return messages.slice(-MAX_HISTORY_MESSAGES);
}
function recordExchange(userText, aiText, modelUsed) {
    if (state.isTempMode) {
        state.tempMessages.push({ role: 'user', text: userText }, { role: 'ai', text: aiText });
        return;
    }
    const isNewChat = !state.activeChatId;
    if (isNewChat) {
        state.activeChatId = 'chat_' + Date.now();
        state.chats.unshift({
            id: state.activeChatId, title: userText.substring(0, 40), messages: [],
            model: modelUsed || state.pendingModel || DEFAULT_MODEL, timestamp: Date.now()
        });
    }
    const chat = getActiveChat();
    if (!chat.model) chat.model = modelUsed || DEFAULT_MODEL;
    chat.messages.push({ role: 'user', text: userText }, { role: 'ai', text: aiText });
    renderSidebar();
    saveChatToFirestore(chat);
    if (isNewChat) generateSmartTitle(chat, userText, aiText, chat.model);
}

// --- Context-aware chat titles (mirrors how other AI chat apps name new chats) ---
async function generateSmartTitle(chat, userText, aiText, model) {
    const placeholderTitle = chat.title;
    try {
        const response = await fetch('/.netlify/functions/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mode: 'title',
                prompt: userText,
                history: [{ role: 'ai', text: aiText.slice(0, 1000) }],
                model
            })
        });
        if (!response.ok) return;
        let title = (await response.text() || '').trim();
        title = title.replace(/^["'`\s]+|["'`\s.!?]+$/g, '').replace(/\s+/g, ' ');
        if (!title) return;
        title = title.slice(0, 50);

        // Only apply if the chat still exists and the user hasn't already renamed it
        const current = state.chats.find(c => c.id === chat.id);
        if (current && current.title === placeholderTitle) {
            current.title = title;
            renderSidebar();
            saveChatToFirestore(current);
        }
    } catch (err) {
        // Network hiccup — the placeholder title just stays as-is.
    }
}

async function handleSendMessage() {
    const text = userInput.value.trim();
    if (!text || state.isGenerating || !currentUser) return;

    state.isGenerating = true;
    sendBtn.disabled = true;
    userInput.value = '';
    userInput.style.height = 'auto';

    const history = getHistoryForRequest();
    const model = getActiveModel();
    const memoryTexts = state.memories.map(m => m.text);

    const rememberMatch = text.match(REMEMBER_REGEX);

    addMessage(text, 'user');
    const typingDiv = showTyping();

    try {
        const response = await fetch('/.netlify/functions/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: text, history, model, memory: memoryTexts })
        });

        const aiText = await response.text();
        typingDiv.remove();

        if (!response.ok) {
            addMessage(aiText || "Something went wrong. Please try again.", 'ai');
            state.isGenerating = false;
            sendBtn.disabled = false;
            return;
        }

        const aiDiv = addMessage('', 'ai');
        const contentDiv = aiDiv.querySelector('.content');

        typeWriter(aiText, contentDiv, async () => {
            state.isGenerating = false;
            sendBtn.disabled = false;
            recordExchange(text, aiText, model);
            if (rememberMatch && rememberMatch[1]) {
                await addMemory(rememberMatch[1]);
                showMemoryToast();
            }
        });
    } catch (err) {
        if (typingDiv) typingDiv.remove();
        addMessage("Connection error. Try again.", 'ai');
        state.isGenerating = false;
        sendBtn.disabled = false;
    }
}

function addMessage(text, role) {
    const div = document.createElement('div');
    div.className = `msg ${role}-msg`;
    if (role === 'ai') {
        div.innerHTML = `<div class="content">${text ? marked.parse(text) : ''}</div>`;
    } else {
        div.innerHTML = `<div class="content">${text}</div>`;
    }
    chatContainer.appendChild(div);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    if (role === 'ai' && text) {
        const content = div.querySelector('.content');
        content.querySelectorAll('pre code').forEach(el => {
            if (!el.dataset.highlighted) { hljs.highlightElement(el); el.dataset.highlighted = 'true'; }
        });
        enhanceCodeBlocks(content);
    }
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

function getChatGroupLabel(timestamp) {
    const now = new Date();
    const date = new Date(timestamp || Date.now());
    const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
    if (dayDiff <= 0) return 'Today';
    if (dayDiff === 1) return 'Yesterday';
    if (dayDiff <= 7) return 'Previous 7 Days';
    if (dayDiff <= 30) return 'Previous 30 Days';
    return 'Older';
}

async function renameChat(chat, newTitle) {
    const trimmed = newTitle.trim().slice(0, 60);
    if (!trimmed || trimmed === chat.title) return;
    chat.title = trimmed;
    renderSidebar();
    await saveChatToFirestore(chat);
}

async function deleteChatById(chatId) {
    state.chats = state.chats.filter(c => c.id !== chatId);
    if (state.activeChatId === chatId) state.activeChatId = null;
    updateUI();
    await deleteChatFromFirestore(chatId);
}

function startInlineRename(item, chat) {
    const titleEl = item.querySelector('.chat-item-title');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'chat-item-title-input';
    input.value = chat.title;
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    let finished = false;
    const finish = async (commit) => {
        if (finished) return;
        finished = true;
        if (commit) await renameChat(chat, input.value);
        else renderSidebar();
    };
    input.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    };
    input.onblur = () => finish(true);
    input.onclick = (e) => e.stopPropagation();
}

function renderSidebar() {
    const list = document.getElementById('chat-list');
    list.innerHTML = '';

    const groupOrder = ['Today', 'Yesterday', 'Previous 7 Days', 'Previous 30 Days', 'Older'];
    const groups = {};
    state.chats.forEach(chat => {
        const label = getChatGroupLabel(chat.timestamp);
        if (!groups[label]) groups[label] = [];
        groups[label].push(chat);
    });

    groupOrder.forEach(label => {
        const chatsInGroup = groups[label];
        if (!chatsInGroup || !chatsInGroup.length) return;

        const groupEl = document.createElement('div');
        groupEl.className = 'chat-group';
        const labelEl = document.createElement('div');
        labelEl.className = 'chat-group-label';
        labelEl.innerText = label;
        groupEl.appendChild(labelEl);

        chatsInGroup.forEach(chat => {
            const item = document.createElement('div');
            item.className = `chat-item ${chat.id === state.activeChatId ? 'active' : ''}`;

            const titleEl = document.createElement('span');
            titleEl.className = 'chat-item-title';
            titleEl.innerText = chat.title;

            const actions = document.createElement('div');
            actions.className = 'chat-item-actions';

            const renameBtn = document.createElement('button');
            renameBtn.className = 'chat-item-action-btn';
            renameBtn.title = 'Rename';
            renameBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
            renameBtn.onclick = (e) => { e.stopPropagation(); startInlineRename(item, chat); };

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'chat-item-action-btn delete';
            deleteBtn.title = 'Delete';
            deleteBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>';
            deleteBtn.onclick = (e) => { e.stopPropagation(); deleteChatById(chat.id); };

            actions.appendChild(renameBtn);
            actions.appendChild(deleteBtn);
            item.appendChild(titleEl);
            item.appendChild(actions);

            item.onclick = () => {
                if (state.isGenerating) return;
                state.activeChatId = chat.id;
                state.isTempMode = false;
                state.tempMessages = [];
                updateUI();
                toggleSidebar();
            };
            groupEl.appendChild(item);
        });
        list.appendChild(groupEl);
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
    state.isTempMode = false; state.activeChatId = null; state.tempMessages = []; state.pendingModel = DEFAULT_MODEL;
    updateUI(); toggleSidebar();
};
document.getElementById('menu-new-chat').onclick = () => {
    if (state.isGenerating) return;
    state.isTempMode = false; state.activeChatId = null; state.tempMessages = []; state.pendingModel = DEFAULT_MODEL;
    updateUI();
};
document.getElementById('temp-toggle-btn').onclick = () => {
    if (state.isGenerating) return;
    state.isTempMode = !state.isTempMode; state.activeChatId = null; state.tempMessages = []; state.tempModel = DEFAULT_MODEL;
    updateUI();
};
document.getElementById('delete-chat-btn').onclick = async () => {
    if (!state.activeChatId) return;
    await deleteChatById(state.activeChatId);
};
document.getElementById('model-gemini-btn').onclick = () => { setActiveModel('gemini'); document.getElementById('context-menu').classList.remove('show'); };
document.getElementById('model-claude-btn').onclick = () => { setActiveModel('claude'); document.getElementById('context-menu').classList.remove('show'); };
document.getElementById('sign-out-btn').onclick = async () => {
    if (state.isGenerating) return;
    document.getElementById('context-menu').classList.remove('show');
    try { await signOut(auth); } catch (err) { console.error('Sign out failed:', err); }
};

// --- Memory (now a tab inside User Settings) wiring ---
document.getElementById('memory-add-btn').onclick = async () => {
    const input = document.getElementById('memory-input');
    const text = input.value.trim();
    if (!text) return;
    await addMemory(text);
    input.value = '';
};
document.getElementById('memory-input').onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('memory-add-btn').click(); }
};

// --- Settings modal wiring ---
function refreshSettingsUI() {
    document.querySelectorAll('#accent-swatches .accent-swatch:not(.accent-swatch-custom)').forEach(sw => {
        sw.classList.toggle('active', sw.dataset.accentA === settings.accentA && sw.dataset.accentB === settings.accentB);
    });
    document.querySelectorAll('#fontsize-group .segmented-btn').forEach(btn => {
        btn.classList.toggle('active', Number(btn.dataset.size) === settings.fontSize);
    });
    document.querySelectorAll('#density-group .segmented-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.density === settings.density);
    });
    document.getElementById('accent-custom-input').value = settings.accentA;
}
function updateSettings(patch) {
    settings = { ...settings, ...patch };
    applySettings(settings);
    saveSettings(settings);
    refreshSettingsUI();
}
// --- User Settings modal: open points (three-dots menu, and the gear button next to the account email) ---
document.getElementById('settings-menu-btn').onclick = () => {
    document.getElementById('context-menu').classList.remove('show');
    showUserSettingsModal('general');
};
document.getElementById('account-settings-btn').onclick = () => {
    showUserSettingsModal('general');
};
document.getElementById('usersettings-close-btn').onclick = hideUserSettingsModal;
document.getElementById('usersettings-modal').onclick = (e) => { if (e.target.id === 'usersettings-modal') hideUserSettingsModal(); };
document.getElementById('settings-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.settings-tab-btn');
    if (!btn) return;
    setSettingsTab(btn.dataset.tab);
});

document.getElementById('accent-swatches').addEventListener('click', (e) => {
    const swatch = e.target.closest('.accent-swatch:not(.accent-swatch-custom)');
    if (!swatch) return;
    updateSettings({ accentA: swatch.dataset.accentA, accentB: swatch.dataset.accentB });
});
document.getElementById('accent-custom-input').addEventListener('input', (e) => {
    updateSettings({ accentA: e.target.value, accentB: e.target.value });
});
document.getElementById('fontsize-group').addEventListener('click', (e) => {
    const btn = e.target.closest('.segmented-btn');
    if (!btn) return;
    updateSettings({ fontSize: Number(btn.dataset.size) });
});
document.getElementById('density-group').addEventListener('click', (e) => {
    const btn = e.target.closest('.segmented-btn');
    if (!btn) return;
    updateSettings({ density: btn.dataset.density });
});
document.getElementById('settings-reset-btn').onclick = () => updateSettings({ ...DEFAULT_SETTINGS });

document.getElementById('send-btn').onclick = handleSendMessage;
userInput.oninput = function() { this.style.height = 'auto'; this.style.height = this.scrollHeight + 'px'; };
userInput.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } };

// --- Auth form handlers ---
document.getElementById('auth-toggle-btn').onclick = () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin');

document.getElementById('auth-form').onsubmit = async (e) => {
    e.preventDefault();
    hideAuthError();
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    if (!email || !password) return;

    const submitBtn = document.getElementById('auth-submit-btn');
    const originalLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Please wait...';

    try {
        if (authMode === 'signup') await createUserWithEmailAndPassword(auth, email, password);
        else await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
        showAuthError(friendlyAuthError(err));
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = originalLabel;
    }
};

document.getElementById('google-signin-btn').onclick = async () => {
    hideAuthError();
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch (err) { showAuthError(friendlyAuthError(err)); }
};
        

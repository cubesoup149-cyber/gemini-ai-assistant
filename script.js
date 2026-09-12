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
function showMemoryModal() {
    renderMemoryList();
    document.getElementById('memory-modal').classList.add('show');
}
function hideMemoryModal() { document.getElementById('memory-modal').classList.remove('show'); }
function showMemoryToast() {
    const toast = document.createElement('div');
    toast.className = 'memory-toast';
    toast.textContent = '🧠 Saved to memory';
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
    if (!state.activeChatId) {
        state.activeChatId = 'chat_' + Date.now();
        state.chats.unshift({
            id: state.activeChatId, title: userText.substring(0, 25), messages: [],
            model: modelUsed || state.pendingModel || DEFAULT_MODEL, timestamp: Date.now()
        });
    }
    const chat = getActiveChat();
    if (!chat.model) chat.model = modelUsed || DEFAULT_MODEL;
    chat.messages.push({ role: 'user', text: userText }, { role: 'ai', text: aiText });
    renderSidebar();
    saveChatToFirestore(chat);
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
        div.innerHTML = `<div class="msg-row"><div class="avatar ai-avatar">V</div><div class="content">${text ? marked.parse(text) : ''}</div></div>`;
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
    div.innerHTML = `<div class="msg-row"><div class="avatar ai-avatar">V</div><div class="content"><div class="typing-dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div></div></div>`;
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
function showMemoryModal() {
    renderMemoryList();
    document.getElementById('memory-modal').classList.add('show');
}
function hideMemoryModal() { document.getElementById('memory-modal').classList.remove('show'); }
function showMemoryToast() {
    const toast = document.createElement('div');
    toast.className = 'memory-toast';
    toast.textContent = '🧠 Saved to memory';
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
    if (!state.activeChatId) {
        state.activeChatId = 'chat_' + Date.now();
        state.chats.unshift({
            id: state.activeChatId, title: userText.substring(0, 25), messages: [],
            model: modelUsed || state.pendingModel || DEFAULT_MODEL, timestamp: Date.now()
        });
    }
    const chat = getActiveChat();
    if (!chat.model) chat.model = modelUsed || DEFAULT_MODEL;
    chat.messages.push({ role: 'user', text: userText }, { role: 'ai', text: aiText });
    renderSidebar();
    saveChatToFirestore(chat);
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
        div.innerHTML = `<div class="msg-row"><div class="avatar ai-avatar">V</div><div class="content">${text ? marked.parse(text) : ''}</div></div>`;
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
    div.innerHTML = `<div class="msg-row"><div class="avatar ai-avatar">V</div><div class="content"><div class="typing-dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div></div></div>`;
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
    const idToDelete = state.activeChatId;
    state.chats = state.chats.filter(c => c.id !== idToDelete);
    state.activeChatId = null;
    updateUI();
    await deleteChatFromFirestore(idToDelete);
};
document.getElementById('model-gemini-btn').onclick = () => { setActiveModel('gemini'); document.getElementById('context-menu').classList.remove('show'); };
document.getElementById('model-claude-btn').onclick = () => { setActiveModel('claude'); document.getElementById('context-menu').classList.remove('show'); };
document.getElementById('sign-out-btn').onclick = async () => {
    if (state.isGenerating) return;
    document.getElementById('context-menu').classList.remove('show');
    try { await signOut(auth); } catch (err) { console.error('Sign out failed:', err); }
};

// --- Memory modal wiring ---
document.getElementById('memory-menu-btn').onclick = () => {
    document.getElementById('context-menu').classList.remove('show');
    showMemoryModal();
};
document.getElementById('memory-close-btn').onclick = hideMemoryModal;
document.getElementById('memory-modal').onclick = (e) => { if (e.target.id === 'memory-modal') hideMemoryModal(); };
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

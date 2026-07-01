/**
 * OpenClaw Browser Extension — Popup Script
 *
 * Standalone popup page that opens when clicking extension icon in toolbar.
 * Communicates with background service worker via chrome.runtime.sendMessage.
 */

(function () {
  'use strict';

  // --- State ---
  let isSetup = false;
  let connectionStatus = 'disconnected';
  let pendingSensitiveMessage = null;
  let isStreaming = false;
  let conversationHistory = [];

  // --- DOM References ---
  const messagesEl = document.getElementById('popup-messages');
  const welcomeEl = document.getElementById('popup-welcome');
  const typingEl = document.getElementById('popup-typing');
  const inputEl = document.getElementById('popup-input');
  const sendBtn = document.getElementById('popup-send-btn');
  const statusEl = document.getElementById('popup-status');

  // Setup overlay
  const setupOverlay = document.getElementById('popup-setup-overlay');
  const setupPw = document.getElementById('popup-setup-pw');
  const setupPwConfirm = document.getElementById('popup-setup-pw-confirm');
  const setupError = document.getElementById('popup-setup-error');
  const setupBtn = document.getElementById('popup-setup-btn');

  // Password overlay
  const pwOverlay = document.getElementById('popup-pw-overlay');
  const pwLevel = document.getElementById('popup-pw-level');
  const pwDesc = document.getElementById('popup-pw-desc');
  const pwKeywords = document.getElementById('popup-pw-keywords');
  const pwInput = document.getElementById('popup-pw-input');
  const pwError = document.getElementById('popup-pw-error');
  const pwConfirm = document.getElementById('popup-pw-confirm');
  const pwCancel = document.getElementById('popup-pw-cancel');

  // --- Helpers ---

  function showTyping() {
    typingEl.classList.remove('hidden');
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideTyping() {
    typingEl.classList.add('hidden');
  }

  function formatTime() {
    return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function addMessage(role, content, options = {}) {
    const { classification } = options;

    if (welcomeEl) welcomeEl.remove();

    const msgDiv = document.createElement('div');
    msgDiv.className = `popup-msg ${role}`;

    let html = escapeHtml(content);

    if (role === 'user' && classification && classification !== 'SAFE') {
      const levelText = classification === 'DANGEROUS' ? '危险操作' : '敏感操作';
      html += `<div class="popup-class-badge ${classification.toLowerCase()}">${levelText}</div>`;
    }

    html += `<div class="msg-time">${formatTime()}</div>`;
    msgDiv.innerHTML = html;
    messagesEl.appendChild(msgDiv);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return msgDiv;
  }

  function addSystemMessage(content, isError = false) {
    if (welcomeEl) welcomeEl.remove();
    const msgDiv = document.createElement('div');
    msgDiv.className = `popup-msg system${isError ? ' error' : ''}`;
    msgDiv.textContent = content;
    messagesEl.appendChild(msgDiv);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function updateStatusUI(status) {
    connectionStatus = status;
    statusEl.className = `popup-status ${status}`;
    const text = { connected: '已连接', disconnected: '未连接', connecting: '连接中' };
    statusEl.textContent = text[status] || status;
  }

  // --- Core ---

  async function checkSetup() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'check_setup' });
      isSetup = response.success && response.isSetup;
      return isSetup;
    } catch (e) {
      return false;
    }
  }

  async function checkConnection() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'check_connection' });
      if (response.success) updateStatusUI(response.status);
    } catch (e) {
      updateStatusUI('disconnected');
    }
  }

  function showSetup() {
    setupOverlay.classList.remove('hidden');
    setupPw.value = '';
    setupPwConfirm.value = '';
    setupError.textContent = '';
  }

  async function handleSetup() {
    const pw = setupPw.value;
    const pwConfirm = setupPwConfirm.value;

    if (!pw || pw.length < 6) {
      setupError.textContent = '密码长度至少为6位';
      return;
    }
    if (pw !== pwConfirm) {
      setupError.textContent = '两次输入的密码不一致';
      return;
    }

    setupBtn.disabled = true;
    setupBtn.textContent = '设置中...';

    const response = await chrome.runtime.sendMessage({ type: 'setup_password', password: pw });

    if (response.success) {
      isSetup = true;
      setupOverlay.classList.add('hidden');
      addSystemMessage('安全密码已设置。您可以开始使用了。');
    } else {
      setupError.textContent = response.error || '设置失败';
    }

    setupBtn.disabled = false;
    setupBtn.textContent = '设置密码并开始使用';
  }

  async function sendMessage(content, password = null) {
    if (!content.trim() || isStreaming) return;

    isStreaming = true;
    sendBtn.disabled = true;
    inputEl.disabled = true;
    showTyping();

    const classification = classifyOperation(content);
    addMessage('user', content, { classification: classification.level });
    conversationHistory.push({ role: 'user', content });

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'send_message',
        content: content,
        password: password
      });

      hideTyping();

      if (response.success) {
        addMessage('assistant', response.content);
        conversationHistory.push({ role: 'assistant', content: response.content });
      } else if (response.needsPassword) {
        showPasswordOverlay(content, response.level, response.matchedKeywords);
      } else {
        addSystemMessage(response.error || '发送失败', true);
      }
    } catch (e) {
      hideTyping();
      addSystemMessage('通信错误: ' + e.message, true);
    }

    isStreaming = false;
    sendBtn.disabled = false;
    inputEl.disabled = false;
    inputEl.focus();
  }

  function showPasswordOverlay(message, level, matchedKeywords) {
    pendingSensitiveMessage = message;
    pwOverlay.classList.remove('hidden');
    pwInput.value = '';
    pwError.textContent = '';

    pwLevel.className = `popup-pw-level ${level.toLowerCase()}`;
    pwLevel.textContent = level === 'DANGEROUS' ? '⚠ 危险操作' : '⚠ 敏感操作';

    pwDesc.textContent = level === 'DANGEROUS'
      ? '此操作可能修改文件、执行命令或删除数据，需要密码确认'
      : '此操作可能读取文件或访问敏感信息，需要密码确认';

    if (matchedKeywords && matchedKeywords.length > 0) {
      pwKeywords.innerHTML = '匹配: ' + matchedKeywords.map(k => `<span>${escapeHtml(k)}</span>`).join('');
      pwKeywords.style.display = '';
    } else {
      pwKeywords.style.display = 'none';
    }

    pwInput.focus();
  }

  async function handlePasswordConfirm() {
    const password = pwInput.value;
    if (!password) {
      pwError.textContent = '请输入密码';
      return;
    }

    pwConfirm.disabled = true;
    pwConfirm.textContent = '验证中...';

    const verifyResponse = await chrome.runtime.sendMessage({
      type: 'verify_password',
      password: password
    });

    if (!verifyResponse.success || !verifyResponse.valid) {
      pwError.textContent = '密码错误';
      pwConfirm.disabled = false;
      pwConfirm.textContent = '确认发送';
      return;
    }

    pwOverlay.classList.add('hidden');
    pwConfirm.disabled = false;
    pwConfirm.textContent = '确认发送';

    if (pendingSensitiveMessage) {
      await sendMessage(pendingSensitiveMessage, password);
      pendingSensitiveMessage = null;
    }
  }

  function hidePasswordOverlay() {
    pwOverlay.classList.add('hidden');
    pendingSensitiveMessage = null;
  }

  // --- Event Listeners ---

  sendBtn.addEventListener('click', () => {
    if (isStreaming) return;
    const content = inputEl.value.trim();
    if (content) {
      inputEl.value = '';
      inputEl.style.height = 'auto';
      sendMessage(content);
    }
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const content = inputEl.value.trim();
      if (content && !isStreaming) {
        inputEl.value = '';
        inputEl.style.height = 'auto';
        sendMessage(content);
      }
    }
  });

  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 80) + 'px';
  });

  // Setup
  setupBtn.addEventListener('click', handleSetup);
  setupPwConfirm.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSetup();
  });

  // Password overlay
  pwCancel.addEventListener('click', hidePasswordOverlay);
  pwConfirm.addEventListener('click', handlePasswordConfirm);
  pwInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handlePasswordConfirm();
    if (e.key === 'Escape') hidePasswordOverlay();
  });

  // Listen for connection status updates
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'connection_status_changed') {
      updateStatusUI(message.status);
    }
  });

  // --- Init ---
  async function init() {
    const setupDone = await checkSetup();
    if (!setupDone) {
      showSetup();
    } else {
      await checkConnection();
    }
    inputEl.focus();
  }

  init();
})();

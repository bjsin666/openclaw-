/**
 * OpenClaw Browser Extension — Content Script
 *
 * Injects a floating icon + chat panel into every webpage.
 * Communicates with the background service worker for all operations.
 */

(function () {
  'use strict';

  // Prevent double injection
  if (document.getElementById('openclaw-root')) return;

  // --- State ---
  let isPanelOpen = false;
  let isSetup = false;
  let connectionStatus = 'disconnected';
  let pendingSensitiveMessage = null;
  let isStreaming = false;
  let currentRequestId = null;
  let conversationHistory = [];
  let commandHistory = [];
  let historyIndex = -1;
  let currentInputDraft = '';

  // --- Create Root Element ---
  const root = document.createElement('div');
  root.id = 'openclaw-root';
  document.body.appendChild(root);

  // Attach shadow DOM? No — use scoped CSS with #openclaw-root prefix.
  // All styles are prefixed to avoid conflicts.

  // --- SVG Icons ---
  const SVG_CLAW = `
    <svg class="oc-float-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8s3.6-8 8-8 8 3.6 8 8-3.6 8-8 8z"/>
      <path d="M8 10c-.6 0-1 .4-1 1s.4 1 1 1 1-.4 1-1-.4-1-1-1zm4-2c-.6 0-1 .4-1 1s.4 1 1 1 1-.4 1-1-.4-1-1-1zm4 2c-.6 0-1 .4-1 1s.4 1 1 1 1-.4 1-1-.4-1-1-1zm-8 4c-.6 0-1 .4-1 1s.4 1 1 1 1-.4 1-1-.4-1-1-1zm8 0c-.6 0-1 .4-1 1s.4 1 1 1 1-.4 1-1-.4-1-1-1zm-4 2c-.6 0-1 .4-1 1s.4 1 1 1 1-.4 1-1-.4-1-1-1z"/>
    </svg>`;

  const SVG_SEND = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;

  const SVG_STOP = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;

  // --- Build UI ---
  root.innerHTML = `
    <!-- Floating Icon Button -->
    <button class="oc-float-btn" id="oc-float-btn" title="OpenClaw AI Assistant">
      ${SVG_CLAW}
      <span class="oc-status-dot disconnected" id="oc-status-dot"></span>
    </button>

    <!-- Chat Panel -->
    <div class="oc-panel hidden" id="oc-panel">
      <!-- Header -->
      <div class="oc-header">
        ${SVG_CLAW.replace('oc-float-icon', 'oc-header-logo')}
        <span class="oc-header-title">OpenClaw</span>
        <span class="oc-header-status disconnected" id="oc-header-status">未连接</span>
        <button class="oc-header-btn" id="oc-prev-btn" title="上一条指令">◂</button>
        <button class="oc-header-btn" id="oc-next-btn" title="下一条指令">▸</button>
        <button class="oc-header-btn" id="oc-settings-btn" title="设置">⚙</button>
        <button class="oc-header-btn" id="oc-close-btn" title="关闭">✕</button>
      </div>

      <!-- Messages Area -->
      <div class="oc-messages" id="oc-messages">
        <div class="oc-welcome" id="oc-welcome">
          <div class="oc-welcome-icon">🦞</div>
          <h3>OpenClaw AI 助手</h3>
          <p>通过此窗口向本地 OpenClaw 发送指令<br>安全中间件保护您的敏感操作</p>
        </div>
      </div>

      <!-- Typing Indicator (hidden by default) -->
      <div class="oc-typing hidden" id="oc-typing">
        <div class="oc-typing-dot"></div>
        <div class="oc-typing-dot"></div>
        <div class="oc-typing-dot"></div>
      </div>

      <!-- Input Area -->
      <div class="oc-input-area">
        <textarea class="oc-input" id="oc-input" rows="1" placeholder="输入指令... (Enter 发送, Shift+Enter 换行)"></textarea>
        <button class="oc-send-btn" id="oc-send-btn" title="发送">
          ${SVG_SEND}
        </button>
      </div>

      <!-- Password Overlay -->
      <div class="oc-password-overlay hidden" id="oc-pw-overlay">
        <div class="oc-password-card">
          <div class="oc-lock-icon">🔒</div>
          <h3>安全验证</h3>
          <span class="oc-pw-level sensitive" id="oc-pw-level">敏感操作</span>
          <p class="oc-pw-desc" id="oc-pw-desc">此操作需要密码确认才能发送到 OpenClaw</p>
          <div class="oc-keywords" id="oc-pw-keywords"></div>
          <input type="password" class="oc-pw-input" id="oc-pw-input" placeholder="输入安全密码" autocomplete="off">
          <div class="oc-pw-error" id="oc-pw-error"></div>
          <div class="oc-pw-buttons">
            <button class="oc-pw-btn cancel" id="oc-pw-cancel">取消</button>
            <button class="oc-pw-btn confirm" id="oc-pw-confirm">确认发送</button>
          </div>
        </div>
      </div>

      <!-- First-time Setup Overlay -->
      <div class="oc-setup-overlay hidden" id="oc-setup-overlay">
        <div class="oc-setup-card">
          <div class="oc-setup-icon">🔐</div>
          <h3>初次使用设置</h3>
          <p>欢迎使用 OpenClaw 浏览器插件。<br>请先设置安全密码以开始使用。<br>此密码用于验证敏感操作。</p>
          <input type="password" class="oc-setup-input" id="oc-setup-pw" placeholder="设置密码（至少6位）" autocomplete="new-password">
          <input type="password" class="oc-setup-input" id="oc-setup-pw-confirm" placeholder="确认密码" autocomplete="new-password">
          <div class="oc-setup-error" id="oc-setup-error"></div>
          <button class="oc-setup-btn" id="oc-setup-btn">设置密码并开始使用</button>
        </div>
      </div>

      <!-- Settings Panel -->
      <div class="oc-settings-panel hidden" id="oc-settings-panel">
        <div class="oc-settings-header">
          <h3>设置</h3>
          <button class="oc-header-btn" id="oc-settings-back-btn" title="返回">←</button>
        </div>
        <div class="oc-settings-body">
          <div class="oc-settings-group">
            <label>OpenClaw 服务地址</label>
            <input type="text" id="oc-setting-url" placeholder="http://127.0.0.1:18789">
            <div class="oc-setting-hint">本地 OpenClaw 网关地址，默认端口 18789</div>
          </div>
          <div class="oc-settings-group">
            <label>网关认证 Token</label>
            <input type="password" id="oc-setting-token" placeholder="留空则不带认证">
            <div class="oc-setting-hint">在 openclaw.json 的 gateway.auth.token 中可找到</div>
          </div>
          <div class="oc-settings-group">
            <label>连接状态</label>
            <div style="font-size:13px;" id="oc-setting-status">-</div>
          </div>
          <div class="oc-settings-group">
            <button class="oc-settings-save" id="oc-settings-save-btn">保存设置</button>
            <button class="oc-settings-clear-logs" id="oc-settings-clear-btn">清除日志</button>
          </div>
          <hr style="border-color:rgba(255,255,255,0.06);margin:16px 0;">
          <div class="oc-settings-group">
            <label>修改安全密码</label>
            <input type="password" class="oc-setup-input" id="oc-change-old-pw" placeholder="当前密码" autocomplete="off" style="margin-bottom:6px;">
            <input type="password" class="oc-setup-input" id="oc-change-new-pw" placeholder="新密码（至少6位）" autocomplete="new-password" style="margin-bottom:6px;">
            <input type="password" class="oc-setup-input" id="oc-change-confirm-pw" placeholder="确认新密码" autocomplete="new-password" style="margin-bottom:6px;">
            <div class="oc-setup-error" id="oc-change-pw-error" style="min-height:16px;font-size:12px;margin-bottom:4px;"></div>
            <button class="oc-settings-save" id="oc-change-pw-btn" style="background:#FFAA00;">修改密码</button>
          </div>
        </div>
      </div>
    </div>
  `;

  // --- DOM References ---
  const floatBtn = document.getElementById('oc-float-btn');
  const panel = document.getElementById('oc-panel');
  const messagesEl = document.getElementById('oc-messages');
  const welcomeEl = document.getElementById('oc-welcome');
  const typingEl = document.getElementById('oc-typing');
  const inputEl = document.getElementById('oc-input');
  const sendBtn = document.getElementById('oc-send-btn');
  const statusDot = document.getElementById('oc-status-dot');
  const headerStatus = document.getElementById('oc-header-status');

  // Password overlay
  const pwOverlay = document.getElementById('oc-pw-overlay');
  const pwLevel = document.getElementById('oc-pw-level');
  const pwDesc = document.getElementById('oc-pw-desc');
  const pwKeywords = document.getElementById('oc-pw-keywords');
  const pwInput = document.getElementById('oc-pw-input');
  const pwError = document.getElementById('oc-pw-error');
  const pwConfirm = document.getElementById('oc-pw-confirm');
  const pwCancel = document.getElementById('oc-pw-cancel');

  // Setup overlay
  const setupOverlay = document.getElementById('oc-setup-overlay');
  const setupPw = document.getElementById('oc-setup-pw');
  const setupPwConfirm = document.getElementById('oc-setup-pw-confirm');
  const setupError = document.getElementById('oc-setup-error');
  const setupBtn = document.getElementById('oc-setup-btn');

  // Settings
  const settingsPanel = document.getElementById('oc-settings-panel');

  // --- Helper Functions ---

  function showTyping() {
    typingEl.classList.remove('hidden');
    scrollToBottom();
  }

  function hideTyping() {
    typingEl.classList.add('hidden');
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function formatTime() {
    const now = new Date();
    return now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Add a message bubble to the chat
   */
  function addMessage(role, content, options = {}) {
    const { classification, error, isStreaming } = options;

    // Remove welcome message on first real message
    if (welcomeEl && (role === 'user' || role === 'assistant')) {
      welcomeEl.remove();
    }

    // If streaming, update the last assistant message
    if (isStreaming && role === 'assistant') {
      const lastMsg = messagesEl.querySelector('.oc-msg.assistant.streaming');
      if (lastMsg) {
        lastMsg.textContent = content;
        scrollToBottom();
        return lastMsg;
      }
    }

    const msgDiv = document.createElement('div');
    msgDiv.className = `oc-msg ${role}${isStreaming ? ' streaming' : ''}${error ? ' error' : ''}`;

    let html = escapeHtml(content);

    // Add classification badge for user messages
    if (role === 'user' && classification && classification !== 'SAFE') {
      const levelText = classification === 'DANGEROUS' ? '危险操作' : '敏感操作';
      html += `<div class="oc-class-badge ${classification.toLowerCase()}">${levelText}</div>`;
    }

    html += `<div class="oc-msg-time">${formatTime()}</div>`;
    msgDiv.innerHTML = html;
    messagesEl.appendChild(msgDiv);
    scrollToBottom();
    return msgDiv;
  }

  /**
   * Add a system message
   */
  function addSystemMessage(content, error = false) {
    if (welcomeEl) welcomeEl.remove();
    const msgDiv = document.createElement('div');
    msgDiv.className = `oc-msg system${error ? ' error' : ''}`;
    msgDiv.textContent = content;
    messagesEl.appendChild(msgDiv);
    scrollToBottom();
  }

  /**
   * Update connection status indicators
   */
  function updateConnectionUI(status) {
    connectionStatus = status;

    // Update dot
    statusDot.className = `oc-status-dot ${status}`;

    // Update header
    headerStatus.className = `oc-header-status ${status}`;
    const statusText = { connected: '已连接', disconnected: '未连接', connecting: '连接中' };
    headerStatus.textContent = statusText[status] || status;

    // Update settings if open
    const settingStatus = document.getElementById('oc-setting-status');
    if (settingStatus) {
      settingStatus.textContent = statusText[status] || status;
    }
  }

  // --- Core Operations ---

  /**
   * Check setup status from background
   */
  async function checkSetup() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'check_setup' });
      isSetup = response.success && response.isSetup;
      return isSetup;
    } catch (e) {
      console.error('[OpenClaw] checkSetup error:', e);
      return false;
    }
  }

  /**
   * Check connection status
   */
  async function checkConnection() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'check_connection' });
      if (response.success) {
        updateConnectionUI(response.status);
      }
    } catch (e) {
      updateConnectionUI('disconnected');
    }
  }

  /**
   * Display the first-time setup overlay
   */
  function showSetup() {
    setupOverlay.classList.remove('hidden');
    setupPw.value = '';
    setupPwConfirm.value = '';
    setupError.textContent = '';
  }

  /**
   * Handle setup submission
   */
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

    const response = await chrome.runtime.sendMessage({
      type: 'setup_password',
      password: pw
    });

    if (response.success) {
      isSetup = true;
      setupOverlay.classList.add('hidden');
      addSystemMessage('✅ 安全密码已设置。您可以开始使用了。');
    } else {
      setupError.textContent = response.error || '设置失败';
    }

    setupBtn.disabled = false;
    setupBtn.textContent = '设置密码并开始使用';
  }

  /**
   * Collect current page context
   */
  function getPageContext(userMessage) {
    const needsPageContent = isPageRelated(userMessage);
    return {
      url: window.location.href,
      title: document.title,
      selectedText: window.getSelection()?.toString()?.trim() || '',
      snapshot: needsPageContent ? buildPageSnapshot() : null,
      needsPageContent: needsPageContent
    };
  }

  /**
   * Build a structured, token-efficient summary of the page.
   * Instead of dumping raw text, extract headings, links, buttons,
   * inputs, and key text — what openclaw actually needs to understand the page.
   */
  function buildPageSnapshot() {
    const MAX_ITEMS = 30; // cap each category to avoid huge payloads

    // --- Headings ---
    const headings = [];
    document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(el => {
      if (headings.length >= MAX_ITEMS) return;
      if (el.closest('#openclaw-root')) return;
      const text = el.textContent.trim();
      if (text) headings.push({ t: el.tagName.toLowerCase(), c: text.slice(0, 100) });
    });

    // --- Links ---
    const links = [];
    document.querySelectorAll('a[href]').forEach(el => {
      if (links.length >= MAX_ITEMS) return;
      if (el.closest('#openclaw-root')) return;
      const text = el.textContent.trim();
      const href = el.getAttribute('href');
      if (text && href && !href.startsWith('#')) {
        links.push({ c: text.slice(0, 80), h: href.slice(0, 120) });
      }
    });

    // --- Buttons ---
    const buttons = [];
    document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]').forEach(el => {
      if (buttons.length >= MAX_ITEMS) return;
      if (el.closest('#openclaw-root')) return;
      const text = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
      if (text) buttons.push({ c: text.slice(0, 60), s: getShortSelector(el) });
    });

    // --- Inputs ---
    const inputs = [];
    document.querySelectorAll('input, textarea, select').forEach(el => {
      if (inputs.length >= MAX_ITEMS) return;
      if (el.closest('#openclaw-root')) return;
      const type = el.type || el.tagName.toLowerCase();
      const name = el.name || el.getAttribute('aria-label') || '';
      const placeholder = el.placeholder || '';
      const label = findLabel(el);
      if (!el.closest('form') && !el.closest('nav') && type === 'hidden') return; // skip hidden/search-in-nav
      inputs.push({
        s: getShortSelector(el),
        t: type,
        ...(name ? { n: name.slice(0, 40) } : {}),
        ...(placeholder ? { p: placeholder.slice(0, 40) } : {}),
        ...(label ? { l: label.slice(0, 40) } : {})
      });
    });

    // --- Key text: first meaningful paragraph ---
    let keyText = '';
    const main = document.querySelector('main, article, [role="main"], .content, .post, .article');
    const container = main || document.body;
    const paras = container.querySelectorAll('p, li, td, th, pre, blockquote');
    for (const p of paras) {
      if (p.closest('#openclaw-root')) continue;
      if (p.closest('nav, footer, header, script, style, noscript')) continue;
      const text = p.textContent.trim();
      if (text.length > 20) {
        keyText = text.slice(0, 300);
        break;
      }
    }

    // --- Stats ---
    const stats = {
      links: document.querySelectorAll('a[href]').length,
      images: document.querySelectorAll('img').length,
      forms: document.querySelectorAll('form').length,
      inputs: document.querySelectorAll('input, textarea, select').length,
      buttons: document.querySelectorAll('button, [role="button"]').length
    };

    return { headings, links, buttons, inputs, keyText, stats };
  }

  /**
   * Generate a brief CSS selector for an element.
   * Prefers id, then name, then a short class-based selector.
   */
  function getShortSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.name) return `[name="${el.name}"]`;
    // Try a tag + class combo
    const tag = el.tagName.toLowerCase();
    const cls = Array.from(el.classList).filter(c => c.length < 30 && !c.includes(' ')).slice(0, 2);
    if (cls.length > 0) return tag + '.' + cls.map(c => CSS.escape(c)).join('.');
    // Fallback: nth-of-type path
    let path = tag;
    let parent = el.parentElement;
    if (parent && parent !== document.body) {
      const idx = Array.from(parent.children).filter(c => c.tagName === el.tagName).indexOf(el) + 1;
      path += `:nth-of-type(${idx})`;
    }
    return path;
  }

  /**
   * Find the label text associated with an input element.
   */
  function findLabel(el) {
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent.trim();
    }
    const parentLabel = el.closest('label');
    if (parentLabel) return parentLabel.textContent.replace(el.value || '', '').trim();
    return '';
  }

  /**
   * Check if a user message is likely referencing the current page.
   */
  function isPageRelated(message) {
    const lowerMsg = message.toLowerCase();
    const pageKeywords = [
      '这个', '当前', '页面', '网页', '这里', '上面', '下面',
      '高亮', '标记', '标注', '选中', '找一下', '找找',
      '搜索', '查找', '点击', '填写', '填入', '输入',
      '滚动', '翻页', '翻译', '总结', '摘要', '概括',
      'this page', 'current page', 'highlight', 'scroll', 'click',
      'fill', 'find', 'search', 'summary', 'summarize', 'translate'
    ];
    for (const kw of pageKeywords) {
      if (lowerMsg.includes(kw)) return true;
    }
    return false;
  }

  /**
   * Send a message to OpenClaw via the background worker
   */
  async function sendMessage(content, password = null) {
    if (!content.trim() || isStreaming) return;

    // Collect page context (smart: only includes summary if page-related)
    const pageContext = getPageContext(content);

    // Check streaming state
    isStreaming = true;
    sendBtn.innerHTML = SVG_STOP;
    inputEl.disabled = true;

    // Add user message to UI
    const classification = classifyOperation(content);
    addMessage('user', content, { classification: classification.level });

    // Add to conversation history
    conversationHistory.push({ role: 'user', content });

    // Send via background with page context
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'send_message',
        content: content,
        password: password,
        pageContext: pageContext
      });

      if (response.success) {
        hideTyping();
        // Parse and execute any browser actions in the response
        const { displayContent, actions } = parseBrowserActions(response.content);
        addMessage('assistant', displayContent);
        conversationHistory.push({ role: 'assistant', content: response.content });

        // Execute browser actions
        if (actions.length > 0) {
          executeBrowserActions(actions);
        }

        if (response.classification) {
          const userMsg = messagesEl.querySelector('.oc-msg.user:last-child');
          if (userMsg && response.classification !== 'SAFE') {
            const badge = document.createElement('div');
            const levelText = response.classification === 'DANGEROUS' ? '危险操作' : '敏感操作';
            badge.className = `oc-class-badge ${response.classification.toLowerCase()}`;
            badge.textContent = levelText;
            userMsg.appendChild(badge);
          }
        }
      } else if (response.needsPassword) {
        // Show password overlay
        showPasswordOverlay(content, response.level, response.matchedKeywords);
      } else {
        addSystemMessage(response.error || '发送失败', true);
      }
    } catch (e) {
      addSystemMessage(`通信错误: ${e.message}`, true);
    }

    // Save to command history (deduplicate consecutive identical commands)
    if (commandHistory.length === 0 || commandHistory[commandHistory.length - 1] !== content) {
      commandHistory.push(content);
    }
    historyIndex = commandHistory.length;
    currentInputDraft = '';

    // Reset state
    isStreaming = false;
    sendBtn.innerHTML = SVG_SEND;
    inputEl.disabled = false;
    inputEl.focus();
  }

  // --- Browser Action Engine (with Undo/Redo) ---

  // Undo/Redo stacks
  let actionHistory = [];    // [{ desc, undo: fn, redo: fn }]
  let undoIndex = -1;        // Points to last executed action; -1 means empty
  let batchCounter = 0;      // Unique batch ID for each highlight/action group

  /**
   * Parse browser action commands from OpenClaw's response.
   * Looks for JSON code blocks: ```json { "action": "...", ... } ```
   */
  function parseBrowserActions(content) {
    const actions = [];
    let displayContent = content;
    const jsonBlockRegex = /```json\s*\n?([\s\S]*?)```/g;
    let match;
    while ((match = jsonBlockRegex.exec(content)) !== null) {
      try {
        const parsed = JSON.parse(match[1].trim());
        if (parsed.action) actions.push(parsed);
      } catch (e) { /* skip */ }
    }
    displayContent = displayContent.replace(/```json\s*\n?[\s\S]*?```/g, '').trim();
    return { displayContent, actions };
  }

  /**
   * Execute browser actions with undo/redo tracking.
   * Each action returns an undo record. New actions clear any "future" (redo) history.
   */
  function executeBrowserActions(actions) {
    // Clear any redo history when new actions are executed
    if (undoIndex < actionHistory.length - 1) {
      actionHistory = actionHistory.slice(0, undoIndex + 1);
    }

    const undoRecords = [];

    for (const action of actions) {
      let record = null;
      switch (action.action) {
        case 'highlight':
          record = doHighlight(action.text, action.color || '#FFEB3B');
          break;
        case 'scrollTo':
          record = doScrollTo(action.text);
          break;
        case 'click':
          record = doClick(action.selector);
          break;
        case 'fill':
          record = doFill(action.selector, action.value);
          break;
        case 'clearHighlights':
          record = doClearHighlights();
          break;
        default:
          console.log('[OpenClaw] Unknown action:', action.action);
      }
      if (record) undoRecords.push(record);
    }

    // Push combined undo record to history
    if (undoRecords.length > 0) {
      actionHistory.push({
        desc: undoRecords.map(r => r.desc).join('；'),
        undoRecords: undoRecords
      });
      undoIndex = actionHistory.length - 1;

      // Show summary + undo hint
      const summary = undoRecords.map(r => r.desc).join('；');
      addSystemMessage(`${summary}  (◂ 可撤销)`);
    }
  }

  // --- Action implementations with undo support ---

  function doHighlight(searchText, color) {
    if (!searchText) return null;
    const batchId = 'oc-batch-' + (++batchCounter);
    let count = 0;
    const walker = document.createTreeWalker(
      document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          if (node.parentElement?.closest('#openclaw-root')) return NodeFilter.FILTER_REJECT;
          if (node.parentElement?.closest('script,style,noscript,textarea,input,select')) return NodeFilter.FILTER_REJECT;
          if (node.parentElement?.classList?.contains('oc-highlight-mark')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    for (const textNode of textNodes) {
      const text = textNode.textContent;
      const escaped = searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'gi');
      if (!regex.test(text)) continue;
      regex.lastIndex = 0;
      const fragment = document.createDocumentFragment();
      let lastIndex = 0, match;
      while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }
        const mark = document.createElement('mark');
        mark.className = 'oc-highlight-mark';
        mark.dataset.ocBatch = batchId;
        mark.style.setProperty('--hl-color', color);
        mark.textContent = match[0];
        fragment.appendChild(mark);
        count++;
        lastIndex = regex.lastIndex;
      }
      if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      }
      textNode.parentNode.replaceChild(fragment, textNode);
    }

    if (count === 0) return null;

    return {
      desc: `🔍 高亮 "${searchText}" (${count}处)`,
      undo: () => {
        const marks = document.querySelectorAll(`[data-oc-batch="${batchId}"]`);
        const parents = new Set();
        marks.forEach(mark => {
          parents.add(mark.parentNode);
          mark.parentNode.replaceChild(document.createTextNode(mark.textContent), mark);
        });
        parents.forEach(p => { try { p.normalize(); } catch (e) {} });
        // Return fresh redo record
        return {
          desc: `🔍 高亮 "${searchText}" (${count}处)`,
          redo: () => doHighlight(searchText, color)
        };
      },
      redo: () => {
        // Re-execute and return fresh undo record
        return doHighlight(searchText, color);
      }
    };
  }

  function doScrollTo(searchText) {
    if (!searchText) return null;
    const prevScroll = { x: window.scrollX, y: window.scrollY };
    let found = false;

    const marks = document.querySelectorAll('.oc-highlight-mark');
    for (const mark of marks) {
      if (mark.textContent.toLowerCase().includes(searchText.toLowerCase())) {
        mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        found = true;
        break;
      }
    }
    if (!found) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => n.parentElement?.closest('#openclaw-root') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
      });
      while (walker.nextNode()) {
        if (walker.currentNode.textContent.toLowerCase().includes(searchText.toLowerCase())) {
          walker.currentNode.parentElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
          found = true;
          break;
        }
      }
    }
    if (!found) return null;

    return {
      desc: `📜 滚动到 "${searchText}"`,
      undo: () => {
        window.scrollTo({ left: prevScroll.x, top: prevScroll.y, behavior: 'smooth' });
        return { desc: `📜 滚动到 "${searchText}"`, redo: () => doScrollTo(searchText) };
      },
      redo: () => doScrollTo(searchText)
    };
  }

  function doClick(selector) {
    if (!selector) return null;
    try {
      const el = document.querySelector(selector);
      if (!el || el.closest('#openclaw-root')) return null;
      // Save visual feedback state
      const oldOutline = el.style.outline;
      el.style.outline = '2px solid #FF6B35';
      el.click();
      setTimeout(() => { el.style.outline = oldOutline; }, 1500);
      return {
        desc: `👆 点击 "${selector}"`,
        undo: () => {
          return { desc: `👆 点击 "${selector}"`, redo: () => doClick(selector) };
        },
        redo: () => doClick(selector)
      };
    } catch (e) { return null; }
  }

  function doFill(selector, value) {
    if (!selector) return null;
    try {
      const el = document.querySelector(selector);
      if (!el || el.closest('#openclaw-root')) return null;
      const oldValue = el.value;
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        desc: `✏ 填入 "${selector}"`,
        undo: () => {
          const el2 = document.querySelector(selector);
          if (el2) {
            el2.value = oldValue;
            el2.dispatchEvent(new Event('input', { bubbles: true }));
            el2.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return { desc: `✏ 填入 "${selector}"`, redo: () => doFill(selector, value) };
        },
        redo: () => doFill(selector, value)
      };
    } catch (e) { return null; }
  }

  function doClearHighlights() {
    const marks = Array.from(document.querySelectorAll('.oc-highlight-mark'));
    if (marks.length === 0) return null;
    const saved = marks.map(mark => ({
      parent: mark.parentNode,
      text: mark.textContent,
      batchId: mark.dataset.ocBatch || '',
      hlColor: mark.style.getPropertyValue('--hl-color') || '#FFEB3B'
    }));
    marks.forEach(mark => {
      mark.parentNode.replaceChild(document.createTextNode(mark.textContent), mark);
      mark.parentNode.normalize();
    });
    return {
      desc: `🧹 清除高亮 (${saved.length}处)`,
      undo: () => {
        saved.forEach(({ parent, text, batchId, hlColor }) => {
          const walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode;
            if (node.textContent === text && !node.parentElement?.classList?.contains('oc-highlight-mark')) {
              const mark = document.createElement('mark');
              mark.className = 'oc-highlight-mark';
              if (batchId) mark.dataset.ocBatch = batchId;
              mark.style.setProperty('--hl-color', hlColor);
              mark.textContent = text;
              node.parentNode.replaceChild(mark, node);
              break;
            }
          }
        });
        return { desc: `🧹 清除高亮 (${saved.length}处)`, redo: () => doClearHighlights() };
      },
      redo: () => doClearHighlights()
    };
  }

  // --- Undo / Redo ---

  function undoLastAction() {
    if (undoIndex < 0 || undoIndex >= actionHistory.length) return;
    const entry = actionHistory[undoIndex];
    // Execute undo in reverse order
    const newRedoRecords = [];
    for (let i = entry.undoRecords.length - 1; i >= 0; i--) {
      try {
        const redoRecord = entry.undoRecords[i].undo(); // undo() now returns the redo data
        if (redoRecord) newRedoRecords.unshift(redoRecord);
      } catch (e) { console.error('[OpenClaw] undo error:', e); }
    }
    // Update entry so redo will use fresh references
    if (newRedoRecords.length > 0) {
      entry.undoRecords = newRedoRecords;
    }
    undoIndex--;
    updateNavButtonStates();
    addSystemMessage(`↩ 已撤销: ${entry.desc}`);
  }

  function redoLastAction() {
    const nextIndex = undoIndex + 1;
    if (nextIndex < 0 || nextIndex >= actionHistory.length) return;
    const entry = actionHistory[nextIndex];
    const newUndoRecords = [];
    for (const record of entry.undoRecords) {
      try {
        const undoRecord = record.redo(); // redo() now returns the undo data
        if (undoRecord) newUndoRecords.push(undoRecord);
      } catch (e) { console.error('[OpenClaw] redo error:', e); }
    }
    if (newUndoRecords.length > 0) {
      entry.undoRecords = newUndoRecords;
    }
    undoIndex = nextIndex;
    updateNavButtonStates();
    addSystemMessage(`↪ 已重做: ${entry.desc}`);
  }

  /**
   * Show the password verification overlay for sensitive operations
   */
  function showPasswordOverlay(message, level, matchedKeywords) {
    pendingSensitiveMessage = message;
    pwOverlay.classList.remove('hidden');
    pwInput.value = '';
    pwError.textContent = '';

    // Update overlay styling based on level
    pwLevel.className = `oc-pw-level ${level.toLowerCase()}`;
    pwLevel.textContent = level === 'DANGEROUS' ? '⚠ 危险操作' : '⚠ 敏感操作';

    pwDesc.textContent = level === 'DANGEROUS'
      ? '此操作可能修改文件、执行命令或删除数据，需要密码确认才能发送到 OpenClaw'
      : '此操作可能读取文件或访问敏感信息，需要密码确认才能发送到 OpenClaw';

    // Show matched keywords
    if (matchedKeywords && matchedKeywords.length > 0) {
      pwKeywords.innerHTML = '匹配关键词: ' + matchedKeywords.map(k => `<span>${escapeHtml(k)}</span>`).join('');
      pwKeywords.style.display = '';
    } else {
      pwKeywords.style.display = 'none';
    }

    pwInput.focus();
  }

  /**
   * Handle password confirmation for sensitive operation
   */
  async function handlePasswordConfirm() {
    const password = pwInput.value;
    if (!password) {
      pwError.textContent = '请输入密码';
      return;
    }

    pwConfirm.disabled = true;
    pwConfirm.textContent = '验证中...';

    // Verify password
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

    // Password valid — hide overlay and send the message
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
    pwInput.value = '';
    pwError.textContent = '';
  }

  // --- Event Handlers ---

  // Toggle panel
  floatBtn.addEventListener('click', async () => {
    if (isPanelOpen) {
      closePanel();
    } else {
      await openPanel();
    }
  });

  async function openPanel() {
    panel.classList.remove('hidden');
    panel.classList.add('opening');
    setTimeout(() => panel.classList.remove('opening'), 250);
    isPanelOpen = true;
    floatBtn.style.display = 'none';

    // Check setup status
    const setupDone = await checkSetup();
    if (!setupDone) {
      showSetup();
    } else {
      checkConnection();
    }

    inputEl.focus();
  }

  function closePanel() {
    panel.classList.add('closing');
    setTimeout(() => {
      panel.classList.add('hidden');
      panel.classList.remove('closing');
    }, 200);
    isPanelOpen = false;
    floatBtn.style.display = 'flex';
  }

  // Close button
  document.getElementById('oc-close-btn').addEventListener('click', closePanel);

  // Send button
  sendBtn.addEventListener('click', () => {
    if (isStreaming) {
      // Cancel ongoing request
      if (currentRequestId) {
        chrome.runtime.sendMessage({ type: 'cancel_request', requestId: currentRequestId });
      }
      isStreaming = false;
      sendBtn.innerHTML = SVG_SEND;
      inputEl.disabled = false;
      hideTyping();
      return;
    }
    const content = inputEl.value.trim();
    if (content) {
      inputEl.value = '';
      inputEl.style.height = 'auto';
      sendMessage(content);
    }
  });

  // Input keyboard handling
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

  // Auto-resize textarea
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 90) + 'px';
  });

  // Password overlay events
  pwCancel.addEventListener('click', hidePasswordOverlay);
  pwConfirm.addEventListener('click', handlePasswordConfirm);
  pwInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handlePasswordConfirm();
    }
    if (e.key === 'Escape') {
      hidePasswordOverlay();
    }
  });

  // Setup events
  setupBtn.addEventListener('click', handleSetup);
  setupPwConfirm.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSetup();
  });

  // Settings panel
  document.getElementById('oc-settings-btn').addEventListener('click', async () => {
    settingsPanel.classList.remove('hidden');
    const response = await chrome.runtime.sendMessage({ type: 'get_settings' });
    if (response.success) {
      document.getElementById('oc-setting-url').value = response.settings.openclawUrl || 'http://127.0.0.1:18789';
      document.getElementById('oc-setting-token').value = response.settings.gatewayToken || '';
      const statusText = { connected: '已连接', disconnected: '未连接', connecting: '连接中' };
      document.getElementById('oc-setting-status').textContent =
        statusText[response.settings.connectionStatus] || response.settings.connectionStatus;
    }
  });

  document.getElementById('oc-settings-back-btn').addEventListener('click', () => {
    settingsPanel.classList.add('hidden');
  });

  document.getElementById('oc-settings-save-btn').addEventListener('click', async () => {
    const url = document.getElementById('oc-setting-url').value.trim();
    const token = document.getElementById('oc-setting-token').value.trim();
    if (url) {
      await chrome.runtime.sendMessage({ type: 'update_settings', key: 'openclawUrl', value: url });
    }
    await chrome.runtime.sendMessage({ type: 'update_settings', key: 'gatewayToken', value: token });
    await checkConnection();
    addSystemMessage('✅ 设置已保存');
    settingsPanel.classList.add('hidden');
  });

  document.getElementById('oc-settings-clear-btn').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'clear_logs' });
    addSystemMessage('✅ 日志已清除');
  });

  // --- Change Password ---
  document.getElementById('oc-change-pw-btn').addEventListener('click', async () => {
    const oldPw = document.getElementById('oc-change-old-pw').value;
    const newPw = document.getElementById('oc-change-new-pw').value;
    const confirmPw = document.getElementById('oc-change-confirm-pw').value;
    const errorEl = document.getElementById('oc-change-pw-error');

    if (!oldPw) { errorEl.textContent = '请输入当前密码'; return; }
    if (!newPw || newPw.length < 6) { errorEl.textContent = '新密码长度至少为6位'; return; }
    if (newPw !== confirmPw) { errorEl.textContent = '两次输入的新密码不一致'; return; }

    const verifyRes = await chrome.runtime.sendMessage({ type: 'verify_password', password: oldPw });
    if (!verifyRes.success || !verifyRes.valid) {
      errorEl.textContent = '当前密码错误';
      return;
    }

    const setupRes = await chrome.runtime.sendMessage({ type: 'setup_password', password: newPw });
    if (setupRes.success) {
      errorEl.style.color = 'var(--oc-safe)';
      errorEl.textContent = '密码修改成功！';
      document.getElementById('oc-change-old-pw').value = '';
      document.getElementById('oc-change-new-pw').value = '';
      document.getElementById('oc-change-confirm-pw').value = '';
      setTimeout(() => { errorEl.style.color = ''; errorEl.textContent = ''; }, 2000);
    } else {
      errorEl.textContent = setupRes.error || '修改失败';
    }
  });

  // --- Undo / Redo buttons ---
  document.getElementById('oc-prev-btn').addEventListener('click', () => undoLastAction());
  document.getElementById('oc-next-btn').addEventListener('click', () => redoLastAction());

  // Update arrow button states based on undo/redo availability
  function updateNavButtonStates() {
    const prevBtn = document.getElementById('oc-prev-btn');
    const nextBtn = document.getElementById('oc-next-btn');
    if (prevBtn) prevBtn.style.opacity = undoIndex < 0 ? '0.3' : '1';
    if (nextBtn) nextBtn.style.opacity = undoIndex >= actionHistory.length - 1 ? '0.3' : '1';
  }

  // Override undo/redo to also update button states
  const _undoLastAction = undoLastAction;
  const _redoLastAction = redoLastAction;
  undoLastAction = function() { _undoLastAction(); updateNavButtonStates(); };
  redoLastAction = function() { _redoLastAction(); updateNavButtonStates(); };

  // Also update after executing new actions
  const _executeBrowserActions = executeBrowserActions;
  executeBrowserActions = function(actions) { _executeBrowserActions(actions); updateNavButtonStates(); };

  // --- Listen for messages from background ---
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'connection_status_changed') {
      updateConnectionUI(message.status);
    }
  });

  // --- Initialize ---
  async function init() {
    await checkSetup();
    // Get initial connection status
    try {
      const response = await chrome.runtime.sendMessage({ type: 'get_connection_status' });
      if (response.success) {
        updateConnectionUI(response.status);
      }
    } catch (e) {
      updateConnectionUI('disconnected');
    }

    console.log('[OpenClaw] Content script initialized. Setup:', isSetup, 'Connection:', connectionStatus);
  }

  init();
})();

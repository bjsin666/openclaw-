/**
 * Background Service Worker — Middleware Hub
 *
 * Responsibilities:
 * 1. Route messages between content script/popup and OpenClaw
 * 2. Classify operations and enforce security policies
 * 3. Log all interactions
 * 4. Maintain connection health status
 */

// Import shared libraries
importScripts(
  '../lib/storage.js',
  '../lib/security.js',
  '../lib/openclaw-client.js'
);

// --- Connection Health Monitoring ---

let healthCheckInterval = null;
let currentBaseUrl = DEFAULT_BASE_URL;

async function performHealthCheck() {
  const url = await Storage.getOpenClawUrl();
  currentBaseUrl = url;

  const { connected } = await checkHealth(url);
  const status = connected ? 'connected' : 'disconnected';
  await Storage.setConnectionStatus(status);

  // Broadcast status to all connected content scripts / popups
  try {
    chrome.runtime.sendMessage({
      type: 'connection_status_changed',
      status: status
    }).catch(() => {
      // No listeners — that's fine
    });
  } catch (e) { /* ignore */ }

  return status;
}

function startHealthChecks() {
  if (healthCheckInterval) return;
  performHealthCheck();
  healthCheckInterval = setInterval(performHealthCheck, 30000); // every 30s
}

function stopHealthChecks() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}

// Start on load
startHealthChecks();

// --- Message Routing ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Use async handler pattern
  handleMessage(message, sender).then(sendResponse);
  return true; // Keep the message channel open for async response
});

async function handleMessage(message, sender) {
  const { type } = message;

  switch (type) {
    // --- Connection ---
    case 'check_connection': {
      const status = await performHealthCheck();
      const url = await Storage.getOpenClawUrl();
      return { success: true, status, url };
    }

    case 'get_connection_status': {
      const status = await Storage.getConnectionStatus();
      const url = await Storage.getOpenClawUrl();
      return { success: true, status, url };
    }

    // --- Password Setup ---
    case 'check_setup': {
      const isSetup = await Storage.isSetup();
      return { success: true, isSetup };
    }

    case 'setup_password': {
      const { password } = message;
      const validation = validatePasswordStrength(password);
      if (!validation.valid) {
        return { success: false, error: validation.reason };
      }
      const hash = await sha256(password);
      await Storage.setPasswordHash(hash);
      await Storage.addLog({
        role: 'system',
        message: '初始密码已设置',
        classification: 'SYSTEM',
        forwarded: false
      });
      return { success: true };
    }

    case 'verify_password': {
      const { password } = message;
      const storedHash = await Storage.getPasswordHash();
      const valid = await verifyPassword(password, storedHash);
      return { success: true, valid };
    }

    // --- Chat ---
    case 'send_message': {
      return await handleSendMessage(message, sender);
    }

    case 'cancel_request': {
      const { requestId } = message;
      const cancelled = cancelRequest(requestId);
      return { success: true, cancelled };
    }

    // --- Logs ---
    case 'get_logs': {
      const logs = await Storage.getLogs();
      return { success: true, logs };
    }

    case 'clear_logs': {
      await Storage.clearLogs();
      return { success: true };
    }

    // --- Settings ---
    case 'get_settings': {
      const url = await Storage.getOpenClawUrl();
      const token = await Storage.getGatewayToken();
      const settings = await Storage.getSettings();
      const isSetup = await Storage.isSetup();
      const status = await Storage.getConnectionStatus();
      return { success: true, settings: { ...settings, openclawUrl: url, gatewayToken: token, isSetup, connectionStatus: status } };
    }

    case 'update_settings': {
      const { key, value } = message;
      if (key === 'openclawUrl') {
        await Storage.setOpenClawUrl(value);
        performHealthCheck(); // Re-check with new URL
      } else if (key === 'gatewayToken') {
        await Storage.setGatewayToken(value);
      } else {
        await Storage.updateSetting(key, value);
      }
      return { success: true };
    }

    default:
      return { success: false, error: `未知消息类型: ${type}` };
  }
}

/**
 * Build system prompt with page context and available browser actions
 * @param {Object} ctx - Page context from content script
 * @returns {string}
 */
function buildSystemPrompt(ctx) {
  const snap = ctx.snapshot;
  const hasSnapshot = snap && (snap.headings.length > 0 || snap.links.length > 0 || snap.buttons.length > 0);

  let prompt = `你是 OpenClaw 浏览器助手。

## 当前页面
URL: ${ctx.url}
标题: ${ctx.title}
${ctx.selectedText ? `用户选中: "${ctx.selectedText}"` : ''}`;

  if (hasSnapshot) {
    prompt += `

## 页面结构`;
    if (snap.headings.length > 0) {
      prompt += `\n标题层级:\n${snap.headings.map(h => `  ${h.t}: ${h.c}`).join('\n')}`;
    }
    if (snap.links.length > 0) {
      prompt += `\n\n链接:\n${snap.links.map(l => `  [${l.c}](${l.h})`).join('\n')}`;
    }
    if (snap.buttons.length > 0) {
      prompt += `\n\n按钮:\n${snap.buttons.map(b => `  "${b.c}" → ${b.s}`).join('\n')}`;
    }
    if (snap.inputs.length > 0) {
      prompt += `\n\n输入框:\n${snap.inputs.map(i => {
        let desc = `  ${i.s} (${i.t})`;
        if (i.l) desc += ` label="${i.l}"`;
        if (i.n) desc += ` name="${i.n}"`;
        if (i.p) desc += ` placeholder="${i.p}"`;
        return desc;
      }).join('\n')}`;
    }
    if (snap.keyText) {
      prompt += `\n\n关键文本: "${snap.keyText}"`;
    }
    if (snap.stats) {
      prompt += `\n\n页面统计: ${snap.stats.links}个链接, ${snap.stats.images}张图片, ${snap.stats.forms}个表单, ${snap.stats.inputs}个输入框, ${snap.stats.buttons}个按钮`;
    }

    prompt += `

## 浏览器操作
回复中用 JSON 代码块执行操作。每个操作一个代码块：

\`\`\`json
{"action":"highlight","text":"要搜索和高亮的文字","color":"#FFEB3B"}
\`\`\`

\`\`\`json
{"action":"scrollTo","text":"要滚动到的文字"}
\`\`\`

\`\`\`json
{"action":"click","selector":"CSS选择器"}
\`\`\`

\`\`\`json
{"action":"fill","selector":"CSS选择器","value":"要填入的值"}
\`\`\`

\`\`\`json
{"action":"clearHighlights"}
\`\`\`

规则:
1. 使用上面列出的选择器(s)来精准定位元素（如 buttons 和 inputs 列表中的 s 值）
2. 高亮/滚动到文字时使用 highlight/scrollTo
3. 不要虚构页面中不存在的元素
4. JSON 代码块放在回复最后`;
  }

  return prompt;
}

/**
 * Handle send_message with security classification
 */
async function handleSendMessage(message, sender) {
  const { content, password, pageContext } = message;

  if (!content || !content.trim()) {
    return { success: false, error: '消息内容为空' };
  }

  // Check if setup is done
  const isSetup = await Storage.isSetup();
  if (!isSetup) {
    return { success: false, error: '请先设置安全密码' };
  }

  // Classify the operation
  const classification = classifyOperation(content);
  const needsPassword = classification.level !== 'SAFE';

  // If this is a password submission for a sensitive operation
  if (needsPassword && password) {
    const storedHash = await Storage.getPasswordHash();
    const valid = await verifyPassword(password, storedHash);
    if (!valid) {
      await Storage.addLog({
        role: 'user',
        message: content,
        classification: classification.level,
        forwarded: false,
        reason: '密码验证失败'
      });
      return { success: false, error: '密码错误，操作未授权', needsPassword: true, level: classification.level };
    }
    // Password valid — proceed
  } else if (needsPassword && !password) {
    // Sensitive operation but no password provided yet
    return {
      success: false,
      needsPassword: true,
      level: classification.level,
      matchedKeywords: classification.matchedKeywords,
      message: `此操作被分类为【${classification.level === 'DANGEROUS' ? '危险' : '敏感'}】级别，需要密码验证`
    };
  }

  // --- Forward to OpenClaw ---
  const baseUrl = await Storage.getOpenClawUrl();

  // Log the request
  await Storage.addLog({
    role: 'user',
    message: content,
    classification: classification.level,
    forwarded: true
  });

  // Check health first
  const { connected } = await checkHealth(baseUrl);
  if (!connected) {
    return { success: false, error: 'OpenClaw 未连接，请确保 OpenClaw 已在本地运行' };
  }

  // Build messages array with system prompt containing page context
  const messages = [];

  // System prompt with page context and browser action capabilities
  if (pageContext) {
    const systemPrompt = buildSystemPrompt(pageContext);
    messages.push({ role: 'system', content: systemPrompt });
  }

  // Get recent conversation history (last 10 exchanges)
  const logs = await Storage.getLogs();
  const recentMessages = logs
    .filter(l => l.role === 'user' || l.role === 'assistant')
    .slice(-10)
    .map(l => ({ role: l.role, content: l.message }));

  messages.push(...recentMessages);
  messages.push({ role: 'user', content });

  // Get gateway token
  const gatewayToken = await Storage.getGatewayToken();

  // Send
  const result = await sendMessage(baseUrl, messages, { gatewayToken });

  if (result.error) {
    await Storage.addLog({
      role: 'system',
      message: result.error,
      classification: 'ERROR',
      forwarded: false
    });
    return { success: false, error: result.error };
  }

  // Log the response
  await Storage.addLog({
    role: 'assistant',
    message: result.content,
    classification: classification.level,
    forwarded: true
  });

  return {
    success: true,
    content: result.content,
    classification: classification.level
  };
}

// --- Keep service worker alive ---

// Ping itself periodically to prevent service worker from being terminated
// This is important for maintaining the health check interval
chrome.alarms?.create('keepalive', { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    // Just a heartbeat — keeps the worker alive
  }
});

// Handle installation
chrome.runtime.onInstalled.addListener(async () => {
  await Storage.setConnectionStatus('disconnected');
  await Storage.setOpenClawUrl(DEFAULT_BASE_URL);
  console.log('[OpenClaw] Extension installed. Waiting for setup.');
});

console.log('[OpenClaw] Background service worker started.');

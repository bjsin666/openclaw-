/**
 * OpenClaw HTTP Client
 * Communicates with a locally-running OpenClaw gateway via OpenAI-compatible API
 * Default endpoint: http://127.0.0.1:18789
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:18789';
const HEALTH_TIMEOUT = 5000; // 5 seconds
const REQUEST_TIMEOUT = 60000; // 60 seconds

/**
 * Build headers with optional auth token
 * @param {string} gatewayToken
 * @returns {Object}
 */
function buildHeaders(gatewayToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (gatewayToken) {
    headers['Authorization'] = `Bearer ${gatewayToken}`;
  }
  return headers;
}

/**
 * Check if the OpenClaw gateway is reachable
 * @param {string} baseUrl
 * @returns {Promise<{ connected: boolean, error?: string }>}
 */
async function checkHealth(baseUrl) {
  const url = baseUrl || DEFAULT_BASE_URL;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_TIMEOUT);

    const response = await fetch(`${url}/health`, {
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    return { connected: response.ok };
  } catch (error) {
    return {
      connected: false,
      error: error.name === 'AbortError'
        ? '连接超时'
        : `无法连接到 OpenClaw: ${error.message}`
    };
  }
}

/**
 * Get available models from OpenClaw
 * @param {string} baseUrl
 * @returns {Promise<{ models?: Array, error?: string }>}
 */
async function getModels(baseUrl) {
  const url = baseUrl || DEFAULT_BASE_URL;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_TIMEOUT);

    const response = await fetch(`${url}/v1/models`, {
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      return { error: `获取模型列表失败 (HTTP ${response.status})` };
    }

    const data = await response.json();
    return { models: data.data || data.models || [] };
  } catch (error) {
    return { error: `获取模型列表失败: ${error.message}` };
  }
}

/**
 * Send a chat completion request (non-streaming)
 * @param {string} baseUrl
 * @param {Array} messages - Array of {role, content} objects
 * @param {Object} options - { model, temperature, maxTokens }
 * @returns {Promise<{ content?: string, error?: string }>}
 */
async function sendMessage(baseUrl, messages, options = {}) {
  const url = baseUrl || DEFAULT_BASE_URL;
  const {
    model = '',
    temperature = 0.7,
    maxTokens = 4096,
    gatewayToken = ''
  } = options;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    const body = {
      messages: messages,
      stream: false
    };
    if (model) body.model = model;
    if (temperature !== undefined) body.temperature = temperature;
    if (maxTokens) body.max_tokens = maxTokens;

    const response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(gatewayToken),
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      return { error: `OpenClaw 返回错误 (HTTP ${response.status}): ${errorText}` };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    return { content };
  } catch (error) {
    if (error.name === 'AbortError') {
      return { error: '请求超时，OpenClaw 未在60秒内响应' };
    }
    return { error: `请求失败: ${error.message}` };
  }
}

/**
 * Send a streaming chat completion request
 * Returns an async generator that yields content chunks
 * @param {string} baseUrl
 * @param {Array} messages - Array of {role, content} objects
 * @param {Object} options - { model, temperature, maxTokens }
 * @returns {AsyncGenerator<{ chunk?: string, done: boolean, error?: string }>}
 */
async function* sendMessageStream(baseUrl, messages, options = {}) {
  const url = baseUrl || DEFAULT_BASE_URL;
  const {
    model = '',
    temperature = 0.7,
    maxTokens = 4096,
    gatewayToken = ''
  } = options;

  let reader;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    const body = {
      messages: messages,
      stream: true
    };
    if (model) body.model = model;
    if (temperature !== undefined) body.temperature = temperature;
    if (maxTokens) body.max_tokens = maxTokens;

    const response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(gatewayToken),
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      clearTimeout(timeoutId);
      const errorText = await response.text().catch(() => '');
      yield { done: true, error: `OpenClaw 返回错误 (HTTP ${response.status}): ${errorText}` };
      return;
    }

    clearTimeout(timeoutId);
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const dataStr = trimmed.slice(6); // Remove 'data: ' prefix
        if (dataStr === '[DONE]') {
          yield { done: true };
          return;
        }

        try {
          const parsed = JSON.parse(dataStr);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            yield { chunk: delta, done: false };
          }
          // Check for finish reason
          if (parsed.choices?.[0]?.finish_reason) {
            yield { done: true };
            return;
          }
        } catch (e) {
          // Skip malformed JSON lines
        }
      }
    }

    yield { done: true };
  } catch (error) {
    if (error.name === 'AbortError') {
      yield { done: true, error: '请求超时' };
    } else {
      yield { done: true, error: `流式请求失败: ${error.message}` };
    }
  } finally {
    if (reader) {
      try { reader.releaseLock(); } catch (e) { /* ignore */ }
    }
  }
}

/**
 * Abort controller storage for cancelling ongoing requests
 */
const activeControllers = new Map();

/**
 * Send a cancellable streaming request
 * Returns a requestId that can be used to cancel
 */
async function* sendCancellableStream(baseUrl, messages, options = {}) {
  const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const abortController = new AbortController();
  activeControllers.set(requestId, abortController);

  try {
    const url = baseUrl || DEFAULT_BASE_URL;
    const body = {
      messages: messages,
      stream: true,
      model: options.model || '',
      temperature: options.temperature || 0.7,
      max_tokens: options.maxTokens || 4096
    };
    if (!body.model) delete body.model;

    const response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(options.gatewayToken || ''),
      body: JSON.stringify(body),
      signal: abortController.signal
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      yield { done: true, error: `OpenClaw 返回错误 (HTTP ${response.status}): ${errorText}` };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') {
          yield { done: true };
          return;
        }

        try {
          const parsed = JSON.parse(dataStr);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            yield { chunk: delta, done: false, requestId };
          }
          if (parsed.choices?.[0]?.finish_reason) {
            yield { done: true, requestId };
            return;
          }
        } catch (e) { /* skip */ }
      }
    }

    yield { done: true, requestId };
  } catch (error) {
    if (error.name === 'AbortError') {
      yield { done: true, error: '请求已取消', requestId };
    } else {
      yield { done: true, error: `请求失败: ${error.message}`, requestId };
    }
  } finally {
    activeControllers.delete(requestId);
  }
}

/**
 * Cancel an ongoing streaming request
 * @param {string} requestId
 */
function cancelRequest(requestId) {
  const controller = activeControllers.get(requestId);
  if (controller) {
    controller.abort();
    activeControllers.delete(requestId);
    return true;
  }
  return false;
}

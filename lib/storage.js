/**
 * Storage wrapper for chrome.storage.local
 * Manages settings, password hash, logs, and connection status
 */

const STORAGE_KEYS = {
  PASSWORD_HASH: 'passwordHash',
  IS_SETUP: 'isSetup',
  CONNECTION_STATUS: 'connectionStatus',
  OPENCLAW_URL: 'openclawUrl',
  GATEWAY_TOKEN: 'gatewayToken',
  LOGS: 'logs',
  SETTINGS: 'settings'
};

const MAX_LOGS = 500;

const Storage = {
  /**
   * Get a single value from storage
   */
  async get(key) {
    const result = await chrome.storage.local.get(key);
    return result[key];
  },

  /**
   * Get multiple values from storage
   */
  async getMany(keys) {
    return await chrome.storage.local.get(keys);
  },

  /**
   * Set a single value in storage
   */
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },

  /**
   * Set multiple values in storage
   */
  async setMany(items) {
    await chrome.storage.local.set(items);
  },

  /**
   * Remove a key from storage
   */
  async remove(key) {
    await chrome.storage.local.remove(key);
  },

  // --- Convenience methods ---

  async isSetup() {
    return !!(await this.get(STORAGE_KEYS.IS_SETUP));
  },

  async getPasswordHash() {
    return await this.get(STORAGE_KEYS.PASSWORD_HASH);
  },

  async setPasswordHash(hash) {
    await this.set(STORAGE_KEYS.PASSWORD_HASH, hash);
    await this.set(STORAGE_KEYS.IS_SETUP, true);
  },

  async getConnectionStatus() {
    return await this.get(STORAGE_KEYS.CONNECTION_STATUS) || 'disconnected';
  },

  async setConnectionStatus(status) {
    await this.set(STORAGE_KEYS.CONNECTION_STATUS, status);
  },

  async getOpenClawUrl() {
    return await this.get(STORAGE_KEYS.OPENCLAW_URL) || 'http://127.0.0.1:18789';
  },

  async setOpenClawUrl(url) {
    await this.set(STORAGE_KEYS.OPENCLAW_URL, url);
  },

  async getGatewayToken() {
    return await this.get(STORAGE_KEYS.GATEWAY_TOKEN) || '';
  },

  async setGatewayToken(token) {
    await this.set(STORAGE_KEYS.GATEWAY_TOKEN, token);
  },

  /**
   * Add a log entry, capping at MAX_LOGS
   */
  async addLog(entry) {
    const logs = await this.get(STORAGE_KEYS.LOGS) || [];
    logs.push({
      ...entry,
      timestamp: new Date().toISOString()
    });
    // Keep only the most recent MAX_LOGS entries
    if (logs.length > MAX_LOGS) {
      logs.splice(0, logs.length - MAX_LOGS);
    }
    await this.set(STORAGE_KEYS.LOGS, logs);
  },

  async getLogs() {
    return await this.get(STORAGE_KEYS.LOGS) || [];
  },

  async clearLogs() {
    await this.set(STORAGE_KEYS.LOGS, []);
  },

  /**
   * Get all settings
   */
  async getSettings() {
    return await this.get(STORAGE_KEYS.SETTINGS) || {};
  },

  /**
   * Update a specific setting
   */
  async updateSetting(key, value) {
    const settings = await this.getSettings();
    settings[key] = value;
    await this.set(STORAGE_KEYS.SETTINGS, settings);
  }
};

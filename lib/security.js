/**
 * Security module
 * - Password hashing (SHA-256)
 * - Operation classification (SAFE / SENSITIVE / DANGEROUS)
 * - Password verification
 *
 * Classification uses verb+target pattern matching. Instead of exact phrases,
 * we check if the message contains a dangerous/sensitive ACTION VERB combined
 * with a relevant TARGET (file, system, config, etc.).
 */

// === DANGEROUS: Verbs that modify, destroy, or execute ===
const DANGEROUS_VERBS = [
  // English
  'delete', 'remove', 'erase', 'wipe', 'purge', 'destroy',
  'write', 'save', 'create', 'make', 'generate', 'produce',
  'modify', 'edit', 'change', 'alter', 'update',
  'move', 'copy', 'duplicate', 'paste', 'cut',
  'install', 'uninstall', 'setup',
  'execute', 'run', 'launch', 'invoke',
  'overwrite', 'override', 'replace',
  'rename', 'chmod', 'chown', 'sudo',
  'commit', 'push', 'merge', 'rebase',
  'restart', 'shutdown', 'reboot', 'kill', 'terminate', 'stop service',
  'format', 'fdisk', 'mkfs', 'dd',
  'truncate', 'drop table', 'drop database',
  'crontab', 'systemctl',
  // Chinese
  '删除', '删掉', '删了', '移除', '清除', '清空', '抹掉', '干掉',
  '写入', '写出', '保存', '存为', '存储',
  '创建', '新建', '建立', '生成', '制作', '造一个', '弄一个',
  '修改', '编辑', '更改', '变更', '改动', '改变', '修正', '调整',
  '移动', '搬', '挪', '复制', '拷贝', '粘贴', '剪切',
  '安装', '卸载', '装上', '卸掉',
  '执行', '运行', '跑一下', '跑', '启动',
  '覆盖', '重写', '替换', '替代',
  '重命名', '改名', '更名为',
  '提交', '推送', '合并', '变基',
  '重启', '关机', '终止', '杀死', '杀掉', '停掉',
  '格式化', '分区',
  '下载到', '存到', '放到', '写到',
  '编译', '构建', '打包', '部署',
  '注入', '植入', '挂载'
];

// === SENSITIVE: Verbs that read, access, or expose ===
const SENSITIVE_VERBS = [
  // English
  'read', 'view', 'look at', 'see', 'show', 'display', 'preview',
  'list', 'search', 'find', 'locate', 'traverse', 'scan',
  'access', 'request', 'call', 'invoke api',
  'download', 'fetch', 'get url', 'curl', 'wget',
  'open file', 'open folder', 'open directory',
  'cat ', 'less ', 'more ', 'head ', 'tail ',
  'ls ', 'dir ', 'ls -',
  'git log', 'git diff', 'git show', 'git status',
  'docker ps', 'docker logs', 'docker inspect',
  'export env', 'print env',
  'ps ', 'top', 'htop', 'ifconfig', 'netstat',
  // Chinese
  '读取', '读出', '看看', '看一下', '看一眼', '读一下', '读',
  '查看', '浏览', '预览', '显示', '展示', '呈现',
  '搜索', '查找', '寻找', '找一下', '找找', '遍历',
  '访问', '请求', '调用', '调取',
  '下载', '拉取', '抓取', '爬取', '爬',
  '打开文件', '打开文件夹', '打开目录',
  '列出', '列举', '枚举', '遍历',
  '导出', '提取', '获取'
];

// Verb prefixes for Chinese (verb often starts the compound word)
// These are single-char or short radical prefixes that indicate an action
const DANGEROUS_PREFIXES = [
  '删', '写', '存', '建', '创', '改', '移', '复', '装', '卸',
  '执', '运', '跑', '覆', '替', '停', '杀', '格', '编', '构',
  '部', '注', '挂', '卸', '推', '提', '并', '重'
];

const SENSITIVE_PREFIXES = [
  '读', '看', '查', '搜', '找', '访', '调', '抓', '爬',
  '列', '导', '取', '获', '浏', '览', '显', '展', '示',
  '下', '载', '请', '求', '调'
];

// === FILE/SYSTEM TARGETS: Things being operated on ===
const FILE_TARGETS = [
  // English
  'file', 'folder', 'directory', 'document', 'doc',
  'desktop', 'downloads', 'download folder',
  'code', 'script', 'source', 'source code',
  'config', 'configuration', 'settings', 'setting',
  'env', 'environment', '.env', 'environment variable',
  'password', 'passwd', 'token', 'secret', 'credential', 'api key',
  'key', 'cert', 'certificate', 'private key',
  'log', 'logs', 'log file',
  'database', 'db', 'table', 'schema',
  'process', 'service', 'daemon', 'cron',
  'cookie', 'session', 'auth',
  'network', 'port', 'ip', 'dns',
  'ssh', 'scp', 'sftp',
  'registry', 'repository', 'repo',
  'disk', 'volume', 'partition',
  // Chinese
  '文件', '文件夹', '目录', '文档', '文本', '文件目录',
  '桌面', '下载', '下载目录', '我的文档', '文档目录',
  '代码', '脚本', '源码', '源代码', '程序',
  '配置', '设置', '环境变量', '配置文件',
  '密码', '密钥', '令牌', '凭据', 'apikey',
  '证书', '私钥', '公钥',
  '日志', '记录', '历史记录',
  '数据库', '数据表', '表', '模式',
  '进程', '服务', '守护进程', '定时任务',
  'cookie', 'session', '认证', '授权',
  '网络', '端口', '地址', 'ip',
  'ssh', '密钥对',
  '磁盘', '分区', '卷',
  '包', '依赖', '模块', '库',
  '注册表', '仓库'
];

// === Words that can appear between verb and target (connectors) ===
// These don't affect classification - just split verb from target
const CONNECTORS = ['的', '一个', '那个', '这个', '一下', '帮我', '请', '帮忙', '来'];

// === Edge cases: Safe contexts where even dangerous verbs are harmless ===
// Patterns that indicate the user is asking a question, not requesting action
const SAFE_CONTEXT_PATTERNS = [
  '怎么删', '如何删', '怎样删', '能不能删', '可以删吗',
  '怎么改', '如何改', '怎样改', '能不能改', '可以改吗',
  '怎么装', '如何装', '怎样装', '能不能装', '可以装吗',
  '是什么意思', '是什么', '怎么用', '如何使用',
  'what is', 'how to', 'how do i', 'can i', 'should i',
  'explain', '什么意思', '为什么', '教程', '教学'
];

/**
 * Check if message contains a safe/question context
 * @param {string} message
 * @returns {boolean}
 */
function hasSafeContext(message) {
  const lowerMsg = message.toLowerCase();
  for (const pattern of SAFE_CONTEXT_PATTERNS) {
    if (lowerMsg.includes(pattern.toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * Check if message contains any keyword from a list
 * @param {string} message
 * @param {string[]} keywords
 * @returns {string[]} matched keywords
 */
function matchKeywords(message, keywords) {
  const lowerMsg = message.toLowerCase();
  const matched = [];
  for (const kw of keywords) {
    if (lowerMsg.includes(kw.toLowerCase())) {
      matched.push(kw);
    }
  }
  return matched;
}

/**
 * Classify an operation based on its message content
 *
 * Strategy:
 * 1. If the message contains a DANGEROUS verb → DANGEROUS (unless safe context)
 * 2. If the message contains a SENSITIVE verb + FILE_TARGET → SENSITIVE
 * 3. Otherwise → SAFE
 *
 * This verb-based approach covers all natural language variations:
 *   "删掉test文件夹" → 删掉(DANGEROUS verb) → DANGEROUS
 *   "把桌面上最新那个文件删了" → 删了(DANGEROUS verb) → DANGEROUS
 *   "帮我看看下载目录里有什么" → 看看(SENSITIVE) + 下载(FILE) → SENSITIVE
 *   "帮我高亮页面上的文字" → 高亮(not in any list) → SAFE
 *
 * @param {string} message - The user's message
 * @returns {{ level: string, matchedKeywords: string[] }}
 */
function classifyOperation(message) {
  // First check safe context (asking questions, not requesting actions)
  if (hasSafeContext(message)) {
    return { level: 'SAFE', matchedKeywords: [] };
  }

  const matchedKeywords = [];

  // Step 1: Check for DANGEROUS verbs
  // These verbs are DANGEROUS regardless of target (they imply write/delete/execute)
  const dangerousHits = matchKeywords(message, DANGEROUS_VERBS);
  if (dangerousHits.length > 0) {
    return {
      level: 'DANGEROUS',
      matchedKeywords: dangerousHits
    };
  }

  // Step 2: Check for SENSITIVE verbs COMBINED with file/system targets
  const sensitiveHits = matchKeywords(message, SENSITIVE_VERBS);
  const targetHits = matchKeywords(message, FILE_TARGETS);

  if (sensitiveHits.length > 0 && targetHits.length > 0) {
    return {
      level: 'SENSITIVE',
      matchedKeywords: [...sensitiveHits, ...targetHits]
    };
  }

  // Step 3: If a SENSITIVE verb is used without a clear file target,
  // but the message also contains a dangerous Chinese prefix, treat as SENSITIVE
  if (sensitiveHits.length > 0) {
    const prefixHits = matchKeywords(message, DANGEROUS_PREFIXES);
    if (prefixHits.length > 0) {
      return {
        level: 'SENSITIVE',
        matchedKeywords: sensitiveHits
      };
    }
  }

  // Default: SAFE
  return { level: 'SAFE', matchedKeywords: [] };
}

/**
 * Check if an operation requires password verification
 * @param {string} message - The user's message
 * @returns {boolean}
 */
function requiresPassword(message) {
  const { level } = classifyOperation(message);
  return level === 'SENSITIVE' || level === 'DANGEROUS';
}

/**
 * Hash a string using SHA-256
 * Uses the Web Crypto API (available in service workers and content scripts)
 * @param {string} input
 * @returns {Promise<string>} hex-encoded hash
 */
async function sha256(input) {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify a password against the stored hash
 * @param {string} inputPassword - The password to verify
 * @param {string} storedHash - The stored SHA-256 hash
 * @returns {Promise<boolean>}
 */
async function verifyPassword(inputPassword, storedHash) {
  if (!inputPassword || !storedHash) return false;
  const inputHash = await sha256(inputPassword);
  return inputHash === storedHash;
}

/**
 * Validate password strength
 * @param {string} password
 * @returns {{ valid: boolean, reason: string }}
 */
function validatePasswordStrength(password) {
  if (!password || password.length < 6) {
    return { valid: false, reason: '密码长度至少为6位' };
  }
  return { valid: true, reason: '' };
}

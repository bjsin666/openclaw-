# OpenClaw 浏览器插件

一个 Chrome/Edge 浏览器扩展，在任意网页上通过悬浮窗与本地 OpenClaw AI 网关对话。内置安全中间件，对所有指令进行安全分级和密码验证后再转发，并通过结构化 DOM 快照让 AI 理解并操作当前页面。

## 功能总览

| 模块 | 功能 |
|------|------|
| **悬浮面板** | 右下角 48px 圆形图标（红/绿/黄状态灯），点击展开 380×520px 暗色聊天面板 |
| **安全中间件** | 动词驱动的操作分级，SHA-256 密码验证，敏感操作拦截后要求密码确认才转发 |
| **页面感知** | 自动采集页面 URL、标题、选中文字，并按需生成结构化 DOM 快照（标题树、链接列表、按钮/输入框及 CSS 选择器） |
| **浏览器操作** | openclaw 可通过 JSON 指令高亮文字、滚动定位、点击元素、填入表单，支持撤销/重做 |
| **操作日志** | 自动记录全部交互，上限 500 条，存储在 chrome.storage.local |
| **双重入口** | 悬浮窗（任意网页） + 工具栏弹窗（点击扩展图标） |

## 架构

```
┌──────────────────────────────────────────────────┐
│  网页 (任意 URL)                                   │
│  ┌──────────────────────────────────────────────┐ │
│  │  Content Script (content.js)                 │ │
│  │  ├─ 浮动图标 + 聊天面板 UI                     │ │
│  │  ├─ getPageContext() → DOM 结构化快照          │ │
│  │  └─ 浏览器操作引擎 (highlight/scrollTo/click/  │ │
│  │     fill/clearHighlights + undo/redo)        │ │
│  └──────────────┬───────────────────────────────┘ │
└─────────────────┼──────────────────────────────────┘
                  │ chrome.runtime.sendMessage
┌─────────────────┼──────────────────────────────────┐
│  后台 Service Worker (background/service-worker.js)│
│  ├─ 安全分级 (classifyOperation)                    │
│  ├─ 密码验证 (SHA-256 via Web Crypto API)           │
│  ├─ 操作日志                                       │
│  ├─ buildSystemPrompt() → 注入页面上下文            │
│  └─ 代理转发                                       │
│                  │                                   │
└──────────────────┼──────────────────────────────────┘
                   │ HTTP fetch (+ Bearer token)
┌──────────────────┼──────────────────────────────────┐
│  OpenClaw Gateway (127.0.0.1:18789)                 │
│  POST /v1/chat/completions                          │
└─────────────────────────────────────────────────────┘
```

## 安全设计

### 操作分级

不依赖固定短语列表，采用**动词驱动**的匹配策略，覆盖中英文自然语言：

| 级别 | 触发条件 | 示例 | 处理 |
|------|---------|------|------|
| **SAFE** | 不含危险/敏感动词 | "你好"、"今天的天气"、"解释一下这段代码" | 直接转发 |
| **SENSITIVE** | 含敏感动词 + 文件/系统目标 | "读取桌面文件"、"查看配置"、"访问这个网址" | 弹密码窗 |
| **DANGEROUS** | 含危险动词 | "删除文件夹"、"执行脚本"、"修改配置文件"、"提交代码" | 弹密码窗 |

安全上下文检测：以"怎么删除"、"如何修改"等**请教句式**开头不会误触发。

### 密码体系

- 首次使用强制设置密码（≥6 位）
- SHA-256 哈希存储于 `chrome.storage.local`，明文不落盘
- 浏览器重启后密码状态持久保留
- 支持修改密码（需先验证旧密码）
- 密码验证失败 → 指令**不发出**，openclaw 完全无感知

### 设计原则

**不修改 openclaw 任何代码**。所有安全逻辑在浏览器端中间件完成，openclaw 只收到已通过验证的请求。

## 页面感知机制

不是实时推送，而是**按需快照**。用户发消息时，插件先判断消息是否与页面相关（关键词匹配），相关时才提取结构化快照：

```
getPageContext()
  ├─ URL + 标题（始终携带）
  ├─ 用户选中文字（如有）
  └─ snapshot: {
        headings: [{t: "h1", c: "标题"}, ...]     ← 标题层级树
        links: [{c: "首页", h: "/"}, ...]          ← 链接及 href
        buttons: [{c: "提交", s: "#submit-btn"}]   ← 按钮及 CSS 选择器
        inputs: [{s: "#search", t: "text", p: "搜索..."}] ← 输入框及属性
        keyText: "页面核心段落..."                  ← 正文首段（≤300字）
        stats: {links: 42, forms: 2, ...}          ← 页面统计
      }
```

快照在**浏览器端预处理**，每类最多 30 条。选择器优先使用 `id` → `name` → `tag.class` → `tag:nth-of-type`，openclaw 可直接用于 click/fill 指令。

## 浏览器操作

openclaw 在回复中使用 JSON 代码块发出指令：

```json
{"action":"highlight","text":"关键词","color":"#FFEB3B"}
{"action":"scrollTo","text":"第三章"}
{"action":"click","selector":"#submit-btn"}
{"action":"fill","selector":"input[name='email']","value":"test@example.com"}
{"action":"clearHighlights"}
```

插件解析后直接操作当前页面 DOM，每条操作记录 undo 数据：

| 操作 | 撤销效果 |
|------|---------|
| highlight | 按批次 (`data-oc-batch`) 精准移除对应标记 |
| scrollTo | 滚回操作前位置 |
| click | 仅做视觉反馈，无法语义撤销 |
| fill | 恢复 input 旧值 |
| clearHighlights | 重建被清除的高亮标记 |

标题栏 ◂ ▸ 按钮控制撤销/重做，历史记录在 undo/redo 时自动刷新引用，支持连续交替操作。

## 项目结构

```
openclaw/
├── manifest.json                 # Manifest V3
├── background/
│   └── service-worker.js         # 安全中间件、日志、代理转发、系统提示词构建
├── content/
│   ├── content.js                # 悬浮图标、聊天面板、页面快照、浏览器操作引擎
│   └── content.css               # 完整暗色主题 UI（高亮动画、遮挡层、响应式）
├── popup/
│   ├── popup.html                # 工具栏弹窗页面
│   ├── popup.js                  # 弹窗交互（复用 lib 模块）
│   └── popup.css                 # 弹窗独立样式
├── lib/
│   ├── security.js               # SHA-256 哈希、动词驱动操作分级
│   ├── storage.js                # chrome.storage.local 封装
│   └── openclaw-client.js        # OpenClaw HTTP 客户端（支持流式 + Bearer 认证）
├── icons/
│   └── icon16/48/128.png         # 扩展图标
└── README.md
```

## 技术栈

- **纯原生 JavaScript + CSS**，无任何前端框架
- Chrome Extension Manifest V3
- Web Crypto API（SHA-256 哈希）
- chrome.storage.local（密码、设置、日志持久化）
- chrome.runtime.sendMessage（前后台通信）
- TreeWalker API（页面文字遍历与高亮）
- SSE 流式解析（openclaw streaming 支持）

## 部署与使用

### 前置条件

1. 本地已部署 OpenClaw 网关（`openclaw onboard --install-daemon`）
2. 在 `~/.openclaw/openclaw.json` 中开启 HTTP API：
   ```json
   "http": { "endpoints": { "chatCompletions": { "enabled": true } } }
   ```
3. 网关运行在 `http://127.0.0.1:18789`

### 安装扩展

1. 打开 `chrome://extensions/` → 开启「开发人员模式」
2. 点击「加载解压缩的扩展」→ 选择本目录
3. 扩展图标出现在工具栏

### 首次使用

1. 浏览任意网页 → 右下角出现悬浮图标
2. 点击图标 → 初次设置界面 → 设置安全密码（≥6 位）
3. 打开设置（⚙）→ 填入网关 Token（在 `openclaw.json` 的 `gateway.auth.token` 中）
4. 保存 → 状态灯变绿 → 可以开始对话

### 基本操作

- `Enter` 发送，`Shift+Enter` 换行
- 标题栏 ◂ ▸ 撤销/重做浏览器操作
- 设置中可修改密码、更换网关地址、清除日志

## 设计决策记录

| 决策 | 选择 | 原因 |
|------|------|------|
| 操作分级方式 | 动词驱动匹配 | 穷举完整短语无法覆盖中文的自然语言表达 |
| 页面信息传递 | 结构化 DOM 快照 | 原始 innerText 含大量噪音，浪费 token 且 AI 难以解析 |
| 高亮撤销实现 | `data-oc-batch` 属性 | DOM 引用在 normalize 后失效；CSS 选择器不受 DOM 变更影响 |
| undo/redo 引用 | 执行后返回新记录 | 交替操作时旧引用指向已销毁的 DOM 节点 |
| 密码存储 | chrome.storage.local | Manifest V3 标准持久化方案，浏览器重启不丢失 |
| UI 方案 | 纯 CSS 暗色主题 | 无框架依赖，`#openclaw-root` 前缀隔离避免污染宿主页面 |

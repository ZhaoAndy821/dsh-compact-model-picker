# dsh-compact-model-picker

[English](#english) | [中文说明](#中文说明)

---

<a name="english"></a>
# dsh-compact-model-picker

A DeepSeek Harness (DSH) plugin providing an **interactive model selector for context compaction (`/compact`)**.

Prevents burning expensive primary model quota (e.g. Claude 3.5 Sonnet / Opus / GPT-4) on summarizing conversation history by allowing the user to select a cheap model (e.g. DeepSeek-V3, R1, Flash, or Mini) on the fly before compaction runs.

---

## 💡 The Problem

When using high-tier models in DSH, running `/compact` (or automatic context compaction) will default to invoking the current session's primary model. For long conversations with 50k–100k+ tokens, passing the full prompt context to summarize history costs significant quota/money, even though compacting history only requires basic text summarization that cheap models can do equally well.

---

## ✨ Features & Mechanism

1. **Non-Intrusive Interception via `command.decorate`**:
   - Hooks into the DSH command registry's `compact` descriptor using the native `popupSelect` surface.
   - When the user types `/compact` and presses Enter (or clicks "压缩 / Compact" from the slash menu), it **does not immediately start**.
   - Instead, it forces open the official `PopupSelectView` modal right above the composer.

2. **Interactive Model Selection**:
   - Displays the real available models queried from the host catalog via `ctx.remote.session.modelCatalog()` (the client half injects the `remote` / `remote.session` faces it reads).
   - The first row is always `current`: "Current Session Model (default)", which keeps the engine's configured summarization target.
   - Flash / Mini / Lite / Haiku models get a "轻量便宜" badge; DeepSeek V3 / R1 get the "推荐·低成本" / "深度思考" badges when present in the catalog.
   - A fallback row set (DeepSeek V3, R1) is used when the catalog RPC is unavailable, so the picker always opens.
   - Built-in search box supports instant keyboard typing filter, arrow-key navigation, and Enter / mouse click.
   - Supports `Esc` or backdrop click to dismiss without firing any compaction.

3. **Safe Host-Side Execution via `/compact-execute`**:
   - Registers `/compact-execute [provider] [model]` as a **root-composition** command.
   - The `compaction` service lives inside each agent preset's `isolate` realm, so a root row cannot inject it. Instead the handler resolves the agent's own engine through the preset registry's public read-addressing API: `ctx.agentPresets.serviceFor(agent, 'compaction')` (with the root-plane `compaction` row as fallback for profiles composed without a preset roster). This is why the host half reports no pending service at boot.
   - With an explicit target, the engine's resolved config is swapped to `{ summarizationProvider, summarizationModel, modelPolicies: [] }` for exactly one `compactNow()` call and restored in `finally`; without a target the configured target is left untouched.
   - Works with DSH's `CompactionEngine` and `tool-result-pruner`; automatic (pressure) compaction is never affected.

---

## 📦 Directory Structure

```text
dsh-compact-model-picker/
├── cordis.patch.yml   # Bundle registration patch for Cordis
├── package.json       # Plugin manifest declaring host & web client entries
├── lib/
│   ├── index.js       # Host plugin: resolves the agent's preset compaction & registers /compact-execute
│   └── client.js      # Client plugin: decorates /compact with popupSelect modal
├── test/
│   ├── client.test.mjs# Client-side unit tests in VM sandbox
│   └── index.test.mjs # Host-side unit tests for routing & error formatting
└── README.md
```

---

## 🚀 Installation & Integration in DSH

1. Link the local repository to your active DSH profile (e.g., in `~/.dsh/profiles/web/package.json`):

```json
"dependencies": {
  "dsh-compact-model-picker": "github:ZhaoAndy821/dsh-compact-model-picker"
}
```

2. Add `dsh-compact-model-picker` to `dsh.profile.bundles` in the same `package.json`:

```json
"dsh": {
  "profile": {
    "bundles": [
      ...
      "dsh-compact-model-picker"
    ]
  }
}
```

3. Restart the DSH web profile, and you're good to go!

### Boot contract (why it loads without warnings)

- Host half: `inject = ["commands"]` only. `commands` is a root-plane service in every
  composed profile; the preset-scoped `compaction` engine is resolved per agent at call
  time, so the row never sits in "pending (waiting for service: compaction)".
- Client half: `inject = ["commandUi", "sessions", "remote", "remote.session"]`. The
  browser command registry is named `commandUi` (the host registry is `commands`);
  waiting for a client service called `commands` leaves the entry pending forever.
- Do not load this plugin as a hot plugin and a profile bundle at the same time:
  the same client factory id would register twice and the WebUI shows
  "Failed to load plugins". Profile bundle only.

Verified against the installed `@deepseek-ai/dsh` 0.1.7-rc.2 (Web profile) and
0.2.1-rc.3 (Desktop runtime): both expose `agentPresets.serviceFor(agent, name)`,
`compaction.compactNow(...)`, the `commandUi` client registry and the
`summarizationProvider` / `summarizationModel` / `modelPolicies` engine config keys.

---

<a name="中文说明"></a>
# 中文说明

DeepSeek Harness (DSH) 插件：为上下文压缩（`/compact`）提供**交互式模型选择弹窗**。

在执行会话压缩前，允许用户动态选择便宜模型（如 DeepSeek-V3、R1、Flash 或 Mini 系列）进行历史浓缩，避免用高单价主模型（如 Claude 3.5 Sonnet / Opus / GPT-4）全量跑压缩导致的巨额 Token 账单与额度浪费。

---

## 💡 痛点背景

在 DSH 中使用高阶商业模型时，默认执行 `/compact`（或自动上下文压缩）会直接调用当前会话的主模型本身。对于拥有数万甚至数十万 Token 的长会话，将全量上下文发给昂贵的主模型来生成摘要，会产生不菲的调用费用。而上下文总结与历史浓缩属于纯文本摘要任务，轻量、低成本的模型即可胜任。

---

## ✨ 核心特性与实现机制

1. **非侵入式弹窗拦截（通过 `command.decorate`）**：
   - 利用 DSH 客户端命令系统的原生 `popupSelect` 装饰器机制拦截 `/compact` 命令。
   - 当用户在输入框键入 `/compact` 按回车、或从 `/` 斜杠菜单中点击“压缩”时，**不会立刻向模型发送请求**。
   - 页面会直接在输入框上方展开 DSH 官方标准的 `PopupSelectView` 选择面板。

2. **交互式模型选择**：
   - 自动通过 `ctx.remote.session.modelCatalog()` 拉取宿主当前实际可用的模型目录。
   - **智能高亮低成本推荐模型**：
     - `deepseek/deepseek-chat`（DeepSeek-V3，标有“推荐·极低成本”徽章）。
     - `deepseek/deepseek-reasoner`（DeepSeek-R1，标有“深度思考”徽章）。
     - 各类 Flash / Mini 模型（如 `mimo-v2-flash`、`glm-4-flash` 等，自动标注高性价比）。
     - `current`：保留“当前会话模型（默认）”选项，方便按需使用原有主模型。
   - 自带实时搜索框（支持打字过滤）、键盘上下箭头导航、回车确认或鼠标点击。
   - 支持按 `Esc` 键或点击遮罩取消，取消后不发起任何压缩调用。

3. **宿主端安全执行（通过 `/compact-execute`）**：
   - 注册 `/compact-execute [provider] [model]` 命令。
   - 动态劫持 `ctx.compaction.summarize`，在执行压缩时仅为单次调用动态替换总结模型，并在 `finally` 块中严格还原原始配置，绝对不污染其他会话或全局设置。
   - 兼容 DSH 的预设作用域（Preset-Scoped）隔离机制与 `tool-result-pruner`。

---

## 📦 目录结构

```text
dsh-compact-model-picker/
├── cordis.patch.yml   # Cordis 插件生命周期装配 Patch
├── package.json       # 声明 Host 与 Web Client 入口及元数据
├── lib/
│   ├── index.js       # Host 服务端插件：解析模型目标并执行压缩
│   └── client.js      # Client 客户端插件：拦截 /compact 并弹出选择面板
├── test/
│   ├── client.test.mjs# 客户端在 VM 模拟沙箱中的单元测试
│   └── index.test.mjs # 服务端路由、隔离解析与错误处理单元测试
├── LICENSE            # MIT 开源许可证
└── README.md          # 中英文双语使用说明与架构文档
```

---

## 🚀 安装与集成指南

1. 在当前激活的 DSH Profile（如 `~/.dsh/profiles/web/package.json`）中添加依赖：

```json
"dependencies": {
  "dsh-compact-model-picker": "github:ZhaoAndy821/dsh-compact-model-picker"
}
```

2. 在同一 `package.json` 的 `dsh.profile.bundles` 列表中声明插件：

```json
"dsh": {
  "profile": {
    "bundles": [
      ...
      "dsh-compact-model-picker"
    ]
  }
}
```

3. 重启 DSH Web 实例（或重新加载 Web Profile），在会话输入框发送 `/compact` 即可开始使用。

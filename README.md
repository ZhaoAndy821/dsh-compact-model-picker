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

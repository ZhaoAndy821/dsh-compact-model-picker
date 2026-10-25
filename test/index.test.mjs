import test from "node:test";
import assert from "node:assert/strict";
import {
  parseModelTarget,
  apply,
  formatCompactionError,
  resolveCompaction
} from "../lib/index.js";

test("parseModelTarget handles various input formats", () => {
  assert.equal(parseModelTarget(""), null);
  assert.equal(parseModelTarget("   "), null);
  assert.deepEqual(parseModelTarget("deepseek/deepseek-chat"), {
    provider: "deepseek",
    model: "deepseek-chat"
  });
  assert.deepEqual(parseModelTarget("  deepseek/deepseek-reasoner  "), {
    provider: "deepseek",
    model: "deepseek-reasoner"
  });
  assert.deepEqual(parseModelTarget("openai gpt-4o-mini"), {
    provider: "openai",
    model: "gpt-4o-mini"
  });
  assert.deepEqual(parseModelTarget("deepseek-chat"), {
    provider: "deepseek",
    model: "deepseek-chat"
  });
  // A model id may itself contain slashes; only the first one separates provider.
  assert.deepEqual(parseModelTarget("openrouter/anthropic/claude-3.5"), {
    provider: "openrouter",
    model: "anthropic/claude-3.5"
  });
});

test("formatCompactionError handles all known codes and fallback", () => {
  assert.equal(formatCompactionError({ code: "busy" }).text.includes("忙碌"), true);
  assert.equal(formatCompactionError({ code: "cancelled" }).text.includes("已取消"), true);
  assert.equal(formatCompactionError({ code: "changed" }).text.includes("变更"), true);
  assert.equal(formatCompactionError({ code: "summary" }).text.includes("精简摘要"), true);
  assert.equal(formatCompactionError({ code: "commit" }).text.includes("历史"), true);
  assert.equal(formatCompactionError({ code: "persistence" }).text.includes("磁盘"), true);
  assert.equal(formatCompactionError({ code: "weird", message: "boom" }).text.includes("weird"), true);
  assert.equal(formatCompactionError(new Error("unexpected")).text.includes("unexpected"), true);
});

function makeCtx({ compaction, registry } = {}) {
  const state = { registered: null, effects: [] };
  const ctx = {
    commands: {
      register: (definition) => {
        state.registered = definition;
        return () => {
          state.registered = null;
        };
      }
    },
    get(name) {
      if (name === "agentPresets") return registry;
      if (name === "compaction") return compaction;
      return undefined;
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect(fn) {
      state.effects.push(fn());
    }
  };
  return { ctx, state };
}

function makeCompaction() {
  return {
    config: {
      summarizationProvider: "",
      summarizationModel: "",
      modelPolicies: [],
      maxTokens: 4096
    },
    seenConfigs: [],
    async compactNow() {
      this.seenConfigs.push({ ...this.config });
      return { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 1500, summarySeq: 4 };
    }
  };
}

test("apply registers /compact-execute and uses the agent's preset-scoped compaction", async () => {
  const compaction = makeCompaction();
  const registry = {
    serviceFor(agent, name) {
      assert.equal(agent.session.id, "s1");
      assert.equal(name, "compaction");
      return compaction;
    }
  };
  const { ctx, state } = makeCtx({ compaction, registry });
  apply(ctx);

  assert.ok(state.registered, "compact-execute must be registered");
  assert.equal(state.registered.name, "compact-execute");
  assert.equal(state.registered.input.hint, "[provider model]");

  const outcome = await state.registered.handler({
    rawInput: "deepseek/deepseek-chat",
    agent: { session: { id: "s1" } },
    signal: new AbortController().signal,
    commandId: "cmd-1"
  });

  assert.equal(outcome.kind, "success");
  assert.ok(outcome.text.includes("[deepseek/deepseek-chat]") === false);
  assert.ok(outcome.text.includes("deepseek/deepseek-chat"));
  assert.equal(outcome.sourceEventSeq, 4);
  assert.equal(compaction.seenConfigs.length, 1);
  assert.equal(compaction.seenConfigs[0].summarizationProvider, "deepseek");
  assert.equal(compaction.seenConfigs[0].summarizationModel, "deepseek-chat");
  assert.equal(compaction.seenConfigs[0].modelPolicies.length, 0);
  // Restored after the run.
  assert.equal(compaction.config.summarizationProvider, "");
  assert.equal(compaction.config.summarizationModel, "");
});

test("compact-execute without a target keeps the configured target", async () => {
  const compaction = makeCompaction();
  compaction.config.summarizationProvider = "deepseek";
  compaction.config.summarizationModel = "deepseek-chat";
  const { ctx, state } = makeCtx({ compaction, registry: { serviceFor: () => compaction } });
  apply(ctx);

  const outcome = await state.registered.handler({
    rawInput: "",
    agent: { session: { id: "s2" } },
    signal: new AbortController().signal,
    commandId: "cmd-2"
  });
  assert.equal(outcome.kind, "success");
  assert.ok(outcome.text.includes("默认模型"));
  assert.equal(compaction.seenConfigs[0].summarizationProvider, "deepseek");
});

test("resolveCompaction falls back to the root-plane service when no preset roster is composed", () => {
  const rootCompaction = { compactNow() {} };
  const ctxWithRoster = makeCtx({ compaction: rootCompaction, registry: { serviceFor: () => undefined } }).ctx;
  assert.equal(resolveCompaction(ctxWithRoster, { session: { id: "s" } }), rootCompaction);
  const ctxWithoutRoster = makeCtx({ compaction: rootCompaction }).ctx;
  assert.equal(resolveCompaction(ctxWithoutRoster, { session: { id: "s" } }), rootCompaction);
});

test("compact-execute maps engine failures to command outcomes", async () => {
  const compaction = {
    config: {},
    async compactNow() {
      const error = new Error("busy");
      error.code = "busy";
      throw error;
    }
  };
  const { ctx, state } = makeCtx({ registry: { serviceFor: () => compaction } });
  apply(ctx);
  const outcome = await state.registered.handler({
    rawInput: "deepseek/deepseek-chat",
    agent: { session: { id: "s3" } },
    signal: new AbortController().signal,
    commandId: "cmd-3"
  });
  assert.equal(outcome.kind, "error");
  assert.ok(outcome.text.includes("忙碌"));
});

test("compact-execute reports a missing compaction engine instead of throwing", async () => {
  const { ctx, state } = makeCtx({});
  apply(ctx);
  const outcome = await state.registered.handler({
    rawInput: "",
    agent: { session: { id: "s4" } },
    signal: new AbortController().signal,
    commandId: "cmd-4"
  });
  assert.equal(outcome.kind, "error");
  assert.ok(outcome.text.length > 0);
});

import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

/** Execute the client bundle in a VM context and return its loader entry. */
function loadBundle() {
  const code = fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  let entry = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (value) => {
          entry = value;
        }
      }
    },
    console: {
      warn: () => {},
      log: () => {},
      error: () => {}
    }
  };
  vm.runInNewContext(code, sandbox);
  assert.ok(entry, "bundle must register itself with __ModuleLoader__.load");
  return entry;
}

const DEFAULT_CATALOG = {
  ok: true,
  value: {
    groups: [
      {
        id: "deepseek",
        name: "DeepSeek",
        models: [
          { id: "deepseek-chat", name: "DeepSeek-V3", description: "Cheap official" },
          { id: "deepseek-reasoner", name: "DeepSeek-R1", description: "Reasoning" }
        ]
      },
      {
        id: "anthropic",
        name: "Anthropic",
        models: [{ id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet", description: "Expensive main" }]
      }
    ]
  }
};

/**
 * @param {{ catalog?: any, commandResult?: (line: string) => any }} options
 */
function makeCtx(options = {}) {
  const calls = [];
  const state = { decoration: null };
  const session = {
    sessionId: "sess-abc",
    command: async (line) => {
      calls.push(line);
      return options.commandResult ? options.commandResult(line) : { ok: true, value: { matched: true } };
    }
  };
  const ctx = {
    get: (name) => {
      if (name !== "commandUi") return undefined;
      return {
        decorate: (decoration) => {
          state.decoration = decoration;
          return () => {
            state.decoration = null;
          };
        }
      };
    },
    sessions: {
      binding: (sessionId) => (sessionId === "sess-abc" ? { session } : undefined)
    },
    remote: options.catalog === false
      ? undefined
      : { session: { modelCatalog: async () => options.catalog ?? DEFAULT_CATALOG } },
    effect: (fn) => fn()
  };
  return { ctx, state, calls, session };
}

test("client bundle exports the plugin identity and real client services", () => {
  const entry = loadBundle();
  assert.equal(entry.id, "dsh-compact-model-picker");
  const exports = entry.factory(() => {
    throw new Error("unexpected require");
  });
  assert.equal(exports.name, "compact-model-picker");
  assert.deepEqual([...exports.inject], ["commandUi", "sessions", "remote", "remote.session"]);
  assert.equal(typeof exports.apply, "function");
});

test("apply decorates /compact with a popupSelect over the host model catalog", async () => {
  const entry = loadBundle();
  const exports = entry.factory(() => {
    throw new Error("unexpected require");
  });
  const { ctx, state } = makeCtx();
  exports.apply(ctx);

  const decoration = state.decoration;
  assert.ok(decoration, "command.decorate must be invoked");
  assert.equal(decoration.name, "compact");
  assert.equal(decoration.ui.kind, "popupSelect");
  assert.equal(decoration.available(), true);

  const options = await decoration.ui.options({ sessionId: "sess-abc" });
  assert.ok(Array.isArray(options));
  assert.equal(options[0].id, "current");

  const v3 = options.find((option) => option.id === "deepseek/deepseek-chat");
  assert.ok(v3, "DeepSeek V3 row must be listed");
  assert.equal(v3.provider, "deepseek");
  assert.equal(v3.model, "deepseek-chat");
  assert.ok(v3.badge.includes("低成本"));

  const claude = options.find((option) => option.id === "anthropic/claude-3-5-sonnet");
  assert.ok(claude, "every catalog model must be listed");
});

test("selecting a model executes /compact-execute with provider and model", async () => {
  const entry = loadBundle();
  const exports = entry.factory(() => {
    throw new Error("unexpected require");
  });
  const { ctx, state, calls } = makeCtx();
  exports.apply(ctx);

  const options = await state.decoration.ui.options({ sessionId: "sess-abc" });
  await state.decoration.ui.onSelect(options.find((option) => option.id === "deepseek/deepseek-chat"), { sessionId: "sess-abc" });
  assert.deepEqual(calls, ["/compact-execute deepseek deepseek-chat"]);

  await state.decoration.ui.onSelect(options[0], { sessionId: "sess-abc" });
  assert.deepEqual(calls, ["/compact-execute deepseek deepseek-chat", "/compact-execute"]);
});

test("client falls back to static rows when the remote catalog is unavailable", async () => {
  const entry = loadBundle();
  const exports = entry.factory(() => {
    throw new Error("unexpected require");
  });
  const { ctx, state } = makeCtx({ catalog: false });
  exports.apply(ctx);
  const options = await state.decoration.ui.options({ sessionId: "sess-abc" });
  assert.equal(options.length, 3);
  assert.equal(options[0].id, "current");
  assert.ok(options.some((option) => option.id === "deepseek/deepseek-chat"));
});

test("client surfaces host failures instead of silently closing the popup", async () => {
  const entry = loadBundle();
  const exports = entry.factory(() => {
    throw new Error("unexpected require");
  });
  const failure = makeCtx({
    commandResult: () => ({ ok: false, error: { code: "busy", message: "agent busy" } })
  });
  exports.apply(failure.ctx);
  await assert.rejects(
    failure.state.decoration.ui.onSelect({ id: "current" }, { sessionId: "sess-abc" }),
    /busy/
  );

  const unmatched = makeCtx({ commandResult: () => ({ ok: true, value: { matched: false } }) });
  exports.apply(unmatched.ctx);
  await assert.rejects(
    unmatched.state.decoration.ui.onSelect({ id: "current" }, { sessionId: "sess-abc" }),
    /compact-execute/
  );
});

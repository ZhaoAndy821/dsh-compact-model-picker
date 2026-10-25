/**
 * @file dsh-compact-model-picker - Host half.
 *
 * Implements model-directed compaction execution for DSH.
 *
 * The client picker emits '/compact-execute [provider] [model]' after the
 * human picks a summarization model. This half registers that command and runs
 * exactly one manual compaction through the official compaction seam
 * (CompactionEngine.compactNow) with the chosen provider/model bound to the
 * summarization call only; the engine's own configuration is restored in a
 * finally block, so later automatic compaction is untouched.
 *
 * Why this row lives on the root composition rather than inside a preset:
 * every agent preset mounts its compaction engine inside an isolate realm
 * (isolate: { compaction: true }), so a root row cannot inject the service -
 * doing so used to leave the row "pending (waiting for service: compaction)"
 * at web boot. The agent-preset registry exposes agentPresets.serviceFor(agent,
 * name) for a caller that already holds the agent ("read addressing"), which is
 * precisely this case: the command handler receives invocation.agent. The
 * root-plane compaction service remains as a fallback for profiles composed
 * without an agent-preset roster.
 */

/** Brand function used when a command definition id is wanted without importing the brand module. */
function brandCommandId(id) {
  return id;
}

/**
 * Convert expected capability failures into concise human-readable outcomes.
 * @param {any} error
 * @returns {{ kind: "error", text: string }}
 */
export function formatCompactionError(error) {
  const code = error?.code;
  if (code) {
    switch (code) {
      case "busy":
        return {
          kind: "error",
          text: "压缩暂不可用：当前有正在进行的压缩任务，或 Agent 处于忙碌状态。"
        };
      case "cancelled":
        return {
          kind: "error",
          text: "压缩已取消。"
        };
      case "changed":
        return {
          kind: "error",
          text: "待压缩的会话历史在替换前发生变更，请重试。"
        };
      case "summary":
        return {
          kind: "error",
          text: "压缩模型未能生成有效的精简摘要（生成的摘要未小于原上下文），请尝试更换其他模型或积累更多历史再试。"
        };
      case "commit":
        return {
          kind: "error",
          text: "压缩提交未完成，部分历史可能已改变，请检查当前会话状态。"
        };
      case "persistence":
        return {
          kind: "error",
          text: "压缩已完成，但会话未能成功保存至磁盘。"
        };
      default:
        return {
          kind: "error",
          text: "压缩失败 (" + code + "): " + (error.message || String(error))
        };
    }
  }
  return {
    kind: "error",
    text: "压缩执行异常: " + (error instanceof Error ? error.message : String(error))
  };
}

/**
 * Parse raw input into target provider and model.
 * Supports:
 *   "provider model" (e.g. "deepseek deepseek-chat")
 *   "provider/model" (e.g. "deepseek/deepseek-chat", model may contain '/')
 * A single bare word is read as a model of the default provider ("deepseek"),
 * which keeps the historical shorthand working.
 * @param {string} rawInput
 * @returns {{ provider: string, model: string } | null}
 */
export function parseModelTarget(rawInput) {
  const trimmed = String(rawInput ?? "").trim();
  if (!trimmed) return null;

  if (trimmed.includes("/")) {
    const slashIdx = trimmed.indexOf("/");
    const provider = trimmed.slice(0, slashIdx).trim();
    const model = trimmed.slice(slashIdx + 1).trim();
    if (provider && model) return { provider, model };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) return { provider: parts[0], model: parts[1] };
  return { provider: "deepseek", model: parts[0] };
}

export const name = "dsh-compact-model-picker";
export const inject = ["commands"];

/**
 * Run one manual compaction, mapping expected failures onto command outcomes.
 * @param {any} compaction - the agent's compaction engine instance.
 * @param {any} invocation - command invocation ({ agent, signal, commandId }).
 * @param {{ provider: string, model: string } | null} target - explicit summarization target.
 * @param {any} ctx - plugin context (for logging).
 * @returns {Promise<{ kind: "success" | "error", text?: string, sourceEventSeq?: number }>}
 */
async function runCompaction(compaction, invocation, target, ctx) {
  const sessionId = invocation.agent?.session?.id;
  const modelLabel = target ? target.provider + "/" + target.model : "默认模型";
  try {
    if (target) {
      ctx.logger?.info?.(
        "[compact-model-picker] compaction requested with " + modelLabel + " for session " + sessionId
      );
    }
    const result = await compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId);
    if (result === null) {
      return {
        kind: "success",
        text: "当前会话暂无可压缩的历史（或保留窗口内不足以产生有效缩减）。"
      };
    }
    return {
      kind: "success",
      text: "已使用 " + modelLabel + " 压缩 " + result.shadowedSeqs.length + " 条历史（约 " + result.shadowedTokenCount + " tokens）。",
      sourceEventSeq: result.summarySeq
    };
  } catch (error) {
    if (invocation.signal?.aborted) return { kind: "error", text: "压缩已取消。" };
    return formatCompactionError(error);
  }
}

/**
 * Resolve the compaction engine for the agent in hand.
 *
 * Preset realms own the canonical instance; the root plane only has one when
 * the composition is not preset-based. serviceFor() is the registry's public
 * read-addressing API for exactly this cross-realm lookup.
 * @param {any} ctx - plugin context.
 * @param {any} agent - the command's receiving agent.
 * @returns {any} the compaction engine, or undefined.
 */
export function resolveCompaction(ctx, agent) {
  const registry = ctx.get?.("agentPresets");
  const scoped = registry?.serviceFor?.(agent, "compaction");
  if (scoped !== undefined) return scoped;
  return ctx.get?.("compaction");
}

/**
 * Mount the host half: one explicitly-targeted compaction command.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.commands.register({
        definitionId: brandCommandId("@deepseek-ai/dsh-compact-model-picker/execute"),
        name: "compact-execute",
        description: "Compact older conversation history using an explicitly specified model",
        input: { hint: "[provider model]" },
        handler: async (invocation) => {
          const target = parseModelTarget(invocation.rawInput);
          const compaction = resolveCompaction(ctx, invocation.agent);
          if (compaction === undefined || typeof compaction.compactNow !== "function") {
            return {
              kind: "error",
              text: "当前会话没有可用压缩引擎（compaction 服务未挂载）。"
            };
          }
          if (target === null) return runCompaction(compaction, invocation, null, ctx);
          if (typeof compaction.config !== "object" || compaction.config === null) {
            return {
              kind: "error",
              text: "当前压缩引擎不支持指定摘要模型。"
            };
          }
          const originalConfig = compaction.config;
          try {
            compaction.config = {
              ...originalConfig,
              summarizationProvider: target.provider,
              summarizationModel: target.model,
              modelPolicies: []
            };
            return await runCompaction(compaction, invocation, target, ctx);
          } finally {
            compaction.config = originalConfig;
          }
        }
      }),
    "compact-model-picker: /compact-execute"
  );
}

export default { name, inject, apply };

window.__ModuleLoader__.load({
	id: "dsh-compact-model-picker",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const name = "compact-model-picker";
		/**
		 * Client services this extension needs. DSH names this registry "commandUi"
		 * in the browser runtime (the Host's registry is "commands"); waiting for a
		 * service called "commands" here would leave the client half pending forever.
		 * The remote faces are declared because the model catalog is fetched through
		 * them - an un-injected service throws "cannot get property ... without inject".
		 */
		const inject = ["commandUi", "sessions", "remote", "remote.session"];

		/** Static rows used when the remote model catalog cannot be reached. */
		const FALLBACK_ROWS = [
			{
				id: "current",
				label: "当前会话模型（默认）",
				detail: "保持当前会话主模型压缩（按该模型价格计费）",
				active: true
			},
			{
				id: "deepseek/deepseek-chat",
				provider: "deepseek",
				model: "deepseek-chat",
				label: "DeepSeek V3 (deepseek-chat)",
				badge: "推荐·低成本",
				detail: "官方 V3 模型，成本低，适合长上下文压缩"
			},
			{
				id: "deepseek/deepseek-reasoner",
				provider: "deepseek",
				model: "deepseek-reasoner",
				label: "DeepSeek R1 (deepseek-reasoner)",
				badge: "深度思考",
				detail: "R1 推理模型，适合复杂工程决策的归纳"
			}
		];

		/**
		 * Badge/detail copy for one catalog model.
		 * @param {string} providerId
		 * @param {string} modelId
		 * @param {string | undefined} declaredDetail
		 * @returns {{ badge?: string, detail?: string }}
		 */
		function describeModel(providerId, modelId, declaredDetail) {
			const id = String(modelId).toLowerCase();
			if (providerId === "deepseek" && id === "deepseek-chat") {
				return { badge: "推荐·低成本", detail: declaredDetail || "官方 V3 模型，成本低，适合长上下文压缩" };
			}
			if (providerId === "deepseek" && id === "deepseek-reasoner") {
				return { badge: "深度思考", detail: declaredDetail || "R1 推理模型，适合复杂工程决策的归纳" };
			}
			if (id.includes("flash") || id.includes("mini") || id.includes("lite") || id.includes("haiku")) {
				return { badge: "轻量便宜", detail: declaredDetail || "轻量高性价比模型，适合快速摘要" };
			}
			return declaredDetail ? { detail: declaredDetail } : {};
		}

		/**
		 * Build the popup rows from the Host model catalog.
		 * @param {any} ctx - client root context.
		 * @returns {Promise<Array<Record<string, any>>>}
		 */
		async function loadModelOptions(ctx) {
			const current = {
				id: "current",
				label: "当前会话模型（默认）",
				detail: "保持当前会话主模型压缩（按该模型价格计费）",
				active: true
			};
			const remote = ctx.remote;
			if (remote === undefined || remote.session === undefined || typeof remote.session.modelCatalog !== "function") {
				return FALLBACK_ROWS;
			}
			try {
				const response = await remote.session.modelCatalog();
				const groups = response && response.ok ? response.value && response.value.groups : undefined;
				if (!Array.isArray(groups)) return FALLBACK_ROWS;
				const rows = [current];
				for (const group of groups) {
					const providerId = group && group.id;
					if (typeof providerId !== "string" || providerId.length === 0) continue;
					const providerName = (group && group.name) || providerId;
					for (const model of (group && group.models) || []) {
						const modelId = model && model.id;
						if (typeof modelId !== "string" || modelId.length === 0) continue;
						const text = describeModel(providerId, modelId, model.description);
						rows.push({
							id: providerId + "/" + modelId,
							provider: providerId,
							model: modelId,
							label: (model.name || modelId) + " (" + providerName + ")",
							...text.badge === undefined ? {} : { badge: text.badge },
							...text.detail === undefined ? {} : { detail: text.detail }
						});
					}
				}
				return rows;
			} catch (error) {
				console.warn("[compact-model-picker] model catalog load failed, using fallback:", error);
				return FALLBACK_ROWS;
			}
		}

		/**
		 * Decorate the Host '/compact' command with an interactive model picker.
		 * @param {any} ctx - client root context.
		 */
		function apply(ctx) {
			const command = ctx.get("commandUi");
			const sessions = ctx.sessions;
			if (command === undefined) {
				console.warn("[compact-model-picker] commandUi service is unavailable on this client");
				return;
			}
			const liveSession = (session) => {
				if (sessions === undefined || typeof sessions.binding !== "function") return undefined;
				const binding = sessions.binding(session && session.sessionId);
				return binding && binding.session;
			};
			ctx.effect(() => command.decorate({
				name: "compact",
				available: () => true,
				ui: {
					kind: "popupSelect",
					options: async () => await loadModelOptions(ctx),
					onSelect: async (option, session) => {
						const live = liveSession(session);
						if (live === undefined) throw new Error("该会话尚未就绪，无法执行压缩。");
						const line = option && (option.id === "current" || option.provider === undefined)
							? "/compact-execute"
							: "/compact-execute " + option.provider + " " + option.model;
						const result = await live.command(line);
						if (!result || result.ok !== true) {
							const cause = result && result.error ? result.error.code + ": " + result.error.message : "unknown error";
							throw new Error("压缩失败：" + cause);
						}
						if (!result.value || result.value.matched !== true) {
							throw new Error("宿主没有 /compact-execute 命令：dsh-compact-model-picker 的宿主半边未加载。");
						}
					}
				}
			}), "compact-model-picker: /compact decoration");
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});

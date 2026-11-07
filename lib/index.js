/**
 * dsh-suggest-actions —— Host 侧。
 *
 * 只做一件事：注册 `suggest_actions` 工具。模型收尾时调用一次，参数里带 1-5 条建议；
 * 工具立刻返回并**结束这一轮**（`concludeTurn()`），真正把建议画成按钮的是客户端插件
 * （lib/client.js）。
 *
 * 为什么不用官方的 ask_user_question：那个的语义是"提问等回答"，会把整轮挂起；
 * 建议按钮要的是"顺带给几个下一步"，不打断这一轮。
 *
 * 0.2.0 起的三处省 token 设计（依据见 CHANGELOG 0.2.0）：
 *   1. 工具说明压到原来的约三分之一：同一条立场规则不再在说明、参数里各讲一遍。
 *   2. 建议名单走 `output.presentationMeta`（随会话日志落盘、只给界面读），
 *      模型看到的工具结果只剩一句话。旧版把整份名单 JSON 又塞回模型上下文。
 *   3. 调用即收尾：`exec.concludeTurn()` 让这一轮在这一步结束，省掉"工具返回后
 *      模型再跑一步只为说句收尾话"的那次往返。旧宿主没有这个方法时照旧多跑一步。
 *
 * 参数清洗在 `lib/normalize.js`（纯函数、可单测），这里只负责接线与配置。
 */
import Schema from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { ANGLES, PLUGIN_REV, TOOL_DESCRIPTION, declaresFor, normalizeActions } from "./normalize.js";

const name = "dsh-suggest-actions";

/** 只依赖工具注册表；不碰会话、不碰用户问答。 */
const inject = ["tools"];

/**
 * 插件配置。写在插件自己的 bundle patch（`cordis.patch.yml`）那一行的 `config` 下。
 */
const Config = Schema.object({
	maxActions: Schema.number().default(5).description("单次最多显示几条建议（1–6），超出的丢弃。"),
	concludeTurn: Schema.boolean().default(true).description("有可用建议时直接结束本轮，省去模型多跑一步收尾。")
});

/** 立场的一句话定义，只写在 enum 旁边这一处。 */
const ANGLE_DESCRIPTION = "cautious: smaller step, verify first. standard: the sensible move. bold: same route, pushed harder. alternative: drop the current approach. stop: no need to do it.";

/** 推荐置顶、`stop` 垫底的排序由 normalize 负责，模型不必知道，所以说明里不再讲。 */
const parameters = {
	actions: {
		type: "array",
		required: true,
		items: {
			type: "object",
			additionalProperties: true,
			properties: {
				angle: { type: "string", required: true, enum: [...ANGLES], description: ANGLE_DESCRIPTION },
				label: { type: "string", required: true, description: "Button text, short, e.g. \"先跑测试再提交\"." },
				prompt: { type: "string", description: "Longer text to send instead of the label." },
				recommended: { type: "boolean" },
				opensNewSession: { type: "boolean", description: "Open a fresh session with `prompt` as its draft (a handoff brief) instead of sending here; for sessions grown too long. At most one." }
			}
		}
	}
};

function apply(ctx, config) {
	const maxActions = config?.maxActions ?? 5;
	const concludeTurn = config?.concludeTurn !== false;
	const tool = defineTool({
		name: "suggest_actions",
		description: TOOL_DESCRIPTION,
		parameters,
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					shown: { type: "integer", required: true }
				}
			},
			// 模型只需知道成没成；名单走 presentationMeta，不回灌上下文。
			render: (_args, value) => [{
				type: "text",
				text: value.shown > 0
					? `${value.shown} suggestion(s) shown under your reply.`
					: "No suggestions shown: every entry lacked a usable label."
			}],
			// 界面读的那份：随 tool/result 落盘，重放与实时两条路径都能拿到，模型看不见。
			presentationMeta: (args) => ({ rev: PLUGIN_REV, actions: normalizeActions(args.actions, maxActions) })
		},
		async execute(args, exec) {
			const shown = normalizeActions(args.actions, maxActions).length;
			// 有按钮才收尾：全被洗掉时让模型照常说完这句话。
			if (shown > 0 && concludeTurn && typeof exec?.concludeTurn === "function") exec.concludeTurn();
			return { shown };
		}
	});
	const options = { when: ({ agent }) => declaresFor(agent) };
	try {
		ctx.tools.register(tool, options);
	} catch {
		// 旧宿主的 register 不认第二个参数时退回全局声明，功能不受影响。
		ctx.tools.register(tool);
	}
}

export { Config, apply, inject, name };

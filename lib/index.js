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
import { ANGLES, normalizeActions } from "./normalize.js";

const name = "dsh-suggest-actions";

/**
 * 版本戳：随 presentationMeta 交给客户端（客户端只读 `actions`，会忽略它）。
 *
 * 2026-09-30 排查"上限改了，界面还是 3 条"时加的：光看行为分不清 host 加载的是
 * 哪一份代码。0.2.0 起它不再进模型上下文，排查时到会话日志的 `tool/result.meta` 里看。
 */
const PLUGIN_REV = "0.2.0";

/** 只依赖工具注册表；不碰会话、不碰用户问答。 */
const inject = ["tools"];

/**
 * 插件配置。写在插件自己的 bundle patch（`cordis.patch.yml`）那一行的 `config` 下。
 */
const Config = Schema.object({
	maxActions: Schema.number().default(5).description("单次最多显示几条建议（1–6），超出的丢弃。")
});

/**
 * 模型看到的工具说明。每句只讲一件事，规则只出现一次：
 * 时机 → 写法 → 立场 → 推荐 → 新会话。
 *
 * 「何时不调用」放在最前：上游描述原先只讲格式，模型会在任务没做完时收尾列菜单，
 * 或在计划模式里用按钮代替 exit_plan_mode 的审批（点按钮只算口头同意）。
 */
const description = [
	"End your turn with 1-5 clickable next steps shown under your reply; clicking one sends its text as the user's next message.",
	"Write your whole reply first: the turn ends right after this call.",
	"Call it once, as the last tool call, only when the task is done or blocked on a choice only the user can make. Do the steps you can do yourself first. Never call it in plan mode or to ask approval for work already in scope.",
	"Write each one as the user would say it, naming a concrete action, not a verdict.",
	"Each entry takes a distinct `angle`; real options only, never padding.",
	"Mark the one you would do first `recommended`."
].join(" ");

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

/**
 * 这一步该不该声明本工具：子 agent 不声明。
 *
 * 建议按钮只画在主对话里，子 agent 的回复用户不直接看，给它声明只是白占上下文。
 * 判据用会话头的 `origin`（官方注释："Coarse product classification for a session
 * created as a subagent child"），不必为此多注入一个服务。读不到就按主会话处理。
 *
 * @param agent - 准备这一步的 agent。
 * @returns 是否声明。
 */
function declaresFor(agent) {
	try {
		return agent?.session?.header?.origin !== "subagent";
	} catch {
		return true;
	}
}

function apply(ctx, config) {
	const maxActions = config?.maxActions ?? 5;
	const tool = defineTool({
		name: "suggest_actions",
		description,
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
			if (shown > 0 && typeof exec?.concludeTurn === "function") exec.concludeTurn();
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

export { Config, apply, declaresFor, description, inject, name };

/**
 * 建议列表的清洗 —— host 侧与测试共用。
 *
 * 规则只此一份：host 用它算出最终名单，经 `output.presentationMeta` 交给客户端，
 * 客户端照抄、不重算（客户端 bundle 拿不到插件配置）。
 */

/**
 * 一条建议的"立场"，两条轴：
 *
 *   力度轴 —— `cautious`（更小步、先验证） / `standard`（常规推进） / `bold`（更用力、更快、更敢冒险）
 *   方向轴 —— `alternative`（换一条路；当前做法走不通时用它，它不是"更激进的同一条路"）
 *   终止   —— `stop`（这事可以不做）
 *
 * 为什么要有这个字段：只靠"告诉模型要给不同角度的建议"没有约束力
 * （规则写成自觉就等于没有）。做成必填枚举 + 同档去重之后，
 * "三条其实是同一条路的三种说法"在格式上就发生不了。
 */
const ANGLES = ["standard", "bold", "cautious", "alternative", "stop"];

/**
 * 一次最多给几条建议；超过就丢，防模型塞一大串。
 *
 * 默认等于**立场的档数**（`ANGLES` 五档）——每种立场各一条，正好五条。
 * 原来默认是 3，结果是：模型就算看得到第四、五个不同动作也会被截掉，
 * 界面上那句"还有 N 条"永远没有东西可展开（2026-09-29 读代码 + 单测确认）。
 */
const DEFAULT_MAX = 5;
const HARD_MAX = 6;

/**
 * 把模型给的 actions 洗成可用的建议列表。
 *
 * 处理这些脏输入：非数组、元素不是对象、label 缺失/纯空白、label 里的换行与
 * 连续空格、重复的 label、重复的立场、非法的立场值、超出上限的条数。
 *
 * 顺序：先把全部输入过完筛，再排序，最后才按上限截断。**不能边筛边截** ——
 * 那样排在后面的推荐项会先被上限丢掉，"推荐的置顶"就白定了。
 *
 * @param input - 工具参数里的 actions（类型未知）。
 * @param maxActions - 最多保留几条；非法值退回默认 5，并夹在 1..6。
 * @returns 清洗后的列表，每项 `{ angle?, label, prompt?, recommended?, opensNewSession? }`。
 */
export function normalizeActions(input, maxActions = DEFAULT_MAX) {
	if (!Array.isArray(input)) return [];
	const limit = Number.isFinite(maxActions)
		? Math.max(1, Math.min(HARD_MAX, Math.trunc(maxActions)))
		: DEFAULT_MAX;
	const collected = [];
	const seenLabels = new Set();
	const seenAngles = new Set();
	// 「另开新会话」这类动作，一个会话只要一个：出现第二个就丢掉，免得点哪个都一样。
	let seenNewSession = false;
	for (const item of input) {
		if (item === null || typeof item !== "object") continue;
		const label = typeof item.label === "string" ? item.label.replace(/\s+/g, " ").trim() : "";
		if (label === "") continue;
		const labelKey = label.toLowerCase();
		if (seenLabels.has(labelKey)) continue;
		// 立场：只认枚举内的值；同一档只留第一条。
		const angle = typeof item.angle === "string" && ANGLES.includes(item.angle) ? item.angle : undefined;
		if (angle !== undefined) {
			if (seenAngles.has(angle)) continue;
			seenAngles.add(angle);
		}
		seenLabels.add(labelKey);
		const prompt = typeof item.prompt === "string" && item.prompt.trim() !== ""
			? item.prompt.trim()
			: undefined;
		// 推荐是显式标记，不绑定位置：模型认为哪条最该做就标哪条，认为"都行"就一个都不标。
		const recommended = item.recommended === true ? true : undefined;
		// 只有显式 true 才算；第二个同类的丢掉（见上面 seenNewSession）。
		const opensNewSession = item.opensNewSession === true ? true : undefined;
		if (opensNewSession === true) {
			if (seenNewSession) continue;
			seenNewSession = true;
		}
		collected.push({
			...(angle === undefined ? {} : { angle }),
			...(recommended === undefined ? {} : { recommended }),
			...(opensNewSession === undefined ? {} : { opensNewSession }),
			label,
			...(prompt === undefined ? {} : { prompt })
		});
	}
	return orderActions(collected).slice(0, limit);
}

/**
 * 排序：推荐的置顶、"可以不做"垫底，其余保持原顺序。
 *
 * 一条同时标着推荐和 `stop` 时按推荐处理 —— 显式标记比立场更可信，
 * 而且"最该先做"和"这事可以不做"本来就自相矛盾，让模型自己难看去。
 *
 * @param items - 已过筛的建议列表。
 * @returns 排好序的新数组（不改动入参）。
 */
function orderActions(items) {
	const recommendedItems = [];
	const middle = [];
	const stopItems = [];
	for (const item of items) {
		if (item.recommended === true) recommendedItems.push(item);
		else if (item.angle === "stop") stopItems.push(item);
		else middle.push(item);
	}
	return [...recommendedItems, ...middle, ...stopItems];
}

/**
 * 版本戳：随 presentationMeta 交给客户端（客户端只读 `actions`，会忽略它）。
 *
 * 2026-09-30 排查「上限改了，界面还是 3 条」时加的：光看行为分不清 host 加载的是
 * 哪一份代码。0.2.0 起它不再进模型上下文，排查时到会话日志的 `tool/result.meta` 里看。
 */
const PLUGIN_REV = "0.2.1";

/**
 * 模型看到的工具说明。每句只讲一件事，规则只出现一次：
 * 时机 → 写法 → 立场 → 推荐 → 新会话。
 *
 * 「何时不调用」放在最前：上游描述原先只讲格式，模型会在任务没做完时收尾列菜单，
 * 或在计划模式里用按钮代替 exit_plan_mode 的审批（点按钮只算口头同意）。
 */
const TOOL_DESCRIPTION = [
	"End your turn with 1-5 clickable next steps shown under your reply; clicking one sends its text as the user's next message.",
	"Write your whole reply first: the turn ends right after this call.",
	"Call it once, as the last tool call, only when the task is done or blocked on a choice only the user can make. Do the steps you can do yourself first. Never call it in plan mode or to ask approval for work already in scope.",
	"Write each one as the user would say it, naming a concrete action, not a verdict.",
	"Each entry takes a distinct `angle`; real options only, never padding.",
	"Mark the one you would do first `recommended`."
].join(" ");

/**
 * 这一步该不该声明本工具：子 agent 不声明。
 *
 * 建议按钮只画在主对话里，子 agent 的回复用户不直接看，给它声明只是白占上下文。
 * 判据用会话头的 `origin`（官方注释：「Coarse product classification for a session
 * created as a subagent child」），不必为此多注入一个服务。读不到就按主会话处理。
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

/**
 * 读 host 交回来的最终列表：0.2.0 起优先读 `block.meta.actions`（presentationMeta），
 * 0.1.x 旧会话日志退回 `block.content` 里的 JSON。
 *
 * @param block - toolview 组件拿到的 block。
 * @returns 建议列表；取不到返回空数组。
 */
function readHostActions(block) {
	if (block === null || typeof block !== "object" || !("kind" in block)) return [];
	const meta = block.meta;
	if (meta !== null && typeof meta === "object" && Array.isArray(meta.actions)) return meta.actions;
	const content = block.content;
	if (!Array.isArray(content)) return [];
	for (const entry of content) {
		const parts = Array.isArray(entry?.content) ? entry.content : [entry];
		for (const part of parts) {
			if (typeof part?.text !== "string") continue;
			let parsed;
			try {
				parsed = JSON.parse(part.text);
			} catch {
				continue;
			}
			if (parsed !== null && typeof parsed === "object" && Array.isArray(parsed.actions)) {
				return parsed.actions;
			}
		}
	}
	return [];
}

/**
 * 按会话与轮次索引的建议列表存储（供客户端 `apply(ctx)` 实例持有并在卸载时清理）。
 *
 * 关联规则：
 *   1. `tool.call.toolview` 在 `preparing`/`start` 阶段携带 `block.turn` 与 `callId`，
 *      在 `result` 阶段携带 `block.seq`、`callId` 与 `block.meta.actions`。
 *   2. `conversation.chat.turnTail` 的 `props.turn` 携带 `{ turn, start: { seq }, end: { seq } }`。
 *   3. 读取时优先按 `turn` 编号精确匹配，其次按 `seq` 落在 `[start.seq, end.seq]` 区间匹配；
 *      仅当旧宿主未传 `props.turn` 时才退回该会话最新一条，彻底消除多轮会话串轮显示。
 */
function createSuggestionStore() {
	const bySession = new Map();
	const callTurns = new Map();
	const listeners = new Map();

	function remember(sessionId, block, callIdProp) {
		if (typeof sessionId !== "string" || sessionId === "" || block === null || typeof block !== "object") return false;
		const callId = typeof callIdProp === "string" && callIdProp !== ""
			? callIdProp
			: typeof block.callId === "string" ? block.callId : "";
		if (typeof block.turn === "number" && callId !== "") {
			callTurns.set(`${sessionId}:${callId}`, block.turn);
		}
		const actions = readHostActions(block);
		if (actions.length === 0) return false;
		const turn = typeof block.turn === "number"
			? block.turn
			: callId !== "" ? callTurns.get(`${sessionId}:${callId}`) : undefined;
		const seq = typeof block.seq === "number" ? block.seq : undefined;
		const key = callId !== "" ? `call:${callId}` : seq !== undefined ? `seq:${seq}` : "latest";
		let entries = bySession.get(sessionId);
		if (entries === undefined) {
			entries = new Map();
			bySession.set(sessionId, entries);
		}
		const prev = entries.get(key);
		if (
			prev !== undefined &&
			prev.turn === turn &&
			prev.seq === seq &&
			JSON.stringify(prev.actions) === JSON.stringify(actions)
		) {
			return false;
		}
		entries.set(key, { key, callId, turn, seq, actions });
		return true;
	}

	function notify(sessionId) {
		const set = listeners.get(sessionId);
		if (set === undefined) return;
		for (const fn of [...set]) {
			try {
				fn();
			} catch {}
		}
	}

	function take(sessionId, turnProp) {
		if (typeof sessionId !== "string" || sessionId === "") return [];
		const entries = bySession.get(sessionId);
		if (entries === undefined || entries.size === 0) return [];
		const list = [...entries.values()];
		if (turnProp === undefined || turnProp === null) {
			return list.at(-1)?.actions ?? [];
		}
		const turnNum = typeof turnProp === "number"
			? turnProp
			: typeof turnProp === "object" && typeof turnProp.turn === "number"
				? turnProp.turn
				: undefined;
		const startSeq = typeof turnProp === "object" && typeof turnProp.start?.seq === "number"
			? turnProp.start.seq
			: undefined;
		const endSeq = typeof turnProp === "object" && typeof turnProp.end?.seq === "number"
			? turnProp.end.seq
			: undefined;
		for (let i = list.length - 1; i >= 0; i -= 1) {
			const item = list[i];
			if (turnNum !== undefined && item.turn !== undefined) {
				if (item.turn === turnNum) return item.actions;
				continue;
			}
			if (item.seq !== undefined && startSeq !== undefined) {
				if (item.seq >= startSeq && (endSeq === undefined || item.seq <= endSeq)) return item.actions;
				continue;
			}
			if (item.turn === undefined && item.seq === undefined) {
				return item.actions;
			}
		}
		return [];
	}

	function subscribe(sessionId, listener) {
		if (typeof sessionId !== "string" || sessionId === "" || typeof listener !== "function") return () => {};
		let set = listeners.get(sessionId);
		if (set === undefined) {
			set = new Set();
			listeners.set(sessionId, set);
		}
		set.add(listener);
		return () => {
			set.delete(listener);
			if (set.size === 0) listeners.delete(sessionId);
		};
	}

	function clear() {
		bySession.clear();
		callTurns.clear();
		listeners.clear();
	}

	return { remember, notify, take, subscribe, clear };
}

export { ANGLES, DEFAULT_MAX, HARD_MAX, PLUGIN_REV, TOOL_DESCRIPTION, createSuggestionStore, declaresFor, readHostActions };

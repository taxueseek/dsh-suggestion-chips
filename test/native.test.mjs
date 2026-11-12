/**
 * 0.2.0 原生化回归：host 侧接线（省 token、入口契约、concludeTurn 开关）与客户端按轮次响应式存储。
 *
 * 不依赖宿主：`@deepseek-ai/dsh-tools` 与 schemastery 用 loader 钩子换成最小桩，
 * 桩只做「原样返回定义」，所以测的是本插件自己的接线，不是宿主行为。
 * 跑：node --test test/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, next) {
	if (specifier === "@deepseek-ai/dsh-tools") return { url: "stub:tools", shortCircuit: true };
	if (specifier === "@deepseek-ai/schemastery") return { url: "stub:schema", shortCircuit: true };
	return next(specifier, context);
}
export async function load(url, context, next) {
	if (url === "stub:tools") return { format: "module", shortCircuit: true, source: "export const defineTool = (d) => d;" };
	if (url === "stub:schema") return { format: "module", shortCircuit: true, source: "const chain = () => new Proxy(function () {}, { get: () => chain, apply: () => chain() }); export default chain();" };
	return next(url, context);
}
`));

const host = await import("../lib/index.js");
const {
	TOOL_DESCRIPTION,
	createSuggestionStore,
	declaresFor,
	readHostActions
} = await import("../lib/normalize.js");

/** 装一次插件，拿到注册的工具与 register 的第二个参数。 */
function install(config) {
	const calls = [];
	host.apply({ tools: { register: (tool, options) => calls.push({ tool, options }) } }, config);
	assert.equal(calls.length, 1);
	return calls[0];
}

const ACTIONS = [
	{ angle: "standard", label: "跑测试" },
	{ angle: "cautious", label: "先看日志", recommended: true },
	{ angle: "stop", label: "先不做" }
];

test("主入口严格遵守函数插件 4 导出契约（loader-entry-shape）", () => {
	assert.deepEqual(Object.keys(host).sort(), ["Config", "apply", "inject", "name"]);
});

test("工具说明压到 900 字符以内（0.1.14 为 2401）", () => {
	assert.ok(TOOL_DESCRIPTION.length < 900, `实际 ${TOOL_DESCRIPTION.length}`);
	const { tool } = install();
	const schemaChars = JSON.stringify(tool.parameters).length + tool.description.length;
	assert.ok(schemaChars < 2000, `说明 + 参数 ${schemaChars} 字符（0.1.14 约 3700）`);
});

test("说明写明时机：做完或要用户拍板才给、计划模式不给、调用后本轮结束", () => {
	assert.match(TOOL_DESCRIPTION, /only when the task is done or blocked/);
	assert.match(TOOL_DESCRIPTION, /plan mode/);
	assert.match(TOOL_DESCRIPTION, /turn ends right after this call/);
});

test("模型看到的结果只有一句话，名单走 presentationMeta", () => {
	const { tool } = install();
	const rendered = tool.output.render({ actions: ACTIONS }, { shown: 3 });
	assert.equal(rendered.length, 1);
	assert.doesNotMatch(rendered[0].text, /先看日志/);
	const meta = tool.output.presentationMeta({ actions: ACTIONS });
	assert.equal(meta.rev, "0.2.3");
	assert.deepEqual(meta.actions.map((a) => a.label), ["先看日志", "跑测试", "先不做"], "推荐置顶、stop 垫底");
});

test("有按钮时默认 concludeTurn，全被洗掉或显式关闭 concludeTurn 时不收尾", async () => {
	const { tool } = install();
	let concluded = 0;
	const exec = { concludeTurn: () => { concluded += 1; } };
	assert.deepEqual(await tool.execute({ actions: ACTIONS }, exec), { shown: 3 });
	assert.equal(concluded, 1);
	assert.deepEqual(await tool.execute({ actions: [{ label: "  " }] }, exec), { shown: 0 });
	assert.equal(concluded, 1, "没有可用建议时让模型照常收尾");
	assert.deepEqual(await tool.execute({ actions: ACTIONS }, {}), { shown: 3 }, "旧宿主没有 concludeTurn 也不报错");

	const { tool: nonConcludingTool } = install({ concludeTurn: false });
	assert.deepEqual(await nonConcludingTool.execute({ actions: ACTIONS }, exec), { shown: 3 });
	assert.equal(concluded, 1, "concludeTurn: false 时不调用 exec.concludeTurn");
});

test("maxActions 配置照旧生效", async () => {
	const { tool } = install({ maxActions: 2 });
	assert.equal((await tool.execute({ actions: ACTIONS }, {})).shown, 2);
	assert.equal(tool.output.presentationMeta({ actions: ACTIONS }).actions.length, 2);
});

test("子 agent 不声明本工具，主会话与读不到会话头时照常声明", () => {
	const { options } = install();
	assert.equal(options.when({ agent: { session: { header: { origin: "subagent" } } } }), false);
	assert.equal(options.when({ agent: { session: { header: {} } } }), true);
	assert.equal(options.when({ agent: {} }), true);
	assert.equal(declaresFor(undefined), true);
});

test("旧宿主 register 不认第二个参数时退回全局注册", () => {
	const calls = [];
	host.apply({ tools: { register: (tool, options) => {
		if (options !== undefined) throw new TypeError("unexpected options");
		calls.push(tool);
	} } });
	assert.equal(calls.length, 1);
});

// ── 客户端纯逻辑与按轮次存储 ──────────────────────────────────────────────────

test("名单优先读 meta，旧会话日志退回结果正文", () => {
	const actions = [{ label: "a" }];
	assert.deepEqual(readHostActions({ kind: "tool-result", meta: { actions }, content: [] }), actions);
	const legacy = { kind: "tool-result", content: [{ type: "text", text: "x" }, { type: "text", text: JSON.stringify({ rev: "0.1.14", actions }) }] };
	assert.deepEqual(readHostActions(legacy), actions);
	assert.deepEqual(readHostActions({ kind: "tool-result", content: [] }), []);
	assert.deepEqual(readHostActions(null), []);
});

test("按轮次存储：同一会话不同轮次互不串轮，支持 start 阶段记 turn 与 result 阶段按 seq 区间匹配", () => {
	const store = createSuggestionStore();
	const t1Actions = [{ label: "第 1 轮按钮" }];
	const t3Actions = [{ label: "第 3 轮按钮" }];

	// 第 1 轮：start 阶段带 turn=1，result 阶段带 seq=15
	store.remember("s1", { phase: "start", callId: "c1", turn: 1 }, "c1");
	assert.equal(store.remember("s1", { kind: "tool-result", callId: "c1", seq: 15, meta: { actions: t1Actions } }, "c1"), true);
	assert.equal(store.remember("s1", { kind: "tool-result", callId: "c1", seq: 15, meta: { actions: t1Actions } }, "c1"), false, "相同内容重复写入不触发变更");

	// 第 3 轮（直接从历史日志水合，无 start 阶段，仅靠 seq=40 落在 [30, 45] 区间匹配）
	assert.equal(store.remember("s1", { kind: "tool-result", callId: "c3", seq: 40, meta: { actions: t3Actions } }, "c3"), true);

	const turn1 = { turn: 1, start: { seq: 1 }, end: { seq: 20 } };
	const turn2 = { turn: 2, start: { seq: 21 }, end: { seq: 29 } };
	const turn3 = { turn: 3, start: { seq: 30 }, end: { seq: 45 } };

	assert.deepEqual(store.take("s1", turn1), t1Actions, "第 1 轮拿到第 1 轮的建议");
	assert.deepEqual(store.take("s1", turn2), [], "未调用 suggest_actions 的第 2 轮不串用其他轮次的建议");
	assert.deepEqual(store.take("s1", turn3), t3Actions, "第 3 轮按 seq 区间拿到第 3 轮的建议");
	assert.deepEqual(store.take("s1", undefined), t3Actions, "旧宿主未传 turn 时退回会话最新一条");

	store.clear();
	assert.deepEqual(store.take("s1", turn1), [], "clear 后全部清空");
});

test("客户端 bundle：仅注册 toolview 与 turnTail 两个槽位，晚到采集可响应式唤醒 Tail，卸载时清理状态", () => {
	let loadedDef;
	const effects = [];
	const stateSlots = [];
	let currentHook = 0;
	const FakeReact = {
		useState(init) {
			const idx = currentHook++;
			if (!(idx in stateSlots)) {
				stateSlots[idx] = typeof init === "function" ? init() : init;
			}
			const set = (next) => {
				stateSlots[idx] = typeof next === "function" ? next(stateSlots[idx]) : next;
			};
			return [stateSlots[idx], set];
		},
		useEffect(fn) {
			effects.push(fn);
		},
		useRef(val) {
			return { current: val };
		},
		createElement(type, props, ...children) {
			return { type, props, children };
		}
	};
	const sandbox = {
		window: {
			__ModuleLoader__: {
				load(def) {
					loadedDef = def;
				}
			},
			setTimeout: () => {},
			navigator: { language: "zh-CN" }
		},
		document: {
			documentElement: { lang: "zh-CN" },
			createElement: () => ({}),
			head: { appendChild: () => {} }
		},
		console
	};
	const source = readFileSync(fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8");
	vm.runInNewContext(source, sandbox);
	assert.equal(loadedDef.id, "dsh-suggestion-chips");
	const plugin = loadedDef.factory(() => FakeReact);
	assert.equal(plugin.name, "dsh-suggestion-chips");
	assert.deepEqual(Array.from(plugin.inject), ["slots", "sessions"]);

	const registered = new Map();
	const cleanups = [];
	plugin.apply({
		effect(fn) {
			const dispose = fn();
			if (typeof dispose === "function") cleanups.push(dispose);
		},
		get() {
			return undefined;
		},
		slots: {
			inject(_name, fn) {
				fn();
			},
			register(spec, Comp) {
				registered.set(spec.name, Comp);
			}
		}
	});

	assert.deepEqual([...registered.keys()], ["tool.call.toolview", "conversation.chat.turnTail"], "不再注册 conversation.input.overlay");
	const Capture = registered.get("tool.call.toolview");
	const Tail = registered.get("conversation.chat.turnTail");
	const turn1 = { turn: 1, start: { seq: 1 }, end: { seq: 10 } };

	// Tail 先挂载（此时 Capture 尚未渲染）
	currentHook = 0;
	assert.equal(Tail({ sessionId: "s1", turn: turn1 }), null);
	const tailCleanups = effects.splice(0).map((fn) => fn());

	// Capture 后渲染并执行 effect，唤醒已订阅的 Tail
	Capture({
		sessionId: "s1",
		callId: "c1",
		block: { kind: "tool-result", callId: "c1", seq: 5, meta: { actions: [{ label: "立刻点我" }] } }
	});
	for (const fn of effects.splice(0)) fn();

	// 再次渲染 Tail，状态已被响应式更新为新建议
	currentHook = 0;
	const rendered = Tail({ sessionId: "s1", turn: turn1 });
	assert.notEqual(rendered, null);
	assert.equal(rendered.props["data-tool"], "suggest_actions");

	// 插件卸载执行 ctx.effect 清理后，状态清空
	for (const fn of tailCleanups) if (typeof fn === "function") fn();
	for (const fn of cleanups) fn();
	stateSlots.length = 0;
	currentHook = 0;
	assert.equal(Tail({ sessionId: "s1", turn: turn1 }), null);
});

test("刷新后从会话事件流补名单：历史轮次的按钮不再因为 store 空而消失", () => {
	let loadedDef;
	const effects = [];
	const stateSlots = [];
	let currentHook = 0;
	const FakeReact = {
		useState(init) {
			const idx = currentHook++;
			if (!(idx in stateSlots)) stateSlots[idx] = typeof init === "function" ? init() : init;
			return [stateSlots[idx], (next) => {
				stateSlots[idx] = typeof next === "function" ? next(stateSlots[idx]) : next;
			}];
		},
		useEffect(fn) {
			effects.push(fn);
		},
		useRef(val) {
			return { current: val };
		},
		createElement(type, props, ...children) {
			return { type, props, children };
		}
	};
	const source = readFileSync(fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8");
	vm.runInNewContext(source, {
		window: {
			__ModuleLoader__: { load: (def) => { loadedDef = def; } },
			setTimeout: () => {},
			navigator: { language: "zh-CN" }
		},
		document: {
			documentElement: { lang: "zh-CN" },
			createElement: () => ({}),
			head: { appendChild: () => {} }
		},
		console
	});

	// 会话日志里已经落盘的名单（刷新前那一轮调用过 suggest_actions）
	const historyEntries = [
		{ event: { type: "turn/start", seq: 1, data: { turn: 1 } } },
		{
			event: {
				type: "tool/result", seq: 5,
				data: {
					turn: 1,
					message: { source: { callId: "c1" }, content: [{ type: "text", text: "2 suggestion(s) shown under your reply." }] },
					meta: { rev: "0.2.0", actions: [{ label: "历史里的一条" }] }
				}
			}
		},
		{ event: { type: "turn/end", seq: 9, data: { turn: 1 } } }
	];
	let snapshot = { entries: historyEntries, change: { kind: "replace", entries: historyEntries } };
	let listener;
	const sessions = {
		binding: (id) => (id === "s1"
			? { eventSource: { getSnapshot: () => snapshot, subscribe: (fn) => { listener = fn; return () => { listener = undefined; }; } } }
			: undefined)
	};
	const registered = new Map();
	const plugin = loadedDef.factory(() => FakeReact);
	plugin.apply({
		effect(fn) {
			fn();
		},
		get(name) {
			return name === "sessions" ? sessions : undefined;
		},
		slots: {
			inject(_name, fn) {
				fn();
			},
			register(spec, Comp) {
				registered.set(spec.name, Comp);
			}
		}
	});

	const Tail = registered.get("conversation.chat.turnTail");
	const turn1 = { turn: 1, start: { seq: 1 }, end: { seq: 9 } };
	// 首帧：store 空（刷新后没有实时采集）
	currentHook = 0;
	assert.equal(Tail({ sessionId: "s1", turn: turn1 }), null);
	// effect 补历史 → setState → 重渲染
	for (const fn of effects.splice(0)) fn();
	currentHook = 0;
	const rendered = Tail({ sessionId: "s1", turn: turn1 });
	assert.notEqual(rendered, null, "没有实时采集也要从历史事件里把名单补上");
	assert.equal(rendered.props["data-tool"], "suggest_actions");

	// 之后新落盘的一轮：追加事件后订阅回调把它也补进来
	const turn2 = { turn: 2, start: { seq: 20 }, end: { seq: 30 } };
	const added = [
		{ event: { type: "turn/start", seq: 20, data: { turn: 2 } } },
		{ event: { type: "tool/result", seq: 25, data: { turn: 2, message: { source: { callId: "c2" }, content: [] }, meta: { actions: [{ label: "第二轮的一条" }] } } } }
	];
	snapshot = { entries: [...historyEntries, ...added], change: { kind: "append", entries: added } };
	if (typeof listener === "function") listener();
	currentHook = 0;
	assert.notEqual(Tail({ sessionId: "s1", turn: turn2 }), null, "新轮次落盘后同样能显示");
});

test("Level 0 确定性提取与显式工具调用的优先级协调", () => {
	const store = createSuggestionStore();

	// 1. 无工具调用时，从文本提取出确定性按钮
	assert.equal(store.rememberText("s1", 1, 10, "任务准备完毕，是否继续执行？"), true);
	const t1 = store.take("s1", { turn: 1 });
	assert.equal(t1.length, 2);
	assert.equal(t1[0].label, "继续");

	// 2. 之后显式工具调用到达，必须无缝覆盖确定性建议
	const explicit = [{ label: "模型定制操作" }];
	store.remember("s1", { kind: "tool-result", callId: "c1", turn: 1, seq: 12, meta: { actions: explicit } }, "c1");
	assert.deepEqual(store.take("s1", { turn: 1 }), explicit, "显式工具结果具有最高优先级");

	// 3. 已经有显式工具结果的轮次，后续文本事件不冲掉显式建议
	assert.equal(store.rememberText("s1", 1, 15, "是否运行测试？"), false);
	assert.deepEqual(store.take("s1", { turn: 1 }), explicit);
});

test("客户端无 tool/result 时从助手文本消息中水合渲染确定性建议按钮", () => {
	let loadedDef;
	const effects = [];
	const stateSlots = [];
	let currentHook = 0;
	const FakeReact = {
		useState(init) {
			const idx = currentHook++;
			if (!(idx in stateSlots)) stateSlots[idx] = typeof init === "function" ? init() : init;
			return [stateSlots[idx], (next) => {
				stateSlots[idx] = typeof next === "function" ? next(stateSlots[idx]) : next;
			}];
		},
		useEffect(fn) {
			effects.push(fn);
		},
		useRef(val) {
			return { current: val };
		},
		createElement(type, props, ...children) {
			return { type, props, children };
		}
	};
	const source = readFileSync(fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8");
	vm.runInNewContext(source, {
		window: {
			__ModuleLoader__: { load: (def) => { loadedDef = def; } },
			setTimeout: () => {},
			navigator: { language: "zh-CN" }
		},
		document: {
			documentElement: { lang: "zh-CN" },
			createElement: () => ({}),
			head: { appendChild: () => {} }
		},
		console
	});

	// 事件流里没有任何 tool/result，只有 assistant 的纯文本消息
	const historyEntries = [
		{ event: { type: "turn/start", seq: 1, data: { turn: 1 } } },
		{
			event: {
				type: "message", seq: 3,
				data: {
					turn: 1,
					message: {
						source: { kind: "assistant" },
						content: [{ type: "text", text: "已修改全部文件，请确认是否提交本次修改？" }]
					}
				}
			}
		},
		{ event: { type: "turn/end", seq: 4, data: { turn: 1 } } }
	];
	const snapshot = { entries: historyEntries, change: { kind: "replace", entries: historyEntries } };
	const sessions = {
		binding: (id) => (id === "s2"
			? { eventSource: { getSnapshot: () => snapshot, subscribe: () => () => {} } }
			: undefined)
	};
	const registered = new Map();
	const plugin = loadedDef.factory(() => FakeReact);
	plugin.apply({
		effect(fn) { fn(); },
		get(name) { return name === "sessions" ? sessions : undefined; },
		slots: {
			inject(_name, fn) { fn(); },
			register(spec, Comp) { registered.set(spec.name, Comp); }
		}
	});

	const Tail = registered.get("conversation.chat.turnTail");
	const turn1 = { turn: 1, start: { seq: 1 }, end: { seq: 4 } };
	// 首帧
	currentHook = 0;
	assert.equal(Tail({ sessionId: "s2", turn: turn1 }), null);
	// 跑 effect 水合
	for (const fn of effects.splice(0)) fn();
	currentHook = 0;
	const rendered = Tail({ sessionId: "s2", turn: turn1 });
	assert.notEqual(rendered, null, "即使没有 tool/result，也能从消息文本中提取渲染出按钮");
	assert.equal(rendered.props["data-tool"], "suggest_actions");
});

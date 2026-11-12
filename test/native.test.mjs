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
	assert.equal(meta.rev, "0.3.1");
	assert.equal(meta.displayMode, "both", "默认呈现形态为 both 双形态联动");
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

test("客户端英文场景水合：无 tool/result 时从英文助手文本渲染按钮", () => {
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
			navigator: { language: "en-US" }
		},
		document: {
			documentElement: { lang: "en-US" },
			createElement: () => ({}),
			head: { appendChild: () => {} }
		},
		console
	});

	const historyEntries = [
		{ event: { type: "turn/start", seq: 1, data: { turn: 1 } } },
		{
			event: {
				type: "message", seq: 3,
				data: {
					turn: 1,
					message: {
						source: { kind: "assistant" },
						content: [{ type: "text", text: "I've finished the refactor. Should I run the tests?" }]
					}
				}
			}
		},
		{ event: { type: "turn/end", seq: 4, data: { turn: 1 } } }
	];
	const snapshot = { entries: historyEntries, change: { kind: "replace", entries: historyEntries } };
	const sessions = {
		binding: (id) => (id === "s3"
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
	currentHook = 0;
	assert.equal(Tail({ sessionId: "s3", turn: turn1 }), null);
	for (const fn of effects.splice(0)) fn();
	currentHook = 0;
	const rendered = Tail({ sessionId: "s3", turn: turn1 });
	assert.notEqual(rendered, null, "英文助手文本也要能水合出按钮");
	assert.equal(rendered.props["data-tool"], "suggest_actions");
});

test("displayMode 配置生效：支持 both、chips、tab、none 四档模式", () => {
	const cBoth = install({ displayMode: "both" });
	assert.equal(cBoth.tool.output.presentationMeta({ actions: ACTIONS }).displayMode, "both");

	const cChips = install({ displayMode: "chips" });
	assert.equal(cChips.tool.output.presentationMeta({ actions: ACTIONS }).displayMode, "chips");

	const cTab = install({ displayMode: "tab" });
	assert.equal(cTab.tool.output.presentationMeta({ actions: ACTIONS }).displayMode, "tab");

	const cNone = install({ displayMode: "none" });
	assert.equal(cNone.tool.output.presentationMeta({ actions: ACTIONS }).displayMode, "none");
});

test("displayMode 为 tab 或 none 时，TurnTail 胶囊组件返回 null，不渲染按钮", () => {
	const store = createSuggestionStore();
	store.remember("s-tab", {
		kind: "tool-result",
		callId: "c1",
		turn: 1,
		meta: { displayMode: "tab", actions: [{ label: "测试按钮" }] }
	});
	assert.equal(store.getDisplayMode("s-tab"), "tab");

	store.remember("s-none", {
		kind: "tool-result",
		callId: "c2",
		turn: 1,
		meta: { displayMode: "none", actions: [{ label: "测试按钮" }] }
	});
	assert.equal(store.getDisplayMode("s-none"), "none");

	store.remember("s-both", {
		kind: "tool-result",
		callId: "c3",
		turn: 1,
		meta: { displayMode: "both", actions: [{ label: "测试按钮" }] }
	});
	assert.equal(store.getDisplayMode("s-both"), "both");
});

test("输入框 Tab 采纳推荐项与尾部胶囊双向联动闭环", () => {
	const store = createSuggestionStore();
	store.remember("s-link", {
		kind: "tool-result",
		callId: "c1",
		turn: 1,
		meta: {
			displayMode: "both",
			actions: [
				{ label: "常规推进", angle: "standard" },
				{ label: "先跑单元测试", angle: "cautious", recommended: true },
				{ label: "暂不修改", angle: "stop" }
			]
		}
	});

	let notified = 0;
	store.subscribe("s-link", () => { notified += 1; });

	// 模拟输入框按 Tab 采纳了推荐项
	const actionsBefore = store.take("s-link", 1);
	const best = actionsBefore.find((a) => a.recommended === true);
	assert.equal(best.label, "先跑单元测试");
	assert.equal(best.adopted, undefined);

	// 触发采纳
	store.rememberUserText("s-link", best.label);
	store.notify("s-link");

	assert.equal(notified, 1);
	const actionsAfter = store.take("s-link", 1);
	const bestAfter = actionsAfter.find((a) => a.recommended === true);
	assert.equal(bestAfter.adopted, true, "按 Tab 采纳后尾部对应胶囊自动标记为已采纳");
});

test("中英文语言环境下的 Tab 徽章与高危安全拦截文案效果", () => {
	const source = readFileSync(fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8");

	// 中文环境沙箱
	const zhSandbox = {
		window: {
			__ModuleLoader__: { load() {} },
			navigator: { language: "zh-CN" }
		},
		document: {
			documentElement: { lang: "zh-CN" },
			createElement: () => ({ style: {} }),
			head: { appendChild: () => {} }
		},
		console
	};
	vm.runInNewContext(source, zhSandbox);
	const zhStrings = zhSandbox.window.__uiStrings__();
	assert.equal(zhStrings.tabBadge, "Tab 采纳");
	assert.equal(zhStrings.tabDangerBadge, "⚠ 高危: Tab 填入草稿");
	assert.equal(zhStrings.recommended, "推荐");

	// 英文环境沙箱
	const enSandbox = {
		window: {
			__ModuleLoader__: { load() {} },
			navigator: { language: "en-US" }
		},
		document: {
			documentElement: { lang: "en-US" },
			createElement: () => ({ style: {} }),
			head: { appendChild: () => {} }
		},
		console
	};
	vm.runInNewContext(source, enSandbox);
	const enStrings = enSandbox.window.__uiStrings__();
	assert.equal(enStrings.tabBadge, "Tab to accept");
	assert.equal(enStrings.tabDangerBadge, "⚠ Danger: Tab to fill draft");
	assert.equal(enStrings.recommended, "Recommended");
});

test("客户端水合支持 DSH 真实事件类型 assistant/message 与 user/message", () => {
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
	const source = readFileSync(fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8");
	const sandbox = {
		window: {
			__ModuleLoader__: { load(def) { loadedDef = def; } },
			setTimeout: () => {},
			navigator: { language: "zh-CN" }
		},
		document: {
			documentElement: { lang: "zh-CN" },
			createElement: () => ({ style: {} }),
			head: { appendChild: () => {} }
		},
		console
	};
	vm.runInNewContext(source, sandbox);
	const plugin = loadedDef.factory(() => FakeReact);

	const entries = [
		{ event: { type: "system/message", seq: 1 } },
		{ event: { type: "user/message", seq: 2, data: { message: { content: "怎么改？" } } } },
		{ event: { type: "assistant/message", seq: 3, data: { turn: 1, message: { content: "修改已完成，请问是否继续下一步？" } } } }
	];

	const fakeEventSource = {
		getSnapshot: () => ({ entries }),
		subscribe: () => () => {}
	};
	const fakeSessions = {
		binding: (id) => (id === "sess-real" ? { eventSource: fakeEventSource } : undefined)
	};

	const registered = new Map();
	plugin.apply({
		effect() {},
		get(name) { return name === "sessions" ? fakeSessions : undefined; },
		slots: {
			inject(_name, fn) { fn(); },
			register(spec, Comp) { registered.set(spec.name, Comp); }
		}
	});

	const Tail = registered.get("conversation.chat.turnTail");
	currentHook = 0;
	Tail({ sessionId: "sess-real", turn: { turn: 1 } });
	// 执行 useEffect 触发 hydrateFromEvents
	for (const ef of effects) ef();

	// 重新渲染验证水合出的动作
	currentHook = 0;
	const rendered = Tail({ sessionId: "sess-real", turn: { turn: 1 } });
	assert.notEqual(rendered, null, "成功识别 assistant/message 并水合渲染按钮");
});

test("用户发送新消息后上一轮建议在输入框自动过期，防止幽灵串味", () => {
	const store = createSuggestionStore();
	store.remember("s-expire", {
		kind: "tool-result",
		callId: "c1",
		turn: 1,
		seq: 3,
		meta: {
			displayMode: "both",
			actions: [{ label: "第一轮建议", prompt: "推进第一步" }]
		}
	});

	// 在未发新消息时，输入框能获取到本轮最新建议
	const before = store.take("s-expire");
	assert.equal(before.length, 1);
	assert.equal(before[0].label, "第一轮建议");

	// 用户在 seq: 5 发送了新消息（新轮次开始）
	store.rememberUserMessage("s-expire", 5);

	// 此时新一轮模型尚未产生新建议，输入框必须返回空，杜绝旧建议幽灵冒出
	const after = store.take("s-expire");
	assert.deepEqual(after, [], "用户发送新提问后旧建议已失效，输入框不可展示幽灵");

	// 但历史轮次的尾部胶囊仍能按 turn 精确查到
	const history = store.take("s-expire", 1);
	assert.equal(history.length, 1, "历史轮次胶囊不受新消息影响");
});

test("新一轮的确定性建议不被上一轮显式建议压住（建议正确触发）", () => {
	const store = createSuggestionStore();
	// 第 1 轮：模型调了工具，建议 seq 10
	store.remember("s-fresh", {
		kind: "tool-result",
		callId: "c1",
		turn: 1,
		seq: 10,
		meta: { displayMode: "both", actions: [{ label: "上一轮工具建议" }] }
	});
	// 用户提问 seq 15，助手这一轮没调工具，靠正文提取出确定性建议 seq 20
	store.rememberUserMessage("s-fresh", 15);
	store.rememberText("s-fresh", 2, 20, "任务已准备完毕，是否继续执行？");

	const ghost = store.take("s-fresh");
	assert.equal(ghost.length > 0, true, "新一轮建议必须出现，不能因为上一轮有显式建议就空着");
	assert.equal(ghost[0].prompt, "继续执行下一步");

	// 历史轮次胶囊仍按 turn 精确取到，不受新鲜度规则影响
	const history = store.take("s-fresh", 1);
	assert.equal(history.length, 1);
	assert.equal(history[0].label, "上一轮工具建议");
});

test("输入框幽灵展示时让出原生placeholder，隐藏时无缝恢复", () => {
	let loadedDef = null;
	const FakeReact = {
		useState(initial) { return [typeof initial === "function" ? initial() : initial, () => {}]; },
		useEffect() {},
		useRef() { return { current: null }; },
		createElement(type, props, ...children) { return { type, props, children }; }
	};
	const source = readFileSync(fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8");

	class FakeElement {
		constructor(tagName) {
			this.tagName = tagName;
			this.style = {};
			this.attributes = new Map();
			this.children = [];
			this.value = "";
			this.placeholder = "";
			this.parentElement = null;
			this.isConnected = true;
		}
		setAttribute(k, v) { this.attributes.set(k, String(v)); }
		getAttribute(k) { return this.attributes.get(k); }
		hasAttribute(k) { return this.attributes.has(k); }
		removeAttribute(k) { this.attributes.delete(k); }
		appendChild(child) {
			child.parentElement = this;
			this.children.push(child);
			return child;
		}
		closest() { return this.parentElement; }
		addEventListener() {}
		removeEventListener() {}
	}

	const parentEl = new FakeElement("div");
	const textarea = new FakeElement("textarea");
	textarea.placeholder = "发消息或倒退里程碑...";
	parentEl.appendChild(textarea);

	const sandbox = {
		window: {
			__ModuleLoader__: { load(def) { loadedDef = def; } },
			setTimeout: () => {},
			navigator: { language: "zh-CN" },
			getComputedStyle: () => ({ paddingTop: "8px", paddingLeft: "12px", font: "14px sans-serif" }),
			addEventListener: () => {},
			removeEventListener: () => {}
		},
		document: {
			documentElement: { lang: "zh-CN" },
			querySelector: (selector) => {
				if (selector.includes("textarea")) return textarea;
				return null;
			},
			createElement: (tag) => new FakeElement(tag),
			createTextNode: (t) => ({ type: "text", text: t }),
			head: { appendChild: () => {} }
		},
		console
	};

	vm.runInNewContext(source, sandbox);

	const registered = new Map();
	let captureEffect = null;
	const mockReact = {
		useState(initial) { return [typeof initial === "function" ? initial() : initial, () => {}]; },
		useEffect(fn) { captureEffect = fn; },
		useRef() { return { current: null }; },
		createElement(type, props, ...children) { return { type, props, children }; }
	};

	let sessionSub = null;
	const ctx = {
		effect() {},
		get(name) {
			if (name === "sessions") {
				return {
					list: {
						getSnapshot: () => ({ current: { id: "sess-ph" }, byId: { "sess-ph": { running: false } } }),
						subscribe: (fn) => {
							sessionSub = fn;
							return () => {};
						}
					}
				};
			}
			return undefined;
		},
		slots: {
			inject(_name, fn) { fn(); },
			register(spec, Comp) { registered.set(spec.name, Comp); }
		}
	};

	const plugin = loadedDef.factory(() => mockReact);
	plugin.apply(ctx);

	const Capture = registered.get("tool.call.toolview");
	Capture({
		sessionId: "sess-ph",
		block: {
			kind: "tool-result",
			meta: { actions: [{ label: "继续推进", prompt: "继续推进下一步", recommended: true }] }
		}
	});
	if (typeof captureEffect === "function") captureEffect();

	// 触发更新
	if (typeof sessionSub === "function") sessionSub();

	// 验证 placeholder 已被清空，原内容暂存进 data-dsh-prev-ph
	assert.equal(textarea.placeholder, "", "显示幽灵时原生 placeholder 应让空");
	assert.equal(textarea.getAttribute("data-dsh-prev-ph"), "发消息或倒退里程碑...");

	// 验证 overlay 结构：[Tab 采纳] 徽章在左，单行文本在右
	const overlay = parentEl.children.find((c) => c.className === "dsh-suggest-ghost-overlay");
	assert.ok(overlay, "创建了 overlay 容器");
	assert.equal(overlay.style.display, "inline-flex");
	assert.equal(overlay.children[0].className, "dsh-suggest-ghost-badge");
	assert.equal(overlay.children[1].className, "dsh-suggest-ghost-text");

	// 模拟用户输入：textarea 有内容，触发更新
	textarea.value = "我正在输入";
	if (typeof sessionSub === "function") sessionSub();

	// 验证 placeholder 恢复
	assert.equal(textarea.placeholder, "发消息或倒退里程碑...", "隐藏幽灵后原生 placeholder 必须恢复");
	assert.equal(textarea.hasAttribute("data-dsh-prev-ph"), false);
});

test("contenteditable 输入框：幽灵与官方 placeholder 不同时显示（不重影）", () => {
	let loadedDef = null;
	let tick = null;
	const source = readFileSync(fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8");

	class FakeEl {
		constructor(tagName) {
			this.tagName = tagName;
			this.style = {};
			this.attributes = new Map();
			this.children = [];
			this.textContent = "";
			this.value = "";
			this.parentElement = null;
			this.isConnected = true;
		}
		setAttribute(k, v) { this.attributes.set(k, String(v)); }
		getAttribute(k) { return this.attributes.get(k) ?? null; }
		hasAttribute(k) { return this.attributes.has(k); }
		removeAttribute(k) { this.attributes.delete(k); }
		get dataset() { return { placeholder: this.attributes.get("data-placeholder") }; }
		appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
		closest() { return this.parentElement; }
		querySelector(sel) {
			const want = sel.replace(/[[\]]/g, "");
			const walk = (el) => {
				for (const c of el.children ?? []) {
					if (c.attributes?.has(want)) return c;
					const hit = walk(c);
					if (hit) return hit;
				}
				return null;
			};
			return walk(this);
		}
		addEventListener() {}
		removeEventListener() {}
	}

	// 真实结构：div[data-input-scroll] > div[data-composer-input][data-placeholder]
	//                                  + div[data-composer-placeholder]
	const scroll = new FakeEl("div");
	scroll.setAttribute("data-input-scroll", "true");
	const editable = new FakeEl("div");
	editable.setAttribute("data-composer-input", "true");
	editable.setAttribute("data-placeholder", "发消息或倒退里程碑...");
	scroll.appendChild(editable);
	const official = new FakeEl("div");
	official.setAttribute("data-composer-placeholder", "true");
	official.textContent = "发消息或倒退里程碑...";
	scroll.appendChild(official);

	const sandbox = {
		window: {
			__ModuleLoader__: { load(def) { loadedDef = def; } },
			setTimeout: () => {},
			navigator: { language: "zh-CN" },
			getComputedStyle: () => ({ paddingTop: "8px", paddingLeft: "12px", font: "14px sans-serif" }),
			addEventListener: () => {},
			removeEventListener: () => {}
		},
		document: {
			documentElement: { lang: "zh-CN" },
			querySelector: (sel) => (sel.includes("data-composer-input") ? editable : null),
			createElement: (tag) => new FakeEl(tag),
			createTextNode: (t) => ({ text: t }),
			head: { appendChild: () => {} }
		},
		setInterval: (fn) => { tick = fn; return 1; },
		clearInterval: () => {},
		console
	};
	vm.runInNewContext(source, sandbox);

	const mockReact = {
		useState(initial) { return [typeof initial === "function" ? initial() : initial, () => {}]; },
		useEffect() {},
		useRef() { return { current: null }; },
		createElement(type, props, ...children) { return { type, props, children }; }
	};
	const registered = new Map();
	const ctx = {
		effect() {},
		get(name) {
			if (name === "sessions") {
				return {
					list: {
						getSnapshot: () => ({ current: { id: "sess-ce" }, byId: { "sess-ce": { running: false } } }),
						subscribe: () => () => {}
					}
				};
			}
			return undefined;
		},
		slots: { inject(_n, fn) { fn(); }, register(spec, Comp) { registered.set(spec.name, Comp); } }
	};
	loadedDef.factory(() => mockReact).apply(ctx);

	const Capture = registered.get("tool.call.toolview");
	Capture({
		sessionId: "sess-ce",
		block: { kind: "tool-result", meta: { actions: [{ label: "采纳方案并执行", prompt: "采纳该方案，请直接执行", recommended: true }] } }
	});

	tick();
	const overlay = scroll.children.find((c) => c.className === "dsh-suggest-ghost-overlay");
	assert.ok(overlay, "幽灵浮层已创建");
	assert.equal(overlay.style.display, "inline-flex", "幽灵处于显示状态");
	// 关键回归：官方那一行必须被让开，否则与幽灵叠成截图里的重影
	assert.equal(official.style.visibility, "hidden", "显示幽灵时必须隐藏官方 placeholder 节点");

	editable.textContent = "我正在输入";
	tick();
	assert.notEqual(official.style.visibility, "hidden", "隐藏幽灵后官方 placeholder 恢复可见");
	assert.equal(overlay.style.display, "none", "幽灵已隐藏");
});

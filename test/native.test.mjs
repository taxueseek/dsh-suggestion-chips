/**
 * 0.2.0 原生化回归：host 侧接线（省 token 三件事）与客户端纯逻辑（输入增强）。
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

test("工具说明压到 900 字符以内（0.1.14 为 2401）", () => {
	assert.ok(host.description.length < 900, `实际 ${host.description.length}`);
	const { tool } = install();
	const schemaChars = JSON.stringify(tool.parameters).length + host.description.length;
	assert.ok(schemaChars < 2000, `说明 + 参数 ${schemaChars} 字符（0.1.14 约 3700）`);
});

test("说明写明时机：做完或要用户拍板才给、计划模式不给、调用后本轮结束", () => {
	assert.match(host.description, /only when the task is done or blocked/);
	assert.match(host.description, /plan mode/);
	assert.match(host.description, /turn ends right after this call/);
});

test("模型看到的结果只有一句话，名单走 presentationMeta", () => {
	const { tool } = install();
	const rendered = tool.output.render({ actions: ACTIONS }, { shown: 3 });
	assert.equal(rendered.length, 1);
	assert.doesNotMatch(rendered[0].text, /先看日志/);
	const meta = tool.output.presentationMeta({ actions: ACTIONS });
	assert.equal(meta.rev, "0.2.0");
	assert.deepEqual(meta.actions.map((a) => a.label), ["先看日志", "跑测试", "先不做"], "推荐置顶、stop 垫底");
});

test("有按钮时 concludeTurn，全被洗掉时不收尾", async () => {
	const { tool } = install();
	let concluded = 0;
	const exec = { concludeTurn: () => { concluded += 1; } };
	assert.deepEqual(await tool.execute({ actions: ACTIONS }, exec), { shown: 3 });
	assert.equal(concluded, 1);
	assert.deepEqual(await tool.execute({ actions: [{ label: "  " }] }, exec), { shown: 0 });
	assert.equal(concluded, 1, "没有可用建议时让模型照常收尾");
	assert.deepEqual(await tool.execute({ actions: ACTIONS }, {}), { shown: 3 }, "旧宿主没有 concludeTurn 也不报错");
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
	assert.equal(host.declaresFor(undefined), true);
});

test("旧宿主 register 不认第二个参数时退回全局注册", () => {
	const calls = [];
	host.apply({ tools: { register: (tool, options) => {
		if (options !== undefined) throw new TypeError("unexpected options");
		calls.push(tool);
	} } });
	assert.equal(calls.length, 1);
});

// ── 客户端纯逻辑 ────────────────────────────────────────────────────────────

/** 在沙箱里跑一份 client.js，拿到测试入口；localStorage 用内存桩。 */
function loadClient(stored = []) {
	const store = new Map([["dsh-suggest-actions:history", JSON.stringify(stored)]]);
	const sandbox = {
		__DSH_SUGGEST_TEST__: {},
		window: {
			localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
			__ModuleLoader__: { load: () => {} },
			setTimeout
		},
		document: { documentElement: { lang: "zh-CN" } },
		console
	};
	sandbox.globalThis = sandbox;
	const source = readFileSync(fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8");
	vm.runInNewContext(source, sandbox);
	// 沙箱里的数组属于另一个 realm，deepStrictEqual 会比原型；过一遍 JSON 只比内容。
	const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
	const raw = sandbox.__DSH_SUGGEST_TEST__;
	return {
		api: { ...raw, readHostActions: (block) => plain(raw.readHostActions(block)), getHistory: () => plain(raw.getHistory()) },
		store
	};
}

/** 可变的假输入框 shell。 */
function fakeShell(draft = "", phase = "plain") {
	const shell = {
		snapshot: { draft, phase },
		state: { getSnapshot: () => shell.snapshot },
		actions: { setDraft: (value) => { shell.snapshot = { ...shell.snapshot, draft: value }; } }
	};
	return shell;
}

test("名单优先读 meta，旧会话日志退回结果正文", () => {
	const { api } = loadClient();
	const actions = [{ label: "a" }];
	assert.deepEqual(api.readHostActions({ kind: "tool-result", meta: { actions }, content: [] }), actions);
	const legacy = { kind: "tool-result", content: [{ type: "text", text: "x" }, { type: "text", text: JSON.stringify({ rev: "0.1.14", actions }) }] };
	assert.deepEqual(api.readHostActions(legacy), actions);
	assert.deepEqual(api.readHostActions({ kind: "tool-result", content: [] }), []);
	assert.deepEqual(api.readHostActions(null), []);
});

test("前缀补全：取最近一条更长的历史；命令、引用、多行与过短前缀不补", () => {
	const { api } = loadClient(["继续这个任务并提交", "继续未完成的任务", "/compact"]);
	assert.equal(api.completionFor("继续"), "继续这个任务并提交");
	assert.equal(api.completionFor("继续未"), "继续未完成的任务");
	assert.equal(api.completionFor("继"), undefined, "少于 2 个字不补");
	assert.equal(api.completionFor("继续这个任务并提交"), undefined, "已经是整句时不补");
	assert.equal(api.completionFor("/co"), undefined);
	assert.equal(api.completionFor("@fi"), undefined);
	assert.equal(api.completionFor("继续\n"), undefined);
});

test("发送时记历史：去重、新的在前、命令不记、上限 100", () => {
	const { api, store } = loadClient(["旧的"]);
	const shell = fakeShell("新的一句");
	const assist = api.createAssistState(shell);
	shell.snapshot = { draft: "新的一句", phase: "sending" };
	assist.observe();
	assert.deepEqual(api.getHistory(), ["新的一句", "旧的"]);
	api.recordSent("旧的");
	assert.deepEqual(api.getHistory(), ["旧的", "新的一句"]);
	api.recordSent("/compact");
	assert.equal(api.getHistory().length, 2);
	for (let i = 0; i < 120; i += 1) api.recordSent(`第 ${i} 句`);
	assert.equal(api.getHistory().length, 100);
	assert.equal(JSON.parse(store.get("dsh-suggest-actions:history")).length, 100, "写回了 localStorage");
});

test("上下键：只在空输入框或正在翻历史时接管，↓ 翻到底清空", () => {
	const { api } = loadClient(["第三句", "第二句", "第一句"]);
	const shell = fakeShell("");
	const assist = api.createAssistState(shell);
	assert.equal(assist.keydown("ArrowDown"), false, "空框按 ↓ 不接管");
	assert.equal(assist.keydown("ArrowUp"), true);
	assert.equal(shell.snapshot.draft, "第三句");
	assist.observe();
	assert.equal(assist.keydown("ArrowUp"), true);
	assert.equal(shell.snapshot.draft, "第二句");
	assist.observe();
	assert.equal(assist.keydown("ArrowDown"), true);
	assert.equal(shell.snapshot.draft, "第三句");
	assist.observe();
	assert.equal(assist.keydown("ArrowDown"), true);
	assert.equal(shell.snapshot.draft, "", "翻回底部清空");
	assist.observe();
	shell.snapshot = { draft: "我自己打的", phase: "plain" };
	assist.observe();
	assert.equal(assist.keydown("ArrowUp"), false, "草稿里有自己打的字时交还编辑器");
});

test("上下键翻到历史尽头不越界；非 plain 阶段不接管", () => {
	const { api } = loadClient(["唯一一句"]);
	const shell = fakeShell("");
	const assist = api.createAssistState(shell);
	assert.equal(assist.keydown("ArrowUp"), true);
	assist.observe();
	assert.equal(assist.keydown("ArrowUp"), false, "到头了交还编辑器");
	const busy = fakeShell("", "sending");
	assert.equal(api.createAssistState(busy).keydown("ArrowUp"), false);
});

test("Tab 采纳补全；没有候选时不接管", () => {
	const { api } = loadClient(["帮我提交并重启服务"]);
	const shell = fakeShell("帮我");
	const assist = api.createAssistState(shell);
	assert.equal(assist.hint(), "帮我提交并重启服务");
	assert.equal(assist.keydown("Tab"), true);
	assert.equal(shell.snapshot.draft, "帮我提交并重启服务");
	shell.snapshot = { draft: "没有匹配", phase: "plain" };
	assert.equal(assist.keydown("Tab"), false);
});

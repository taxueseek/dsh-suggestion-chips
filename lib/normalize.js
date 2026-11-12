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
 * 主流高危命令与破坏性意图识别规则（基于第一性原理与 MECE 分类）：
 *
 * 1. 文件与磁盘破坏（File & Disk Destruction）：
 *    - rm -rf / rmdir /s /q / del /f /s /q / shred / wipefs / mkfs / format / dd 扇区覆盖
 * 2. 版本库不可逆丢弃与重写（Git Destructive Overwrites）：
 *    - git push -f / --force / +branch / git reset --hard / git clean -fd / git branch -D / git checkout -f
 * 3. 数据库与持久化抹除（Database & Storage Dropping）：
 *    - drop database/table/schema / truncate table / delete from (无条件或全表) / flushall / flushdb
 * 4. 系统停机与暴力杀进程/特权破坏（System Crash & Privilege Abuse）：
 *    - shutdown / reboot / poweroff / init 0 / kill -9 / killall -9 / pkill -9 / taskkill /f / chmod 777 /
 * 5. 危险管道盲执行与远程脚本植入（Remote Pipeline Execution）：
 *    - curl ... | bash / wget ... | sh / iwr ... | iex
 * 6. 中文破坏性自然语言意图（Natural Language High-Risk Intent）：
 *    - 强制删除/清空数据库/格式化磁盘/强制推送/覆盖无备份/放弃所有修改
 */
const DANGER_PATTERNS = [
	// 1. 文件与磁盘级强制删除/格式化
	/\brm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-[a-z]*r\s+-[a-z]*f|-[a-z]*f\s+-[a-z]*r|--force\s+-r|-r\s+--force)\b/i,
	/\b(?:rmdir|del)\s+[\/\-][sSqQfF]/i,
	/\b(?:mkfs(?:\.[a-z0-9]+)?|format\s+[a-z]:|wipefs\s+-a|shred\s+-[a-z]*u)/i,
	/\bdd\s+if=[^\s]+\s+of=\/dev\/[a-z0-9]+/i,

	// 2. 版本控制不可逆丢弃与强制覆盖
	/\bgit\s+push\s+[^\n]*(?:-f\b|--force\b|\+[a-z0-9_\/-]+)/i,
	/\bgit\s+reset\s+--hard\b/i,
	/\bgit\s+clean\s+-[a-z]*f/i,
	/\bgit\s+branch\s+(?:-D\b|--delete\s+(?:--force\b|-f\b))/,
	/\bgit\s+checkout\s+-f\b/i,

	// 3. 数据库与持久化抹除
	/\bdrop\s+(?:database|schema|table|collection|keyspace)\b/i,
	/\btruncate\s+(?:table\s+)?[a-z0-9_`"']+/i,
	/\bdelete\s+from\s+[a-z0-9_`"']+(?:\s*;|\s*$|\s+where\s+(?:1\s*=\s*1|true)\b)/i,
	/\b(?:flushall|flushdb)\b/i,

	// 4. 系统停机与暴力杀进程/特权破坏
	/\b(?:shutdown\s+-[hHr]|reboot|poweroff|init\s+0)\b/i,
	/\bkill\s+-9\s+(?:-1|\d+)\b/i,
	/\b(?:killall|pkill)\s+-9\b/i,
	/\btaskkill\s+\/f\b/i,
	/\bchmod\s+(?:-[a-z]*R[a-z]*\s+)?777\s+\//i,

	// 5. 危险管道盲执行
	/\b(?:curl|wget)\s+[^\n|]+\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i,
	/\b(?:iwr|curl)\s+[^\n|]+\|\s*iex\b/i,

	// 6. 中文自然语言强破坏意图
	/(?:强制|强行|彻底|无备份|静默)(?:删除|清空|抹除|格式化|重置|覆盖|丢弃|检出)/,
	/(?:清空|格式化|抹除)(?:数据库|数据表|磁盘|全盘|全表|缓存)/,
	/(?:强制推送|强制覆盖|覆盖无备份|放弃所有修改|彻底删除|重置所有本地修改)/
];

/**
 * 判断动作是否包含破坏性或不可逆高危特征。
 */
function isDangerousAction(item) {
	if (item === null || typeof item !== "object") return false;
	if (item.danger === true) return true;
	const texts = [];
	if (typeof item.label === "string" && item.label !== "") texts.push(item.label);
	if (typeof item.prompt === "string" && item.prompt !== "") texts.push(item.prompt);
	for (const text of texts) {
		for (const pattern of DANGER_PATTERNS) {
			if (pattern.test(text)) return true;
		}
	}
	return false;
}

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
		// 高危操作标记：显式声明或规则命中的破坏性操作。
		const danger = item.danger === true || isDangerousAction(item) ? true : undefined;
		// 只有显式 true 才算；第二个同类的丢掉（见上面 seenNewSession）。
		const opensNewSession = item.opensNewSession === true ? true : undefined;
		if (opensNewSession === true) {
			if (seenNewSession) continue;
			seenNewSession = true;
		}
		collected.push({
			...(angle === undefined ? {} : { angle }),
			...(recommended === undefined ? {} : { recommended }),
			...(danger === undefined ? {} : { danger }),
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
const PLUGIN_REV = "0.3.0";

/**
 * 判断一段文本是否只含可打印 ASCII。英文场景走英文按钮，中文场景走中文按钮。
 *
 * @param {string} text - 待判断的文本。
 * @returns {boolean} 是否按英文处理。
 */
function isAsciiText(text) {
	return typeof text === "string" && /^[\x20-\x7E]+$/.test(text.trim());
}

/**
 * 从文本中提取编号选项列表（2~5 项）。
 *
 * 同时认中文「方案一：」与英文「Plan A:」「Option 1:」；停止词也分中英两套。
 *
 * @param {string} tail - 文本尾部。
 * @returns {Array} 建议项数组。
 */
function extractOptionList(tail) {
	const optionRegex = /(?:^|\n)\s*(?:(?:(?:\d+|[A-Da-d])[\.、\)）])|(?:(?:方案|选项)[一二三四五1-5][\:：])|(?:(?:option|plan)\s*[1-5A-Da-d]\s*[\.、\)）\:：]))\s*([^\n]+)/gi;
	const matches = [];
	let match;
	while ((match = optionRegex.exec(tail)) !== null) {
		const raw = match[1].replace(/[*_`]/g, "").trim();
		if (raw.length >= 2 && raw.length <= 80) {
			matches.push(raw);
		}
	}
	if (matches.length < 2 || matches.length > 6) return [];
	const angles = ["standard", "bold", "cautious", "alternative", "stop"];
	return matches.slice(0, 5).map((opt, idx) => {
		const ascii = isAsciiText(opt);
		const label = (idx + 1) + ". " + opt.slice(0, 24);
		const prompt = ascii ? "Go with option " + (idx + 1) + ": " + opt : "按选项 " + (idx + 1) + " 执行：" + opt;
		const isStop = ascii
			? /\b(?:no|cancel|skip|abort|exit|quit|discard|drop|stop)\b/i.test(opt)
			: /不|取消|暂缓|放弃|关闭|退出/.test(opt);
		const angle = isStop ? "stop" : angles[idx] || "alternative";
		return {
			label,
			prompt,
			angle,
			recommended: idx === 0
		};
	});
}

/**
 * 从文本尾部提取确认型疑问句的对应动作。
 *
 * @param {string} tail - 文本尾部。
 * @returns {Array} 建议项数组。
 */
function extractConfirmationActions(tail) {
	const isQuestion = /[?？]|(?:吗|呢|吧)[\s\n]*$/i.test(tail);
	if (!isQuestion) return [];

	// 英文问句走英文按钮，避免命中中文正则里的 commit、push 与问号后给出中文标签。
	if (isAsciiText(tail)) return extractEnglishConfirmationActions(tail);

	if (/(?:提交|commit|push|推送)[\s\S]{0,20}(?:代码|修改|到远端|到远程)?[\s\S]{0,15}(?:吗|呢|吧|\?|？)/i.test(tail)) {
		return [
			{ label: "提交并推送", prompt: "提交并推送到远端", angle: "standard", recommended: true },
			{ label: "查看 git diff", prompt: "先查看 git diff 改动细节", angle: "cautious" },
			{ label: "先不提交", prompt: "先不提交，我再确认一下", angle: "stop" }
		];
	}

	if (/(?:测试|单测|test)[\s\S]{0,15}(?:吗|呢|吧|\?|？)/i.test(tail)) {
		return [
			{ label: "运行测试", prompt: "运行测试进行验证", angle: "standard", recommended: true },
			{ label: "跳过测试", prompt: "先跳过测试，继续下一步", angle: "stop" }
		];
	}

	if (/(?:继续|往下|进行下一步|开始执行)[\s\S]{0,20}(?:吗|呢|吧|\?|？)/i.test(tail) ||
		/(?:准备好|确认后)继续/.test(tail)) {
		return [
			{ label: "继续", prompt: "继续执行下一步", angle: "standard", recommended: true },
			{ label: "先暂停", prompt: "先暂停，稍后再继续", angle: "stop" }
		];
	}

	if (/(?:采纳|采用|应用|合并)[\s\S]{0,15}(?:方案|改动|修改|建议)[\s\S]{0,15}(?:吗|呢|吧|\?|？)/i.test(tail)) {
		return [
			{ label: "采纳方案并执行", prompt: "采纳该方案，请直接执行", angle: "standard", recommended: true },
			{ label: "暂不采纳", prompt: "先不采用该方案", angle: "stop" }
		];
	}

	return [];
}

/**
 * 英文确认型问句的固定动作。
 *
 * @param {string} tail - 文本尾部，已确认为纯 ASCII 且含问句。
 * @returns {Array} 建议项数组。
 */
function extractEnglishConfirmationActions(tail) {
	if (/(?:commit|push)[\s\S]{0,30}(?:\?|$)/i.test(tail)) {
		return [
			{ label: "Commit and push", prompt: "Commit and push to the remote", angle: "standard", recommended: true },
			{ label: "Show git diff", prompt: "Show me the git diff first", angle: "cautious" },
			{ label: "Don't commit yet", prompt: "Don't commit yet, I'll review first", angle: "stop" }
		];
	}

	if (/(?:run|execute|start)[\s\S]{0,20}(?:tests?|test suite|specs?)[\s\S]{0,10}(?:\?|$)/i.test(tail)) {
		return [
			{ label: "Run the tests", prompt: "Run the tests to verify", angle: "standard", recommended: true },
			{ label: "Skip the tests", prompt: "Skip the tests for now", angle: "stop" }
		];
	}

	if (/(?:adopt|apply|use|merge|accept|proceed with)[\s\S]{0,25}(?:plan|approach|change|changes|suggestion|proposal|option)[\s\S]{0,10}(?:\?|$)/i.test(tail)) {
		return [
			{ label: "Apply the plan", prompt: "Apply the plan and proceed", angle: "standard", recommended: true },
			{ label: "Don't apply it", prompt: "Don't apply it yet", angle: "stop" }
		];
	}

	if (/(?:continue|proceed|go on|go ahead|next step|move forward|carry on)[\s\S]{0,30}(?:\?|$)/i.test(tail)) {
		return [
			{ label: "Continue", prompt: "Continue with the next step", angle: "standard", recommended: true },
			{ label: "Pause", prompt: "Pause here for now", angle: "stop" }
		];
	}

	return [];
}

/**
 * 从文本尾部提取工程收尾推进动作。
 *
 * @param {string} tail - 文本尾部。
 * @returns {Array} 建议项数组。
 */
function extractLifecycleActions(tail) {
	if (/[?？]|(?:吗|呢)[\s\n]*$/i.test(tail)) return [];
	if (/(?:修改|修复|重构|编写|实现|配置)(?:已完成|完毕|成功|好了)/.test(tail)) {
		return [
			{ label: "跑测试验证", prompt: "跑一下测试验证改动", angle: "standard", recommended: true },
			{ label: "查看 git diff", prompt: "查看当前的 git diff", angle: "cautious" },
			{ label: "提交本次修改", prompt: "提交本次修改", angle: "bold" }
		];
	}
	if (isAsciiText(tail) && (
		/(?:i'?ve|i have)\s+(?:finished|completed|updated|refactored|implemented|applied)\b/i.test(tail)
		|| /\b(?:refactor|fix|changes?|update|implementation|migration)\b[\s\S]{0,25}\b(?:complete|done|finished|ready)\b/i.test(tail)
	)) {
		return [
			{ label: "Run the tests", prompt: "Run the tests to verify the change", angle: "standard", recommended: true },
			{ label: "Show git diff", prompt: "Show me the current git diff", angle: "cautious" },
			{ label: "Commit the changes", prompt: "Commit the changes", angle: "bold" }
		];
	}
	return [];
}

/**
 * 从助手文本中以纯规则/状态机提取确定性操作（Level 0 确定性提取器）。
 *
 * 当模型收尾未显式调用 `suggest_actions` 工具时，本函数作为 0ms、0 Token、
 * 100% 缓存友好的确定性兜底：
 *
 * 1. 选项型问句（Numbered Options）：末尾包含「1. xxx 2. yyy」或「方案一 / 方案二」，英文认「Plan A:」；
 * 2. 确认型问句（Confirmation）：末尾询问「是否继续？」「是否提交？」「是否运行测试？」，英文认 `Should I ...?`；
 * 3. 工程收尾型（Lifecycle Progression）：结尾总结「修改已完成」「修复完毕」或 `I've finished ...` 但未给下一步。
 *
 * @param {string} text - 助手回复的完整或末尾正文。
 * @param {number} [maxActions=DEFAULT_MAX] - 上限。
 * @returns {Array} 清洗后的建议动作列表（若无确定性动作则返回空数组）。
 */
function extractDeterministicActions(text, maxActions = DEFAULT_MAX) {
	if (typeof text !== "string" || text.trim().length < 5) return [];
	const clean = text.trim();
	const tail = clean.slice(-2000);

	const optionActions = extractOptionList(tail);
	if (optionActions.length >= 2) {
		return normalizeActions(optionActions, maxActions);
	}

	const confirmTail = clean.slice(-400);
	const confirmActions = extractConfirmationActions(confirmTail);
	if (confirmActions.length > 0) {
		return normalizeActions(confirmActions, maxActions);
	}

	const lifecycleActions = extractLifecycleActions(confirmTail);
	if (lifecycleActions.length > 0) {
		return normalizeActions(lifecycleActions, maxActions);
	}

	return [];
}

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
	if (block === null || typeof block !== "object") return [];
	const meta = block.meta;
	if (meta !== null && typeof meta === "object" && Array.isArray(meta.actions)) return meta.actions;
	if (Array.isArray(block.actions)) return block.actions;
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
	const adoptedBySession = new Map();
	const displayModes = new Map();
	let activeSessionId = "";

	function getActiveSessionId() {
		return activeSessionId;
	}

	function setActiveSessionId(sessionId) {
		if (typeof sessionId === "string" && sessionId !== "") {
			activeSessionId = sessionId;
		}
	}

	function getDisplayMode(sessionId) {
		if (typeof sessionId !== "string" || sessionId === "") return "both";
		return displayModes.get(sessionId) || "both";
	}

	function setDisplayMode(sessionId, mode) {
		if (typeof sessionId !== "string" || sessionId === "") return;
		const validModes = ["both", "chips", "tab", "none"];
		if (validModes.includes(mode)) {
			displayModes.set(sessionId, mode);
		}
	}

	function rememberUserText(sessionId, text) {
		if (typeof sessionId !== "string" || sessionId === "" || typeof text !== "string") return false;
		const trimmed = text.trim().toLowerCase();
		if (trimmed === "") return false;
		let set = adoptedBySession.get(sessionId);
		if (set === undefined) {
			set = new Set();
			adoptedBySession.set(sessionId, set);
		}
		set.add(trimmed);
		return true;
	}

	function remember(sessionId, block, callIdProp) {
		if (typeof sessionId !== "string" || sessionId === "" || block === null || typeof block !== "object") return false;
		const callId = typeof callIdProp === "string" && callIdProp !== ""
			? callIdProp
			: typeof block.callId === "string" ? block.callId : "";
		if (typeof block.turn === "number" && callId !== "") {
			callTurns.set(`${sessionId}:${callId}`, block.turn);
		}
		const actions = readHostActions(block);
		if (block.meta && typeof block.meta.displayMode === "string") {
			setDisplayMode(sessionId, block.meta.displayMode);
		}
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
			prev.source === "explicit" &&
			JSON.stringify(prev.actions) === JSON.stringify(actions)
		) {
			return false;
		}
		entries.set(key, { key, callId, turn, seq, actions, source: "explicit" });
		return true;
	}

	function rememberText(sessionId, turn, seq, text) {
		if (typeof sessionId !== "string" || sessionId === "" || typeof text !== "string") return false;
		const actions = extractDeterministicActions(text);
		if (actions.length === 0) return false;
		const turnNum = typeof turn === "number" ? turn : undefined;
		const seqNum = typeof seq === "number" ? seq : undefined;
		const key = turnNum !== undefined ? `turn:${turnNum}` : seqNum !== undefined ? `seq:${seqNum}` : "latest";
		let entries = bySession.get(sessionId);
		if (entries === undefined) {
			entries = new Map();
			bySession.set(sessionId, entries);
		}
		for (const item of entries.values()) {
			if (turnNum !== undefined && item.turn === turnNum && item.source === "explicit") return false;
		}
		const prev = entries.get(key);
		if (prev !== undefined && prev.source === "explicit") return false;
		if (prev !== undefined && JSON.stringify(prev.actions) === JSON.stringify(actions)) return false;
		entries.set(key, { key, turn: turnNum, seq: seqNum, actions, source: "deterministic" });
		return true;
	}

	function notify(sessionId) {
		const targets = typeof sessionId === "string" && sessionId !== "" ? [sessionId, "*"] : ["*"];
		for (const key of targets) {
			const set = listeners.get(key);
			if (set === undefined) continue;
			for (const fn of [...set]) {
				try {
					fn(sessionId);
				} catch {}
			}
		}
	}

	function take(sessionId, turnProp) {
		if (typeof sessionId !== "string" || sessionId === "") return [];
		const entries = bySession.get(sessionId);
		if (entries === undefined || entries.size === 0) return [];
		const list = [...entries.values()];
		if (turnProp === undefined || turnProp === null) {
			const explicit = list.filter((i) => i.source === "explicit").at(-1);
			return explicit?.actions ?? list.at(-1)?.actions ?? [];
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

		let explicitActions = undefined;
		let deterministicActions = undefined;

		for (let i = list.length - 1; i >= 0; i -= 1) {
			const item = list[i];
			let matched = false;
			if (turnNum !== undefined && item.turn !== undefined) {
				if (item.turn === turnNum) matched = true;
			} else if (item.seq !== undefined && startSeq !== undefined) {
				if (item.seq >= startSeq && (endSeq === undefined || item.seq <= endSeq)) matched = true;
			} else if (item.turn === undefined && item.seq === undefined) {
				matched = true;
			}
			if (matched) {
				if (item.source === "explicit") {
					explicitActions = item.actions;
					break;
				} else if (deterministicActions === undefined) {
					deterministicActions = item.actions;
				}
			}
		}
		const rawActions = explicitActions ?? deterministicActions ?? [];
		const adoptedSet = adoptedBySession.get(sessionId);
		if (adoptedSet === undefined || adoptedSet.size === 0) return rawActions;
		return rawActions.map((action) => {
			const promptKey = typeof action.prompt === "string" ? action.prompt.trim().toLowerCase() : "";
			const labelKey = typeof action.label === "string" ? action.label.trim().toLowerCase() : "";
			const isAdopted = (promptKey !== "" && adoptedSet.has(promptKey)) || (labelKey !== "" && adoptedSet.has(labelKey));
			return isAdopted ? { ...action, adopted: true } : action;
		});
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
		adoptedBySession.clear();
		displayModes.clear();
	}

	return { remember, rememberText, rememberUserText, notify, take, subscribe, clear, getDisplayMode, setDisplayMode, getActiveSessionId, setActiveSessionId };
}

export {
	ANGLES,
	DEFAULT_MAX,
	HARD_MAX,
	PLUGIN_REV,
	TOOL_DESCRIPTION,
	createSuggestionStore,
	declaresFor,
	extractDeterministicActions,
	isDangerousAction,
	readHostActions
};

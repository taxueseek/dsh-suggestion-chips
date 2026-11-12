/**
 * dsh-suggest-actions —— 客户端侧。
 *
 * 两处注册，分工明确：
 *   1. `tool.call.toolview`（工具卡片）——**静默采集**：把这一轮的建议记进插件内存，
 *      自己不显示任何东西（它在"过程组"里，折叠起来本来就看不见）。
 *   2. `conversation.chat.turnTail`（轮次尾部）——**显示按钮**。这个位置在
 *      `TurnTailNodeView` 里，和"点赞那排"同一个容器、排在它之前，
 *      **不在过程折叠范围内**，所以过程收起来它也露着。
 *
 * 依据（2026-09-26 读源码确认）：
 *   - 折叠用的是 HTML `hidden` 属性（`hidden": processHidden`），不是卸载，
 *     所以采集组件在被折叠时**仍然会渲染**，数据拿得到；
 *   - `turnTail` 由 `renderSlot("conversation.chat.turnTail", { turn, seq, openFile })`
 *     渲染，本身不带 sessionId，靠 `inject: (sessionId) => ...` 注入；
 *   - 点一下走 `conversation.input.shell(sessionId).actions` 的 setDraft + submit，
 *     和用户自己敲键盘是同一条路。
 *   3. 每条建议右侧还挂一个小按钮（输入框图标，见 `fillComposer`）：把这句话放进
 *      输入框、**不发送**，用户改完自己按回车。
 *   4. 状态由 `apply(ctx)` 实例内的 `createSuggestionStore()` 持有（`ctx.effect` 卸载清理），
 *      按 `(sessionId, turn / seq)` 关联采集器与展示器，并通过订阅机制消除挂载时序竞态与跨轮次串轮。
 *   5. 展示器挂载时从 `sessions.binding(sessionId).eventSource` 回放一遍名单，
 *      补上「刷新后 store 为空、历史轮次没有按钮」这条。名单本来随会话日志落盘。
 */
"use strict";
(() => {
	/** 视觉意图：回复下方的一排快速操作，安静但不隐形——浅灰底、无边框、13px。 */
	const CSS = [
		// 宽度：整列按"最长的那条标签"定宽（grid 的 max-content 列），几条按钮因此一样宽。
		// 全文要用 contain:inline-size 排除出宽度计算，否则它会把整列撑宽。
		".dsh-suggest{display:grid;grid-template-columns:max-content;align-items:start;gap:10px;padding:4px 0 2px}",
		".dsh-suggest-item{display:flex;flex-direction:column;gap:4px;min-width:0}",
		".dsh-suggest-line{display:flex;align-items:center;gap:8px;min-width:0}",
		".dsh-suggest-btn{display:flex;flex-direction:column;gap:4px;align-items:stretch;flex:1 1 auto;width:auto;min-width:0;max-width:min(100%,520px);box-sizing:border-box;padding:10px 14px;border:0;border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-interactive-bg-hover,#f1f2f4);color:var(--dsw-alias-label-primary,#1a1a1a);font:inherit;font-size:13px;line-height:1.5;text-align:left;cursor:pointer;transition:background 80ms}",
		".dsh-suggest-row{display:flex;align-items:center;gap:10px;min-width:0}",
		".dsh-suggest-full{contain:inline-size;max-height:0;opacity:0;overflow:hidden;color:var(--dsw-alias-label-secondary,#6b6f76);font-size:12px;line-height:1.6;word-break:break-word;transition:max-height 160ms ease,opacity 160ms ease}",
		".dsh-suggest-item:hover .dsh-suggest-full,.dsh-suggest-item:focus-within .dsh-suggest-full{max-height:9em;opacity:1;overflow:auto}",
		".dsh-suggest-btn:hover{background:var(--dsw-alias-interactive-bg-active,#e4e6ea)}",
		".dsh-suggest-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}",
		".dsh-suggest-btn:disabled{opacity:.5;cursor:default}",
		// 填入按钮：把这条建议放进输入框，让用户改完自己发。常驻可见但低调，悬停提亮。
		".dsh-suggest-fill{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8f98);cursor:pointer;opacity:.75;transition:background 80ms,color 80ms,opacity 80ms}",
		".dsh-suggest-fill:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f2f4);color:var(--dsw-alias-label-primary,#1a1a1a);opacity:1}",
		".dsh-suggest-fill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}",
		".dsh-suggest-fill:disabled{opacity:.4;cursor:default}",
		".dsh-suggest-fill svg{display:block}",
		".dsh-suggest-btn[data-recommended]{font-weight:600}",
		".dsh-suggest-btn[data-danger]{border:1px solid var(--dsw-alias-state-warning-primary,#f39c12)}",
		".dsh-suggest-rec{flex:none;font-size:11px;line-height:1.7;padding:0 7px;border-radius:999px;background:var(--dsw-alias-brand-primary,#4176e6);color:#fff}",
		".dsh-suggest-danger{flex:none;font-size:11px;line-height:1.7;padding:0 7px;border-radius:999px;background:var(--dsw-alias-state-warning-primary,#f39c12);color:#fff}",
		".dsh-suggest-adopted{flex:none;font-size:11px;line-height:1.7;padding:0 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-active,#e4e6ea);color:var(--dsw-alias-label-secondary,#6b6f76);opacity:.85}",
		".dsh-suggest-tag{flex:none;font-size:11px;line-height:1.7;padding:0 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-active,#e4e6ea);color:var(--dsw-alias-label-secondary,#6b6f76)}",
		".dsh-suggest-error{max-width:min(100%,520px);color:var(--dsw-alias-state-error-primary,#c0392b);font-size:12px;line-height:1.6;word-break:break-word}",
		".dsh-suggest-warn-info{max-width:min(100%,520px);color:var(--dsw-alias-state-warning-primary,#d35400);font-size:12px;line-height:1.6;word-break:break-word}",
		".dsh-suggest-more{justify-self:start;display:inline-flex;align-items:center;gap:6px;padding:2px 6px;border:0;background:none;color:var(--dsw-alias-label-secondary,#6b6f76);font:inherit;font-size:12px;line-height:1.8;cursor:pointer;border-radius:var(--dsw-radius-sm,6px)}",
		".dsh-suggest-more:hover{color:var(--dsw-alias-label-primary,#1a1a1a);background:var(--dsw-alias-interactive-bg-hover,#f1f2f4)}",
		".dsh-suggest-more:disabled{opacity:.5;cursor:default}",
		".dsh-suggest-label{flex:1;min-width:0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}",
		".dsh-suggest-arrow{flex:none;color:var(--dsw-alias-label-tertiary,currentColor);opacity:.7}"
	].join("");

	/** 官方 styles 服务优先，取不到就退回自己插一个 <style>。 */
	function installStyles(ctx) {
		try {
			const styles = ctx.get("styles");
			if (styles !== undefined && styles !== null && typeof styles.insert === "function") {
				styles.insert(CSS);
				return;
			}
		} catch {}
		try {
			const tag = document.createElement("style");
			tag.textContent = CSS;
			document.head.appendChild(tag);
		} catch {}
	}

	/**
	 * 读 host 交回来的最终列表：清洗、去重、排序、截断都由 host 定，界面照抄。
	 *
	 * 客户端 bundle 拿不到插件配置（`maxActions`），上限在本地算不出来；host 把结果随
	 * 工具结果一起送过来（`render` 里那段 JSON），规则因此只剩一份。
	 *
	 * ⚠️ 取不到就是空数组——**这里没有兜底**。真取不到，界面一条按钮都不会出现。
	 *
	 * @param block - toolview 组件拿到的 block。
	 * @returns 建议列表；取不到返回空数组。
	 */
	function readHostActions(block) {
		if (block === null || typeof block !== "object" || !("kind" in block)) return [];
		// 0.2.0 起名单走 presentationMeta（模型看不见）；0.1.x 的旧会话日志里名单在结果正文，下面兜底。
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
	 * 取会话输入框的 shell：会话、输入框服务都从 ctx 懒取，取不到就返回 undefined。
	 *
	 * @param ctx - 插件上下文。
	 * @param sessionId - 目标会话。
	 * @returns shell，或 undefined。
	 */
	function composerShell(ctx, sessionId) {
		const conversation = ctx.get("conversation");
		const input = conversation === undefined || conversation === null ? undefined : conversation.input;
		const shell = input !== undefined && input !== null && typeof input.shell === "function"
			? input.shell(sessionId)
			: undefined;
		return shell === undefined || shell === null ? undefined : shell;
	}

	/**
	* 用用户的身份发一条消息：写草稿 → 等草稿真的落定 → 提交。
	*
	* 两步之间必须等：setDraft 走 Lexical 的异步更新，而 submit 读的是编辑器投影，
	* 同一 tick 里连着调，提交上去的还是空草稿。
	*
	* @param ctx - 插件上下文。
	* @param sessionId - 目标会话。
	* @param text - 要发出去的文本。
	*/
	function sendAsUser(ctx, sessionId, text) {
		const shell = composerShell(ctx, sessionId);
		if (shell === undefined) throw new Error(`no composer shell for session "${sessionId}"`);
		const actions = shell.actions;
		const setDraft = actions !== undefined && actions !== null && typeof actions.setDraft === "function"
			? (value) => actions.setDraft(value)
			: typeof shell.setDraft === "function" ? (value) => shell.setDraft(value) : undefined;
		if (setDraft === undefined) throw new Error("composer shell exposes no setDraft");
		const submit = actions !== undefined && actions !== null && typeof actions.submit === "function"
			? () => actions.submit()
			: undefined;
		if (submit === undefined) throw new Error("composer shell exposes no submit");
		setDraft(text);
		let tries = 0;
		const settle = () => {
			let draft;
			try {
				draft = shell.state.getSnapshot().draft;
			} catch {
				draft = undefined;
			}
			if (draft === text || tries >= 12) {
				try {
					submit();
				} catch (error) {
					console.error("[dsh-suggest-actions] submit failed:", error);
				}
				return;
			}
			tries += 1;
			window.setTimeout(settle, 25);
		};
		window.setTimeout(settle, 0);
	}

	/** 点一条建议时真正要用的文本：优先 prompt，退回 label。 */
	function actionText(item) {
		return typeof item.prompt === "string" && item.prompt !== "" ? item.prompt : item.label;
	}

	/**
	* 把建议文本放进当前会话的输入框，**不发送**——用户改完自己按回车。
	*
	* 写进去之前先清空：输入框里原有的内容会被这句替换掉，不留上一句的尾巴。
	*
	* @param ctx - 插件上下文。
	* @param sessionId - 当前会话。
	* @param text - 要放进去的文本。
	*/
	function fillComposer(ctx, sessionId, text) {
		const shell = composerShell(ctx, sessionId);
		if (shell === undefined) throw new Error(`no composer shell for session "${sessionId}"`);
		const actions = shell.actions;
		if (actions !== undefined && actions !== null && typeof actions.insertText === "function") {
			try {
				actions.insertText(text);
				if (typeof shell.focus === "function") shell.focus();
				return;
			} catch {}
		}
		const setDraft = actions !== undefined && actions !== null && typeof actions.setDraft === "function"
			? (value) => actions.setDraft(value)
			: typeof shell.setDraft === "function" ? (value) => shell.setDraft(value) : undefined;
		if (setDraft === undefined) throw new Error("composer shell exposes no setDraft");
		setDraft(text);
		if (typeof shell.focus === "function") shell.focus();
	}

	/**
	 * 主流高危命令与破坏性意图识别规则（客户端双重校验）。
	 */
	const DANGER_PATTERNS = [
		/\brm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-[a-z]*r\s+-[a-z]*f|-[a-z]*f\s+-[a-z]*r|--force\s+-r|-r\s+--force)\b/i,
		/\b(?:rmdir|del)\s+[\/\-][sSqQfF]/i,
		/\b(?:mkfs(?:\.[a-z0-9]+)?|format\s+[a-z]:|wipefs\s+-a|shred\s+-[a-z]*u)/i,
		/\bdd\s+if=[^\s]+\s+of=\/dev\/[a-z0-9]+/i,
		/\bgit\s+push\s+[^\n]*(?:-f\b|--force\b|\+[a-z0-9_\/-]+)/i,
		/\bgit\s+reset\s+--hard\b/i,
		/\bgit\s+clean\s+-[a-z]*f/i,
		/\bgit\s+branch\s+(?:-D\b|--delete\s+(?:--force\b|-f\b))/,
		/\bgit\s+checkout\s+-f\b/i,
		/\bdrop\s+(?:database|schema|table|collection|keyspace)\b/i,
		/\btruncate\s+(?:table\s+)?[a-z0-9_`"']+/i,
		/\bdelete\s+from\s+[a-z0-9_`"']+(?:\s*;|\s*$|\s+where\s+(?:1\s*=\s*1|true)\b)/i,
		/\b(?:flushall|flushdb)\b/i,
		/\b(?:shutdown\s+-[hHr]|reboot|poweroff|init\s+0)\b/i,
		/\bkill\s+-9\s+(?:-1|\d+)\b/i,
		/\b(?:killall|pkill)\s+-9\b/i,
		/\btaskkill\s+\/f\b/i,
		/\bchmod\s+(?:-[a-z]*R[a-z]*\s+)?777\s+\//i,
		/\b(?:curl|wget)\s+[^\n|]+\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i,
		/\b(?:iwr|curl)\s+[^\n|]+\|\s*iex\b/i,
		/(?:强制|强行|彻底|无备份|静默)(?:删除|清空|抹除|格式化|重置|覆盖|丢弃|检出)/,
		/(?:清空|格式化|抹除)(?:数据库|数据表|磁盘|全盘|全表|缓存)/,
		/(?:强制推送|强制覆盖|覆盖无备份|放弃所有修改|彻底删除|重置所有本地修改)/
	];

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

	/** 填入图标：一个带光标的输入框——点它把建议写进下面那个输入框。 */
	function fillIcon(React) {
		return React.createElement("svg", {
			width: 16,
			height: 16,
			viewBox: "0 0 16 16",
			fill: "none",
			"aria-hidden": "true",
			focusable: "false"
		}, React.createElement("rect", {
			x: 1.9,
			y: 3.9,
			width: 12.2,
			height: 8.2,
			rx: 2.2,
			stroke: "currentColor",
			strokeWidth: 1.4
		}), React.createElement("path", {
			d: "M5.6 6.1v3.8",
			stroke: "currentColor",
			strokeWidth: 1.4,
			strokeLinecap: "round"
		}));
	}

	/**
	* 新建一个会话、把界面切过去，再把交接文本放进它的输入框。
	*
	* 为什么不用官方的 fork：fork 带的是整段历史，上下文一样长，省不下钱；
	* 这条要的是"从零开始、只带结论"。所以走 create——新会话落在同一个工作目录，
	* 文本只写进草稿、**不自动发送**，用户能看一眼、再补一句。
	*
	* @param ctx - 插件上下文。
	* @param sessionId - 当前会话，用它推出新会话该落在哪个目录。
	* @param text - 要带过去的文本。
	* @returns 新会话 id。
	*/
	function openNewSession(ctx, sessionId, text) {
		return (async () => {
			const sessions = ctx.get("sessions");
			if (sessions === undefined || sessions === null || typeof sessions.create !== "function") {
				throw new Error("会话服务不可用，建不了新会话");
			}
			const childId = await sessions.create(currentWorkspaceTarget(ctx, sessions, sessionId));
			const uiWorkspace = ctx.get("uiWorkspace");
			if (uiWorkspace !== undefined && uiWorkspace !== null && typeof uiWorkspace.openSession === "function") {
				uiWorkspace.openSession(childId);
			} else if (typeof sessions.open === "function") {
				sessions.open(childId);
			} else {
				throw new Error(`新会话 ${childId} 已建好，但没找到把它切到前台的办法`);
			}
			await fillDraft(ctx, childId, text);
			return childId;
		})();
	}

	/**
	* 新会话该落在哪儿：先按"当前会话所属的工作区"建，这样它会出现在侧栏同一组里；
	* 工作区读不到就退回当前会话的工作目录，再不行交给 create 用默认值。
	*
	* 为什么不是只给 cwd：官方自己人（ui-workspace）建会话时传的是 workspaceId。
	*
	* @param ctx - 插件上下文。
	* @param sessions - 会话服务。
	* @param sessionId - 当前会话。
	* @returns 传给 `sessions.create` 的参数对象。
	*/
	function currentWorkspaceTarget(ctx, sessions, sessionId) {
		const workspaceId = currentWorkspaceId(ctx, sessionId);
		if (workspaceId !== undefined) return { workspaceId };
		const cwd = currentCwd(sessions, sessionId);
		return cwd === undefined ? {} : { cwd };
	}

	/**
	* 从工作区列表里找当前会话属于哪一个。
	* 读不到不是错误，交给调用方退回别的办法，所以这里不抛。
	*
	* @param ctx - 插件上下文。
	* @param sessionId - 当前会话。
	* @returns 工作区 id，或 undefined。
	*/
	function currentWorkspaceId(ctx, sessionId) {
		const workspaces = ctx.get("workspaces");
		if (workspaces === undefined || workspaces === null || workspaces.list === undefined
			|| workspaces.list === null || typeof workspaces.list.getSnapshot !== "function") return undefined;
		const snapshot = workspaces.list.getSnapshot();
		const items = snapshot === undefined || snapshot === null || !Array.isArray(snapshot.items) ? [] : snapshot.items;
		const current = items.find((item) => item !== null && typeof item === "object"
			&& Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId));
		if (current === undefined || typeof current.workspaceId !== "string" || current.workspaceId === "") return undefined;
		return current.workspaceId;
	}

	/**
	* 读当前会话的工作目录，新会话照它落位。
	* 读不到就返回 undefined（交给 create 用默认目录）——这不是错误，所以不抛。
	*
	* @param sessions - 会话服务。
	* @param sessionId - 当前会话。
	* @returns 工作目录，或 undefined。
	*/
	function currentCwd(sessions, sessionId) {
		if (sessions.list === undefined || sessions.list === null || typeof sessions.list.getSnapshot !== "function") return undefined;
		const snapshot = sessions.list.getSnapshot();
		const summary = snapshot === undefined || snapshot === null || snapshot.byId === undefined ? undefined : snapshot.byId[sessionId];
		return summary === undefined || summary === null ? undefined : summary.cwd;
	}

	/**
	* 把文本写进目标会话的输入框，等到它真的落定。
	*
	* 新建出来的会话，输入框不是立刻就在的（要先挂载），所以这里轮询；
	* 轮询到期仍写不进去就抛错——静默失败会让用户以为"已经带过去了"。
	*
	* @param ctx - 插件上下文。
	* @param sessionId - 目标会话。
	* @param text - 要写进草稿的文本。
	* @returns 写入成功时以 sessionId 结算。
	*/
	function fillDraft(ctx, sessionId, text) {
		return new Promise((resolve, reject) => {
			let attempts = 0;
			const attempt = () => {
				let shell;
				try {
					shell = composerShell(ctx, sessionId);
				} catch (error) {
					reject(error);
					return;
				}
				if (shell !== undefined && shell !== null) {
					const actions = shell.actions;
					const setDraft = actions !== undefined && actions !== null && typeof actions.setDraft === "function"
						? (value) => actions.setDraft(value)
						: typeof shell.setDraft === "function" ? (value) => shell.setDraft(value) : undefined;
					if (setDraft !== undefined) {
						try {
							setDraft(text);
						} catch (error) {
							reject(error);
							return;
						}
						let draft;
						try {
							draft = shell.state.getSnapshot().draft;
						} catch {
							// 读不到状态就按写入成功算：setDraft 已经调用过了。
							draft = undefined;
						}
						if (draft === undefined || draft === text) {
							resolve(sessionId);
							return;
						}
					}
				}
				attempts += 1;
				if (attempts > NEW_SESSION_WAIT_TRIES) {
					reject(new Error("新会话的输入框一直没准备好，交接内容没能带过去"));
					return;
				}
				window.setTimeout(attempt, NEW_SESSION_WAIT_MS);
			};
			attempt();
		});
	}

	/**
	 * 从文本中提取编号选项列表（2~5 项）。
	 */
	function extractOptionList(tail) {
		const optionRegex = /(?:^|\n)\s*(?:(?:(?:\d+|[A-Da-d])[\.、\)）])|(?:(?:方案|选项)[一二三四五1-5][\:：]))\s*([^\n]+)/g;
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
			const label = (idx + 1) + ". " + opt.slice(0, 24);
			const prompt = "按选项 " + (idx + 1) + " 执行：" + opt;
			const isStop = /不|取消|暂缓|放弃|关闭|退出/.test(opt);
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
	 */
	function extractConfirmationActions(tail) {
		const isQuestion = /[?？]|(?:吗|呢|吧)[\s\n]*$/i.test(tail);
		if (!isQuestion) return [];

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
	 * 从文本尾部提取工程收尾推进动作。
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
		return [];
	}

	/**
	 * 从助手文本中以纯规则/状态机提取确定性操作（Level 0 确定性提取器）。
	 */
	function extractDeterministicActions(text) {
		if (typeof text !== "string" || text.trim().length < 5) return [];
		const clean = text.trim();
		const tail = clean.slice(-2000);

		const optionActions = extractOptionList(tail);
		if (optionActions.length >= 2) return optionActions;

		const confirmTail = clean.slice(-400);
		const confirmActions = extractConfirmationActions(confirmTail);
		if (confirmActions.length > 0) return confirmActions;

		const lifecycleActions = extractLifecycleActions(confirmTail);
		if (lifecycleActions.length > 0) return lifecycleActions;

		return [];
	}

	/**
	 * 按会话与轮次索引的建议列表存储（由 `apply(ctx)` 实例持有，`ctx.effect` 卸载清理）。
	 *
	 * 关联规则：
	 *   1. `tool.call.toolview` 在 `preparing`/`start` 阶段携带 `block.turn` 与 `callId`，
	 *      在 `result` 阶段携带 `block.seq`、`callId` 与 `block.meta.actions`。
	 *   2. `conversation.chat.turnTail` 的 `props.turn` 携带 `{ turn, start: { seq }, end: { seq } }`。
	 *   3. 读取时优先按 `turn` 编号精确匹配，其次按 `seq` 落在 `[start.seq, end.seq]` 区间匹配；
	 *      仅当旧宿主未传 `props.turn` 时才退回该会话最新一条，彻底消除多轮会话串轮显示。
	 *   4. 显式工具调用（`source: "explicit"`）优先；未调用时由 `rememberText` 提取的确定性动作兜底。
	 */
	function createSuggestionStore() {
		const bySession = new Map();
		const callTurns = new Map();
		const listeners = new Map();
		const adoptedBySession = new Map();

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
		}

		return { remember, rememberText, rememberUserText, notify, take, subscribe, clear };
	}

	/**
	* 点击逻辑：防连点 + 分发。
	*
	* 两条路：
	*   - 普通建议 —— 把句子作为用户消息发在当前会话（`sendAsUser`）。
	*   - `opensNewSession` —— 新建会话、切过去、把文本放进那边的草稿。
	*
	* 两条路的失败都要让人看见：只往控制台写一句，用户会以为已经生效了。
	*
	* @param React - 官方 React。
	* @param ctx - 插件上下文。
	* @param sessionId - 当前会话。
	* @returns [进行中, 点击处理, 填入输入框, 失败文案]。
	*/
	function usePicker(React, ctx, sessionId) {
		const [pending, setPending] = React.useState(false);
		const [failure, setFailure] = React.useState("");
		const busy = React.useRef(false);
		const settle = () => {
			busy.current = false;
			setPending(false);
		};
		const pick = (item) => {
			if (busy.current || sessionId === "") return;
			if (item.adopted === true) return;
			if (item.danger === true || isDangerousAction(item)) {
				// 高危动作拦截直发，降级为安全填入草稿框，并展示防护提示
				fill(item);
				setFailure(uiStrings().dangerNotice);
				return;
			}
			busy.current = true;
			setPending(true);
			setFailure("");
			const text = actionText(item);
			if (item.opensNewSession === true) {
				openNewSession(ctx, sessionId, text).then(settle, (error) => {
					console.error("[dsh-suggest-actions] open new session failed:", error);
					setFailure(errorMessage(error));
					settle();
				});
				return;
			}
			try {
				sendAsUser(ctx, sessionId, text);
			} catch (error) {
				console.error("[dsh-suggest-actions] send failed:", error);
				setFailure(errorMessage(error));
			}
			window.setTimeout(settle, 900);
		};
		const fill = (item) => {
			if (sessionId === "") return;
			try {
				fillComposer(ctx, sessionId, actionText(item));
				setFailure("");
			} catch (error) {
				console.error("[dsh-suggest-actions] fill composer failed:", error);
				setFailure(errorMessage(error));
			}
		};
		return [pending, pick, fill, failure];
	}

	/** 失败的文案：说清哪儿错了，别只给个"出错了"。 */
	function errorMessage(error) {
		if (error !== null && typeof error === "object" && typeof error.message === "string" && error.message !== "") {
			return error.message;
		}
		return String(error);
	}

	/** 采集器：挂在工具卡片上，只记数据，不画东西。 */
	function createCapture(React, store) {
		return function SuggestActionsCapture(props) {
			const sessionId = typeof props.sessionId === "string" ? props.sessionId : "";
			// 同步写入 store（让后渲染的 Tail 首帧即可拿到），再在 commit 后通知先挂载的 Tail。
			const changed = store.remember(sessionId, props.block, props.callId);
			React.useEffect(() => {
				if (changed && sessionId !== "") store.notify(sessionId);
			});
			return null;
		};
	}

	/**
	 * 默认直接露出几条，其余折叠起来。
	 *
	 * 2026-09-30 从 3 改成 5：单轮上限本来就是 5（立场五档各一条），阈值设成 3
	 * 会让界面上永远只有 3 个按钮、多出来的要点一下才看得见——用户连着两轮
	 * 反馈"最多只能看到 3 个"。设成 5 等于默认铺开；折叠这段逻辑留着，给
	 * 以后上限被调高（配置到 6）时用。
	 */
	const VISIBLE_ACTIONS = 5;

	/** 新会话的输入框要等它挂载：最多等 40 × 100ms = 4 秒。 */
	const NEW_SESSION_WAIT_TRIES = 40;
	const NEW_SESSION_WAIT_MS = 100;

	/**
	 * 界面文案：只分中英两套，够用就行，不引翻译框架。
	 *
	 * ⚠️ 组件的 props 里其实带了官方翻译入口 `t`（插件笔记里记着这一条），但它的
	 * 词条格式还没查清，所以这里先按界面语言自己判断；查清之后可以整段换掉。
	 * 判断不出语言时按中文——那是原来的行为。
	 */
	function uiStrings() {
		const lang = String(document.documentElement?.lang || window.navigator?.language || "").toLowerCase();
		const zh = lang === "" || lang.startsWith("zh");
		return zh
			? { recommended: "推荐", danger: "高危", dangerHint: "高危命令：已拦截一键直发，点击将安全填入输入框供您审核确认", dangerNotice: "已拦截一键直发：检测到高危破坏性指令，已为您安全填入输入框，请核对后手动按回车发送", adopted: "已采纳", newSession: "新会话", failed: "没能带过去：", more: (n) => `还有 ${n} 条`, less: "收起", fillHint: "填入输入框，改完再发" }
			: { recommended: "Recommended", danger: "Danger", dangerHint: "High-risk command: direct sending intercepted, click to fill composer for review", dangerNotice: "Direct execution intercepted: high-risk command filled into composer for your review", adopted: "Adopted", newSession: "New session", failed: "Could not carry it over: ", more: (n) => `${n} more`, less: "Show less", fillHint: "Put in the message box to edit before sending" };
	}

	/**
	 * 一条建议：按钮 + 悬停展开的全文。
	 *
	 * 全文**放在按钮外面**（做按钮的兄弟节点）：一是不参与按钮宽度计算，二展开之后
	 * 点它不会误发——它原先长在按钮里，想选中文字复制一下都会点出去。
	 */
	function actionItem(React, item, key, pending, pick, fill, text) {
		// 只有确实比标签更长、内容也不同的 prompt 才值得展开；缺省时发送的就是 label 本身。
		const full = typeof item.prompt === "string" && item.prompt !== "" && item.prompt !== item.label
			? item.prompt
			: undefined;
		const isDanger = item.danger === true || isDangerousAction(item);
		const btnTitle = isDanger ? text.dangerHint : item.label;
		return React.createElement("div", {
			key,
			className: "dsh-suggest-item"
		}, React.createElement("div", {
			className: "dsh-suggest-line"
		}, React.createElement("button", {
			type: "button",
			className: "dsh-suggest-btn",
			title: btnTitle,
			"data-recommended": item.recommended === true ? "" : undefined,
			"data-danger": isDanger ? "" : undefined,
			"data-adopted": item.adopted === true ? "" : undefined,
			disabled: pending || item.adopted === true,
			onClick: () => pick(item)
		}, React.createElement("span", {
			className: "dsh-suggest-row"
		}, React.createElement("span", {
			className: "dsh-suggest-label", title: item.label
		}, item.label), item.opensNewSession === true ? React.createElement("span", {
			className: "dsh-suggest-tag"
		}, text.newSession) : null, item.recommended === true ? React.createElement("span", {
			className: "dsh-suggest-rec"
		}, text.recommended) : null, isDanger ? React.createElement("span", {
			className: "dsh-suggest-danger",
			title: text.dangerHint
		}, `\u26A0 ${text.danger}`) : null, item.adopted === true ? React.createElement("span", {
			className: "dsh-suggest-danger"
		}, `\u26A0 ${text.danger}`) : null, item.adopted === true ? React.createElement("span", {
			className: "dsh-suggest-adopted"
		}, `\u2713 ${text.adopted}`) : null, React.createElement("span", {
			className: "dsh-suggest-arrow",
			"aria-hidden": "true"
		}, "\u2192"))), React.createElement("button", {
			type: "button",
			className: "dsh-suggest-fill",
			title: text.fillHint,
			"aria-label": text.fillHint,
			disabled: pending,
			onClick: () => fill(item)
		}, fillIcon(React))), full === undefined ? null : React.createElement("span", {
			className: "dsh-suggest-full"
		}, full));
	}

	/**
	 * 从会话事件流补齐名单：刷新、切走再回来、或历史轮次的采集中间件没挂过
	 * （宿主只在渲染过 toolview 时才采集），store 就是空的，按钮随之消失。
	 *
	 * 名单本身随会话日志落盘（`tool/result.meta.actions`），所以直接从
	 * `ctx.sessions.binding(sessionId).eventSource` 的回放窗口里读一遍即可。
	 * 事件源不可得时静默放弃——旧宿主没有它，行为回到「只靠实时采集」。
	 *
	 * @param ctx - 插件上下文。
	 * @param store - 建议存储。
	 * @param sessionId - 当前会话。
	 * @returns 取消订阅函数。
	 */
	function hydrateFromEvents(ctx, store, sessionId) {
		let sessions;
		try {
			sessions = typeof ctx.get === "function" ? ctx.get("sessions") : undefined;
		} catch {
			sessions = undefined;
		}
		if (sessions === undefined) {
			try {
				sessions = ctx.sessions;
			} catch {
				sessions = undefined;
			}
		}
		const binding = typeof sessions?.binding === "function" ? sessions.binding(sessionId) : undefined;
		const source = binding?.eventSource;
		if (source === undefined || source === null
			|| typeof source.getSnapshot !== "function" || typeof source.subscribe !== "function") {
			return () => {};
		}
		const absorb = (entries) => {
			let changed = false;
			for (const entry of entries ?? []) {
				const event = entry?.event ?? entry;
				if (event?.type === "tool/result") {
					const data = event.data ?? {};
					const meta = data.meta;
					if (meta === null || typeof meta !== "object" || !Array.isArray(meta.actions)) continue;
					if (store.remember(sessionId, {
						kind: "tool-result",
						callId: data.message?.source?.callId,
						seq: event.seq,
						turn: typeof data.turn === "number" ? data.turn : undefined,
						meta
					})) {
						changed = true;
					}
				} else if (event?.type === "message" || event?.type === "message/content") {
					const data = event.data ?? {};
					const msg = data.message ?? data;
					const isUser = msg?.source?.kind === "user" || msg?.role === "user";
					if (isUser) {
						let text = "";
						if (typeof msg.content === "string") {
							text = msg.content;
						} else if (Array.isArray(msg.content)) {
							for (const part of msg.content) {
								if (part?.type === "text" && typeof part.text === "string") {
									text += part.text;
								}
							}
						}
						if (text && typeof store.rememberUserText === "function" && store.rememberUserText(sessionId, text)) {
							changed = true;
						}
					} else {
						const isAssistant = msg?.source?.kind === "assistant" || msg?.role === "assistant";
						if (isAssistant) {
							let text = "";
							if (typeof msg.content === "string") {
								text = msg.content;
							} else if (Array.isArray(msg.content)) {
								for (const part of msg.content) {
									if (part?.type === "text" && typeof part.text === "string") {
										text += part.text;
									}
								}
							}
							const turn = typeof data.turn === "number" ? data.turn : undefined;
							if (text && store.rememberText(sessionId, turn, event.seq, text)) {
								changed = true;
							}
						}
					}
				}
			}
			if (changed) store.notify(sessionId);
		};
		absorb(source.getSnapshot().entries);
		return source.subscribe(() => {
			const snapshot = source.getSnapshot();
			const change = snapshot.change;
			// prepend / append 只带增量；replace 与 settle-assistant 带的是整窗，直接重扫。
			if (change?.kind === "append" || change?.kind === "prepend") absorb(change.entries);
			else absorb(snapshot.entries);
		});
	}

	/** 展示器：挂在轮次尾部，画按钮；超过 VISIBLE_ACTIONS 条就折叠，展开状态不记忆。 */
	function createTail(React, ctx, store) {
		return function SuggestActionsTail(props) {
			const sessionId = typeof props.sessionId === "string" ? props.sessionId : "";
			const turn = props.turn;
			const [items, setItems] = React.useState(() => store.take(sessionId, turn));
			// 展开状态**故意不记忆**：组件重新挂载（滚动、切会话回来）就回到收起，
			// 否则历史轮次会把"还有 N 条"全撑开，屏幕很快失控。
			const [expanded, setExpanded] = React.useState(false);
			React.useEffect(() => {
				if (sessionId === "") return undefined;
				const unsubscribeStore = store.subscribe(sessionId, () => {
					setItems(store.take(sessionId, turn));
				});
				// 先把历史补齐再读一次：refresh 之后 eventSource 里已经有落盘的名单。
				const dropHydration = hydrateFromEvents(ctx, store, sessionId);
				setItems(store.take(sessionId, turn));
				return () => {
					unsubscribeStore();
					dropHydration();
				};
			}, [sessionId, turn]);
			const [pending, pick, fill, failure] = usePicker(React, ctx, sessionId);
			if (items.length === 0) return null;
			const text = uiStrings();
			const overflow = items.length > VISIBLE_ACTIONS;
			const visible = expanded || !overflow ? items : items.slice(0, VISIBLE_ACTIONS);
			const children = visible.map((item, index) => actionItem(React, item, `a${index}`, pending, pick, fill, text));
			if (failure !== "") {
				const isNotice = failure.includes("拦截") || failure.includes("intercepted");
				children.push(React.createElement("div", {
					key: "failure",
					className: isNotice ? "dsh-suggest-warn-info" : "dsh-suggest-error"
				}, isNotice ? `\u26A0 ${failure}` : `${text.failed}${failure}`));
			}
			if (overflow) children.push(React.createElement("button", {
				key: "toggle",
				type: "button",
				className: "dsh-suggest-more",
				disabled: pending,
				onClick: () => setExpanded(!expanded)
			}, expanded ? `${text.less} \u25B4` : `${text.more(items.length - VISIBLE_ACTIONS)} \u25BE`));
			return React.createElement("div", {
				className: "dsh-suggest",
				"data-tool": "suggest_actions"
			}, children);
		};
	}

	window.__ModuleLoader__.load({
		id: "dsh-suggestion-chips",
		factory: (require) => {
			const React = require("react");
			return {
				name: "dsh-suggestion-chips",
				inject: ["slots", "sessions"],
				apply(ctx) {
					const store = createSuggestionStore();
					if (typeof ctx.effect === "function") {
						ctx.effect(() => () => store.clear());
					}
					installStyles(ctx);
					ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
						name: "tool.call.toolview",
						key: "suggest_actions"
					}, createCapture(React, store)));
					ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
						name: "conversation.chat.turnTail",
						id: "suggestion-chips",
						inject: (sessionId) => ({ sessionId })
					}, createTail(React, ctx, store)));
				}
			};
		}
	});
})();

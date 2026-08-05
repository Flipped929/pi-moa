/**
 * moa-mode — pi-moa 多模型协同总开关（P2 核心交付）
 * @version v1.3-2026-08-05（moa-review 架构化：多模型多角色多 agent 多轮联合评审至零可执行，skills 感知）
 *
 * 命令：
 *   /moa on      开启协同模式（所有任务自动按模式拆片派活）
 *   /moa off     关闭，回到主模型单干
 *   /moa status  开关状态 + 角色在线检查 + 任务记录统计
 *   /moa review <主题>  多模型多角色多 agent 多轮联合评审，优化至零可执行状态（可利用优质 agent skills，find skills）
 *
 * 机制：
 * - on 状态下通过 before_agent_start 向系统提示注入调度规则（仅主会话，子代理进程自动跳过）
 * - 任务记录约定 .pi/moa/<session-id>/（自动建目录；含 .gitignore 自动登记）
 * - 纪律：>10 分钟任务才拆片；并行≤3；主模型认领≤40%；输出强制结构化
 *
 * 环境变量：PI_MOA_DEFAULT=1 可默认开启（测试/脚本用）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── /moa status 数据层（三层：调度 captain/监测审计 Navigator/执行子模型）────────────────
interface RunningAgent { agent: string; model: string; etime: string; task: string }
interface ModelAgg { tasks: number; input: number; output: number; cost: number; durs: number[] }

function fmtTok(n: number): string {
	return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
function fmtDur(ms: number): string {
	const s = Math.round(ms / 1000);
	return s >= 3600 ? `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/** 任务文本 → 概括描述（用户要求：看概括不看路径）。优先【概括】标记；其次「执行（概括）」括号；再剥任务卡路径前缀 */
function summarizeTask(raw: string): string {
	let t = (raw ?? "").replace(/\s+/g, " ").trim();
	const bracket = t.match(/【(.{2,40}?)】/);
	if (bracket) return bracket[1];
	const paren = t.match(/执行（([^（）]{4,40}?)）/);
	if (paren) return paren[1];
	t = t.replace(/^先读任务卡\s+\S+\s*(并|，)?\s*/, "");
	t = t.replace(/\/[^\s]*\.md/g, "").trim();
	return t.slice(0, 36) || "（无描述）";
}

/** 在跑子代理：ps 扫描 pi --mode json 进程（PI_MOA_AGENT 由 subagent 扩展注入 env） */
function listRunningSubagents(): RunningAgent[] {
	try {
		const out = execFileSync("ps", ["-E", "-eo", "pid=,etime=,args="], { encoding: "utf-8", timeout: 5000 });
		const rows: RunningAgent[] = [];
		for (const line of out.split("\n")) {
			if (!line.includes("--mode") || !line.includes("json") || !line.includes("Task: ")) continue;
			if (line.includes("ps -E")) continue;
			const parts = line.trim().split(/\s+/);
			if (parts[0] === String(process.pid)) continue;
			const task = summarizeTask(line.split("Task: ")[1] ?? "");
			rows.push({
				agent: line.match(/PI_MOA_AGENT=([\w-]+)/)?.[1] ?? "?",
				model: line.match(/--model\s+(\S+)/)?.[1]?.split("/").pop() ?? "default",
				etime: parts[1] ?? "?",
				task,
			});
		}
		return rows;
	} catch { return []; }
}

/** 会话文件：优先当前 cwd 对应目录的最新 jsonl，失败则全局最新 */
function findSessionFile(cwd: string): string | null {
	const base = path.join(process.env.HOME ?? "", ".pi/agent/sessions");
	const encoded = cwd.replace(/\//g, "-");
	const candidates: string[] = [];
	const pushJsonl = (dir: string) => {
		try {
			for (const f of fs.readdirSync(dir)) if (f.endsWith(".jsonl")) candidates.push(path.join(dir, f));
		} catch { /* 目录不存在 */ }
	};
	pushJsonl(path.join(base, encoded));
	if (!candidates.length) {
		try {
			for (const d of fs.readdirSync(base)) pushJsonl(path.join(base, d));
		} catch { return null; }
	}
	if (!candidates.length) return null;
	return candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

/** 解析会话文件：调度层消耗（主会话 assistant usage 求和）+ 子模型已完成任务（subagent toolResult details） */
function parseSessionStats(file: string): {
	captain: { input: number; output: number; cost: number };
	byModel: Map<string, ModelAgg>;
	recent: { agent: string; model: string; task: string; dur: number | null }[];
} {
	const captain = { input: 0, output: 0, cost: 0 };
	const byModel = new Map<string, ModelAgg>();
	const recent: { agent: string; model: string; task: string; dur: number | null }[] = [];
	const callTs = new Map<string, { ts: number; task: string }>();
	try {
		for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
			if (!line) continue;
			let o: any;
			try { o = JSON.parse(line); } catch { continue; }
			const m = o?.message;
			if (!m) continue;
			if (m.role === "assistant") {
				if (m.usage) {
					captain.input += m.usage.input ?? 0;
					captain.output += m.usage.output ?? 0;
					captain.cost += m.usage.cost?.total ?? 0;
				}
				for (const c of m.content ?? []) {
					if (c?.type === "toolCall" && c?.name === "subagent" && o.timestamp) {
						callTs.set(c.id, { ts: Date.parse(o.timestamp), task: summarizeTask(String(c.arguments ?? "")) });
					}
				}
			} else if (m.role === "toolResult" && m.toolName === "subagent" && m.details?.results) {
				const call = callTs.get(m.toolCallId);
				const dur = call && o.timestamp ? Date.parse(o.timestamp) - call.ts : null;
				for (const r of m.details.results) {
					const model = (r.model ?? "unknown").split("/").pop() ?? "unknown";
					const agg = byModel.get(model) ?? { tasks: 0, input: 0, output: 0, cost: 0, durs: [] };
					agg.tasks += 1;
					agg.input += r.usage?.input ?? 0;
					agg.output += r.usage?.output ?? 0;
					agg.cost += r.usage?.cost?.total ?? r.usage?.cost ?? 0;
					if (dur != null) agg.durs.push(dur);
					byModel.set(model, agg);
					recent.push({ agent: r.agent ?? "?", model, task: summarizeTask(String(r.task ?? call?.task ?? "")), dur });
				}
			}
		}
	} catch { /* 会话文件读取失败容忍 */ }
	return { captain, byModel, recent: recent.slice(-5) };
}

/** Navigator 状态：navigator-watch 落盘的状态文件（可能不存在） */
function readNavigatorState(boardBase: string): string {
	try {
		const s = JSON.parse(fs.readFileSync(path.join(boardBase, ".navigator-state.json"), "utf-8"));
		const ago = s.lastCheckAt ? fmtDur(Date.now() - s.lastCheckAt) + "前" : "未跑";
		return `校验${s.turns ?? 0}轮·告警${(s.statusAlerts ?? 0) + (s.ledgerAlerts ?? 0)}·最近 ${ago}`;
	} catch {
		return "待命（下轮 turn_end 首次校验）";
	}
}


const AGENTS = ["executor", "executor-k3", "analyst", "critic", "devil"] as const;

const REVIEW_PROMPT = (topic: string) =>
	`[pi-moa 多模型多角色多 agent 多轮联合评审] 主题：${topic}
目标：优化至零可执行状态（分 Phase、每 Phase 带验证与回滚、无未裁决开放问题或已显式移交我决策）。

编队（本次评审强制明示）：
- analyst / critic = DeepSeek-V4-flash（executor/analyst/critic 角色）
- devil = Kimi K3 异构上下文（专抓 DeepSeek 家族共同盲区，前提层挑战）
- 高难度判断/关键架构决策维度 → 升级你（captain K3）亲审；机械核对类维度 → 保持 flash
- 评审开场白必须明示本次各维度模型分配与理由

skills 感知（强制）：开场先 find-skills 检索与主题相关的优质 agent skills，
列出「采用/不采用」清单及理由；采用的 skill 必须先读其 SKILL.md 再评审。

流程（按实际情况弹性执行）：
- Round 1：各角色并行开火（结果卡落盘 .pi/moa/review-<主题>-<日期>/results/）
- Round 2：交叉质询（观点互喂再评，重点回应 devil 的前提挑战）
- Round 3：你裁决收敛 → 零可执行终稿
- 弹性条款：争议小可提前收敛（说明理由）；争议大/前提被动摇则加轮；
  每轮结束你必须判断「继续还是收敛」，禁止无脑跑满三轮

记录：各角色结果卡 + 误判事件 + tokens_by_model 全部落盘任务记录（navigator 原料）。`;

const ORCHESTRATION_RULES = `

[pi-moa 协同模式已开启 — 调度规则]
你是 captain（聚合器/调度器）。对每个用户任务先判断规模：
1. 默认动作 = 派活。MoA 开启状态下，“顺手自己干”是违规行为。简单任务也要优先派子模型——充分试错才能测绘子模型能力边界（用户裁决：DeepSeek 额度不设限、大胆试错、建立试错样本库；每个任务都是 NAVIGATOR 可信度样本）；K3 额度是全场最贵资源，captain 只做拆片、抽查、裁决、合并。不派活的豁免仅四类：密钥/凭证类（安全边界，不出本机 captain 手）；视觉/图片类（子模型纯文本）；纯问答/诊断类（无文件产出）；harness 自治规则修订（调度规则本身的修改）。文件产出型工作（写代码/写文档/改配置）一律派 executor，captain 只做拆片、抽查、合并。
2. 拆片前先评估“重叠度”（多个子模型是否必须读同一份大材料）：
   【调度矩阵：任务类型 → 子模型数量】
   - 高重叠阅读类（全文档审计/全景勘察）→ 0-1 个：自己单跑，或“一读多评”：1 个 analyst 通读产出摘要任务记录，critic/devil 基于摘要+定向抽查，禁止重复全读（防重叠税）
   - 编码类（scope 天然不相交）→ 2-3 个并行 executor + critic 审 diff
   - 评审类（方案/设计评审，输入材料小）→ 3 个满编：analyst/critic/devil 对抗多轮 → 你裁决 → 零可执行终稿（每Phase有验证+回滚，开放问题移交用户）
   - 【review 前置】方案/设计/架构决策类输入，规模够大时在派编码前先走 /moa review 流水线（按实际情况定轮次深度）
   - 调研类（多角度外部主题）→ 2-3 个 analyst 分角度 → critic 查缺 → 你综合
   - 写作类 → 1 个 executor 起草 + 1 个 critic 挑刺 → 你定稿
   - 拿不准：先派 1 个 analyst 探测再定
3. 纪律：并行子代理≤3；你自己认领最难切片但≤40%工作量；executor 返回 blocked/handoff 时你从 handoff 包断点接手；图片/视觉步骤永远你自己做（子模型纯文本）。
4. 实证纪律：git 提交说明、代码注释、“验证通过”字样一律不算实证，必须验代码/SQL/配置本体。
5. 抽查机制（captain 保留验证权）：
   - 对子模型结果卡中的关键实证（文件:行号、数据、结论）风险导向抽查 10-30%，亲自复核原文
   - 必抽项：全过/无异常类结论、安全相关结论、影响后续决策的关键判断
   - 发现一处造假/误判 → 该子模型本次产出全量复核，并在任务记录中记录误判事件（供 navigator 统计角色可信度）
   - 抽查结果写入终稿（“已抽查 N 项，复核率 X%”），未抽查的结论标注“未经复核”
4. 任务卡必须含：goal / scope(可写路径) / context_files / 输出要求(结果卡≤300字)。
5. 任务记录：任务开始先建 .pi/moa/<任务名>/ 目录，任务卡、结果卡、handoff 包落盘（task.md / results/*.md / handoffs/*.md），每个运行单元记录 session_id/run_id/actor/读写范围/risk_level/outputs。
6. 你始终掌握全部通讯：子代理间不直连，冲突由你裁决；拿不准的升级给用户。
7. 联网搜索工具优先级：web-search-free 是托底手段，仅在其他网络搜索工具/skill 不可用时使用；凡有更好用的搜索途径（如其他搜索 skill、API、专用工具）一律优先用更好的。派调研类任务时在任务卡中注明此优先级。`;

interface MoaState {
	enabled: boolean;
	tasksStarted: number;
}

export default function (pi: ExtensionAPI) {
	const state: MoaState = {
		enabled: process.env.PI_MOA_DEFAULT === "1",
		tasksStarted: 0,
	};

	const isSubagent = () => process.env.PI_MOA_SUBAGENT === "1";

	function agentRoster(): string {
		const dir = path.join(process.env.HOME ?? "", ".pi/agent/agents");
		return AGENTS.map((a) => {
			const ok = fs.existsSync(path.join(dir, `${a}.md`));
			return `${ok ? "✅" : "❌"} ${a}`;
		}).join("  ");
	}

	function moaDirCount(cwd: string): number {
		const base = path.join(cwd, ".pi/moa");
		try {
			return fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
		} catch {
			return 0;
		}
	}

	function ensureBlackboard(cwd: string) {
		const base = path.join(cwd, ".pi/moa");
		fs.mkdirSync(base, { recursive: true });
		// .gitignore 登记（G1 留痕：仅工作区内小动作，并通知）
		const gi = path.join(cwd, ".gitignore");
		if (fs.existsSync(path.join(cwd, ".git"))) {
			let content = "";
			try {
				content = fs.readFileSync(gi, "utf-8");
			} catch {}
			if (!content.split("\n").some((l) => l.trim() === ".pi/moa/")) {
				fs.appendFileSync(gi, (content.endsWith("\n") || !content ? "" : "\n") + ".pi/moa/\n");
				return ".gitignore 已登记 .pi/moa/";
			}
		}
		return null;
	}

	async function handle(sub: string, rest: string[], ctx: any) {
		switch (sub) {
			case "on": {
				state.enabled = true;
				let note = "";
				if (!isSubagent()) {
					const gi = ensureBlackboard(ctx.cwd);
					if (gi) note = `（${gi}）`;
				}
				ctx.ui.notify(
					`🐙 pi-moa 已开启 ${agentRoster()}${note}`,
					"info",
				);
				break;
			}
			case "off":
				state.enabled = false;
				ctx.ui.notify("pi-moa 已关闭，回到单模型模式", "info");
				break;
			case "status": {
				if (isSubagent()) {
					ctx.ui.notify("pi-moa 状态：子代理进程内不可用", "warning");
					return;
				}
				const boardBase = path.join(ctx.cwd, ".pi/moa");
				const L: string[] = [];
				L.push(`🐙 MoA ${state.enabled ? "ON" : "OFF"} · 任务记录 ${moaDirCount(ctx.cwd)} 个`);
				// 三层：调度 captain（聚合裁决）/ 监测审计 Navigator / 执行子模型
				// 会话文件优先用官方 API 精确锁定本会话（encoding 猜测不可靠，曾致面板串会话）
				const sf = (() => {
					try {
						const f = (ctx as any).sessionManager?.getSessionFile?.();
						if (f && fs.existsSync(f)) return f;
					} catch { /* fall through */ }
					return findSessionFile(ctx.cwd);
				})();
				const stats = sf ? parseSessionStats(sf) : null;
				L.push(stats
					? `【captain·调度】k3 · ↑${fmtTok(stats.captain.input)} ↓${fmtTok(stats.captain.output)}${stats.captain.cost ? ` $${stats.captain.cost.toFixed(2)}` : ""}`
					: `【captain·调度】k3 · 消耗见 /session`);
				L.push(`【Navigator·监测审计】${readNavigatorState(boardBase)}`);
				const running = listRunningSubagents();
				const crew: string[] = [];
				if (running.length) {
					crew.push(`▶ 在跑 ${running.length}`);
					for (const r of running) crew.push(`  ${r.agent} @${r.model} · ${r.etime} · ${r.task}`);
				}
				if (stats) {
					for (const [model, agg] of [...stats.byModel.entries()].sort((a, b) => b[1].input - a[1].input)) {
						const avg = agg.durs.length ? ` ⏱均${fmtDur(agg.durs.reduce((x, y) => x + y, 0) / agg.durs.length)}` : "";
						crew.push(`Σ ${model} · ${agg.tasks}任务 ↑${fmtTok(agg.input)} ↓${fmtTok(agg.output)}${agg.cost ? ` $${agg.cost.toFixed(2)}` : ""}${avg}`);
					}
					for (const r of stats.recent.slice(-3)) {
						crew.push(`  ✓ ${r.agent} @${r.model}${r.dur != null ? ` ${fmtDur(r.dur)}` : ""} · ${r.task}`);
				}
				}
				L.push(`【子模型】${crew.length ? "" : "空闲"}`);
				L.push(...crew);
				L.push(`角色：${agentRoster()}`);
				ctx.ui.notify(L.join("\n"), "info");
				break;
			}
			case "review": {
				const topic = rest.join(" ").trim();
				if (!topic) {
					ctx.ui.notify("用法：/moa review <主题>（多模型多角色多 agent 多轮联合评审至零可执行，可利用优质 agent skills）或 /moa-review <主题>", "warning");
					return;
				}
				state.enabled = true;
				const gi = ensureBlackboard(ctx.cwd);
				if (gi) ctx.ui.notify(gi, "info");
				ctx.sendUserMessage(REVIEW_PROMPT(topic));
				break;
			}
			default:
				ctx.ui.notify("用法：/moa on|off|status|review <主题>（review=多模型多角色多agent多轮联合评审至零可执行，skills 感知）", "warning");
		}
	}

	pi.registerCommand("moa", {
		description: "pi-moa 多模型协同：/moa on|off|status|review <主题>（review=多模型多角色多agent多轮联合评审至零可执行，可利用优质 agent skills，find skills）",
		handler: async (args, ctx) => {
			const [sub, ...rest] = (args ?? "").trim().split(/\s+/);
			await handle(sub ?? "", rest, ctx);
		},
	});

	// 快捷别名命令
	pi.registerCommand("moa-on", {
		description: "pi-moa：开启多模型协同（= /moa on）",
		handler: async (_args, ctx) => handle("on", [], ctx),
	});
	pi.registerCommand("moa-off", {
		description: "pi-moa：关闭协同（= /moa off）",
		handler: async (_args, ctx) => handle("off", [], ctx),
	});
	pi.registerCommand("moa-status", {
		description: "pi-moa：状态（= /moa status）",
		handler: async (_args, ctx) => handle("status", [], ctx),
	});
	pi.registerCommand("moa-review", {
		description: "pi-moa 评审：多模型多角色多agent多轮联合评审至零可执行状态（可利用优质 agent skills，find skills）",
		handler: async (args, ctx) => handle("review", (args ?? "").trim().split(/\s+/), ctx),
	});

	// 主会话注入调度规则；子代理进程跳过（避免规则套娃）
	pi.on("before_agent_start", async (event) => {
		if (!state.enabled || isSubagent()) return undefined;
		if ((event.systemPrompt ?? "").includes("[pi-moa 协同模式已开启")) return undefined;
		return { systemPrompt: (event.systemPrompt ?? "") + ORCHESTRATION_RULES };
	});

	// 状态栏指示
	pi.on("session_start", async (_event, ctx) => {
		if (state.enabled && !isSubagent()) {
			ctx.ui.setStatus("🐙 moa", "pi-moa ON");
		}
	});
}

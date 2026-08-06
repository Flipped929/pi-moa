/**
 * moa-mode — pi-moa 多模型协同总开关（P2 核心交付）
 * @version v1.4-2026-08-05（moa-status 台账化：subagent 扩展直写 runs.jsonl 结构化台账，status 只读台账折叠，废除会话/ps 解析）
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

// ── /moa status 数据层（三层：调度 captain/监测审计 Navigator/执行子模型）
// 三代血泪：从自由文本/会话 jsonl 解析任务信息必炸（路径截断/中文标点/串会话）。
// 现改为：subagent 扩展直写结构化运行台账 runs.jsonl（append-only JSONL），
// status 只读台账折叠状态——已删 findSessionFile/parseSessionStats/listRunningSubagents（ps/会话解析）。
// ──────────────────────────────────────────────────────────────
const LEDGER_FILE = path.join(process.env.HOME ?? "", ".pi/agent/moa/runs.jsonl");

interface LedgerStart {
	event: "start";
	runId: string;
	ts: number;
	pid: number;
	agent: string;
	model: string | null;
	summary: string;
}
interface LedgerEnd {
	event: "end";
	runId: string;
	ts: number;
	agent: string;
	model: string | null;
	summary: string;
	exitCode: number;
	usage: { input: number; output: number; costTotal: number; turns: number };
}

function fmtTok(n: number): string {
	return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
function fmtDur(ms: number): string {
	const s = Math.round(ms / 1000);
	return s >= 3600 ? `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/** 读台账：starts/ends 按写入顺序返回（append-only） */
function readLedger(): { starts: LedgerStart[]; ends: LedgerEnd[] } {
	const starts: LedgerStart[] = [];
	const ends: LedgerEnd[] = [];
	try {
		for (const line of fs.readFileSync(LEDGER_FILE, "utf-8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const o = JSON.parse(line);
				if (o?.event === "start") starts.push(o as LedgerStart);
				else if (o?.event === "end") ends.push(o as LedgerEnd);
			} catch { /* 坏行跳过 */ }
		}
	} catch { /* 台账缺失/未创建 */ }
	return { starts, ends };
}

/** pid 存活探测（信号 0 不杀进程）；EPERM=进程存在但属他人 */
function isPidAlive(pid: number): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

/** 今日 0 点（本地时区）毫秒时间戳，用于「今日 end 聚合」 */
function startOfToday(): number {
	const d = new Date();
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/** captain 消耗：仅官方 sessionManager 精确锁定的本会话 assistant usage 求和（不解析任务信息） */
function readCaptainUsage(sessionFile: string): { input: number; output: number; cost: number } | null {
	const cap = { input: 0, output: 0, cost: 0 };
	try {
		for (const line of fs.readFileSync(sessionFile, "utf-8").split("\n")) {
			if (!line) continue;
			let o: any;
			try { o = JSON.parse(line); } catch { continue; }
			const m = o?.message;
			if (m?.role === "assistant" && m?.usage) {
				cap.input += m.usage.input ?? 0;
				cap.output += m.usage.output ?? 0;
				cap.cost += m.usage.cost?.total ?? 0;
			}
		}
	} catch { return null; }
	return cap;
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

评审视角（v1.5）：从 MoA 多模型架构角度联评——调度矩阵适配、角色分工、异构性覆盖、成本结构（K3/flash 配比）、防重叠税，不只是内容本身。

编队（用户裁决：DeepSeek 充分利用，K3 只做异构挑战与裁决）：
- analyst / critic / executor = DeepSeek-V4-flash（thinking:max，主力承担各维度初评与执行）
- devil = Kimi K3 异构上下文（专抓 DeepSeek 家族共同盲区，前提层挑战）
- 高难度判断/关键架构决策维度 → 升级你（captain K3）亲审；机械核对类维度 → 保持 flash
- 评审开场白必须明示本次各维度模型分配与理由

skills 感知（强制）：开场先 find-skills 检索与主题相关的优质 agent skills，
列出「采用/不采用」清单及理由；采用的 skill 必须先读其 SKILL.md 再评审。

流程（按实际情况弹性执行）：
- Round 1：各角色并行开火（结果卡落盘 .pi/moa/review-<主题>-<日期>/results/，必填 summary 字段）
- Round 2：交叉质询（观点互喂再评，重点回应 devil 的前提挑战）
- Round 3：你裁决收敛 → 零可执行终稿
- 弹性条款：争议小可提前收敛（说明理由）；争议大/前提被动摇则加轮；
  每轮结束你必须判断「继续还是收敛」，禁止无脑跑满三轮

记录：各角色结果卡 + 误判事件 + tokens_by_model 全部落盘任务记录（navigator 原料）。
评审透明化（用户裁决 2026-08-06）：过程和结果都上报 captain——每轮结束报轮次推进/关键分歧/被否方案；
评审卡按 moa/templates/review-card.md 结构化格式（rounds/verdict/findings/误判事件）；
前提被动摇、连续 fail、裁决逆转等节点实时转告用户，不等终稿。`;

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
   - 【review 节点】按实际情况在以下节点主动发起 review（不必等用户点名）：批次收官后、critic 连续两次 fail、关键架构分拱、模型/技术选型变更前
   - 调研类（多角度外部主题）→ 2-3 个 analyst 分角度 → critic 查缺 → 你综合
   - 写作类 → 1 个 executor 起草 + 1 个 critic 挑刺 → 你定稿
   - 拿不准：先派 1 个 analyst 探测再定
3. 纪律：并行子代理≤3；executor 返回 blocked/handoff 时你从 handoff 包断点接手；图片/视觉步骤永远你自己做（子模型纯文本）。
   【captain 成本纪律（2026-08-06 用户裁决：质量/效率/性价比三轴）】
   - 派卡不读原文：任务卡所需背景材料先派 analyst 出 ≤300字摘要，你只读摘要写卡（安全/密钥/凭证切片除外）；禁止为写卡读全量文件
   - 工具输出截断：docker logs/SQL/长文件只取关键行（tail/grep/offset 前置）；子模型结果卡超过 300字部分只扫 concerns
   - 胶水活下放：DEVLOG 起草/黑板收集/验证报告/种子执行回报全派 flash，你只签字合并
   - 批次收尾即 compact 会话：任务记录是记忆体，会话不背历史包袱
   - 性价比 KPI：captain 输入占比目标 ≤30%（告警线 50%），flash 任务覆盖率 ≥80%
   【自优化循环（用户裁决 2026-08-06：试错样本要自优化）】
   - 每个样本（任务结果/误判/高频坑）→ 沉淀为 instinct YAML（navigator-report 已产）
   - confidence≥0.5 的教训由自优化脚本自动维护进角色定义「已知坑」管理区（agents/*.md），携带 evidence+日期；你不定期抽查管理区内容（防错误教训固化，confidence<0.5 不注入）
   - 调度档位表每 10 任务按台账校准一次；任务卡模板每轮新坑出现后即补必填字段
   【captain 工作量浮动制（用户裁决 2026-08-06）】你认领最难切片，工作量按子代理信用度在 **20%-40% 浮动**：信用度高（台账近期 done 率高、误判事件少）→ 靠 20%（最轻插手+抽查下限）；信用度低或该领域无样本 → 靠 40%（加强亲执与复核）。信用度依据：NAVIGATOR 角色可信度表 + runs.jsonl 台账 + 误判事件记录，每批次开始时你明读一次并在任务卡写下本次浮动档位与理由。
   【治理档位静态查表（Phase 3，用户裁决：绕过小样本统计噪声，用先验画像而非后验统计）】
   - 任务含 {SQL/脱敏/密钥/部署/安全/凭证} 关键词 或 risk≥中 → 关键路径升 K3（executor-k3 或你亲审）
   - item_count≥50 或 context text_length≥20k → 升 K3
   - 低风险机械类（纯格式/字段映射/照抄规范页）→ flash 单跑可免 critic（在任务卡注明理由）
   - blocked 率仅在样本 n≥3 时允许回写校准档位；台账（runs.jsonl）每 10 个任务回顾一次档位准确性并调整本表
4. 实证纪律：git 提交说明、代码注释、“验证通过”字样一律不算实证，必须验代码/SQL/配置本体。
5. 抽查机制（captain 保留验证权 + 子模型协同抽查）：
   - captain 对子模型结果卡中的关键实证（文件:行号、数据、结论）风险导向抽查 10-30%，亲自复核原文
   - 必抽项：全过/无异常类结论、安全相关结论、影响后续决策的关键判断
   - 发现一处造假/误判 → 该子模型本次产出全量复核，并在任务记录中记录误判事件（供 navigator 统计角色可信度）
   - 【子模型协同抽查（用户裁决 2026-08-06）】批次收官时，captain 指定抽查样本（含必抽项）派 1 个独立上下文的 analyst/critic 做实证点抽验（逐项给出 文件:行号 复核结论）；子模型可以在 captain 样本外自增 1-2 个它认为可疑的点（适当发挥，注明理由）；captain 的亲自抽查与子模型抽验结果并录终稿（两份复核率分别标注），冲突由 captain 裁决
   - 抽查结果写入终稿（“已抽查 N 项，复核率 X%”），未抽查的结论标注“未经复核”
4. 任务卡必须含：goal / scope(可写路径) / context_files / 输出要求(结果卡≤300字)；派活时 subagent 工具的 task/tasks/chain 条目必须填 summary 字段（≤20字任务概括，用于 /moa status 状态面板显示）。
5. 任务记录：任务开始先建 .pi/moa/<任务名>/ 目录，任务卡、结果卡、handoff 包落盘（task.md / results/*.md / handoffs/*.md），每个运行单元记录 session_id/run_id/actor/读写范围/risk_level/outputs。
6. 你始终掌握全部通讯：子代理间不直连，冲突由你裁决；拿不准的升级给用户。
   【评审透明化（用户裁决 2026-08-06）】子模型间或子模型内部的多 agent 评审：①过程和结果必须上报 captain——不只是 verdict，含轮次推进、关键分歧、被否掉的方案及理由 ②结构化留痕：评审卡按 moa/templates/review-card.md 格式落盘（rounds/verdict/findings/误判事件），供 Navigator 监测审计优化 ③关键过程节点（前提被动摇、连续 fail、裁决逆转）你实时转告用户，不等终稿。
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
				// 三层：调度 captain（聚合裁决）/ 监测审计 Navigator / 执行子模型（子模型层只读台账）
				// captain 行：仅官方 sessionManager 精确锁定本会话（encoding 猜测曾致面板串会话），只求和 assistant usage
				const sf = (() => {
					try {
						const f = (ctx as any).sessionManager?.getSessionFile?.();
						if (f && fs.existsSync(f)) return f;
					} catch { /* 无 session 文件 */ }
					return null;
				})();
				const captain = sf ? readCaptainUsage(sf) : null;
				L.push(captain
					? `【captain·调度】k3 · ↑${fmtTok(captain.input)} ↓${fmtTok(captain.output)}${captain.cost ? ` $${captain.cost.toFixed(2)}` : ""}`
					: `【captain·调度】k3 · 消耗见 /session`);
				L.push(`【Navigator·监测审计】${readNavigatorState(boardBase)}`);

				const { starts, ends } = readLedger();
				if (starts.length === 0 && ends.length === 0) {
					L.push(`【子模型·台账】无记录（ledger 自今日起）`);
				} else {
					// 折叠：start 无配对 end 且 pid 存活 = 在跑；pid 已死 = 残留（崩溃/强杀）
					const endByRunId = new Set(ends.map((e) => e.runId));
					const running = starts.filter((s) => !endByRunId.has(s.runId) && isPidAlive(s.pid));
					const stale = starts.filter((s) => !endByRunId.has(s.runId) && !isPidAlive(s.pid));

					const crew: string[] = [];
					if (running.length) {
						crew.push(`▶ 在跑 ${running.length}`);
						for (const r of running)
							crew.push(`  ${r.agent} @${(r.model ?? "default").split("/").pop()} · ${fmtDur(Date.now() - r.ts)} · ${r.summary}`);
					}
					// 今日 end 聚合：Σ 各模型任务数 / tokens / 均价（按模型归一化展示）
					const today = startOfToday();
					const todayEnds = ends.filter((e) => e.ts >= today);
					if (todayEnds.length) {
						const byModel = new Map<string, { tasks: number; input: number; output: number; cost: number }>();
						for (const e of todayEnds) {
							const m = (e.model ?? "default").split("/").pop() ?? "default";
							const agg = byModel.get(m) ?? { tasks: 0, input: 0, output: 0, cost: 0 };
							agg.tasks += 1;
							agg.input += e.usage?.input ?? 0;
							agg.output += e.usage?.output ?? 0;
							agg.cost += e.usage?.costTotal ?? 0;
							byModel.set(m, agg);
						}
						for (const [model, agg] of [...byModel.entries()].sort((a, b) => b[1].input - a[1].input)) {
							const avg = agg.tasks ? ` 均$${(agg.cost / agg.tasks).toFixed(3)}` : "";
							crew.push(`Σ ${model} · ${agg.tasks}任务 ↑${fmtTok(agg.input)} ↓${fmtTok(agg.output)} $${agg.cost.toFixed(2)}${avg}`);
						}
					}
					// 最近 5 条 end = ✓ 列表（最新在前）
					for (const e of ends.slice(-5).reverse()) {
						const s = starts.find((x) => x.runId === e.runId);
						const dur = s ? e.ts - s.ts : null;
						crew.push(`  ✓ ${e.agent} @${(e.model ?? "default").split("/").pop()}${dur != null ? ` ${fmtDur(dur)}` : ""} · ${e.summary}`);
					}
					// 当前状态行（用户要求）：在跑=台账在跑；空闲=最近完成于多久前
					const lastAt = ends.length ? ends[ends.length - 1].ts : 0;
					L.push(`【子模型】当前：${running.length ? `▶ 在跑 ${running.length} 个` : lastAt ? `空闲（最近完成 ${fmtDur(Date.now() - lastAt)}前）` : "空闲（台账无完成记录）"}`);
					L.push(...crew);
					if (stale.length) L.push(`  ↯ ${stale.length} 条未配对 start（进程已退出，可忽略）`);
				}
				L.push(`角色：${agentRoster()}`);
				ctx.ui.notify(L.join("\n"), "info");
				break;
			}
			case "optimize": {
				if (isSubagent()) { ctx.ui.notify("子代理进程内不可用", "warning"); return; }
				const dry = rest.includes("dry") || rest.includes("--dry");
				const script = path.join(process.env.HOME ?? "", ".pi/agent/moa/self-optimize.py");
				if (!fs.existsSync(script)) { ctx.ui.notify("self-optimize.py 不存在（先派 OPT 切片构建）", "error"); return; }
				try {
					const out = execFileSync("python3", dry ? [script, "--dry"] : [script], { encoding: "utf-8", timeout: 120_000 });
					const summary = out.trim().split("\n").slice(-18).join("\n");
					ctx.ui.notify(`🧬 自优化${dry ? "（dry-run）" : ""}完成\n${summary}`, "info");
				} catch (e: any) {
					ctx.ui.notify(`自优化执行失败：${String(e?.message ?? e).split("\n")[0]}`, "error");
				}
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
		description: "pi-moa 多模型协同：/moa on|off|status|review <主题>|optimize [dry]（optimize=双层自优化：样本注入+架构分析）",
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

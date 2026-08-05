/**
 * moa-mode — pi-moa 多模型协同总开关（P2 核心交付）
 * @version v1.2-2026-08-05（用户补充：captain 按需抽查机制）
 *
 * 命令：
 *   /moa on      开启协同模式（所有任务自动按模式拆片派活）
 *   /moa off     关闭，回到主模型单干
 *   /moa status  开关状态 + 角色在线检查 + 黑板统计
 *   /moa review <主题>  评审模式快捷方式（多角色多轮联合评审至零可执行状态）
 *
 * 机制：
 * - on 状态下通过 before_agent_start 向系统提示注入调度规则（仅主会话，子代理进程自动跳过）
 * - 黑板约定 .pi/moa/<session-id>/（自动建目录；含 .gitignore 自动登记）
 * - 纪律：>10 分钟任务才拆片；并行≤3；主模型认领≤40%；输出强制结构化
 *
 * 环境变量：PI_MOA_DEFAULT=1 可默认开启（测试/脚本用）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENTS = ["executor", "analyst", "critic", "devil"] as const;

const ORCHESTRATION_RULES = `

[pi-moa 协同模式已开启 — 调度规则]
你是 captain（聚合器/调度器）。对每个用户任务先判断规模：
1. 小任务（预计<10分钟）：直接自己完成，不派活。
2. 拆片前先评估“重叠度”（多个子模型是否必须读同一份大材料）：
   【调度矩阵：任务类型 → 子模型数量】
   - 高重叠阅读类（全文档审计/全景勘察）→ 0-1 个：自己单跑，或“一读多评”：1 个 analyst 通读产出摘要黑板，critic/devil 基于摘要+定向抽查，禁止重复全读（防重叠税）
   - 编码类（scope 天然不相交）→ 2-3 个并行 executor + critic 审 diff
   - 评审类（方案/设计评审，输入材料小）→ 3 个满编：analyst/critic/devil 对抗多轮 → 你裁决 → 零可执行终稿（每Phase有验证+回滚，开放问题移交用户）
   - 调研类（多角度外部主题）→ 2-3 个 analyst 分角度 → critic 查缺 → 你综合
   - 写作类 → 1 个 executor 起草 + 1 个 critic 挑刺 → 你定稿
   - 拿不准：先派 1 个 analyst 探测再定
3. 纪律：并行子代理≤3；你自己认领最难切片但≤40%工作量；executor 返回 blocked/handoff 时你从 handoff 包断点接手；图片/视觉步骤永远你自己做（子模型纯文本）。
4. 实证纪律：git 提交说明、代码注释、“验证通过”字样一律不算实证，必须验代码/SQL/配置本体。
5. 抽查机制（captain 保留验证权）：
   - 对子模型结果卡中的关键实证（文件:行号、数据、结论）风险导向抽查 10-30%，亲自复核原文
   - 必抽项：全过/无异常类结论、安全相关结论、影响后续决策的关键判断
   - 发现一处造假/误判 → 该子模型本次产出全量复核，并在黑板记录误判事件（供 navigator 统计角色可信度）
   - 抽查结果写入终稿（“已抽查 N 项，复核率 X%”），未抽查的结论标注“未经复核”
4. 任务卡必须含：goal / scope(可写路径) / context_files / 输出要求(结果卡≤300字)。
5. 黑板：任务开始先建 .pi/moa/<任务名>/ 目录，任务卡、结果卡、handoff 包落盘（task.md / results/*.md / handoffs/*.md），每个运行单元记录 session_id/run_id/actor/读写范围/risk_level/outputs。
6. 你始终掌握全部通讯：子代理间不直连，冲突由你裁决；拿不准的升级给用户。`;

const REVIEW_PROMPT = (topic: string) =>
	`[pi-moa 多模型评审模式] 对以下主题开启多角色多 agent 多轮联合评审，优化至零可执行状态（可利用优质 skills，find skills）：
主题：${topic}
评审角色与模型分配（由你 captain 自动决定）：
- 默认：analyst/critic = flash 子模型，devil = K3 独立上下文（跨家族异构）
- 自动升级：维度涉及高难度判断/关键架构决策/flash 首轮质量不足时，升级为你（K3）亲审
- 自动降级：机械检查类维度（格式、字段完整性、清单核对）保持 flash
- 评审开场白中明示本次各维度模型分配与理由
流程：Round 1 各角色并行开火 → Round 2 交叉质询（观点互喂再评）→ Round 3 你裁决收敛
产出：零可执行终稿（分Phase、每Phase带验证与回滚、无未裁决开放问题或已显式移交我决策）
记录：各角色产出落盘 .pi/moa/review-<日期>/results/，并记录 tokens_by_model 供成本对比。`;

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

	pi.registerCommand("moa", {
		description: "pi-moa 多模型协同：/moa on|off|status|review <主题>",
		handler: async (args, ctx) => {
			const [sub, ...rest] = (args ?? "").trim().split(/\s+/);
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
					const board = isSubagent() ? "n/a（子代理进程）" : `${moaDirCount(ctx.cwd)} 个任务记录`;
					ctx.ui.notify(
						`pi-moa ${state.enabled ? "🟢 开启" : "⚪ 关闭"}\n角色：${agentRoster()}\n黑板：${board}`,
						"info",
					);
					break;
				}
				case "review": {
					const topic = rest.join(" ").trim();
					if (!topic) {
						ctx.ui.notify("用法：/moa review <主题>", "warning");
						return;
					}
					state.enabled = true;
					const gi = ensureBlackboard(ctx.cwd);
					if (gi) ctx.ui.notify(gi, "info");
					ctx.sendUserMessage(REVIEW_PROMPT(topic));
					break;
				}
				default:
					ctx.ui.notify("用法：/moa on|off|status|review <主题>", "warning");
			}
		},
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

/**
 * navigator-watch — pi-moa 任务记录纪律的结构性强制（Navigator 实体 · 源头保证）
 * @version v1.2-2026-08-06（Phase 1a：turn_end 结果卡 status 校验，提醒档不 block；Option C 全文+行锚定+枚举）
 *
 * 解决的问题：任务记录落盘此前只靠提示词自觉（已发生漏记），navigator 只是约定无实体。
 *
 * 强制锚点（主会话生效，子代理进程自动跳过）：
 * 1. tool_call 拦截：派活（subagent）或 git commit/push 前，本会话必须已落盘过
 *    .pi/moa 任务卡（任一工具调用触及 .pi/moa 路径即视为已落盘）——否则 block。
 *    仅在项目已加入 MoA（向上能查到 .pi/moa 目录）时强制，普通项目无感。
 * 2. turn_end 对账：每 5 轮扫描一次——COMMIT-LEDGER.md 中未在任务记录任何文件出现的
 *    commit = 漏记，notify 警告（同一 hash 只报一次）；并自动重跑 navigator-report.py。
 * 3. /navigator on|off|status|scan：开关与手动巡检。默认开启（PI_NAVIGATOR_DEFAULT=0 关闭）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let enabled = process.env.PI_NAVIGATOR_DEFAULT !== "0";
	let boardTouched = false;      // 本会话是否已落盘过任务记录
	let boardRoot: string | null = null; // 观察到的 .pi/moa 目录
	let turnCount = 0;
	const notifiedMissing = new Set<string>(); // 已告警过的漏记 hash
	const notifiedNoStatus = new Set<string>(); // 已告警过的缺 status 结果卡

	const isSubagent = () => process.env.PI_MOA_SUBAGENT === "1";

	/** 从 ctx.cwd 向上查找 .pi/moa（项目是否加入 MoA） */
	function findBoardRoot(cwd: string): string | null {
		let dir = cwd;
		const home = process.env.HOME ?? "";
		for (let i = 0; i < 8; i++) {
			const cand = path.join(dir, ".pi", "moa");
			if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) return cand;
			const parent = path.dirname(dir);
			if (parent === dir || !dir.startsWith(home) || dir === home) break;
			dir = parent;
		}
		return null;
	}

	/** 工具调用是否构成任务记录落盘（写语义才算：write/edit 或 bash 写入操作；只读提及不算——防绕过） */
	function touchesBoard(toolName: string, input: unknown): string | null {
		try {
			if (toolName === "write" || toolName === "edit") {
				const p = String((input as any)?.path ?? "");
				return p.includes(".pi/moa") ? p : null;
			}
			if (toolName === "bash") {
				const cmd = String((input as any)?.command ?? "");
				if (/\b(mkdir|cp|mv|touch|tee)\b[^;&|]*\.pi\/moa/.test(cmd)) return cmd.slice(0, 200);
				if (/(?<!\d)>>?\s*[^;&|]*\.pi\/moa/.test(cmd)) return cmd.slice(0, 200);
			}
			return null;
		} catch {
			return null;
		}
	}

	const BLOCK_REASON =
		"[navigator-watch 拦截] pi-moa 任务记录纪律：本会话尚未落盘任何任务卡。" +
		"请先在项目 .pi/moa/<任务名>/task.md 落盘任务卡（goal/scope/actor/risk_level），再执行此操作。" +
		"（派活豁免≠记录豁免；纯问答/诊断不涉及文件产出时可忽略本提示先说明理由）";

	function collectFiles(dir: string, acc: string[], depth: number): void {
		if (depth > 3) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) collectFiles(p, acc, depth + 1);
			else if (e.name.endsWith(".md")) acc.push(p);
		}
	}

	/** 对账：台账 commit 是否都出现在任务记录文本里；返回漏记 hash 列表 */
	function reconcile(root: string): string[] {
		const ledger = path.join(root, "COMMIT-LEDGER.md");
		if (!fs.existsSync(ledger)) return [];
		const hashes = fs.readFileSync(ledger, "utf-8")
			.split("\n").map((l) => l.split("|")[0].trim()).filter((h) => /^[0-9a-f]{6,}$/.test(h));
		if (!hashes.length) return [];
		const files: string[] = [];
		collectFiles(root, files, 0);
		const corpus = files
			.filter((f) => path.basename(f) !== "COMMIT-LEDGER.md")
			.map((f) => { try { return fs.readFileSync(f, "utf-8"); } catch { return ""; } })
			.join("\n");
		return hashes.filter((h) => !corpus.includes(h));
	}

	function runReport(root: string): void {
		// root = <proj>/.pi/moa → 脚本在 <proj>/scripts/navigator-report.py
		const script = path.join(path.dirname(path.dirname(root)), "scripts", "navigator-report.py");
		if (!fs.existsSync(script)) return;
		execFile("python3", [script], { timeout: 60_000 }, () => { /* 报表失败不影响主流程 */ });
	}

	/** Phase 1a：结果卡 status 校验（提醒档）——返回缺 status 的卡路径 */
	function findCardsMissingStatus(root: string): string[] {
		const files: string[] = [];
		collectFiles(root, files, 0);
		return files.filter((f) => {
			const base = path.basename(f);
			if (base === "task.md" || base === "final.md" || base === "NAVIGATOR.md" || base === "COMMIT-LEDGER.md") return false;
			if (base.startsWith("P") && base.includes("-")) { /* prompts/ 目录文件名也类似，靠目录区分 */ }
			if (!f.includes("/results/") && !f.includes("/handoffs/")) return false;
			try {
				// Option C（2026-08-06 captain 裁决）：全文扫描 + 行锚定 + 枚举校验，
				// 治 600 字符窗口脆弱性，同时抓"有 status 但值非法"的真问题
				const text = fs.readFileSync(f, "utf-8");
				return !/^[\s>*\-]*status\s*[:：]\s*(done|partial|blocked|handoff)\b/im.test(text);
			} catch {
				return false;
			}
		});
	}

	pi.registerCommand("navigator", {
		description: "Navigator 监测：/navigator on|off|status|scan",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim() || "status";
			if (sub === "on") { enabled = true; ctx.ui.notify("🧭 navigator 已开启", "info"); return; }
			if (sub === "off") { enabled = false; ctx.ui.notify("navigator 已关闭", "info"); return; }
			const root = boardRoot ?? findBoardRoot(ctx.cwd);
			if (sub === "scan") {
				if (!root) { ctx.ui.notify("未发现 .pi/moa 任务记录目录", "warning"); return; }
				runReport(root);
				const missing = reconcile(root);
				ctx.ui.notify(
					missing.length ? `⚠️ 漏记 commit：${missing.join(", ")}` : "✅ 台账对账无漏记",
					missing.length ? "warning" : "info",
				);
				return;
			}
			ctx.ui.notify(
				`navigator ${enabled ? "🟢 监测中" : "⚪ 关闭"}\n` +
				`任务记录：${root ?? "未发现"}\n本会话落盘：${boardTouched ? "✅" : "❌"}`,
				"info",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (isSubagent()) return;
		boardRoot = findBoardRoot(ctx.cwd);
		if (enabled) ctx.ui.setStatus("🧭 nav", "navigator ON");
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled || isSubagent()) return undefined;

		// 先观察：任何触及 .pi/moa 的写意图都算落盘痕迹（包括被本扩展拦截前的尝试）
		const hit = touchesBoard((event as any).toolName, (event as any).input);
		if (hit) {
			boardTouched = true;
			// 记录绝对路径形式的任务记录根
			const abs = hit.replace(/^\.\//, path.join(ctx.cwd, "/"));
			const idx = abs.indexOf(".pi/moa");
			if (idx > 0) {
				const cand = abs.slice(0, idx) + ".pi/moa";
				if (fs.existsSync(cand)) boardRoot = cand;
			}
			return undefined;
		}

		// 项目未加入 MoA 则不强制
		const root = boardRoot ?? findBoardRoot(ctx.cwd);
		if (!root) return undefined;
		boardRoot = root;

		const name = (event as any).toolName as string;
		if (name === "subagent") {
			if (!boardTouched) return { block: true, reason: BLOCK_REASON };
			return undefined;
		}
		if (name === "bash") {
			const cmd = String(((event as any).input?.command) ?? "");
			if (/(^|[;&|]\s*)git[^;&|]*\b(commit|push)\b/.test(cmd) && !boardTouched) {
				return { block: true, reason: BLOCK_REASON };
			}
		}
		return undefined;
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!enabled || isSubagent()) return;
		turnCount++;
		if (!boardRoot || turnCount % 5 !== 0) return;
		runReport(boardRoot);
		// Phase 1a：handoff/status 校验（提醒档，不 block）
		const alerts: string[] = [];
		const noStatus = findCardsMissingStatus(boardRoot).filter((f) => !notifiedNoStatus.has(f));
		if (noStatus.length) {
			noStatus.forEach((f) => notifiedNoStatus.add(f));
			const msg = `🧭 navigator：${noStatus.length} 张结果卡缺 status 字段（${noStatus.map((f) => path.basename(f)).join(", ")}）——handoff 三档化提醒档，请补全或说明`;
			ctx.ui.notify(msg, "warning");
			alerts.push(msg);
		}
		const missing = reconcile(boardRoot).filter((h) => !notifiedMissing.has(h));
		if (missing.length) {
			missing.forEach((h) => notifiedMissing.add(h));
			const msg = `🧭 navigator：检测到 ${missing.length} 笔 commit 无任务记录（${missing.join(", ")}）——请补记 .pi/moa 任务卡`;
			ctx.ui.notify(msg, "warning");
			alerts.push(msg);
		}
		// 告警送达 captain（用户裁决：popup 可能看不到，captain 必须知情并处置）
		// 附时间戳+指纹：队列延迟送达时可识别陈旧告警（已发生 2 次）
		if (alerts.length) {
			try {
				const fp = alerts.join("|").length + "-" + (turnCount % 1000);
				pi.sendUserMessage(
					`[Navigator 告警·需 captain 处置][生成于 ${new Date().toISOString().slice(0, 16).replace("T", " ")} fp:${fp}]\n${alerts.join("\n")}`,
					{ deliverAs: "followUp" },
				);
			} catch { /* 注入失败不影响主流程 */ }
		}
		// 状态落盘：供 /moa status「Navigator·监测审计」层读取
		try {
			fs.writeFileSync(
				path.join(boardRoot, ".navigator-state.json"),
				JSON.stringify({
					turns: turnCount,
					statusAlerts: notifiedNoStatus.size,
					ledgerAlerts: notifiedMissing.size,
					lastCheckAt: Date.now(),
				}),
			);
		} catch { /* 落盘失败不影响主流程 */ }
	});
}

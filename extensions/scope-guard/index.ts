/**
 * scope-guard v3 — pi 钩子薄壳（策略加载 + 事件绑定），逻辑全在 ./core
 * @version v3.0-2026-08-05（M1：core/壳分离，可单测）
 *
 * 策略文件：~/.pi/agent/moa/guard-policy.json（缺失时用内建默认）
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	BudgetTracker,
	createPiiScanner,
	defaultPolicy,
	extractBashWriteTargets,
	isMoaBoardWriteAllowed,
	isOutsideCwd,
	isProtectedPath,
	mergePolicy,
	resolvePath,
	type MergedPolicy,
} from "./core";

const HOME = os.homedir();
const POLICY_PATH = path.join(HOME, ".pi/agent/moa/guard-policy.json");
const NO_RETRY =
	"此限制不可逾越：不要重试、不要换路径绕过、不要用其他工具代替，直接在结果中上报 blocked。";

function loadPolicy(): MergedPolicy {
	try {
		return mergePolicy(JSON.parse(fs.readFileSync(POLICY_PATH, "utf-8")));
	} catch {
		return defaultPolicy();
	}
}

export default function (pi: ExtensionAPI) {
	const policy = loadPolicy();
	const scanner = createPiiScanner(policy.pii.patterns);

	// ── 防线 1+2：写工具 & bash 绕行 ─────────────────────────────
	pi.on("tool_call", async (event, ctx) => {
		const isSub = process.env.PI_MOA_SUBAGENT === "1";
		const cwd = path.resolve(ctx.cwd ?? process.cwd());

		if (event.toolName === "write" || event.toolName === "edit") {
			const abs = resolvePath(cwd, String(event.input.path ?? ""));
			if (isProtectedPath(abs, policy.protectedExact, policy.protectedParts, HOME)) {
				ctx.hasUI && ctx.ui.notify(`🛡️ scope-guard 拦截敏感路径写入: ${abs}`, "warning");
				return { block: true, reason: `scope-guard: "${abs}" 是受保护路径（凭证/密钥/仓库内部）。${NO_RETRY}` };
			}
			if (isSub && policy.subagent.restrictToCwd && isOutsideCwd(abs, cwd)) {
				// pi-moa 黑板放行：仅当文件名含自身 actor 名（单写者+归属），其余越界写入照拦
				if (isMoaBoardWriteAllowed(abs, process.env.PI_MOA_AGENT)) {
					return undefined;
				}
				ctx.hasUI && ctx.ui.notify(`🛡️ scope-guard 拦截越界写入: ${abs}`, "warning");
				return { block: true, reason: `scope-guard: 子代理禁止写工作目录之外的路径 "${abs}"（黑板结果卡例外：文件名须含你的角色名，如 results/xx-${process.env.PI_MOA_AGENT ?? "<actor>"}.md）。${NO_RETRY}` };
			}
			return undefined;
		}

		if (event.toolName === "bash" && isSub && policy.subagent.blockBashWritesOutsideCwd) {
			const cmd = String(event.input.command ?? "");
			for (const t of extractBashWriteTargets(cmd)) {
				const abs = resolvePath(cwd, t);
				if (isProtectedPath(abs, policy.protectedExact, policy.protectedParts, HOME) || isOutsideCwd(abs, cwd)) {
					return { block: true, reason: `scope-guard: 子代理 bash 命令试图写入越界/敏感路径 "${abs}"。${NO_RETRY}` };
				}
			}
		}
		return undefined;
	});

	// ── 防线 3：出网 PII 检查 ────────────────────────────────────
	if (policy.pii.enabled) {
		pi.on("before_provider_request", (event, ctx) => {
			let text: string;
			try {
				text = JSON.stringify(event.payload);
			} catch {
				return undefined;
			}
			const hits = scanner.scan(text);
			if (hits.length === 0) return undefined;

			const names = hits.map((h) => h.name).join(", ");
			ctx.hasUI &&
				ctx.ui.notify(`🛡️ scope-guard：出网 payload 检出疑似密钥（${names}）→ ${policy.pii.action}`, "warning");
			if (policy.pii.action !== "redact") return undefined;

			try {
				return JSON.parse(scanner.redact(text));
			} catch {
				return undefined; // 解析失败则不动 payload（已告警）
			}
		});
	}

	// ── 会话预算告警 ─────────────────────────────────────────────
	const warnAt = policy.budget.sessionTokenWarnAt;
	if (warnAt > 0) {
		const tracker = new BudgetTracker(warnAt);
		pi.on("message_end", async (event, ctx) => {
			const msg: any = (event as any).message;
			const usage = msg?.usage;
			if (msg?.role === "assistant" && usage?.totalTokens) {
				const { total, justFired } = tracker.add(usage.totalTokens);
				if (justFired) {
					ctx.hasUI &&
						ctx.ui.notify(
							`💰 scope-guard 预算告警：本会话已消耗 ${total.toLocaleString()} tokens（阈值 ${warnAt.toLocaleString()}）`,
							"warning",
						);
				}
			}
			return undefined;
		});
	}
}

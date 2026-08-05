/**
 * Scope Guard v2 — pi-moa 安全硬边界（策略驱动版）
 * @version v2.0-2026-08-05（P2.5：策略化 + PII 出网红action + 会话预算告警）
 *
 * 策略文件：~/.pi/agent/moa/guard-policy.json（缺失时使用内建默认，行为等同 v1）
 * 开源复用：本文件零硬编码个人路径，全部路径经 $HOME 展开；示例见 guard-policy.example.json
 *
 * 三道防线：
 * 1. 写工具拦截（write/edit）：敏感路径全会话禁写；子代理（PI_MOA_SUBAGENT=1）禁写 cwd 外
 * 2. bash 绕行拦截：子代理 shell 重定向/tee 目标越界或敏感 → 拦截
 * 3. 出网 PII 防线（before_provider_request）：payload 中检出密钥模式 → 按策略 redact 替换并告警
 * 附加：会话 token 预算统计，超阈值告警（policy.budget.sessionTokenWarnAt）
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HOME = os.homedir();
const POLICY_PATH = path.join(HOME, ".pi/agent/moa/guard-policy.json");
const NO_RETRY =
	"此限制不可逾越：不要重试、不要换路径绕过、不要用其他工具代替，直接在结果中上报 blocked。";

interface Policy {
	version?: string;
	protectedExact?: string[]; // 支持 ~ 前缀
	protectedParts?: string[];
	subagent?: { restrictToCwd?: boolean; blockBashWritesOutsideCwd?: boolean };
	pii?: { enabled?: boolean; action?: "redact" | "warn"; patterns?: Record<string, string> };
	budget?: { sessionTokenWarnAt?: number };
}

const DEFAULT_PII_PATTERNS: Record<string, string> = {
	generic_api_key: "(?<![A-Za-z0-9])sk-[A-Za-z0-9_\\-]{16,}",
	anthropic_key: "(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_\\-]{16,}",
	aws_access_key: "AKIA[0-9A-Z]{16}",
	github_token: "(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}",
	slack_token: "xox[baprs]-[A-Za-z0-9\\-]{10,}",
	private_key_block: "-----BEGIN [A-Z ]*PRIVATE KEY-----",
};

const DEFAULT_POLICY: Required<Policy> = {
	version: "builtin-default",
	protectedExact: [
		"~/.pi/agent/auth.json",
		"~/.pi/agent/models.json",
		"~/.cc-switch/cc-switch.db",
		"~/.kimi-code/credentials/kimi-code.json",
	],
	protectedParts: ["/.ssh/", "/.gnupg/", "/.aws/", "/.git/", "/.env"],
	subagent: { restrictToCwd: true, blockBashWritesOutsideCwd: true },
	pii: { enabled: true, action: "redact", patterns: DEFAULT_PII_PATTERNS },
	budget: { sessionTokenWarnAt: 0 },
};

function expandHome(p: string): string {
	return p.startsWith("~/") ? path.join(HOME, p.slice(2)) : p;
}

function loadPolicy(): Required<Policy> {
	try {
		const raw = JSON.parse(fs.readFileSync(POLICY_PATH, "utf-8")) as Policy;
		return {
			version: raw.version ?? "custom",
			protectedExact: raw.protectedExact ?? DEFAULT_POLICY.protectedExact,
			protectedParts: raw.protectedParts ?? DEFAULT_POLICY.protectedParts,
			subagent: { ...DEFAULT_POLICY.subagent, ...(raw.subagent ?? {}) },
			pii: {
				...DEFAULT_POLICY.pii,
				...(raw.pii ?? {}),
				patterns: { ...DEFAULT_PII_PATTERNS, ...(raw.pii?.patterns ?? {}) },
			},
			budget: { ...DEFAULT_POLICY.budget, ...(raw.budget ?? {}) },
		};
	} catch {
		return DEFAULT_POLICY;
	}
}

export default function (pi: ExtensionAPI) {
	const policy = loadPolicy();
	const protectedExact = new Set(policy.protectedExact.map(expandHome));
	const protectedParts = policy.protectedParts;
	const piiRegexes = Object.entries(policy.pii.patterns).map(
		([name, src]) => ({ name, re: new RegExp(src, "g") }) as const,
	);

	const isProtected = (abs: string) =>
		protectedExact.has(abs) || protectedParts.some((frag) => abs.includes(frag));

	// ── 防线 1+2：写工具 & bash 绕行（v1 逻辑，策略化）─────────────────
	pi.on("tool_call", async (event, ctx) => {
		const isSub = process.env.PI_MOA_SUBAGENT === "1";
		const cwd = path.resolve(ctx.cwd ?? process.cwd());

		if (event.toolName === "write" || event.toolName === "edit") {
			const abs = path.resolve(cwd, String(event.input.path ?? ""));
			if (isProtected(abs)) {
				ctx.hasUI && ctx.ui.notify(`🛡️ scope-guard 拦截敏感路径写入: ${abs}`, "warning");
				return { block: true, reason: `scope-guard: "${abs}" 是受保护路径（凭证/密钥/仓库内部）。${NO_RETRY}` };
			}
			if (isSub && policy.subagent.restrictToCwd && !abs.startsWith(cwd + path.sep) && abs !== cwd) {
				ctx.hasUI && ctx.ui.notify(`🛡️ scope-guard 拦截越界写入: ${abs}`, "warning");
				return { block: true, reason: `scope-guard: 子代理禁止写工作目录之外的路径 "${abs}"。${NO_RETRY}` };
			}
			return undefined;
		}

		if (event.toolName === "bash" && isSub && policy.subagent.blockBashWritesOutsideCwd) {
			const cmd = String(event.input.command ?? "");
			const targets: string[] = [];
			for (const m of cmd.matchAll(/>>?\s*(["']?)([^\s"'|;&]+)\1/g)) targets.push(m[2]);
			for (const m of cmd.matchAll(/\btee\s+(?:-[a-z]+\s+)*(["']?)([^\s"'|;&]+)\1/g)) targets.push(m[2]);
			for (const t of targets) {
				const abs = path.resolve(cwd, t);
				const outside = !abs.startsWith(cwd + path.sep) && abs !== cwd;
				if (isProtected(abs) || outside) {
					return { block: true, reason: `scope-guard: 子代理 bash 命令试图写入越界/敏感路径 "${abs}"。${NO_RETRY}` };
				}
			}
		}
		return undefined;
	});

	// ── 防线 3：出网 PII 检查（redact 优先，warn 兜底）─────────────────
	if (policy.pii.enabled) {
		pi.on("before_provider_request", (event, ctx) => {
			let text: string;
			try {
				text = JSON.stringify(event.payload);
			} catch {
				return undefined;
			}
			const hits = piiRegexes.filter(({ re }) => {
				re.lastIndex = 0;
				return re.test(text);
			});
			if (hits.length === 0) return undefined;

			const names = hits.map((h) => h.name).join(", ");
			ctx.hasUI &&
				ctx.ui.notify(`🛡️ scope-guard：出网 payload 检出疑似密钥（${names}）→ ${policy.pii.action}`, "warning");

			if (policy.pii.action !== "redact") return undefined; // warn-only

			let cleaned = text;
			for (const { re } of hits) {
				re.lastIndex = 0;
				cleaned = cleaned.replace(re, "***REDACTED-BY-SCOPE-GUARD***");
			}
			try {
				return JSON.parse(cleaned);
			} catch {
				return undefined; // 解析失败则不动 payload（已告警）
			}
		});
	}

	// ── 会话预算告警 ──────────────────────────────────────────────
	const warnAt = policy.budget.sessionTokenWarnAt ?? 0;
	if (warnAt > 0) {
		let total = 0;
		let warned = false;
		pi.on("message_end", async (event, ctx) => {
			const msg: any = (event as any).message;
			const usage = msg?.usage;
			if (msg?.role === "assistant" && usage?.totalTokens) {
				total += usage.totalTokens;
				if (!warned && total >= warnAt) {
					warned = true;
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

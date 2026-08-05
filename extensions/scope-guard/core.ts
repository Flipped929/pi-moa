/**
 * guard-core — pi-moa scope-guard 的纯逻辑核心（不依赖 pi 运行时，可独立单测）
 * @version v1.0-2026-08-05（M1：从 scope-guard.ts 抽离）
 */

export interface Policy {
	version?: string;
	protectedExact?: string[];
	protectedParts?: string[];
	subagent?: { restrictToCwd?: boolean; blockBashWritesOutsideCwd?: boolean };
	pii?: { enabled?: boolean; action?: "redact" | "warn"; patterns?: Record<string, string> };
	budget?: { sessionTokenWarnAt?: number };
}

export interface MergedPolicy {
	version: string;
	protectedExact: string[];
	protectedParts: string[];
	subagent: { restrictToCwd: boolean; blockBashWritesOutsideCwd: boolean };
	pii: { enabled: boolean; action: "redact" | "warn"; patterns: Record<string, string> };
	budget: { sessionTokenWarnAt: number };
}

export const DEFAULT_PII_PATTERNS: Record<string, string> = {
	generic_api_key: "(?<![A-Za-z0-9])sk-[A-Za-z0-9_\\-]{16,}",
	anthropic_key: "(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_\\-]{16,}",
	aws_access_key: "(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}",
	github_token: "(?<![A-Za-z0-9])(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}",
	slack_token: "(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9\\-]{10,}",
	private_key_block: "-----BEGIN [A-Z ]*PRIVATE KEY-----",
};

export function defaultPolicy(): MergedPolicy {
	return {
		version: "builtin-default",
		protectedExact: [
			"~/.pi/agent/auth.json",
			"~/.pi/agent/models.json",
		],
		protectedParts: ["/.ssh/", "/.gnupg/", "/.aws/", "/.git/", "/.env"],
		subagent: { restrictToCwd: true, blockBashWritesOutsideCwd: true },
		pii: { enabled: true, action: "redact", patterns: { ...DEFAULT_PII_PATTERNS } },
		budget: { sessionTokenWarnAt: 0 },
	};
}

/** 用户策略与默认策略合并（用户数组整体替换，子对象深合并，PII patterns 合并） */
export function mergePolicy(raw: Policy, base?: MergedPolicy): MergedPolicy {
	const d = base ?? defaultPolicy();
	return {
		version: raw.version ?? "custom",
		protectedExact: raw.protectedExact ?? d.protectedExact,
		protectedParts: raw.protectedParts ?? d.protectedParts,
		subagent: { ...d.subagent, ...(raw.subagent ?? {}) },
		pii: {
			...d.pii,
			...(raw.pii ?? {}),
			patterns: { ...d.pii.patterns, ...(raw.pii?.patterns ?? {}) },
		},
		budget: { ...d.budget, ...(raw.budget ?? {}) },
	};
}

/** ~ 展开（posix 风格，测试可移植） */
export function expandHome(p: string, home: string): string {
	return p.startsWith("~/") ? home + p.slice(1) : p;
}

/** 规范化路径分隔符为 /，去掉尾部分隔符（根目录除外） */
export function normalizePath(p: string): string {
	let s = p.replace(/\\/g, "/");
	s = s.replace(/\/+/g, "/");
	if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
	return s;
}

/** 路径是否受保护（精确匹配 或 包含敏感片段） */
export function isProtectedPath(
	absPath: string,
	protectedExact: string[],
	protectedParts: string[],
	home: string,
): boolean {
	const abs = normalizePath(absPath);
	const exact = protectedExact.map((p) => normalizePath(expandHome(p, home)));
	if (exact.includes(abs)) return true;
	return protectedParts.some((frag) => abs.includes(normalizePath(frag)));
}

/** 是否越出工作目录 */
export function isOutsideCwd(absPath: string, cwd: string): boolean {
	const abs = normalizePath(absPath);
	const base = normalizePath(cwd);
	return abs !== base && !abs.startsWith(base + "/");
}

/** 从 bash 命令提取重定向/tee 的写入目标（支持引号包裹的含空格路径） */
export function extractBashWriteTargets(command: string): string[] {
	const targets: string[] = [];
	const push = (...candidates: (string | undefined)[]) => {
		const v = candidates.find((c) => c !== undefined);
		if (v) targets.push(v);
	};
	for (const m of command.matchAll(/>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s"'|;&]+))/g))
		push(m[1], m[2], m[3]);
	for (const m of command.matchAll(/\btee\s+(?:-[a-z]+\s+)*(?:"([^"]+)"|'([^']+)'|([^\s"'|;&]+))/g))
		push(m[1], m[2], m[3]);
	return targets;
}

/** 简单路径解析（绝对路径直通；相对路径基于 cwd，处理 ./ 与 ../ 一段） */
export function resolvePath(cwd: string, p: string): string {
	let s = p;
	if (!s.startsWith("/")) s = normalizePath(cwd) + "/" + s;
	const parts = s.split("/");
	const out: string[] = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return "/" + out.join("/");
}

export interface PiiHit {
	name: string;
	index: number;
}

/**
 * 合成密钥放行（防"对自己测试数据开火"）：
 * - 同字符重复串（sk-aaaa… / xxxx…，真实密钥有熵不会长成这样）
 * - 含 example/fake/test/dummy/sample/placeholder/your- 等明示标记
 */
export function isSyntheticSecret(s: string): boolean {
	const body = s.replace(/^(sk-(ant-)?|(ghp|gho|ghu|ghs|ghr)_|xox[baprs]-|AKIA)/, "");
	if (/^(.)\1{7,}$/.test(body)) return true;
	if (/example|fake|test|dummy|sample|placeholder|your[-_]/i.test(s)) return true;
	return false;
}

export interface PiiScanner {
	scan(text: string): PiiHit[];
	redact(text: string, placeholder?: string): string;
}

/** 编译 PII 扫描器（pattern 合并后编译为 RegExp；合成密钥自动放行） */
export function createPiiScanner(patterns: Record<string, string>): PiiScanner {
	const regs = Object.entries(patterns).map(([name, src]) => ({
		name,
		re: new RegExp(src, "g"),
	}));
	return {
		scan(text: string): PiiHit[] {
			const hits: PiiHit[] = [];
			for (const { name, re } of regs) {
				re.lastIndex = 0;
				let m: RegExpExecArray | null;
				while ((m = re.exec(text)) !== null) {
					if (!isSyntheticSecret(m[0])) {
						hits.push({ name, index: m.index });
						break; // 每个 pattern 记一次即可
					}
				}
			}
			return hits;
		},
		redact(text: string, placeholder = "***REDACTED-BY-SCOPE-GUARD***"): string {
			let out = text;
			for (const { re } of regs) {
				re.lastIndex = 0;
				out = out.replace(re, (m) => (isSyntheticSecret(m) ? m : placeholder));
			}
			return out;
		},
	};
}

/** 会话 token 预算追踪器（超阈值触发一次） */
export class BudgetTracker {
	private total = 0;
	private fired = false;
	constructor(private warnAt: number) {}
	add(tokens: number): { total: number; justFired: boolean } {
		this.total += tokens;
		if (!this.fired && this.warnAt > 0 && this.total >= this.warnAt) {
			this.fired = true;
			return { total: this.total, justFired: true };
		}
		return { total: this.total, justFired: false };
	}
	get value(): number {
		return this.total;
	}
}

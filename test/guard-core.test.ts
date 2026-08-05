import { describe, expect, it } from "vitest";
import {
	BudgetTracker,
	createPiiScanner,
	defaultPolicy,
	expandHome,
	extractBashWriteTargets,
	isOutsideCwd,
	isProtectedPath,
	mergePolicy,
	normalizePath,
	resolvePath,
} from "../extensions/scope-guard/core";

const HOME = "/home/tester";

describe("expandHome", () => {
	it("展开 ~ 前缀", () => {
		expect(expandHome("~/.pi/agent/auth.json", HOME)).toBe("/home/tester/.pi/agent/auth.json");
	});
	it("非 ~ 路径原样返回", () => {
		expect(expandHome("/etc/passwd", HOME)).toBe("/etc/passwd");
	});
	it("单独的 ~ 不展开（仅 ~/ 前缀生效）", () => {
		expect(expandHome("~other/x", HOME)).toBe("~other/x");
	});
});

describe("normalizePath", () => {
	it("去尾部斜杠与重复斜杠", () => {
		expect(normalizePath("/a//b/")).toBe("/a/b");
	});
	it("根目录保留", () => {
		expect(normalizePath("/")).toBe("/");
	});
	it("反斜杠转正", () => {
		expect(normalizePath("C:\\a\\b")).toBe("C:/a/b");
	});
});

describe("resolvePath", () => {
	it("绝对路径直通", () => {
		expect(resolvePath("/work", "/tmp/x.txt")).toBe("/tmp/x.txt");
	});
	it("相对路径基于 cwd", () => {
		expect(resolvePath("/work", "a/b.txt")).toBe("/work/a/b.txt");
	});
	it("处理 ./ 与 ../", () => {
		expect(resolvePath("/work/proj", "./x.txt")).toBe("/work/proj/x.txt");
		expect(resolvePath("/work/proj", "../evil.txt")).toBe("/work/evil.txt");
	});
});

describe("isProtectedPath", () => {
	const exact = ["~/.pi/agent/auth.json"];
	const parts = ["/.ssh/", "/.git/", "/.env"];
	it("精确匹配（含 ~ 展开）", () => {
		expect(isProtectedPath("/home/tester/.pi/agent/auth.json", exact, parts, HOME)).toBe(true);
	});
	it("片段匹配 .ssh", () => {
		expect(isProtectedPath("/home/tester/.ssh/id_rsa", exact, parts, HOME)).toBe(true);
	});
	it("片段匹配 .env 文件", () => {
		expect(isProtectedPath("/work/proj/.env", exact, parts, HOME)).toBe(true);
	});
	it("普通文件不命中", () => {
		expect(isProtectedPath("/work/proj/src/index.ts", exact, parts, HOME)).toBe(false);
	});
	it("envy 等相似名不误伤", () => {
		expect(isProtectedPath("/work/envy.ts", exact, parts, HOME)).toBe(false);
	});
});

describe("isOutsideCwd", () => {
	it("cwd 内 false", () => {
		expect(isOutsideCwd("/work/a/b.txt", "/work")).toBe(false);
	});
	it("cwd 本身 false", () => {
		expect(isOutsideCwd("/work", "/work")).toBe(false);
	});
	it("兄弟目录 true", () => {
		expect(isOutsideCwd("/tmp/x", "/work")).toBe(true);
	});
	it("前缀相似但不越界（/workshop vs /work）", () => {
		expect(isOutsideCwd("/workshop/x", "/work")).toBe(true);
		expect(isOutsideCwd("/work/shop/x", "/work")).toBe(false);
	});
});

describe("extractBashWriteTargets", () => {
	it("> 与 >>", () => {
		expect(extractBashWriteTargets("echo hi > a.txt")).toEqual(["a.txt"]);
		expect(extractBashWriteTargets("echo hi >> /tmp/b.log")).toEqual(["/tmp/b.log"]);
	});
	it("引号目标", () => {
		expect(extractBashWriteTargets(`echo x > "my file.txt"`)).toEqual(["my file.txt"]);
	});
	it("tee", () => {
		expect(extractBashWriteTargets("echo x | tee out.txt")).toEqual(["out.txt"]);
		expect(extractBashWriteTargets("echo x | tee -a /var/log/y")).toEqual(["/var/log/y"]);
	});
	it("无写入返回空", () => {
		expect(extractBashWriteTargets("ls -la | grep foo")).toEqual([]);
	});
	it("多目标", () => {
		const t = extractBashWriteTargets("echo a > x.txt; echo b >> y.txt");
		expect(t).toEqual(["x.txt", "y.txt"]);
	});
});

describe("createPiiScanner", () => {
	const scanner = createPiiScanner(defaultPolicy().pii.patterns);
	it("检出 sk- 密钥", () => {
		expect(scanner.scan("key is sk-abcdefghijklmnop1234")).toHaveLength(1);
	});
	it("检出 sk-ant-", () => {
		expect(scanner.scan("sk-ant-abcdefghijklmnop").length).toBeGreaterThan(0);
	});
	it("检出 AWS / GitHub token / 私钥块", () => {
		expect(scanner.scan("AKIAIOSFODNN7EXAMPLE").length).toBeGreaterThan(0);
		expect(scanner.scan("ghp_abcdefghijklmnopqrstuvwxyz").length).toBeGreaterThan(0);
		expect(scanner.scan("-----BEGIN OPENSSH PRIVATE KEY-----").length).toBeGreaterThan(0);
	});
	it("普通文本不误报", () => {
		expect(scanner.scan("hello world, this is safe text")).toHaveLength(0);
	});
	it("sk- 前缀紧跟字母数字不嵌套误报", () => {
		expect(scanner.scan("task-abcdefgh")).toHaveLength(0);
	});
	it("redact 替换命中串", () => {
		const out = scanner.redact("use sk-abcdefghijklmnop1234 ok");
		expect(out).toContain("***REDACTED-BY-SCOPE-GUARD***");
		expect(out).not.toContain("sk-abcdefghijklmnop1234");
	});
	it("redact 多次触发全局替换", () => {
		const out = scanner.redact("sk-aaaaaaaaaaaaaaaa1111 and sk-bbbbbbbbbbbbbbbb2222");
		expect(out).not.toMatch(/sk-[ab]/);
	});
});

describe("mergePolicy", () => {
	it("空输入返回默认", () => {
		const m = mergePolicy({});
		expect(m.subagent.restrictToCwd).toBe(true);
		expect(m.pii.enabled).toBe(true);
	});
	it("数组整体替换", () => {
		const m = mergePolicy({ protectedExact: ["/x"] });
		expect(m.protectedExact).toEqual(["/x"]);
	});
	it("子对象深合并", () => {
		const m = mergePolicy({ subagent: { restrictToCwd: false } });
		expect(m.subagent.restrictToCwd).toBe(false);
		expect(m.subagent.blockBashWritesOutsideCwd).toBe(true);
	});
	it("PII patterns 合并而非覆盖", () => {
		const m = mergePolicy({ pii: { patterns: { my_key: "mykey-[0-9]+" } } });
		expect(m.pii.patterns.my_key).toBeDefined();
		expect(m.pii.patterns.generic_api_key).toBeDefined();
	});
	it("budget 覆盖", () => {
		expect(mergePolicy({ budget: { sessionTokenWarnAt: 100 } }).budget.sessionTokenWarnAt).toBe(100);
	});
});

describe("BudgetTracker", () => {
	it("未超阈值不触发", () => {
		const t = new BudgetTracker(100);
		expect(t.add(50).justFired).toBe(false);
	});
	it("超阈值触发一次", () => {
		const t = new BudgetTracker(100);
		t.add(80);
		expect(t.add(30).justFired).toBe(true);
		expect(t.add(10).justFired).toBe(false);
	});
	it("阈值为 0 关闭", () => {
		const t = new BudgetTracker(0);
		expect(t.add(999999).justFired).toBe(false);
	});
	it("累计值正确", () => {
		const t = new BudgetTracker(0);
		t.add(10);
		t.add(15);
		expect(t.value).toBe(25);
	});
});

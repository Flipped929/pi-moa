# Contributing to pi-moa

欢迎贡献！/ Contributions welcome!

## 快速上手

1. Fork + clone，`npm install`
2. 改代码前先跑 `npm test` 确认基线绿
3. 提交前必须：`npx vitest run` 全绿 + `bash scripts/e2e-smoke.sh` 通过

## 硬性规则

- **core.ts 覆盖率不得低于 80%**（CI 强制，当前 100%）
- **零个人信息**：不得提交个人绝对路径、真实 API key、私有项目引用（CI 有 hygiene 扫描）
- **机制与文档同步**：改 extensions/ 行为时同步更新 docs/ 对应章节
- 角色/模式文件改动需带版本号（frontmatter `version:` 或文件头 `@version`）

## 分支与提交

- 分支：`feat/xxx` `fix/xxx` `docs/xxx`
- 提交信息：`<type>: <摘要>`（feat/fix/docs/chore/security/test）
- PR 描述里写明：动机、改动点、验证方式（测试/手测证据）

## 报告安全问题

请勿开公开 issue —— 见 [SECURITY.md](SECURITY.md)。

# Changelog

## [0.1.0] - 2026-08-05
首个公开版本。
- 双平面架构：captain 执行面（主会话）+ Navigator 治理面（异步审计）
- 扩展：moa-mode（/moa on|off|status|review + 调度矩阵注入）、scope-guard v2（三道防线+PII redact+预算告警）、subagent（官方 example + 子代理环境标记）
- 角色：executor / analyst / critic / devil（模型 roster 可替换）
- 协议：任务卡/结果卡/handoff 包 + 黑板 .pi/moa/
- 机制：调度矩阵（任务类型→子模型数）、抽查机制、实证纪律、一读多评（重叠税防控）
- install.sh / uninstall.sh

## [0.2.0] - 2026-08-05（M1 生产级加固）
- scope-guard v3：core/壳分离（extensions/scope-guard/core.ts 纯逻辑 + index.ts 钩子薄壳）
- vitest 单测 39 项，core.ts 覆盖率 100%（语句/分支/函数/行）
- e2e 冒烟脚本（mock OpenAI 端点，CI 零 API 成本）：scripts/e2e-smoke.sh
- install.sh 适配目录化安装（自动清理旧版平铺 scope-guard.ts 防双加载）
- /moa-on /moa-off /moa-status /moa-review 快捷命令

## 路线图
- 0.3: docs 完整版（EN README / playbooks 编写指南）+ pi packages 原生分发 + GitHub Actions CI
- 0.3: docs 完整版（EN README / playbooks 编写指南）+ pi packages 原生分发
- 0.4: Navigator 治理面落地（/moa audit + 成本基线报告）

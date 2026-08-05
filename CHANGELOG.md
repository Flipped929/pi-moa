# Changelog

## [0.1.0] - 2026-08-05
首个公开版本。
- 双平面架构：captain 执行面（主会话）+ Navigator 治理面（异步审计）
- 扩展：moa-mode（/moa on|off|status|review + 调度矩阵注入）、scope-guard v2（三道防线+PII redact+预算告警）、subagent（官方 example + 子代理环境标记）
- 角色：executor / analyst / critic / devil（模型 roster 可替换）
- 协议：任务卡/结果卡/handoff 包 + 黑板 .pi/moa/
- 机制：调度矩阵（任务类型→子模型数）、抽查机制、实证纪律、一读多评（重叠税防控）
- install.sh / uninstall.sh

## 路线图
- 0.2: guard-core 纯函数重构 + vitest 单测（≥80%）+ e2e mock 冒烟 + CI
- 0.3: docs 完整版（EN README / playbooks 编写指南）+ pi packages 原生分发
- 0.4: Navigator 治理面落地（/moa audit + 成本基线报告）

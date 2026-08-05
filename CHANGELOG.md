# Changelog

## [0.4.1] - 2026-08-05（发布整理）
- moa-mode v1.3：/moa review 架构化——多模型多角色多 agent 多轮联合评审至零可执行（Round 1 并行开火 → Round 2 交叉质询 → Round 3 裁决收敛，弹性轮次）；skills 感知（开场 find-skills 检索并明示采用/不采用清单）
- moa-mode v1.4：/moa status 三层排版——【captain·调度】（主会话 token/成本）/【Navigator·监测审计】（navigator-watch 对账状态）/【子模型】（在跑进程 + 已完成任务与时长，按模型聚合）
- navigator-watch v1.1：任务记录纪律结构性强制（Navigator 实体落地）——派活（subagent）/ git commit·push 前须已落盘任务卡否则 block；turn_end 每 5 轮对账（COMMIT-LEDGER 漏记 commit + 结果卡缺 status 字段，提醒档）+ 自动重跑 navigator-report.py；/navigator on|off|status|scan 命令；状态落盘 .navigator-state.json 供 /moa status 读取
- 写权限机制：任务记录结果卡单写者——子代理写 .pi/moa 内路径须文件名含自身 actor 名（isMoaBoardWriteAllowed，PI_MOA_AGENT 注入）；共享文件（task.md/final.md/NAVIGATOR.md/COMMIT-LEDGER.md）仅 captain 可写
- 新角色 executor-k3：K3 高能力档执行者（主领设计型/高难度分片），与 deepseek executor 双档并存
- 术语：黑板 → 任务记录（.pi/moa/<任务名>/）
- scope-guard core 单测新增 isMoaBoardWriteAllowed 覆盖（39 → 45 项）

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

## [0.3.0] - 2026-08-05（M3 文档完整版）
- docs/architecture.md：双平面/三卡协议/调度矩阵/安全模型/8+ 设计决策记录
- docs/configuration.md：install/roster/guard-policy 全字段参考/命令表/FAQ
- docs/playbooks.md：5 内置模式拆解 + 新角色新模式编写教程 + 最佳实践/反模式
- docs/README.en.md：英文 README
- 文档由 3 executor 并行起草 + captain 抽查复核（实证机制应用于自身）

## [0.4.0] - 2026-08-05（M4 CI/CD 与社区）
- GitHub Actions：单测 + core.ts≥80% 覆盖门禁 + e2e mock 冒烟 + gitleaks + 个人信息 hygiene 扫描
- CONTRIBUTING / CODE_OF_CONDUCT / SECURITY（含绕过案例征集与已知边界声明）
- issue/PR 模板

## 路线图
- 0.5: pi packages 原生分发（pi install）+ GitHub Release 自动化
- 0.3: docs 完整版（EN README / playbooks 编写指南）+ pi packages 原生分发
- 0.4: Navigator 治理面落地（/moa audit + 成本基线报告）

# pi-moa 架构

> 面向开源贡献者的技术文档。所有机制描述均与源码一致：主调度逻辑见 `extensions/moa-mode.ts`，安全边界见 `extensions/scope-guard/index.ts` 与 `extensions/scope-guard/core.ts`，角色契约见 `agents/*.md`，通讯协议见 `moa/templates/*.md`，演进历史见 `CHANGELOG.md`。
> 本文不虚构源码中不存在的能力；凡是路线图内容均显式标注。

## 1. 一句话

**pi-moa 把一个强模型 captain 变成"教练兼队员"**：强模型（如 Kimi K3）负责拆片、派活、抽查与裁决，并亲自认领最难切片（≤40% 工作量）；便宜模型（DeepSeek / Haiku 等）以独立进程并行承包分析与执行；所有通讯走"任务卡 / 结果卡 / handoff 包"三卡协议，落盘黑板全程可审计；安全边界由 scope-guard 在工具执行层物理拦截，而非依赖 prompt 自觉。

设计动机（README「为什么」）：

- 编码会话里 40-60% 的 token 是"搜索、机械修改、格式化"——不该让旗舰模型干。
- 单模型长会话必撞上下文墙（实测：单会话 90 万+ token 后 compaction 直接失败）。
- 多模型意见集成（MoA）需要**真异构**才有效：同模型多角色要配对抗 prompt + 独立上下文 + 跨家族审查。
- 纯路由不够：还需要安全硬边界、质量门、成本基线对比。

## 2. 双平面架构全景图

系统分两个平面：**captain 执行面**（同步，主会话内完成拆片-派活-裁决）与 **Navigator 治理面**（异步，消费黑板留痕做审计与优化）。两个平面之间唯一的共享状态是**黑板** `.pi/moa/`。

```
┌────────────────────── 执行面（同步 · 主会话） ──────────────────────┐
│                                                                    │
│  你（用户）                                                         │
│    │  任务                                                          │
│    ▼                                                               │
│  ┌──────────────┐  拆片/派活/抽查/裁决   ┌────────────────────────┐ │
│  │  captain     │ ────────────────────► │ 子代理（独立 pi 进程）   │ │
│  │  强模型·主会话 │                      │  executor 可写（限定域） │ │
│  │  认领最难切片  │ ◄──────────────────── │  analyst  只读         │ │
│  │  ≤40% 工作量  │  结果卡 / handoff 包   │  critic   只读·对抗     │ │
│  └──────┬───────┘                      │  devil    只读·跨家族    │ │
│         │  任务卡/结果卡/handoff 包落盘   └───────────┬────────────┘ │
│         │  子代理间不直连（星型拓扑）                  │              │
│         ▼                                            │              │
│  ┌──────────────────────────────────────────────────────┐          │
│  │ 黑板  .pi/moa/<任务>/                                │          │
│  │   task.md · results/*.md · handoffs/*.md             │          │
│  │   run_unit: session_id/run_id/actor/读写范围/        │          │
│  │             risk_level/outputs                       │          │
│  └──────────────────────────────────────────────────────┘          │
└───────────────────────────────┬─────────────────────────────────────┘
                                 │ 异步读取（tokens_by_model / cost_actual /
                                 │ 误判事件 / cost_single_model_baseline）
                                 ▼
┌────────────────────── 治理面（异步 · Navigator） ────────────────────┐
│  角色可信度统计 · 重叠税监测 · 多模型 vs 单模型成本基线 · 优化建议      │
│  当前已就位：黑板数据原料（run_unit 记录、tokens_by_model、           │
│   误判事件、成本基线字段）。完整治理动作（/moa audit、成本基线报告）    │
│   在 0.4 路线图（见 CHANGELOG.md）。                                  │
└──────────────────────────────────────────────────────────────────────┘
```

**执行面（captain）**：主会话内注入调度规则（`before_agent_start` 钩子），对小任务直接完成、对大任务拆片派活、对子模型结果抽查、对冲突裁决。它是唯一的通讯汇聚点。

**治理面（Navigator）**：异步审计平面。其数据来源在设计上已通过协议保证——每个运行单元记录 `session_id/run_id/actor/读写范围/risk_level/outputs`（任务卡模板 `run_unit`），结果卡携带 `usage.tokens_by_model` 与 `cost_actual`，任务卡预留 `cost_single_model_baseline`（同任务全 K3 估算值），抽查机制在黑板记录**误判事件**（"供 navigator 统计角色可信度"）。完整的治理动作（`/moa audit` 命令与成本基线报告）是 0.4 路线图内容，当前版本以"数据原料先行"的方式落地。

**黑板**：`.pi/moa/<任务>/` 目录，存放 task.md / results/*.md / handoffs/*.md。开启协同模式时自动建目录，并在 `.gitignore` 登记 `.pi/moa/`（仅当目录是 git 仓库时，幂等追加）。

## 3. 三卡协议

三卡协议是 captain 与子模型之间的通讯契约：**任务卡**（captain → 子模型）、**结果卡**（子模型 → captain）、**handoff 包**（结果卡 `status=handoff` 时附加的断点移交）。

### 3.1 任务卡（`moa/templates/task-card.md`）

captain 派活时下发的任务说明 + 运行单元记录：

| 字段 | 类型 | 含义 |
|---|---|---|
| `task_card.goal` | string | 一句话目标 |
| `task_card.scope` | string[] | **可写路径列表**，即写权限边界；多子模型并行时 scope 互不相交 |
| `task_card.context_files` | string[] | 需读路径；**不给全量历史，只给相关文件**（子代理是独立进程、无全局视野，靠此显式喂上下文） |
| `task_card.output` | string | 结果卡要求（≤300 字正文，落盘路径） |
| `task_card.playbook` | enum | 编码 \| 评审 \| 调研 \| 写作 \| 默认 |
| `task_card.deadline_hint` | string | 预计规模（分钟） |
| `run_unit.session_id` / `run_unit.run_id` | string | 会话 / 运行单元标识 |
| `run_unit.actor` | string | 角色+模型，如 `executor@deepseek-v4-flash` |
| `run_unit.workspace_scope` | string | 读写范围 |
| `run_unit.sandbox_profile` | string | 权限边界 |
| `run_unit.risk_level` | enum | G0 \| G1 \| G2 \| G3 |
| `run_unit.approval_ref` | string | 审批引用 |
| `run_unit.tokens_by_model` | object | `{model: {input, output}}` —— 成本对比原料 |
| `run_unit.cost_actual` | number | 实际成本 |
| `run_unit.cost_single_model_baseline` | number | 同任务全 K3 估算值 |

### 3.2 结果卡（`moa/templates/result-card.md`）

子模型回报 captain 的结构化结论，**正文 ≤300 字**：

| 字段 | 含义 |
|---|---|
| `result_card.status` | `done` \| `partial` \| `blocked` \| `handoff` |
| `result_card.summary` | 结论（≤300 字） |
| `result_card.artifacts` | 产出文件路径列表——**细节在文件，卡里只有索引** |
| `result_card.concerns` | 风险 / 需上游决策的事，无则写"无" |

各角色的结果卡字段略有差异，见第 4 节角色表。

### 3.3 handoff 包（结果卡 `status=handoff` 时追加）

"搞不定不丢人，交出好 handoff 包就是合格产出"（executor.md）。追加字段：

| 字段 | 含义 |
|---|---|
| `handoff_packet.suggest_next` | 建议接手方：`k3` \| `<角色>` |
| `handoff_packet.what_done` | 已完成的尝试（≤150 字） |
| `handoff_packet.current_state.files_touched` | 已触碰文件 |
| `handoff_packet.current_state.decisions_made` | 已做出的决策 |
| `handoff_packet.dead_ends` | **确认走不通的路**（模板注释："最值钱的部分"）——防止下一个角色重走死路 |
| `handoff_packet.open_question` | 卡住的具体点 |
| `handoff_packet.usage` | `tokens_by_model` / `cost_actual`（navigator 成本对比原料） |

captain 收到 handoff 后**从断点接手**（调度规则："executor 返回 blocked/handoff 时你从 handoff 包断点接手"），而不是重头再来。

### 3.4 体积纪律

| 规则 | 出处 |
|---|---|
| 结果卡正文 ≤300 字 | 所有 agents/*.md 返回格式 + 任务卡 `output` |
| handoff `what_done` ≤150 字 | executor.md |
| 大段产出（代码、长文）写入文件，返回内容只放结论和路径 | executor.md 工作纪律 3 |
| 任务卡不给全量历史，只给 `context_files` | task-card.md |

### 3.5 为什么是星型拓扑

调度规则原文："你始终掌握全部通讯：子代理间不直连，冲突由你裁决；拿不准的升级给用户。"

- **冲突裁决集中**：多角色意见冲突只有单一仲裁者（captain），不存在子代理间的拉锯或互相覆盖。
- **可审计**：全部通讯经 captain 落盘黑板，治理面才能异步消费。
- **防级联幻觉**：子代理只接触 captain 下发的上下文，不会被另一个子代理的错误结论二次污染。

代价是 captain 成为汇聚瓶颈，因此配套三条约束：**并行子代理 ≤3、captain 认领 ≤40% 工作量、结果卡 ≤300 字**。

## 4. 角色体系

### 4.1 角色表

| 角色 | 模型（默认） | 工具 | 权限 | 立场 | 结果卡字段 |
|---|---|---|---|---|---|
| **captain** | `kimi-coding/k3` | 全部 | 主会话，全权 | 调度/裁决/抽查，同时认领最难切片 | 无（它是调度方） |
| **executor** | `deepseek/deepseek-v4-flash` | read, edit, write, grep, find, ls, bash | **可写，但限定在任务卡 scope** | 完成任务分片 | `status/summary/artifacts/concerns`，handoff 时追加 `suggest_next/what_done/dead_ends/open_question` |
| **analyst** | `deepseek/deepseek-v4-flash` | read, grep, find, ls, bash | **只读**（bash 仅只读命令：git log/diff/show、grep、wc 等） | 分析，结论必须带 文件:行号 | `status/summary/findings/concerns` |
| **critic** | `deepseek/deepseek-v4-flash` | read, grep, find, ls, bash | 只读 | **对抗**：默认被审查产出有问题，目标是证明错在哪 | `status/verdict/critical/warnings/blind_spots`，verdict ∈ pass \| pass_with_notes \| fail |
| **devil** | `kimi-coding/k3`（**跨家族**） | read, grep, find, ls, bash | 只读 | 挑战**根本前提**，抓执行层同家族模型的系统性盲区；可看图片，含截图/架构图时视觉审查由它负责 | `status/verdict/premise_challenges/systemic_risks/alternative`，verdict ∈ agree \| disagree \| conditional |

角色契约细节（来自 agents/*.md）：

- **executor**：严格在任务卡 scope 内工作，不碰范围外文件；先读 `context_files` 再动手；图片/视觉内容看不了，遇到立即 `blocked`，不许瞎猜。
- **analyst**：围绕目标分析，不做无关扩展；拿不准的一律标"存疑"，不许凑"真✅"。
- **critic**：与执行者/分析者用相同模型，**价值来自对抗性立场而非同情理解**；找不到问题要明说"未发现 N 类问题"，不许编造假问题凑数；图片相关审查在 `blind_spots` 中注明"未覆盖"。
- **devil**：唯一异构角色；唱反调是职责，但每个反对意见必须给出推理，不许为反而反。

### 4.2 模型 roster 替换规则

架构**不绑定厂商**。默认 roster 与替换方式：

- 默认：`executor/analyst/critic = deepseek-v4-flash`，`devil/captain = kimi-k3`（agents/*.md 的 `model:` frontmatter 字段）。
- 替换：改 `~/.pi/agent/agents/*.md` 的 `model:` 字段即可，换成 Claude / GPT / 本地模型都行。
- `/moa status` 做角色在线检查：检查 `~/.pi/agent/agents/{executor,analyst,critic,devil}.md` 文件是否存在（✅/❌），**只检查文件存在性，不校验模型能力**。

只有四条硬性约束（README「模型 roster」+ moa-mode 调度规则）：

1. **captain 用你最强的模型**（长上下文优先）——它是汇聚点，上下文窗口是硬约束。
2. **devil 用与执行层不同家族的模型**——异构才有意义（见下）。
3. **含图任务永远走多模态模型**（子模型纯文本；图片/视觉步骤 captain 自己做，devil.md 例外声明其可看图片并负责视觉审查）。
4. 执行层（executor/analyst/critic）要便宜快。

### 4.3 为什么 devil 必须跨家族

README「为什么」第 3 条：**多模型意见集成需要真异构才有效**——同模型多角色要配对抗 prompt + 独立上下文 + 跨家族审查。devil.md 说得更直接：

> 其他角色（DeepSeek 系）可能在同一处犯系统性错误——你的存在就是为了抓这个。

同家族模型共享训练数据与推理偏置，多个 DeepSeek 角色可能**集体**犯同一类错误；批评家若与执行者同模型，只能抓到"个体错误"而抓不到"家族盲区"。devil 用旗舰模型（K3）正是为了在前提层面（需求理解、方向、更简单的路）提供真正独立的第二意见。

权衡：跨家族意味着 devil 用贵模型。因此它被设计为**只读**角色，且**不默认出现在所有任务里**——调度矩阵中只有评审类默认满编（analyst/critic/devil），编码类默认是 executor + critic，devil 按需启用。

### 4.4 captain 与 Navigator 的角色边界

- **captain**：执行面的队员兼教练。真实干活（认领最难切片，≤40% 工作量），不是纯调度壳。
- **Navigator**：治理面的审计者。不参与单次任务的派活与执行，只消费黑板数据做统计与建议。当前版本 Navigator 的"数据接口"已全部就位（run_unit、tokens_by_model、误判事件、成本基线字段），治理动作本体在 0.4 路线图（`/moa audit` + 成本基线报告）。

## 5. 调度矩阵

调度规则在 `/moa on` 后通过 `before_agent_start` 注入主会话系统提示（子代理进程因 `PI_MOA_SUBAGENT=1` 自动跳过，防规则套娃）。captain 对每个任务先判断规模：**预计 <10 分钟的小任务直接自己完成，不派活**；大任务按下表拆片：

| 任务类型 | 子模型数量 | 编排方式 | 关键理由 |
|---|---|---|---|
| 高重叠阅读类（全文档审计/全景勘察） | **0-1 个** | captain 自己单跑，或"一读多评"：1 个 analyst 通读产出摘要黑板，critic/devil **基于摘要 + 定向抽查**，禁止重复全读 | 防重叠税 |
| 编码类（scope 天然不相交） | **2-3 个并行** | 并行 executor（各自 scope 不相交）+ critic 审 diff | 并行收益最高 |
| 评审类（方案/设计评审，输入材料小） | **3 个满编** | analyst/critic/devil 对抗多轮 → captain 裁决 → **零可执行终稿**（每 Phase 带验证+回滚，开放问题移交用户） | 对抗密度最大 |
| 调研类（多角度外部主题） | **2-3 个** | 多个 analyst 分角度 → critic 查缺 → captain 综合 | 角度覆盖 |
| 写作类 | **1+1** | 1 个 executor 起草 + 1 个 critic 挑刺 → captain 定稿 | 最省配置 |
| 拿不准 | **1 个探测** | 先派 1 个 analyst 探测再定 | 避免过度编排 |
| 小任务（<10 分钟） | **0** | captain 直接完成 | 编排本身有成本 |

**全局纪律**（无论哪种类型）：

- 并行子代理 ≤3。
- captain 认领最难切片，但 ≤40% 工作量。
- 图片/视觉步骤永远 captain 自己做（子模型纯文本）。
- 输出强制结构化（结果卡）。
- 任务卡必须含：`goal / scope(可写路径) / context_files / 输出要求(结果卡≤300字)`。
- 评审模式（`/moa review <主题>`）另有流程：Round 1 各角色并行开火 → Round 2 交叉质询（观点互喂再评）→ Round 3 captain 裁决收敛；开场白中**明示本次各维度模型分配与理由**；自动升级（高难度判断/关键架构决策/flash 首轮质量不足 → captain 亲审）与自动降级（机械检查类维度保持 flash）；记录 `tokens_by_model` 供成本对比。

### 5.1 重叠税与一读多评

**重叠税**：多个子模型**重复读取同一份大材料**的 token 浪费。全文档审计若让 analyst/critic/devil 各读一遍，材料 token 被乘了 3——这是纯浪费，不产生任何新信息。

**一读多评**的解法：只让 1 个 analyst 通读全量材料，产出**摘要黑板**；critic/devil 基于摘要 + 对关键区段的**定向抽查**发表意见，**禁止重复全读**。这样材料只被读 1 次，多角色意见仍然齐备。

权衡：摘要会丢失细节。因此配套"定向抽查"——需要深挖的区段由 captain 指定、角色只精读指定片段，而不是放回全量读取。

## 6. 质量机制

质量机制分三层：抽查（captain 验证）、实证纪律（证据标准）、信任降级（后果机制）。

### 6.1 抽查机制（captain 保留验证权）

调度规则原文：

> - 对子模型结果卡中的关键实证（文件:行号、数据、结论）**风险导向抽查 10-30%**，亲自复核原文
> - **必抽项**：全过/无异常类结论、安全相关结论、影响后续决策的关键判断
> - 发现一处造假/误判 → 该子模型**本次产出全量复核**，并在黑板记录误判事件（供 navigator 统计角色可信度）
> - 抽查结果写入终稿（"已抽查 N 项，复核率 X%"），未抽查的结论标注"未经复核"

设计要点：

- **风险导向**：抽查比例不是均匀抽样，而是押注在"最容易出问题也最危险"的结论上——尤其是"全过/无异常"这类天然缺乏证据压力的结论（模型最可能在这里偷懒），以及安全相关、影响后续决策的关键判断。
- **抽查结果必须透明化**：终稿里写明抽查了多少项、复核率多少；未抽查的结论显式标注"未经复核"。这让下游（用户或后续任务）能区分证据等级。
- 抽查是 captain 的**义务**而非可选项——机制以调度规则的形式写死在注入的提示里。

### 6.2 实证纪律（铁律）

analyst.md 原文：

> git 提交说明、代码注释、文档中的"验证通过"字样**一律不算实证**。必须验证代码/SQL/配置本体并给出 文件:行号。拿不准的一律标"存疑"，不许凑"真✅"。

调度规则同样注入："git 提交说明、代码注释、'验证通过'字样一律不算实证，必须验代码/SQL/配置本体。"

为什么这么严格：git log、注释、"已验证"这类**二手证据**是 LLM 最廉价的产出方式，可以系统性造假——模型没真的跑过代码也能编出"验证通过"。证据标准必须是**本体**：代码、SQL、配置文件本身，且给出 文件:行号 可复核定位。

### 6.3 信任降级

- 一次抽查发现造假/误判 → 该子模型**本次产出全量复核**（不再抽查，全查）。
- 误判事件**记录到黑板**，作为 Navigator 统计角色可信度的输入——这是"信任"从一次性的临时惩罚升级为**跨任务的可积累信号**的机制。
- 配合实证纪律，子模型知道"全过/无异常"类结论会被重点抽查，造假的期望收益被压低。

## 7. 安全模型

安全边界由 **scope-guard**（`extensions/scope-guard/`）实现。v3 版本分两层：`index.ts` 是 pi 钩子薄壳（策略加载 + 事件绑定），`core.ts` 是纯逻辑核心（不依赖 pi 运行时，可独立单测，vitest 39 项测试、100% 语句/分支/函数/行覆盖）。

策略文件：`~/.pi/agent/moa/guard-policy.json`，缺失时用内建默认（`defaultPolicy()`）；用户策略通过 `mergePolicy` 合并（数组整体替换、子对象深合并、PII patterns 合并）。

### 7.1 三道防线

**防线 1：敏感路径写拦截（所有会话）**

`tool_call` 钩子拦截 `write` / `edit`，用 `isProtectedPath` 判定：精确命中 `protectedExact`（默认 `~/.pi/agent/auth.json`、`~/.pi/agent/models.json`）或包含 `protectedParts` 片段（默认 `/.ssh/`、`/.gnupg/`、`/.aws/`、`/.git/`、`/.env`）即 block。**对主会话和子代理都生效**——主模型同样不许写凭证与密钥。

**防线 2：子代理越界写拦截（仅子代理，`PI_MOA_SUBAGENT=1`）**

- `write` / `edit`：`restrictToCwd` 开启时，目标路径越出工作目录（`isOutsideCwd`）即 block。
- **bash 绕行拦截**：`blockBashWritesOutsideCwd` 开启时，用 `extractBashWriteTargets` 从命令中提取**重定向（`>` / `>>`）与 `tee`** 的写入目标（支持引号包裹的含空格路径），命中越界/敏感路径即 block。这是关键设计：子代理不能通过 bash 绕过写工具的限制。

被拦截时返回固定 reason 并附带 **NO_RETRY 声明**：

> 此限制不可逾越：不要重试、不要换路径绕过、不要用其他工具代替，直接在结果中上报 blocked。

**防线 3：出网 PII 检查（`before_provider_request`）**

对发给模型的 payload 做 JSON 序列化后扫描。默认 PII pattern（`DEFAULT_PII_PATTERNS`）：`sk-` 通用 API key、`sk-ant-` Anthropic key、`AKIA` AWS key、`ghp_` 等 GitHub token、`xox` Slack token、`-----BEGIN ... PRIVATE KEY-----`。命中后 `action` 决定行为：`redact`（默认，替换为 `***REDACTED-BY-SCOPE-GUARD***`）或 `warn`（只告警）。redact 后 JSON 解析失败则不动 payload（已告警），避免破坏请求。

### 7.2 会话预算告警

`BudgetTracker` 监听 `message_end` 的 assistant `usage.totalTokens`，累加至阈值（`budget.sessionTokenWarnAt`，默认 0 即关闭；示例 500000）时**告警一次**。这是对"上下文墙"教训（90 万+ token 后 compaction 失败）的事前防线——在撞墙前提醒用户。

### 7.3 为什么 prompt 约束不算边界

pi-moa 的安全哲学是**物理拦截而非 prompt 自觉**：

1. **拦截点在工具执行层**：`tool_call` 钩子在工具真正执行前 block，不依赖模型"记得遵守"写在提示里的安全规则。prompt 约束可被诱导、遗忘、被注入覆盖；钩子拦截不可绕过。
2. **主动防绕行**：防线 2 专门解析 bash 重定向/tee——说明设计者把"子代理用 bash 绕过写工具"当作真实威胁建模，而 prompt 约束对此毫无办法。
3. **失败模式明确**：被拦截即返回固定 reason + NO_RETRY，要求子代理直接上报 blocked，而不是换个路径再试——禁止"绕过-重试"的对抗循环。
4. **可测试**：安全逻辑抽到 core.ts 纯函数，100% 覆盖率的单测保证拦截判定本身不出错——prompt 约束无法单测。

prompt 约束（角色定义里的"只读""限定 scope"）依然存在，但定位是**行为引导**（让子代理少踩边界），真正兜底的是 scope-guard 的执行层拦截。

## 8. 设计决策记录（ADR）

每条决策附"为什么"与"权衡"，来源标注在条目末尾（源码注释 / CHANGELOG / 模板）。

### ADR-01 双平面架构：执行与治理分离

- **为什么**：单平面下 captain 既执行又自审，无法形成独立的可信度统计；治理必须站在执行之外异步消费留痕。CHANGELOG 0.1.0 将"captain 执行面 + Navigator 治理面（异步审计）"列为架构支柱。
- **权衡**：治理数据原料已随协议落黑板，但治理动作本体（`/moa audit`、成本基线报告）在 0.4 路线图——当前以"数据先行"推进，Navigator 的完整价值尚未兑现。

### ADR-02 星型拓扑：全通讯经 captain

- **为什么**：冲突裁决集中、通讯可审计、防子代理间级联幻觉；规则原文"子代理间不直连，冲突由你裁决；拿不准的升级给用户"。
- **权衡**：captain 成为汇聚瓶颈。配套三约束：并行 ≤3、captain 认领 ≤40%、结果卡 ≤300 字。

### ADR-03 结果卡 ≤300 字体积纪律 + 产物落盘

- **为什么**：星型拓扑下所有卡汇聚进 captain 上下文；大段输出会冲垮它。"细节在文件，卡里只有索引"（result-card.md）。
- **权衡**：增加一次落盘/读取往返；用 handoff 包与 artifacts 路径补偿信息完整性。

### ADR-04 模型 roster 可替换，不绑定厂商

- **为什么**：架构只定义角色契约与异构约束（agents/*.md 的 `model:` frontmatter），不绑定厂商；用户手里有什么模型就换什么。
- **权衡**：`/moa status` 只检查 agents/*.md 文件存在性，无法硬校验模型能力；异构约束靠文档约定与调度规则而非强制。

### ADR-05 devil 必须跨家族

- **为什么**：MoA 真异构才有价值；同家族模型系统性错误相关（devil.md："其他角色（DeepSeek 系）可能在同一处犯系统性错误"）；同模型多角色需对抗 prompt + 独立上下文 + 跨家族审查（README「为什么」）。
- **权衡**：跨家族意味着用旗舰模型，成本高 → 只读 + 默认仅评审类启用。

### ADR-06 一读多评，防重叠税

- **为什么**：多个子模型重读同一份大材料是纯 token 浪费（重叠税）；高重叠任务改为 1 个 analyst 通读 → 摘要黑板 → critic/devil 基于摘要 + 定向抽查，"禁止重复全读"。
- **权衡**：摘要丢细节 → 用"定向抽查"补偿；全量复核的权力保留在 captain 手里。

### ADR-07 抽查机制 + 信任降级（captain 保留验证权）

- **为什么**：LLM 产出默认不可全信；"全过/无异常"类结论、安全结论、影响后续决策的关键判断是必抽项；一处造假 → 全量复核 + 黑板记录误判事件。
- **权衡**：抽查消耗 captain token → 用风险导向把比例压在 10-30%，且未抽查结论显式标注"未经复核"换取透明。

### ADR-08 实证纪律：二手证据不算实证

- **为什么**：git 提交说明、注释、"验证通过"字样是模型最廉价的产出，可系统性造假；证据标准必须是代码/SQL/配置本体 + 文件:行号，拿不准标"存疑"。
- **权衡**：强制本体验证增加子模型耗时与 token；换取结论可信度与可复核性。

### ADR-09 安全用物理拦截，而非 prompt 约束

- **为什么**：prompt 约束靠模型自觉，可被诱导/遗忘/注入；scope-guard 在 `tool_call` 层 block，并解析 bash 重定向/tee 防绕行，block 附带 NO_RETRY 禁重试。
- **权衡**：需要穷举写路径向量（write/edit/bash 重定向/tee），且策略可被用户 `mergePolicy` 覆盖——用户是最终信任根。

### ADR-10 scope-guard v3 core/壳分离 + 100% 覆盖单测

- **为什么**：安全逻辑必须可单测；v3 把纯逻辑抽到 core.ts（不依赖 pi 运行时），vitest 39 项、100% 语句/分支/函数/行覆盖；e2e 冒烟 mock OpenAI 端点，CI 零 API 成本（CHANGELOG 0.2.0）。
- **权衡**：多一层抽象与文件；换取拦截判定本身的回归安全。

### ADR-11 子代理独立进程 + `PI_MOA_SUBAGENT` 标记

- **为什么**：隔离上下文窗口（单会话 90 万+ token 后 compaction 失败的教训）；子代理进程跳过调度规则注入，防"规则套娃"（moa-mode.ts 注释）。
- **权衡**：进程启动开销；独立上下文缺全局视野 → 用任务卡 `context_files` 显式喂上下文。

### ADR-12 黑板 `.pi/moa/` + `.gitignore` 登记

- **为什么**：全程留痕可审计（G1 留痕），供 Navigator 异步消费；自动在 `.gitignore` 登记防仓库污染（moa-mode.ts `ensureBlackboard`）。
- **权衡**：工作区新增目录与写入噪声；以 `.gitignore` 隔离，且仅 git 仓库内登记。

## 9. 源码地图（贡献者索引）

| 概念 | 源码位置 |
|---|---|
| 调度矩阵 / 抽查 / 实证纪律原文 | `extensions/moa-mode.ts`（`ORCHESTRATION_RULES` 注入文本） |
| 评审模式流程 | `extensions/moa-mode.ts`（`REVIEW_PROMPT`） |
| /moa 命令与快捷别名 | `extensions/moa-mode.ts`（`handle`） |
| 环境变量 `PI_MOA_DEFAULT` / `PI_MOA_SUBAGENT` | `extensions/moa-mode.ts`、`extensions/subagent/index.ts` |
| 三道防线 / PII / 预算告警 | `extensions/scope-guard/index.ts` |
| 路径保护 / bash 写目标解析 / PII 扫描器 / 预算追踪 / 策略合并 | `extensions/scope-guard/core.ts` |
| 子代理派生（single/parallel/chain、JSON 模式、usage 统计） | `extensions/subagent/index.ts`、`extensions/subagent/agents.ts` |
| 角色定义与返回格式 | `agents/{executor,analyst,critic,devil}.md` |
| 三卡协议字段与 run_unit | `moa/templates/{task-card,result-card}.md` |
| 策略示例 | `moa/guard-policy.example.json` |
| 演进历史 / 路线图 | `CHANGELOG.md` |

## 10. 当前状态与路线图（诚实声明）

- **已落地（0.1.0 / 0.2.0）**：双平面骨架（执行面完整 + 治理面数据接口）、moa-mode 调度注入、scope-guard 三道防线 + PII redact + 预算告警、四角色 roster、三卡协议与黑板、调度矩阵/抽查/实证纪律/一读多评、install.sh/uninstall.sh、39 项单测 + e2e 冒烟。
- **路线图（未落地，勿当已实现）**：0.3 英文 README / playbooks 文档 + pi packages 原生分发 + GitHub Actions CI；0.4 Navigator 治理面落地（`/moa audit` + 成本基线报告）。

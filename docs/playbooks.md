# pi-moa 模式（Playbooks）编写指南

> 这篇文档写给两种人：**captain 使用者**（想理解任务怎么被拆、派给谁）和**模式作者**（想为 pi-moa 新增角色与模式）。所有例子均来自本仓库真实文件：调度规则原文在 [`extensions/moa-mode.ts`](../extensions/moa-mode.ts)，角色写法在 [`agents/`](../agents/)，三卡模板在 [`moa/templates/`](../moa/templates/)。阅读前建议先过一遍 [README](../README.md) 的核心概念表。

---

## 1. 什么是"模式（playbook）"

一句话：**任务类型 → 分工方式的映射**。

pi-moa 的多模型协同不是"所有任务都派一堆子模型"，而是 captain 先给任务分类，再按该类别的默认编排决定：派几个子模型、派哪些角色、并行还是链式、谁来裁决。这个映射在源码里就是 `extensions/moa-mode.ts` 中 `ORCHESTRATION_RULES` 的**调度矩阵**：

```
【调度矩阵：任务类型 → 子模型数量】
- 高重叠阅读类（全文档审计/全景勘察）→ 0-1 个：自己单跑，或"一读多评"
- 编码类（scope 天然不相交）→ 2-3 个并行 executor + critic 审 diff
- 评审类（方案/设计评审，输入材料小）→ 3 个满编：analyst/critic/devil 对抗多轮
- 调研类（多角度外部主题）→ 2-3 个 analyst 分角度 → critic 查缺
- 写作类 → 1 个 executor 起草 + 1 个 critic 挑刺
- 拿不准：先派 1 个 analyst 探测再定
```

为什么需要模式而不是一刀切？因为子模型的数量和分工直接决定**成本**（每个子模型都是独立上下文、独立 token 计费）和**质量**（多角色对抗能发现单模型盲区，但重叠读材料会浪费 token）。模式就是把这些权衡固化成可复用的决策。

### 内置 5 模式一览

| 模式 | 触发条件 | 角色编排 | 并行度 | 成本特征 |
|---|---|---|---|---|
| 编码 | 写代码/改文件，scope 可切分 | 2-3 executor 并行 + critic 审 diff | 高（天然不相交） | 便宜模型干重活，captain 只裁决 |
| 评审 | 方案/设计/代码评审，输入材料小 | analyst/critic/devil 满编 3 | 高（材料小，重叠税低） | 最贵的模式，值得 |
| 调研 | 多角度外部主题 | 2-3 analyst 分角度 + critic 查缺 | 中 | 角度划分决定成本 |
| 写作 | 起草/改写长文 | 1 executor 起草 + 1 critic 挑刺 | 低 | 最省的模式 |
| 默认 | 拿不准 / 高重叠阅读 | 先 1 analyst 探测；或 0-1 个自己单跑 | 极低 | 先探测再投入 |

---

### 1.1 编码模式

- **触发条件**：任务需要写代码、改文件、跑命令，且工作内容可以按文件/模块切成互不相交的分片。
- **角色编排**：`2-3 个 executor 并行`（每个 executor 一个任务卡，scope 互不相交）+ `1 个 critic 审 diff`（挑错、找边界遗漏）。captain 认领最难的一个切片，但自留工作量 ≤40%。
- **适用场景**：多模块并行开发、重构分片、修一批同类 bug。
- **真实示例（本仓库）**：`extensions/` 目录的模块划分本身就是一次典型的编码拆片——`moa-mode.ts`（调度）、`scope-guard/core.ts + index.ts`（安全，core 纯逻辑壳分离）、`subagent/`（子代理派生）天然是三个不相交的 scope，可派三个 executor 并行开发，再由 critic 审 diff（CHANGELOG v0.1.0 记载"多模块并行开发"即此场景）。
- **关键纪律**：任务卡的 `scope`（可写路径列表）必须互不相交，这是**防写冲突的唯一手段**——子代理间不直连，写同一个文件必然产生脏合并。

### 1.2 评审模式

- **触发条件**：方案/设计/代码评审，**输入材料小**（这是它能满编的前提——材料小则重叠税低）。
- **角色编排**：`3 个满编`：analyst（只读分析）/ critic（对抗挑错）/ devil（K3 跨家族挑战前提）。流程三阶段：**Round 1 各角色并行开火 → Round 2 交叉质询（观点互喂再评）→ Round 3 captain 裁决收敛**（见 `REVIEW_PROMPT` 原文）。产出**零可执行终稿**：分 Phase、每 Phase 带验证与回滚、无未裁决开放问题或已显式移交用户。
- **自动升降级**（captain 在开场白中明示分配与理由）：机械检查类维度（格式、字段完整性、清单核对）保持 flash 子模型；高难度判断/关键架构决策/flash 首轮质量不足时升级为 captain（K3）亲审。
- **真实示例（本仓库）**：`examples/demo-review/c.py` 就是 README 演示的评审对象：

  ```python
  def calc(a, b, op):
      if op == "add":
          return a + b
      elif op == "div":
          return a / b
      else:
          return None

  def main():
      data = [1, 2, 3, "4", 5]
      total = 0
      for x in data:
          total += x
      print(calc(total, 0, "div"))

  main()
  ```

  派 analyst + critic 并行审查的预期产出：`c.py:13` 的 `calc(total, 0, "div")` 除零必崩（Python 浮点除零抛 `ZeroDivisionError`）；`c.py:9-11` 的 `data` 含字符串 `"4"`，`total += x` 在循环中途抛 `TypeError`。两个都是 critic 该抓的"必崩 bug"，且都有 `文件:行号` 证据。

### 1.3 调研模式

- **触发条件**：外部主题、需要多角度信息的任务（技术选型、生态调研、竞品分析）。
- **角色编排**：`2-3 个 analyst 分角度`（每个 analyst 认领一个角度，互不重叠）→ `critic 查缺`（找漏掉的角度和盲点）→ captain 综合裁决。
- **适用场景**：CHANGELOG 路线图里的"pi packages 原生分发方案调研"、"GitHub Actions CI 选型"这类开放问题。
- **拆片示范（基于仓库真实文件的示范）**：调研"如何给 pi-moa 加 GitHub Actions CI"，可拆为：analyst A 调研"测试与 lint 工具链（vitest + 现有 39 项单测如何进 CI）"、analyst B 调研"发布产物（`install.sh` 的目录化安装如何打包）"、analyst C 调研"覆盖率门槛（`core.ts` 100% 覆盖率如何守）"。三个角度都只读仓库不同文件：`test/`、`scripts/`、`extensions/scope-guard/core.ts`。
- **关键纪律**：角度划分 = scope 划分（这里的 scope 是"读哪些文件、回答哪个问题"）。角度重叠 = 重叠税。

### 1.4 写作模式

- **触发条件**：起草/改写长文（README、文档、博客、评审意见汇总），**不涉及并行写文件**。
- **角色编排**：`1 个 executor 起草`（把大段产出写入文件，结果卡只放路径和结论）→ `1 个 critic 挑刺`（查逻辑漏洞、结构问题、事实错误）→ captain 定稿。
- **适用场景**：README 提到 `docs/README.en.md（WIP）`——这就是一个写作模式的天然任务卡：executor 起草英文版、critic 挑刺术语与结构、captain 定稿。
- **为什么只要 1+1？** 写作的"分工收益"很低——多人各写一段再拼接，风格和术语必然打架；而"起草 + 对抗审查"是写作场景成本最低的高质量配置。**写作模式是 5 模式里并行度最低的**，这是刻意的：省下的钱花在 critic 的挑刺上。

### 1.5 默认模式（兜底）

- **触发条件**：任务不在前三类的明确射程内，或拿不准属于哪类。
- **角色编排**：两条路二选一——
  1. **拿不准**：先派 `1 个 analyst 探测`（只读、低成本、产出"这任务属于哪类 + 建议怎么拆"），探测完再定模式。
  2. **高重叠阅读类**（全文档审计/全景勘察）：**0-1 个**——captain 自己单跑，或"一读多评"：`1 个 analyst 通读`产出摘要黑板，critic/devil 基于摘要 + 定向抽查，**禁止重复全读**（防重叠税）。
- **适用场景**："审计 docs/ 目录所有文档的一致性"这类任务——让 3 个子模型各读一遍全部文档是灾难（重叠税爆表），正确做法是 1 个 analyst 通读产出摘要，critic 只抽查。
- **真实示例（本仓库）**：本文档（`docs/playbooks.md`）本身由"1 个 executor 通读全部源文件后撰写"（对应高重叠阅读类的单跑/一读多评），产出单文件，无需 fan-out。

---

## 2. 如何写新角色

角色文件是放在 `~/.pi/agent/agents/`（或项目 `.pi/agents/`）下的 markdown，`extensions/subagent/agents.ts` 会解析 frontmatter 并用 body 作为 system prompt 启动独立 `pi` 进程。

### 2.1 frontmatter 字段

以 [`agents/analyst.md`](../agents/analyst.md) 为实例：

```markdown
---
version: 1.0-2026-08-05
name: analyst
description: 分析者。只读分析代码、方案或主题，产出结构化分析结论。不改任何文件。
tools: read, grep, find, ls, bash
model: deepseek/deepseek-v4-flash
---
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 角色名，captain 派活时用。**唯一**，与文件同名最不易错 |
| `description` | ✅ | 一句话说明角色能干什么、不能干什么。subagent 工具列角色清单时直接展示，captain 靠它选角色 |
| `model` | 可选 | 模型标识（如 `deepseek/deepseek-v4-flash`、`kimi-coding/k3`）。**不写则继承主会话模型** |
| `tools` | 可选 | 逗号分隔的工具白名单。**权限收敛的关键字段**，见 §2.2 |
| `version` | 可选 | 建议带日期，黑板审计时能追溯角色版本 |

### 2.2 system prompt 写作技巧

**① 立场设定（最重要的开头）**

角色 prompt 的第一段必须定义"我是谁、我的价值来自什么"。对比本仓库两个同模型角色的写法：

- `agents/analyst.md`："你与执行者使用相同模型，因此你的价值来自**只读视角**与分析深度"（隐含：你不写代码，所以你的产出必须靠证据说服人）
- `agents/critic.md`："你与执行者/分析者使用相同模型，因此你的价值来自**对抗性立场**，不是同情理解"（隐含：默认被审查的产出有问题）

> 写新角色时问自己：**这个角色和现有角色模型相同，凭什么不混同？** 答案必须写进第一段。同模型角色靠立场差异化，跨模型角色（devil）靠异构差异化（`agents/devil.md`："其他角色可能在同一处犯系统性错误——你的存在就是为了抓这个"）。

**② 纪律条款（编号列表，每条是可执行的命令）**

- **只读/可写声明**：`agents/analyst.md` 第 1 条"只读：不修改、不创建任何文件"；`agents/executor.md` 第 1 条"严格在任务指定的 scope（可写路径列表）内工作，不碰范围外的任何文件"。这条必须和任务卡 scope、frontmatter `tools` 三方一致。
- **场景内例外**：analyst 写"bash 仅用于只读命令：git log/diff/show、grep、wc 等"——把"只读"从抽象原则变成可判定的命令清单。
- **能力边界声明**：纯文本模型角色必须写"图片/视觉内容无法处理，遇到立即 status=blocked，不要瞎猜"（executor 第 4 条、analyst 末条）。**这是防幻觉的硬闸**。

**③ 输出格式（结构化结果卡）**

每个角色末尾固定给出返回格式模板（见 `agents/` 四个文件的"返回格式"节）。角色专用字段要和立场呼应：

- analyst → `findings`（带 文件:行号） + `concerns`
- critic → `verdict: pass | pass_with_notes | fail` + `critical/warnings/blind_spots`
- devil → `premise_challenges`（挑战前提，不是细节）+ `systemic_risks`
- executor → `status: done | partial | blocked | handoff` + `artifacts`（产物路径）

**④ 体积纪律**

结果卡正文一律 **≤300 字**（模板见 `moa/templates/result-card.md`）。"大段产出（代码、长文）写入文件；返回内容里只放结论和路径"（executor 第 3 条）。原因：结果卡是 captain 聚合多个子模型产出的输入，卡越大 captain 上下文膨胀越快，多模型协同的经济性就没了。细节进文件、卡里只有索引。

**⑤ 防凑数条款**

- analyst："拿不准的一律标'存疑'，不许凑'真✅'"
- critic："找不到问题也要明说'未发现 N 类问题'，不许编造假问题凑数"
- devil："每个反对意见必须给出推理，不许为反而反"

这些条款直接对抗 LLM 的"讨好倾向"（不敢说不知道）和"表演倾向"（没事找事），是抽查机制之外的第二道质量闸。

### 2.3 完整新角色示例：translator

放在 `~/.pi/agent/agents/translator.md`（或仓库 `agents/translator.md` 供项目内使用）：

```markdown
---
version: 1.0-2026-08-05
name: translator
description: 译者。在限定文件内做中英互译，术语与 glossary 严格一致，代码与路径原样保留。可写。
tools: read, edit, write, grep, find, ls
model: deepseek/deepseek-v4-flash
---

你是 pi-moa 协作系统中的译者（translator），由调度器（Kimi K3）分派一个翻译分片。

## 立场设定
- 你的读者是开源贡献者：准确优先于文采，术语必须与 glossary 一致
- 不"润色"原文逻辑；发现原文错误时在 concerns 标注，不擅自改写
- 你的价值来自术语一致性：同词同译、全文可检索

## 工作纪律
1. 只翻译任务卡 scope 列出的文件，不碰其他任何文件
2. 先读 context_files（必须含 glossary/术语表）再动手
3. 代码块、路径、命令、frontmatter 字段、链接原样保留，一律不译
4. 译文结构与原文一一对应：标题层级、列表、表格、换行不变

## 术语纪律
- 专有名词（pi-moa、captain、executor、critic、scope、task card、result card、playbook）保留英文
- 术语表查不到的，首次出现附英文原文，如：调度矩阵（scheduling matrix）
- 拿不准的标"存疑"，不许硬译

## 返回格式（结果卡，≤300 字正文）
status: done | partial | blocked
summary: 翻译了哪些文件/段落
artifacts: [改动文件路径列表]
concerns: [原文疑点/术语存疑处，无则写"无"]
```

对照 §2.2 检查这个示例：① 立场明确（准确优先、术语一致性）；② 纪律可判定（scope 边界 + 术语表强制 + 不译清单）；③ 结构化输出；④ 结果卡 ≤300 字；⑤ 防凑数（"存疑"条款）。tools 只给了 read/edit/write/grep/find/ls，**没有 bash**——译者不需要执行命令，这就是权限收敛。

> 注意：任务卡通过 `context_files` 给 glossary 路径，captain 每次派活都要带上；角色 prompt 只声明"必须读"，不写死路径（角色是通用的，路径是任务级的）。

---

## 3. 如何写新模式

模式不是一个独立文件，而是三件事的组合：**任务卡设计规范 + 调度决策（并行/链式）+ 重叠度评估**。它们通过 `extensions/subagent/` 工具的 `single / parallel / chain` 三种模式落地（源码见 `extensions/subagent/index.ts`，其中 `chain` 支持 `{previous}` 占位符串接上一步输出）。

### 3.1 任务卡设计

任务卡是 captain → 子模型的唯一输入，模板见 [`moa/templates/task-card.md`](../moa/templates/task-card.md)：

```yaml
task_card:
  goal: 一句话目标
  scope: [可写路径列表]          # 写权限边界，多子模型时互不相交
  context_files: [需读路径]      # 不给全量历史，只给相关文件
  output: 结果卡要求（≤300字正文，落盘路径）
  playbook: 编码|评审|调研|写作|默认
  deadline_hint: 预计规模（分钟）
```

**scope 划分原则（三条铁律）：**

1. **互不相交（disjoint）**：多 executor 并行时，各自 `scope` 的写路径集合必须为空交集。参考仓库实例：编码模式下 `extensions/moa-mode.ts` / `extensions/scope-guard/` / `extensions/subagent/` 三个 scope 天然不相交。若两个分片必须碰同一个文件，说明拆片错误——要么合并成一个分片，要么改成"只读共享 + 单一写入者"，要么串行。
2. **scope 是写权限，不是读权限**：executor 只在 scope 内写，但可以读 scope 外的文件（`context_files` 指定）。`extensions/scope-guard` 在物理层强制这条边界（`restrictToCwd` + `blockBashWritesOutsideCwd`，见 `moa/guard-policy.example.json`）——**写边界靠物理拦截，不靠 prompt 自觉**。
3. **scope 粒度匹配任务规模**：`deadline_hint` 估计 <10 分钟的任务根本不拆片（见 §4.4）；一个任务卡的目标必须能在一次子代理会话内完成。超过就再拆。

**防撞设计（写冲突以外的第二类碰撞）：**

- **读重叠**：多个子模型读同一份大材料 = 重叠税。防法见 §3.3 的"一读多评"。
- **结论冲突**：子代理间不直连，观点冲突全部上报 captain，由 captain 裁决（ORCHESTRATION_RULES 第 6 条："你始终掌握全部通讯：子代理间不直连，冲突由你裁决；拿不准的升级给用户"）。**任务卡里永远不要要求两个子模型互相协商**。
- **黑板命名冲突**：每个任务一个黑板目录 `.pi/moa/<任务名>/`，任务卡、结果卡、handoff 包落盘 `task.md / results/*.md / handoffs/*.md`，每个运行单元记录 `session_id / run_id / actor / 读写范围 / risk_level / outputs`（对齐任务卡模板的 `run_unit` 节）。文件名带 `run_id` 防覆盖。

### 3.2 何时并行、何时串行链式

判断依据只有一条：**后一步是否依赖前一步的输出？**

| 依赖关系 | 编排方式 | 工具形态 | 仓库实例 |
|---|---|---|---|
| 无依赖，scope 不相交 | **并行** | `subagent` parallel | 编码模式 2-3 executor；调研模式 2-3 analyst 分角度 |
| 无依赖，材料小，需对抗 | **并行 + 多轮** | parallel + 观点互喂 | 评审模式 Round 1 并行 → Round 2 交叉质询 |
| 有依赖（后步要前步产物） | **串行链式** | `subagent` chain（`{previous}` 占位符） | 写作模式 executor 起草 → critic 挑刺；"一读多评" analyst 摘要 → critic 基于摘要抽查 |
| 依赖 + 需要断点接手 | **链式 + handoff** | chain 中断 → handoff 包 → captain 接手 | executor 返回 `status=handoff` 时（§4.3） |

经验法则：

- **并行省时间，链式省 token**。并行 = 多个上下文同时计费；链式 = 每一步都只带前一步的摘要（`{previous}`），上下文小。
- **评审的"多轮"是串行套并行**：Round 1 各角色并行（互不依赖），Round 2 把 Round 1 结果互喂再评（串行依赖），Round 3 captain 裁决。这是唯一推荐三轮以上的场景，因为评审价值随对抗轮数上升。
- **能串成摘要就不传全文**：链式传递时用 `{previous}` 传上一步的结果卡/摘要，不是传它读过的文件。这就是"一读多评"的技术实现。

### 3.3 重叠度评估方法

拆片前问三个问题（对应 ORCHESTRATION_RULES 第 2 条"拆片前先评估重叠度"）：

1. **有多少子模型必须读同一份大材料？** 若答案是"全部"（全文档审计、全景勘察），重叠税 = 材料大小 × 子模型数，直接触发降级：0-1 个。
2. **材料能不能先浓缩成摘要？** 能 → 用"一读多评"：1 个 analyst 通读产出摘要黑板 → critic/devil 基于摘要 + 定向抽查（抽查点由 captain 在任务卡里指定）。
3. **不同子模型读的材料能不能按角度切分？** 能 → 把"角度"写进各自的 `context_files`，让它们读**不同的**文件集（调研模式的核心手法：analyst A 读 `test/`、analyst B 读 `scripts/`、analyst C 读 `extensions/scope-guard/core.ts`，谁也不重复读谁）。

一个可量化的判断：**若两份任务卡的 `context_files` 交集超过 50%，且材料 > 200 行，就该考虑降级或一读多评。**

---

## 4. 最佳实践 10 条

**4.1 实证纪律（铁律）**

git 提交说明、代码注释、文档里的"验证通过"字样**一律不算实证**（ORCHESTRATION_RULES 第 4 条 + `agents/analyst.md`）。必须验证代码/SQL/配置本体并给出 `文件:行号`。为什么：注释和 commit message 是"声明"，代码本体才是"事实"——子模型会顺手引用注释当证据，captain 要把它打回去。

**4.2 抽查配合**

captain 对子模型结果卡中的关键实证（文件:行号、数据、结论）做**风险导向抽查 10-30%**，亲自复核原文（ORCHESTRATION_RULES 第 5 条）。必抽项：全过/无异常类结论、安全相关结论、影响后续决策的关键判断。发现一处造假/误判 → 该子模型本次产出全量复核 + 黑板记录误判事件（供 navigator 统计角色可信度）。抽查结果写入终稿（"已抽查 N 项，复核率 X%"），未抽查的结论标注"未经复核"。**抽查不是不信任，是让结果卡有价。**

**4.3 dead_ends 写法（handoff 包最值钱的部分）**

`moa/templates/result-card.md` 里 handoff 包的 `dead_ends` 注释写着"最值钱的部分"。好的 dead_ends 长这样：

```yaml
dead_ends:
  - 尝试过用正则解析嵌套括号 → 状态机爆炸，放弃（README.md 无嵌套结构，用简单 split 即可）
  - 尝试过 git blame 定位回归 → 仓库只有 1 个提交，信息不足
```

坏的 dead_ends：`- 试了不行`（没写试了什么、为什么不行）。dead_ends 的价值在于**防止下一个接手者（captain 或下一个子模型）重复踩同一个坑**——它把"试错成本"变成可继承的资产。

**4.4 何时不派活**

- 预计 <10 分钟的小任务：captain 直接自己完成（ORCHESTRATION_RULES 第 1 条）。派活有固定开销（建黑板、写任务卡、起进程、聚合结果），小任务派活是负收益。
- 图片/视觉步骤：永远 captain 自己做（子模型纯文本，见反模式 5）。
- 高重叠大材料：0-1 个，自己单跑或一读多评。
- 需要用户拍板的开放问题：不派给子模型，直接升级给用户（ORCHESTRATION_RULES 第 6 条）。

**4.5 成本意识**

- 任务卡 `run_unit` 节强制记录 `tokens_by_model`（`{model: {input, output}}`）、`cost_actual`、`cost_single_model_baseline`（同任务全 K3 估算值）——这些是 navigator 成本基线的原料，**不记录就没有对比**。
- 机械检查类维度保持 flash 子模型，高难度判断升级 K3 亲审（`REVIEW_PROMPT` 的自动升降级）——把旗舰 token 花在裁决上，不花在格式检查上。
- 写作/高重叠任务主动降并行度（§1.4、§1.5）：省钱本身就是模式设计目标。

**4.6 任务卡最小化**

`context_files` 只给相关文件，**不给全量历史**（任务卡模板注释："不给全量历史，只给相关文件"）。子模型上下文是独立窗口，塞无关历史 = 烧钱 + 稀释注意力。captain 认领 ≤40% 工作量，把重活交出去。

**4.7 结果卡体积纪律**

结果卡正文 ≤300 字，细节落盘文件，卡里只有索引（`artifacts` 路径）。检查方法：如果 captain 要聚合 3 张结果卡，每张 300 字是 900 字，可控；每张 2000 字就是灾难。

**4.8 黑板全程留痕**

每个任务先建 `.pi/moa/<任务名>/`，task.md / results/*.md / handoffs/*.md 全部落盘，运行单元记录 session/run/actor/读写范围/risk_level（任务卡模板 `run_unit`）。留痕的三个消费者：captain 断点接手、navigator 异步审计、用户复盘。`.gitignore` 自动登记 `.pi/moa/`（`moa-mode.ts` 的 `ensureBlackboard`）。

**4.9 拿不准先探测**

任务类型判断不准时，先派 1 个 analyst 探测（只读、便宜、产出"这任务属于哪类 + 怎么拆"），再决定模式（ORCHESTRATION_RULES 第 2 条末行）。探测的成本是 1 个子模型的几分之一，换来的是不跑偏的编排。

**4.10 角色权限收敛**

frontmatter `tools` 字段按需最小化：analyst/critic/devil 只给只读工具 + bash（仅限只读命令），executor 才给 edit/write；新角色示例 translator 干脆不给 bash（§2.3）。**prompt 里的"只读"是意愿，tools 白名单是能力，scope-guard 是物理边界——三层都要收敛。** 权限收敛的另一面是"角色职责收敛"：analyst 只分析不修改、critic 只挑错不改代码、executor 只做分片内的事，跨职责行动都是越权。

---

## 5. 反模式 5 条

**5.1 高重叠 fan-out（最大的钱坑）**

把"审计 10 个文档文件"这类任务拆给 3 个子模型各读一遍全部材料。重叠税 = 材料大小 × 3，结果 3 张几乎一样的摘要卡。**解法**：§3.3 的三问评估 → 一读多评或自己单跑。判断信号：你发现自己在给每份任务卡贴同一串 `context_files`。

**5.2 全信结果卡（质量崩塌之源）**

captain 收了结果卡直接进终稿，不做任何抽查。子模型是便宜模型 + 独立上下文，它的"done"不等于事实——`examples/demo-review/c.py` 这类 bug 不会被它自己发现（它又没跑代码）。**解法**：§4.2 抽查机制是强制项，不是可选项；抽查记录进终稿。

**5.3 超大任务卡**

一个任务卡塞了三个目标："重构 A 模块 + 修 B 的 bug + 更新 C 的文档"。后果：子模型上下文爆炸、scope 无法收敛、blocked/handoff 概率飙升、结果卡不可信。**解法**：任务卡单目标；超 10 分钟继续拆；每个分片都能独立验证。

**5.4 角色权限不收敛**

给只读角色加了 write 工具，或角色 prompt 里写"只读"但 tools 列表给了 bash 全量。后果：scope-guard 的 `blockBashWritesOutsideCwd` 只拦路径不拦意图，权限敞开的角色会"顺手修一下"。**解法**：§4.10 三层收敛——prompt 声明 + tools 白名单 + scope-guard 物理拦截，缺一不可。检查方法：每个角色的 tools 列表里，每多一个工具都要能说清"哪个纪律条款需要它"。

**5.5 图片喂纯文本模型**

把截图、架构图、UI 稿丢给 executor/analyst/critic（都是 `deepseek-v4-flash` 纯文本模型）。它们不会报 blocked，而是会"看图说话"编造内容——这正是幻觉的高发场景。**解法**：图片/视觉任务永远 captain 自己做；或交给唯一的多模态角色 devil（`agents/devil.md`："你可以看图片：任务含截图/架构图时，视觉审查由你负责"）。角色 prompt 里的"遇到图片立即 blocked"条款 + captain 的分流纪律，两条都要。

---

## 附：新模式的落地检查清单

写完一个模式（或改完一个角色）后，逐条自查：

- [ ] 任务卡 scope 在并行场景下互不相交？
- [ ] 每个角色的 tools 白名单与纪律条款一致？
- [ ] 纯文本角色都写了"图片立即 blocked"？
- [ ] 结果卡 ≤300 字，细节走 `artifacts` 落盘？
- [ ] 子模型间零直连，冲突全部上报 captain？
- [ ] `tokens_by_model` / `cost_actual` 在 run_unit 里记录？
- [ ] 高重叠材料走了"一读多评"或单跑？
- [ ] 拿不准的任务先探测再编排？

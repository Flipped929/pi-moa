# pi-moa 配置参考手册

本文档是 pi-moa 的**字段级**配置手册：所有字段名、默认值与源码（`install.sh`、`agents/*.md`、`extensions/scope-guard/core.ts`、`extensions/moa-mode.ts`、`extensions/subagent/agents.ts`）逐字一致。建议搭配 [architecture.md](architecture.md) 阅读。

---

## 1. 安装与卸载

### 1.1 前置条件

| 条件 | 说明 |
|---|---|
| pi CLI | `command -v pi` 必须可用，否则 install.sh 直接退出（exit 1） |
| 模型 provider | 任一 provider 已在 pi 中配好（API key / baseURL），roster 里引用的模型真实存在 |
| 磁盘权限 | 对目标目录 `~/.pi/agent` 有写权限 |

### 1.2 install.sh 行为详解

```
用法: ./install.sh          # 幂等，可反复执行
目标: ${PI_AGENT_DIR:-$HOME/.pi/agent}      （下文简称 $PI_DIR）
```

| 步骤 | 动作 | 覆盖策略 |
|---|---|---|
| 1. 扩展 | `$PI_DIR/extensions/moa-mode.ts` 复制 | 已有文件先备份 `*.bak-<时间戳>` |
| 1a. 扩展 | 删除旧版平铺 `$PI_DIR/extensions/scope-guard.ts` | **直接删除**（v3 起为目录结构，避免双加载） |
| 1b. 扩展 | `$PI_DIR/extensions/scope-guard/{index,core}.ts` 复制 | 逐个备份后覆盖 |
| 1c. 扩展 | `$PI_DIR/extensions/subagent/{index,agents}.ts` 复制 | 逐个备份后覆盖 |
| 2. 角色 | `$SRC/agents/*.md` → `$PI_DIR/agents/` | 逐个备份后覆盖 |
| 3a. 模板 | `$SRC/moa/templates/*.md` → `$PI_DIR/moa/templates/` | **直接覆盖，不备份** |
| 3b. 策略 | `guard-policy.example.json` → `$PI_DIR/moa/guard-policy.json` | **仅当目标不存在时创建，绝不覆盖已有策略** |

要点：

- **幂等**：重复执行安全；每次执行都会重新备份当前版本，备份文件格式为 `文件名.bak-YYYYMMDD-HHMMSS`。
- **不覆盖策略**：`guard-policy.json` 只在缺失时从 example 生成一次。你的自定义策略永远不会被 install.sh 冲掉。
- **清理旧版**：v3 之前的 scope-guard 是单个平铺文件 `extensions/scope-guard.ts`，与目录版共存会导致钩子双注册、策略双加载，install.sh 会主动 `rm -f` 它。
- 备份文件不会自动清理，如需回收可手动删除 `*.bak-*`。

### 1.3 PI_AGENT_DIR 自定义安装目录

```bash
PI_AGENT_DIR=$HOME/.config/my-pi-agent ./install.sh
```

- 所有扩展 / 角色 / 模板 / 策略都装到该目录，结构与默认一致。
- ⚠️ 两个**硬编码**不受 `PI_AGENT_DIR` 影响（见 FAQ F2/F4）：
  - scope-guard 运行时读策略的路径固定为 `~/.pi/agent/moa/guard-policy.json`；
  - `/moa status` 的角色在线检查固定读 `~/.pi/agent/agents/`。
  - 使用自定义目录时，需手动把 `guard-policy.json` 与 `agents/` 同步到 `~/.pi/agent/` 下，否则策略回退内建默认、roster 显示 ❌。

### 1.4 uninstall.sh 行为详解

```
用法: ./uninstall.sh
目标: ${PI_AGENT_DIR:-$HOME/.pi/agent}
```

| 移除 | 保留 |
|---|---|
| `extensions/moa-mode.ts`、`extensions/scope-guard.ts`（旧平铺） | `$PI_DIR/moa/`（guard-policy.json 策略 + templates 模板） |
| `extensions/scope-guard/`、`extensions/subagent/` | 各项目 `.pi/moa/` 任务记录中记录 |
| `agents/{executor,analyst,critic,devil}.md` | `*.bak-*` 备份文件 |

卸载**有意保留**策略、模板与任务记录数据（审计留痕），需彻底清理请手动删除。

> 注意：uninstall.sh 的角色删除列表目前为 `{executor,analyst,critic,devil}`，暂未包含新增的 `executor-k3`；卸载后需手动删除 `$PI_DIR/agents/executor-k3.md`（待上游同步）。

---

## 2. 模型 roster 配置

### 2.1 默认 roster

| 角色 | 文件 | 默认 model | 定位 |
|---|---|---|---|
| captain | *（pi 主会话本身，无 agent 文件）* | 主会话当前模型（示例环境为 kimi-k3） | 调度 / 裁决 / 最难切片，≤40% 工作量 |
| executor | `agents/executor.md` | `deepseek/deepseek-v4-flash` | 真实执行切片，限定域可写 |
| executor-k3 | `agents/executor-k3.md` | `kimi-coding/k3` | K3 高能力执行档，主领设计型/高难度分片 |
| analyst | `agents/analyst.md` | `deepseek/deepseek-v4-flash` | 只读分析，实证纪律 |
| critic | `agents/critic.md` | `deepseek/deepseek-v4-flash` | 对抗审查，挑错为唯一目标 |
| devil | `agents/devil.md` | `kimi-coding/k3` | 跨家族异构魔鬼代言人，可看图片 |

角色文件安装位置：`~/.pi/agent/agents/*.md`（用户级）；项目级见 2.3。

### 2.2 frontmatter 全字段

`subagent/agents.ts` 用 `parseFrontmatter` 解析，**字段值一律为字符串**：

| 字段 | 必填 | 类型 | 说明 | 解析规则 |
|---|---|---|---|---|
| `name` | ✅ | string | 角色名，subagent 工具按此查找 | 缺失则整个文件被跳过 |
| `description` | ✅ | string | 角色说明 | 缺失则整个文件被跳过 |
| `tools` | 可选 | string（逗号分隔） | 允许的工具白名单 | `split(",")` → trim → 过滤空串；空则不加 `--tools` 参数（用默认） |
| `model` | 可选 | string | 模型标识 `provider/model-id` | 传给子进程 `--model`；缺失则用 pi 默认模型 |
| `version` | 可选 | string | 版本/日期标记，**纯信息字段，解析器不消费** | 无 |

示例（`agents/executor.md` 原文）：

```markdown
---
version: 1.0-2026-08-05
name: executor
description: 任务执行者。认领一个边界明确的任务分片并真实完成它（写代码、改文件、跑命令）。输出结构化结果卡。
tools: read, edit, write, grep, find, ls, bash
model: deepseek/deepseek-v4-flash
---
```

`tools` 里的工具名必须与 pi 实际工具名一致（`read/edit/write/grep/find/ls/bash`）。executor 的 bash 写权限受 scope-guard 防线 2 限制（见 §3.5）。

### 2.3 换成 Claude / GPT / 本地模型

`model:` 字段填 pi 已配置好的 provider 模型标识即可，架构不绑定厂商：

```markdown
# 换成 Claude（anthropic provider）
model: anthropic/claude-sonnet-4-5

# 换成 GPT（openai provider）
model: openai/gpt-4o-mini

# 换成本地模型（如 Ollama / vLLM 起的 OpenAI 兼容端点）
model: ollama/qwen2.5-coder-14b
```

- 项目级角色：在项目根 `<项目>/.pi/agents/*.md`（pi 的 `CONFIG_DIR_NAME` 默认 `.pi`）放同名文件，subagent 工具加 `agentScope: "both"`（或 `"project"`）即可同时发现两级角色；项目级与用户级重名时项目级覆盖。
- 项目级角色首次执行会弹确认框（`confirmProjectAgents`，默认 true），只信任的仓库再放行。

### 2.4 三档模型选择建议

| 档位 | 角色 | 要求 | 理由 |
|---|---|---|---|
| **强 + 长上下文** | captain | 你手里最强的模型，上下文窗口越大越好 | 要读全部结果卡 / handoff 包做裁决；长会话不易撞上下文墙 |
| **跨家族异构** | devil | 与执行层**不同厂商/家族**的模型 | MoA 靠真异构才有效：同家族模型会在同一处犯系统性错误；devil 的存在就是抓这个盲区 |
| **便宜快** | executor / analyst / critic | 延迟低、单价低，够用即可 | 占任务量 60%+ 的搜索/机械修改/格式化不值得旗舰模型跑；critic 与执行层同模型时靠对抗 prompt 补位 |

其他硬规则：

- **含图任务永远走多模态**：子模型纯文本（图片/视觉一律 `status=blocked` 上报或 devil 审查），视觉步骤 captain 自己做或派 devil。
- 三档模型建议同步更新 `ORCHESTRATION_RULES` 中 `agentRoster()` 的检查——不过 roster 只检查文件存在性，不校验 model 字段。

---

## 3. guard-policy.json 全字段参考

### 3.1 文件位置与加载

- 运行时策略路径：**固定** `~/.pi/agent/moa/guard-policy.json`（`scope-guard/index.ts` 硬编码，不受 PI_AGENT_DIR 影响）。
- 安装时由 install.sh 从 `moa/guard-policy.example.json` 生成（仅首次）。
- 加载时机：扩展启动时 `loadPolicy()` 读取一次，**改动需重启 pi 会话生效**。
- 文件缺失 / JSON 解析失败：静默回退内建默认 `defaultPolicy()`。

### 3.2 顶层字段

| 字段 | 类型 | 默认值（内建） | 示例值（example） | 语义 |
|---|---|---|---|---|
| `version` | string | `"builtin-default"` | `"1.0-example"` | 策略版本标识，不参与逻辑 |
| `protectedExact` | string[] | `["~/.pi/agent/auth.json", "~/.pi/agent/models.json"]` | `["~/.pi/agent/auth.json", "~/.config/your-shell/secrets.env"]` | 精确匹配的受保护路径（可 `~/` 展开） |
| `protectedParts` | string[] | `["/.ssh/", "/.gnupg/", "/.aws/", "/.git/", "/.env"]` | 同左 | 路径**包含**任一片段即受保护（子串匹配） |
| `subagent` | object | 见 3.4 | 见 3.4 | 子代理写权限边界 |
| `pii` | object | 见 3.5 | 见 3.5 | 出网 PII 检查 |
| `budget` | object | 见 3.6 | 见 3.6 | 会话 token 预算告警 |

### 3.3 合并语义（mergePolicy）

用户策略与内建默认的合并规则（`core.ts`）：

| 字段 | 合并方式 |
|---|---|
| `version` | 用户提供则用用户值，否则 `"custom"` |
| `protectedExact` / `protectedParts` | **数组整体替换**（写空数组 `[]` = 清空内建，仅剩你自己的规则） |
| `subagent` / `budget` | 子对象**深合并**（未写字段继承内建默认） |
| `pii` | 深合并；`pii.patterns` 特殊：**与内建默认合并而非覆盖**（新增 pattern 追加，不改动内建） |

```jsonc
// 示例：只关掉子代理 bash 拦截，其余全继承内建
{ "subagent": { "blockBashWritesOutsideCwd": false } }
```

### 3.4 ~ 展开与路径规范化（core.ts）

| 规则 | 行为 | 例子 |
|---|---|---|
| `expandHome` | 仅 `~/` 前缀展开为主目录 | `~/.pi/agent/auth.json` → `~（展开为你的主目录）/.pi/agent/auth.json` |
| `expandHome` | 单独 `~`、`~other/x` **不展开** | `~other/x` 原样保留（匹配不到，相当于无效条目） |
| `normalizePath` | 反斜杠转正、压缩重复 `/`、去尾部 `/`（根目录除外） | `C:\a\b` → `C:/a/b`；`/a//b/` → `/a/b` |
| `isProtectedPath` | 规范化后与 `protectedExact` 精确比较，或包含任一 `protectedParts` 片段 | `/work/proj/.env` 命中 `/.env/`；`/work/envy.ts` 不命中（需前面有 `/`） |
| `isOutsideCwd` | `abs === cwd` 或 `abs.startsWith(cwd + "/")` 为界内 | `/work/shop/x` 在 `/work` 内；`/workshop/x` 不在 |

### 3.5 subagent 子对象

| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `restrictToCwd` | boolean | `true` | 子代理 `write`/`edit` 越出工作目录 → 物理拦截 |
| `blockBashWritesOutsideCwd` | boolean | `true` | 子代理 `bash` 命令的写入目标（`>`/`>>` 重定向、`tee`，支持引号包裹路径）越界或命中受保护路径 → 物理拦截 |

拦截时返回的 reason 固定附加提示：*"此限制不可逾越：不要重试、不要换路径绕过、不要用其他工具代替，直接在结果中上报 blocked。"*

注意：**受保护路径的 write/edit 拦截对主会话同样生效**（防线 1 不分主/子）；越界拦截只针对子代理（`PI_MOA_SUBAGENT=1` 进程）。

### 3.6 pii 子对象

| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `enabled` | boolean | `true` | 是否开启出网 payload 检查（`before_provider_request` 钩子） |
| `action` | `"redact" \| "warn"` | `"redact"` | redact=打码后发出；warn=仅告警不修改 payload |
| `patterns` | Record<string, string> | 内建 6 条，见下 | 命名正则表，**与内建合并** |

内建 `DEFAULT_PII_PATTERNS`（`core.ts`）：

| pattern 名 | 正则 |
|---|---|
| `generic_api_key` | `(?<![A-Za-z0-9])sk-[A-Za-z0-9_\-]{16,}` |
| `anthropic_key` | `(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_\-]{16,}` |
| `aws_access_key` | `(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}` |
| `github_token` | `(?<![A-Za-z0-9])(ghp\|gho\|ghu\|ghs\|ghr)_[A-Za-z0-9]{20,}` |
| `slack_token` | `(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9\-]{10,}` |
| `private_key_block` | `-----BEGIN [A-Z ]*PRIVATE KEY-----` |

占位符：`***REDACTED-BY-SCOPE-GUARD***`。redact 后若 JSON 反序列化失败（如 payload 结构被破坏），**放弃打码、仅保留告警**，不拦截请求。

**自定义 pattern 教程**（追加式，不会覆盖内建）：

```json
{
  "pii": {
    "patterns": {
      "your_company_key_prefix": "yourco-[A-Za-z0-9]{20,}"
    }
  }
}
```

正则写法建议：

1. 用 `(?<![A-Za-z0-9])` 负向后行断言防嵌套误报（避免 `task-abcdefgh` 命中 `sk-` 系）。
2. 只对**足够长的特征串**做匹配（16+ 位），短串误报率高。
3. 想关闭某条内建 pattern：无法删除，只能把 `action` 改为 `"warn"`，或改该 pattern 名为不重复键（同键名会覆盖内建值）。

### 3.7 budget 子对象

| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `sessionTokenWarnAt` | number | `0` | 累计 assistant `usage.totalTokens` 达到阈值时告警一次；**`0` = 关闭**；`> 0` 才注册 `message_end` 监听 |

告警只触发**一次**（`BudgetTracker.fired`），不会反复刷屏。

### 3.8 四道防线速查（index.ts 事件绑定）

| 防线 | 事件 | 触发条件 | 动作 |
|---|---|---|---|
| 1 | `tool_call`（write/edit） | 目标路径受保护 | block + 告警 |
| 2a | `tool_call`（write/edit） | 子代理 + `restrictToCwd` + 越界 | block + 告警（任务记录结果卡例外：`isMoaBoardWriteAllowed` 放行，见 3.9） |
| 2b | `tool_call`（bash） | 子代理 + `blockBashWritesOutsideCwd` + 写入目标越界/受保护 | block + 告警 |
| 3 | `before_provider_request` | `pii.enabled` + payload 命中 pattern | redact 或 warn |
| 预算 | `message_end` | `sessionTokenWarnAt > 0` 且累计达标 | 一次性告警 |

### 3.9 任务记录写放行（isMoaBoardWriteAllowed，硬编码，非 guard-policy 字段）

> 用户裁决 2026-08-05：子代理可写 cwd 之外的任务记录路径（防线 2a write/edit 的例外；**bash 写入不放行**——强制走 write/edit 留痕路径），但**文件名必须含自身 actor 名**——单写者 + 归属记录。

- 实现：`extensions/scope-guard/core.ts` 的 `isMoaBoardWriteAllowed(absPath, agentName)`，纯函数可单测；`index.ts` 在防线 2 拦截前调用：`isMoaBoardWriteAllowed(abs, process.env.PI_MOA_AGENT)`。
- 规则：路径包含 `/.pi/moa/` **且**文件名（basename，忽略大小写）包含 `agentName` → 放行；否则按防线 2 正常拦截。
- `agentName` 来源：subagent 工具 spawn 子进程时注入的环境变量 `PI_MOA_AGENT`（`extensions/subagent/index.ts`），值等于对应 `agents/*.md` 的 `name`（如 `critic`）。
- 结果：结果卡文件名必须形如 `results/xx-<actor>.md`（如 `R1-critic.md`）。共享文件 `task.md` / `final.md` / `NAVIGATOR.md` / `COMMIT-LEDGER.md` 天然不含 actor 名 → 子代理不可写，仅 captain（主会话，不受子代理限制）可写。
- 已知边界：子串匹配——`executor` 也能写 `r1-executor-k3.md`（`executor` 是 `executor-k3` 的子串），反向则不行。如需精确到角色全名，待上游收紧为边界匹配。
- 不可配置：此规则不读 guard-policy.json，属 core 硬编码；改行为需改源码。

---

## 4. /moa 命令与环境变量

### 4.1 命令全表（`moa-mode.ts`）

| 命令 | 行为 |
|---|---|
| `/moa on` | 开启协同模式；主会话中自动确保任务记录目录并登记 `.gitignore`；通知角色 roster 状态 |
| `/moa off` | 关闭协同，回到单模型模式（注入的调度规则在下一个主会话系统提示中移除） |
| `/moa status` | 显示开关状态、4 角色在线检查（✅/❌）、任务记录任务数；子代理进程中任务记录显示 `n/a` |
| `/moa review <主题>` | 评审模式快捷方式：自动开启协同 → 建任务记录 → 注入多角色多轮联合评审 prompt（主题为空则提示用法） |
| `/moa`（无参数或未知子命令） | 打印用法提示 |

### 4.2 快捷别名

| 别名 | 等价 |
|---|---|
| `/moa-on` | `/moa on` |
| `/moa-off` | `/moa off` |
| `/moa-status` | `/moa status` |
| `/moa-review <主题>` | `/moa review <主题>` |

### 4.3 环境变量

| 变量 | 取值 | 作用 |
|---|---|---|
| `PI_MOA_DEFAULT` | `"1"` | 启动即开启协同模式（`state.enabled = process.env.PI_MOA_DEFAULT === "1"`），测试/脚本用 |
| `PI_MOA_SUBAGENT` | `"1"` | **由 subagent 工具自动注入子进程**（`extensions/subagent/index.ts` spawn 时设置）。子代理进程据此：跳过调度规则注入（防套娃）、`/moa status` 任务记录显示 `n/a`、`/moa on` 不写 `.gitignore` |
| `PI_MOA_AGENT` | 角色名 | **由 subagent 工具自动注入子进程**（值 = agent 文件 `name`）。scope-guard 用它做任务记录写放行判定（§3.9）；`/moa status` 用它显示在跑子代理的角色 |

### 4.4 调度规则注入机制

- `pi.on("before_agent_start")`：`enabled` 且**非子代理**时，把 `ORCHESTRATION_RULES` 追加到系统提示。
- 防重复注入：系统提示已含 `[pi-moa 协同模式已开启` 标记则跳过。
- `session_start`：开启状态下主会话状态栏显示 `🐙 moa`。
- 注入内容要点：<10 分钟小任务不派活；调度矩阵（高重叠阅读 0-1 个 / 编码 2-3 并行 / 评审满编 3 / 调研 2-3 / 写作 1+1）；并行 ≤3；captain ≤40% 工作量；任务卡五要素；任务记录落盘约定；抽查 10-30% 与信任降级。

---

## 5. 任务记录目录结构

### 5.1 目录树

```
<项目根>/.pi/moa/               ← 任务记录根（自动创建）
├── <任务名>/                   ← 每个任务一个目录
│   ├── task.md                 ← 任务卡（goal/scope/context_files/output/… + run_unit 记录）
│   ├── results/                ← 子模型结果卡（每角色一个 .md，文件名含 actor 名单写者）
│   │   └── xx-<actor>.md        （如 R1-critic.md，见 §3.9）
│   └── handoffs/               ← handoff 包（status=handoff 时追加）
│       └── <role>.md
├── review-<日期>/              ← /moa review 专用
│   └── results/                ← 各角色产出 + tokens_by_model 成本记录
└── ...
```

### 5.2 文件含义

| 文件 | 来源 → 去向 | 内容 |
|---|---|---|
| `task.md` | captain → 子模型 | 模板 `moa/templates/task-card.md`：`task_card.goal/scope/context_files/output/playbook/deadline_hint` + `run_unit` 运行单元记录 |
| `results/*.md` | 子模型 → captain | 模板 `moa/templates/result-card.md`：`result_card.status/summary/artifacts/concerns`（≤300 字正文）。文件名须含 actor 名单写者（`xx-<actor>.md`，§3.9），否则 scope-guard 拦截 |
| `handoffs/*.md` | 子模型 → captain | `status=handoff` 时追加：`handoff_packet.suggest_next/what_done/current_state/dead_ends/open_question/artifacts`（dead_ends 死路清单最值钱）+ `usage.tokens_by_model/cost_actual` |
| 各文件头部 run_unit | 任务记录留痕 | `session_id / run_id / actor（角色@模型）/ workspace_scope / sandbox_profile / risk_level(G0-G3) / approval_ref / tokens_by_model / cost_actual / cost_single_model_baseline` |

`cost_single_model_baseline`：同任务全部用 captain 模型（如 K3）估算的成本，供 Navigator 做多模型 vs 单模型成本对比。

### 5.3 .gitignore 行为（moa-mode.ts ensureBlackboard）

- 触发点：`/moa on` 与 `/moa review`（主会话进程，子代理跳过）。
- 条件：项目根存在 `.git` 目录。
- 动作：读取项目 `.gitignore`，若没有精确行 `.pi/moa/` 则追加（文件末尾无换行时先补 `\n`），并提示 `.gitignore 已登记 .pi/moa/`。
- 目的：任务记录留痕不进版本库（G1 留痕：仅工作区内小动作）。
- 非 git 项目：不写 .gitignore，任务记录照常创建。
- 卸载不删任务记录；想清空记录直接删除对应 `.pi/moa/<任务名>/` 目录。

---

## 6. 常见问题 FAQ

**F1. 认证失败 / 模型 404（"model not found"）**
- `model:` 标识必须是 pi 已配置的 provider，格式 `provider/model-id`。核对 `~/.pi/agent/models.json` 或 pi 的模型列表，确认 provider 名称与模型 id 完全一致。
- 先在主会话直接引用该模型跑一次，排除 provider/API key 本身的问题。

**F2. /moa status 角色显示 ❌（角色不可见）**
- roster 检查**硬编码**读 `~/.pi/agent/agents/{executor,analyst,critic,devil}.md`，不认 `PI_AGENT_DIR`。用了自定义安装目录时需手动把 `agents/` 同步到 `~/.pi/agent/agents/`。
- 文件必须含 `name` 与 `description` frontmatter（缺任一即被 discover 跳过）。
- 改了 agents 文件后重启 pi 会话（agent 列表在启动/工具调用时发现）。

**F3. scope-guard 拦截误伤（合法路径被 block）**
- 检查 `protectedParts` 子串匹配：片段只要出现在路径中即命中，如 `/.git/` 会命中 `/project/.git-notes/` 之类的相似名——把误伤路径加入更精确的 `protectedExact` 无法豁免，需**移除/收窄**触发它的 parts 片段。
- 检查路径规范化：反斜杠、`//`、尾斜杠都会被归一化，`~/` 前缀才会展开（单独 `~` 不展开）。
- 防线 2 只拦子代理（`PI_MOA_SUBAGENT=1`）的越界写；主会话被拦只可能是防线 1（受保护路径）或 PII。

**F4. 策略不生效（改了 guard-policy.json 没反应）**
- 策略路径固定 `~/.pi/agent/moa/guard-policy.json`（不认 PI_AGENT_DIR）：自定义目录安装的，检查策略是否在正确位置。
- `loadPolicy()` 在扩展启动时执行一次，**改完必须重启 pi 会话**。
- JSON 解析失败会静默回退内建默认——先 `jq .` 验证文件合法性。
- 数组字段是整体替换、子对象是深合并、`pii.patterns` 是追加合并——确认你改的字段属于哪类合并语义。

**F5. PII 打码把请求搞坏了**
- `action: "redact"` 在 JSON 反序列化失败时会放弃打码仅告警（源码保证），若仍异常检查是否命中过于宽泛的自定义 pattern。
- 稳妥做法：先 `action: "warn"` 观察一段时间，确认 pattern 精准后再切 `redact`。
- 命中但不想打码的合法串，用负向后行断言（`(?<![A-Za-z0-9])`）或加长特征串规避。

**F6. 预算告警不触发**
- 默认 `sessionTokenWarnAt: 0` = 关闭。显式设 `> 0` 才注册监听，且只告警一次。
- 统计口径是 assistant 消息的 `usage.totalTokens` 累计值。

**F7. 子代理没用我配的 model**
- frontmatter 的 `model` 字段可选；缺失/拼写错误的 model 会被 pi 忽略而落到默认模型。核对 `provider/model-id` 格式与可用性。
- 同一 agent 名在项目级覆盖用户级时，模型也随项目级文件走。

**F8. 任务记录没建 / .gitignore 没登记**
- `ensureBlackboard` 只在 `/moa on` 和 `/moa review` 时执行，且子代理进程跳过——如果通过 `PI_MOA_DEFAULT=1` 自动开启，首次任务前先手动 `/moa on` 一次。
- `.gitignore` 登记仅限 git 仓库（存在 `.git`）；非 git 项目只建目录不写 ignore。

**F9. 子代理里出现了调度规则（规则套娃）**
- 正常路径下 subagent 工具 spawn 时会注入 `PI_MOA_SUBAGENT=1`，`before_agent_start` 据此跳过注入。
- 若你手动用 `pi -p` 之类方式派子进程而没设该变量，规则会被注入到子代理——手动派发时自行设置 `PI_MOA_SUBAGENT=1`。

**F10. scope-guard 行为异常（双加载嫌疑）**
- 若存在旧版平铺 `~/.pi/agent/extensions/scope-guard.ts` 且目录版并存，会双注册钩子、双份拦截提示。install.sh 会自动删除平铺版；手动安装/升级过的话自查 `ls ~/.pi/agent/extensions/`。

**F11. 卸载后还有残留**
- uninstall.sh 有意保留 `moa/`（策略+模板）与各项目任务记录。彻底清理：`rm -rf ~/.pi/agent/moa <项目>/.pi/moa`，备份文件 `*.bak-*` 一并删除。

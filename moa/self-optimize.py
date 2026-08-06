#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
self-optimize.py — pi-moa 双层自优化器（executor/DS 切片 OPT + OPTFIX 整改 2026-08-06）

层 1 样本自优化：从 NAVIGATOR.md instinct YAML（误判事件+已知高频坑）取教训，
  confidence>=0.5 的教训进入「待注入清单」（用户批准制），
  用户明确批准后 apply 才注入 agents/*.md 的 <!-- MOA-LESSONS:BEGIN/END --> 管理区
  （幂等：同 id 更新不重加，块外零改动）；<0.5 仅列报告。
层 2 架构运行分析（纯只读）：runs.jsonl 台账（成本架构/效率）+ 黑板结果卡扫描（能力画像）→
  只出建议不自动改，分【待批准注入】/【已批准注入】/【仅记录】/【需 captain 裁决】/【需用户裁决】。

模式（2026-08-06 用户裁决：写安全 + 用户批准制）：
  python3 self-optimize.py             # report（默认）：只读分析 + 报告 + 待注入清单（pending-injections.md），
                                       #   永不写 agents/*.md —— 未经用户批准不产生任何文件改动（对 agents 而言）
  python3 self-optimize.py apply       # apply：仅用户明确批准后调用；把 pending 清单写入 agents 管理区
                                       #   （写前逐文件 .bak-<时间戳> 备份；写后回读校验 BEGIN/END+frontmatter，
                                       #    校验失败自动从 .bak 恢复并报错退出非零）
  python3 self-optimize.py --dry       # 零写盘：只打印报告与清单预览（三遍验证用）

约束（OPTFIX 必修）：
  1. 写安全：.bak 备份 + 写后回读校验 + 失败自动恢复；默认行为 dry（只出报告不写），写盘需显式 apply
  2. 用户批准制：默认跑只产出报告+待注入清单（~/.pi/agent/moa/pending-injections.md，
     含每条教训的 创建日期/id/confidence/evidence/拟注入角色）；apply 才写入管理区；
     报告顶部明示"未经用户批准，本报告不产生任何文件改动"
  3. flash 成本口径：读 ~/.pi/agent/models.json——deepseek 模型若无 cost 字段，层2 对无计价模型输出
     "成本=未配置计价（0 为口径缺失非免费）"；captain 占比等成本结论只基于有计价模型并注明口径；
     不得把 0 当真实成本下结论；models.json 占位 cost 标注"占位待核价"，报告【需用户裁决】列出实际价格待确认
  4. TTL：pending-injections.md 条目带创建日期；超 30 天未批准自动移入归档区（报告注明"已归档"），
     不再出现在待注入清单

零第三方依赖（python3 标准库）。YAML 用宽容正则解析（instinct 块为 JSON 兼容子集）。
"""
import argparse
import datetime
import json
import os
import re
import shutil
import sys
from pathlib import Path

HOME = Path.home()
DEFAULT_AGENTS = HOME / ".pi" / "agent" / "agents"
DEFAULT_RUNS = HOME / ".pi" / "agent" / "moa" / "runs.jsonl"
DEFAULT_PENDING = HOME / ".pi" / "agent" / "moa" / "pending-injections.md"
DEFAULT_MODELS_JSON = HOME / ".pi" / "agent" / "models.json"
# 黑板根默认自动发现：环境变量 PI_MOA_BOARD > 常见项目位置 > 当前目录
def _discover_board() -> Path:
    import os
    if os.environ.get("PI_MOA_BOARD"):
        return Path(os.environ["PI_MOA_BOARD"])
    for base in (Path.cwd(), HOME):
        cand = base / ".pi" / "moa"
        if cand.is_dir():
            return cand
    return HOME / ".pi" / "agent" / "moa"  # 兜底（无黑板时各扫描器优雅跳过）

DEFAULT_BLACKBOARD = _discover_board()
DEFAULT_NAVIGATOR = DEFAULT_BLACKBOARD / "NAVIGATOR.md"
DEFAULT_REPORT = HOME / ".pi" / "agent" / "moa" / "self-optimize-report.md"

BEGIN = "<!-- MOA-LESSONS:BEGIN（self-optimize.py 管理区，勿手改；块外零改动） -->"
END = "<!-- MOA-LESSONS:END -->"

THRESHOLD = 0.5          # 层 1 注入阈值
TTL_DAYS = 30            # 待注入条目超 30 天未批准 → 归档
ROLE_LABEL = "executor/executor-k3/analyst/critic/devil（agents/*.md 全部）"
UNPRICED_LABEL = "未配置计价（0 为口径缺失，非免费）"
KPI_INPUT_RATIO = 0.30   # captain 输入占比 KPI
ALERT_INPUT_RATIO = 0.50 # 告警线
DUR_OUTLIER = 2.0        # 时长离群倍数（>2 倍均值）
TURNS_OUTLIER = 2.0      # turns 离群倍数
DONE_RATE_FLOOR = 0.6    # 能力画像 done 率下限
MIN_CARD_N = 3           # 矩阵建议最小样本数

# ---------------------------------------------------------------- 层 1：样本解析

def extract_fenced_blocks(text):
    """宽容提取 ```yaml/yml/json 围栏块；也接受裸 json 块。"""
    blocks = [m.group(1) for m in re.finditer(r"```(?:yaml|yml|json)\s*\n(.*?)```", text, re.S)]
    if not blocks:  # 无围栏时找最外层 { ... }
        for m in re.finditer(r"\{.*\}", text, re.S):
            blocks.append(m.group(0))
    return blocks


def parse_instinct_block(block):
    """解析一个 instinct 块 → instincts 列表（JSON 兼容子集，宽容降级）。"""
    b = block.strip()
    i, j = b.find("{"), b.rfind("}")
    if i == -1 or j <= i:
        return []
    b = b[i:j + 1]
    try:
        data = json.loads(b)
    except Exception:
        # 宽容降级：行级 key: value 收集（不支持嵌套则放弃该块）
        data = None
        pairs = {}
        for line in b.splitlines():
            m = re.match(r'\s*"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)"', line)
            if m:
                pairs[m.group(1)] = m.group(2)
        if "id" in pairs and "trigger" in pairs:
            data = {"instincts": [pairs]}
    if not isinstance(data, dict):
        return []
    insts = data.get("instincts", [])
    if isinstance(insts, dict):  # 容错：单对象而非数组
        insts = [insts]
    return [x for x in insts if isinstance(x, dict)]


def collect_instincts(navigator_text):
    """NAVIGATOR.md 全文 → 全部 instinct（去重按 id，后者覆盖前者）。"""
    out = {}
    for blk in extract_fenced_blocks(navigator_text):
        for inst in parse_instinct_block(blk):
            iid = str(inst.get("id", "")).strip()
            if not iid:
                continue
            out[iid] = inst
    return list(out.values())


def ev_short_names(evidence):
    """evidence 数组 → 短任务名列表（取前两段，如 p3-task3-p3b2-b3 → p3-task3）"""
    names, dates = [], []
    for ev in evidence or []:
        ev = str(ev)
        dm = re.search(r"\((\d{4}-\d{2}-\d{2})\)", ev)
        if dm:
            dates.append(dm.group(1))
        nm = re.sub(r"\s*\(\d{4}-\d{2}-\d{2}\)", "", ev).strip()
        if nm:
            names.append("-".join(nm.split("-")[:2]))
    return names, (max(dates) if dates else datetime.date.today().isoformat())


def lesson_line(inst):
    """instinct → 管理区行：- [conf][id] 教训（trigger）— evidence，日期"""
    conf = inst.get("confidence", 0.3)
    iid = str(inst.get("id", "")).strip()
    trig = str(inst.get("trigger", "")).strip()
    domain = str(inst.get("domain", "其他")).strip()
    names, date = ev_short_names(inst.get("evidence") or [])
    ev = "/".join(names) if names else "（无）"
    # 教训句：trigger 去「当…时」包装，尾部补行动短语；括号内保留原文 trigger 作触发条件
    t = trig
    if t.startswith("当"):
        t = t[1:]
    lesson = t.rstrip("。.！!")
    if lesson.endswith("时"):
        lesson = lesson[:-1] + "时须按已知教训执行"
    elif lesson:
        lesson = lesson + "（触发时按已知教训执行）"
    if not lesson:
        lesson = iid
    line = "- [{}][{}] {}·{}（trigger: {}）— {}，{}".format(
        conf, iid, domain, lesson, trig, ev, date)
    return line


def parse_existing_lines(block_text):
    """管理区块文本 → {id: 行文本}"""
    out = {}
    for line in block_text.splitlines():
        m = re.match(r"^\s*- \[[\d.]+\]\[([^\]]+)\]\s+(.*)$", line)
        if m:
            out[m.group(1)] = line.strip()
    return out


def build_block(lines):
    """lesson 行列表 → 管理区完整块文本（按 confidence 降序、id 升序）。"""
    out = [BEGIN]
    out.extend(lines)
    out.append(END)
    return "\n".join(out)


def _backup_path(path):
    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    return path.with_name("{}.bak-{}".format(path.name, ts))


def verify_injection(path):
    """写后回读校验：BEGIN/END 标记完整 + frontmatter 完整可解析。返回错误列表（空=通过）。"""
    errs = []
    try:
        text = path.read_text(encoding="utf-8")
    except Exception as e:
        return ["文件不可读: {}".format(e)]
    if BEGIN not in text:
        errs.append("BEGIN 标记缺失")
    if END not in text:
        errs.append("END 标记缺失")
    if BEGIN in text and END in text and text.index(END) <= text.index(BEGIN):
        errs.append("END 位置先于 BEGIN")
    lines = text.split("\n")
    if lines and lines[0].strip() == "---":
        close = next((k for k in range(1, len(lines)) if lines[k].strip() == "---"), None)
        if close is None:
            errs.append("frontmatter 无闭合 ---")
        else:
            fm = "\n".join(lines[1:close])
            if not re.search(r"^\s*(name|version|description|model|tools|thinking)\s*:", fm, re.M):
                errs.append("frontmatter 关键字段缺失")
    return errs


def inject_into_file(path, lines, do_write):
    """注入/更新单个 agent 文件管理区。返回 (changed, action_desc)。幂等：内容相同则不动。

    do_write=True 时写盘（仅 apply 模式调用）：写前 .bak 备份；写后回读校验（BEGIN/END 完整
    + frontmatter 可解析），校验失败自动从 .bak 恢复并返回 verify-failed-restored。"""
    text = path.read_text(encoding="utf-8")
    new_block = build_block(lines)
    if BEGIN in text and END in text:
        i = text.index(BEGIN)
        j = text.index(END, i) + len(END)
        old_block = text[i:j]
        if old_block == new_block:
            return False, "unchanged"
        new_text = text[:i] + new_block + text[j:]
        action = "updated"
    else:
        if BEGIN in text or END in text:
            return False, "skip-broken-block"  # 半块残缺：不碰，留给 captain
        new_text = text.rstrip("\n") + "\n\n" + new_block + "\n"
        action = "created"
    if do_write:
        backup = _backup_path(path)
        try:
            shutil.copy2(path, backup)
            path.write_text(new_text, encoding="utf-8")
        except OSError as e:
            return False, "write-failed: {}".format(e)
        errs = verify_injection(path)
        if errs:
            try:
                shutil.copy2(backup, path)  # 校验失败自动恢复
            except OSError:
                pass
            return False, "verify-failed-restored: {}".format("; ".join(errs))
    return True, action


# ---------------------------------------------------------------- 待注入清单（用户批准制 + TTL）

PENDING_HEADER = """# pi-moa 待注入清单（用户批准制，2026-08-06 用户裁决）

> ⚠ 默认（report）模式只产出本清单与报告，**不写 agents/*.md**。
> 用户明确批准后执行 `python3 self-optimize.py apply`（或 `/moa optimize apply`），才把本清单写入各角色管理区
> （写前 .bak 备份 + 写后回读校验）。创建超 {ttl} 天未批准自动移入归档区（不再出现在待注入清单）。
> 行格式：- YYYY-MM-DD | <管理区行> | <拟注入角色> | <pending|applied|archived>

""".format(ttl=TTL_DAYS)


def entry_line(e):
    return "- {} | {} | {} | {}".format(e["date"], e["line"], e["role"], e["status"])


def conf_of(e):
    m = re.search(r"\[([\d.]+)\]\[", e["line"])
    return float(m.group(1)) if m else 0.0


def id_of(e):
    m = re.search(r"\]\[([^\]]+)\]", e["line"])
    return m.group(1) if m else "?"


def parse_pending(text):
    """pending-injections.md → {status: {id: entry}}。行格式：- YYYY-MM-DD | <lesson line> | <role> | <status>"""
    out = {"pending": {}, "applied": {}, "archived": {}}
    cur = None
    for line in text.splitlines():
        if line.startswith("## "):
            h = line[3:].strip()
            cur = next((k for k in out if h.startswith(k)), None)
            continue
        if not line.startswith("- "):
            continue
        m = re.match(r"^- (\d{4}-\d{2}-\d{2}) \| (.*) \| ([^|]*) \| (pending|applied|archived)$", line)
        if not m:
            continue
        iid = id_of({"line": m.group(2)})
        if iid == "?":
            continue
        out[m.group(4)][iid] = {"date": m.group(1), "line": m.group(2).strip(),
                                "role": m.group(3).strip(), "status": m.group(4)}
    return out


def render_pending(pending, applied, archived, notes):
    L = [PENDING_HEADER]
    L.append("## 待注入（{} 条）".format(len(pending)))
    for iid in sorted(pending, key=lambda x: (-conf_of(pending[x]), x)):
        L.append(entry_line(pending[iid]))
    L.append("\n## 已批准注入（{} 条，apply 后由待注入移入；源已删除的自动撤注）".format(len(applied)))
    for iid in sorted(applied, key=lambda x: (-conf_of(applied[x]), x)):
        L.append(entry_line(applied[iid]))
    L.append("\n## 归档区（创建超 {} 天未批准，自动移入；{} 条）".format(TTL_DAYS, len(archived)))
    for iid in sorted(archived):
        L.append(entry_line(archived[iid]))
    L.append("\n---\n> 最近归档/撤注记录：\n")
    for n in notes:
        L.append("- " + n)
    return "\n".join(L) + "\n"


def apply_ttl(pending, archived):
    """待注入条目超 TTL_DAYS 未批准 → 移入归档区。返回被归档 id 列表。"""
    cutoff = datetime.date.today() - datetime.timedelta(days=TTL_DAYS)
    moved = []
    for iid in list(pending.keys()):
        try:
            d = datetime.datetime.strptime(pending[iid]["date"], "%Y-%m-%d").date()
        except Exception:
            continue
        if d < cutoff:
            e = pending.pop(iid)
            e["status"] = "archived"
            archived[iid] = e
            moved.append(iid)
    return moved


def merge_into_pending(lessons_in, pending, applied, archived, today_iso):
    """把 NAVIGATOR 教训并入待注入清单：
    - 已批准/已归档的 id 不重复加入待注入；已在待注入的刷新内容（保留创建日期）
    - 已批准注入但 NAVIGATOR 源已删除 → 撤注：移出已批准区（下次 apply 不再保留）
    返回 (new_ids, dropped_ids)。"""
    inst_by_id = {str(i.get("id", "")).strip(): i for i in lessons_in}
    new_ids, dropped = [], []
    for iid, inst in inst_by_id.items():
        line = lesson_line(inst)
        if iid in applied:
            applied[iid]["line"] = line  # 内容刷新（保留原批准日期）
            continue
        if iid in archived:
            continue  # 已归档不复活
        if iid in pending:
            pending[iid]["line"] = line  # 内容刷新，创建日期保留
        else:
            pending[iid] = {"date": today_iso, "line": line, "role": ROLE_LABEL, "status": "pending"}
            new_ids.append(iid)
    for iid in list(applied.keys()):
        if iid not in inst_by_id:
            del applied[iid]
            dropped.append(iid)
    return new_ids, dropped


def existing_zone_ids(agents_dir):
    """各 agent 文件管理区现有教训 id 集合（撤注检测用）。"""
    ids = set()
    for f in sorted(agents_dir.glob("*.md")):
        try:
            t = f.read_text(encoding="utf-8")
        except Exception:
            continue
        if BEGIN in t and END in t:
            i, j = t.index(BEGIN), t.index(END)
            ids |= set(parse_existing_lines(t[i:j]).keys())
    return ids


# ---------------------------------------------------------------- 层 2：架构分析

def load_runs(runs_path):
    """runs.jsonl → 配对后的运行列表。容错：坏行跳过。"""
    pairs = {}
    order = []
    if not runs_path.exists():
        return []
    for line in runs_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        rid = d.get("runId", "")
        if not rid:
            continue
        if rid not in pairs:
            pairs[rid] = {}
            order.append(rid)
        pairs[rid].update(d)
    runs = []
    starts = {}
    for line in runs_path.read_text(encoding="utf-8").splitlines():
        try:
            d = json.loads(line.strip())
        except Exception:
            continue
        if d.get("event") == "start":
            starts[d.get("runId", "")] = d.get("ts")
    for rid in order:
        p = pairs[rid]
        st = starts.get(rid)
        et = p.get("ts")
        dur = max(0, (et - st) / 1000.0) if (et is not None and st is not None) else 0.0
        runs.append({
            "runId": rid,
            "agent": str(p.get("agent", "")),
            "model": str(p.get("model", "")),
            "summary": str(p.get("summary", "")),
            "exitCode": p.get("exitCode"),
            "ts_start": st,
            "dur_s": dur,
            "usage": p.get("usage") or {},
            "has_end": p.get("event") == "end",
        })
    return runs


def mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


def classify_domain(text):
    """summary/卡正文 → 任务域。启发式关键词，优先级：审查/调研 > 前端 > SQL/数据 > 部署/运维。"""
    t = text or ""
    if re.search(r"审查|评审|挑刺|调研|复盘|验证|真实性|review|audit|verify|检查", t, re.I):
        return "审查/调研"
    if re.search(r"前端|vue|页面|组件|界面|菜单|cashier|wiring|front", t, re.I):
        return "前端"
    if re.search(r"sql|mapper|查询|字段|索引|数据库|总账|凭证|预算|税务|表|数据", t, re.I):
        return "SQL/数据"
    if re.search(r"docker|compose|容器|部署|环境|密钥|脱敏|证书|邮件|服务|ops|deploy", t, re.I):
        return "部署/运维"
    return "其他"


def norm_actor(a):
    """结果卡 actor 归一：executor-k3 保留；括号内角色词优先；其余 *-executor/*-critic/executor*/critic*/analyst*/captain*/devil* 归一。"""
    a = str(a).strip()
    m = re.search(r"[（(](executor[^)）]*|critic[^)）]*|analyst[^)）]*|devil[^)）]*)[)）]", a)
    if m:
        a = m.group(1)
    a = re.sub(r"\s*[（(].*?[)）]", "", a)
    a = re.split(r"\s*[｜|]\s*", a)[0]
    a = a.split("@")[0].strip()
    if a.startswith("executor-k3") or a.endswith("executor-k3"):
        return "executor-k3"
    if a.startswith("executor") or a.endswith("-executor"):
        return "executor"
    if a.startswith("critic") or a.endswith("-critic"):
        return "critic"
    if a.startswith("analyst") or a.endswith("-analyst"):
        return "analyst"
    if a.startswith("captain"):
        return "captain"
    if a.startswith("devil") or a.endswith("-devil"):
        return "devil"
    return a or "未知"


def scan_result_cards(blackboard_root):
    """扫描黑板各任务 results/*.md → 卡片记录 [{actor,status,domain,file}]。navigator-comparison* 视为元记录跳过。"""
    cards = []
    if not blackboard_root.exists():
        return cards
    for task_dir in sorted(blackboard_root.iterdir()):
        if not task_dir.is_dir():
            continue
        rdir = task_dir / "results"
        if not rdir.is_dir():
            continue
        for f in sorted(rdir.glob("*.md")):
            if "navigator-comparison" in f.name:
                continue
            try:
                text = f.read_text(encoding="utf-8")
            except Exception:
                continue
            am = re.search(r"^\s*(?:[-*]\s*)?actor:\s*(.+)$", text, re.M)
            sm = re.search(r"^\s*(?:[-*]\s*)?status:\s*(done|partial|blocked|handoff)", text, re.M | re.I)
            actor = am.group(1).strip() if am else ""
            status = sm.group(1).strip().lower() if sm else ""
            body = re.sub(r"^---?\s*$", " ", text, flags=re.M)
            # summary 行或标题优先归类，正文兜底
            summ = re.search(r"^summary:\s*(.+)$", text, re.M)
            headline = re.search(r"^#\s*(.+)$", text, re.M)
            cls_text = (summ.group(1) if summ else "") + " " + (headline.group(1) if headline else "") + " " + body[:400]
            cards.append({
                "actor": actor,
                "norm_actor": norm_actor(actor) if actor else "未知",
                "status": status,
                "domain": classify_domain(cls_text),
                "file": str(f),
            })
    return cards


def parallel_stats(runs):
    """同 pid 并发窗口统计：runs 里按 runId 前缀 pid 分组（runId 形如 ts-pid-n）。"""
    groups = {}
    for r in runs:
        parts = r["runId"].rsplit("-", 2)
        pid = parts[0] + "-" + parts[1] if len(parts) >= 3 else r["runId"]
        groups.setdefault(pid, []).append(r)
    max_conc = 0
    for pid, rs in groups.items():
        n = 0
        for i, a in enumerate(rs):
            for b in rs:
                if a is b:
                    continue
                # 时间重叠（start 相同也视为并行）
                if a["ts_start"] is not None and b["ts_start"] is not None:
                    a_end = a["ts_start"] + a["dur_s"] * 1000
                    b_end = b["ts_start"] + b["dur_s"] * 1000
                    if a["ts_start"] <= b_end and b["ts_start"] <= a_end:
                        n += 1
        max_conc = max(max_conc, n + 1)
    return max_conc


def load_pricing(models_json_path):
    """~/.pi/agent/models.json → {model_id: {"priced": bool, "note": str}}。
    计价口径（OPTFIX 必修 3）：有 cost 字段且任一项单价 >0 → 已计价；否则视为未配置计价
    （cost 全 0 或缺失均为口径缺失，不是免费；costNote=占位待核价 的按未计价处理并在报告提示）。"""
    pricing = {}
    try:
        data = json.loads(models_json_path.read_text(encoding="utf-8"))
    except Exception:
        return pricing
    for prov in (data.get("providers") or {}).values():
        for m in (prov.get("models") or []):
            mid = str(m.get("id", "")).strip()
            if not mid:
                continue
            cost = m.get("cost")
            note = str(m.get("costNote", "") or "").strip()
            priced = False
            if isinstance(cost, dict):
                rates = [cost.get(k) for k in ("input", "output", "cacheRead", "cacheWrite")]
                if any(isinstance(x, (int, float)) and x > 0 for x in rates):
                    priced = True
            pricing[mid] = {"priced": priced, "note": note}
    return pricing


def match_pricing(model, pricing):
    """台账 model 名 ↔ models.json id 匹配：全等或互相包含。返回 (priced, note) 或 (None, "")。"""
    if not model:
        return None, ""
    if model in pricing:
        return pricing[model]["priced"], pricing[model]["note"]
    for mid, p in pricing.items():
        if mid in model or model in mid:
            return p["priced"], p["note"]
    return None, ""


def arch_analysis(runs, cards, pricing):
    """层 2 全部分析 → dict（供报告渲染）。分析逻辑不变，仅成本口径标注（OPTFIX 必修 3）。"""
    res = {"models": {}, "k3_input_ratio": 0.0, "outliers_dur": [], "outliers_turns": [],
           "matrix": {}, "domain_dist": {}, "max_concurrency": 0,
           "unpriced_models": [], "zero_cost_priced": [],
           "kpi": {"status": "ok", "ratio": 0.0}, "blocked_points": []}

    # --- 成本架构（按 model；口径：仅已计价模型计真实成本）---
    per_model = {}
    for r in runs:
        if not r["has_end"]:
            continue
        m = r["model"] or "unknown"
        pm = per_model.setdefault(m, {"n": 0, "input": 0, "output": 0, "cost": 0.0, "dur": 0.0, "turns": 0})
        u = r["usage"]
        pm["n"] += 1
        pm["input"] += u.get("input", 0)
        pm["output"] += u.get("output", 0)
        pm["cost"] += u.get("costTotal", 0) or 0
        pm["dur"] += r["dur_s"]
        pm["turns"] += u.get("turns", 0)
    for m, pm in per_model.items():
        priced, note = match_pricing(m, pricing)
        pm["priced"] = bool(priced)
        pm["price_note"] = note or ""
        if pm["n"]:
            if not priced:
                res["unpriced_models"].append(m)   # 无计价 → 0 是口径缺失非免费
            elif pm["cost"] == 0:
                res["zero_cost_priced"].append(m)  # 已计价但全 0 → 需用户确认免费/漏记账
    res["models"] = per_model
    tot_in = sum(v["input"] for v in per_model.values())
    k3_in = sum(v["input"] for k, v in per_model.items() if "k3" in k.lower() or "kimi" in k.lower())
    if tot_in:
        res["k3_input_ratio"] = k3_in / tot_in
        res["kpi"]["ratio"] = res["k3_input_ratio"]
        res["kpi"]["status"] = ("alert" if res["k3_input_ratio"] >= ALERT_INPUT_RATIO
                                else "warn" if res["k3_input_ratio"] >= KPI_INPUT_RATIO else "ok")

    # --- 离群（时长 / turns / input）---
    ends = [r for r in runs if r["has_end"]]
    dur_mean = mean([r["dur_s"] for r in ends])
    turns_mean = mean([r["usage"].get("turns", 0) for r in ends])
    res["dur_mean"] = dur_mean
    res["turns_mean"] = turns_mean
    for r in ends:
        if dur_mean and r["dur_s"] > DUR_OUTLIER * dur_mean:
            res["outliers_dur"].append(r)
        t = r["usage"].get("turns", 0)
        if turns_mean and t > TURNS_OUTLIER * turns_mean:
            res["outliers_turns"].append(r)

    # --- 能力画像（黑板结果卡）---
    matrix = {}  # (norm_actor, domain) -> {"done":n,"partial":n,"blocked":n,"handoff":n,"other":n}
    for c in cards:
        if not c["norm_actor"] or not c["status"]:
            continue
        key = (c["norm_actor"], c["domain"])
        cell = matrix.setdefault(key, {"done": 0, "partial": 0, "blocked": 0, "handoff": 0, "other": 0})
        st = c["status"]
        if st in cell:
            cell[st] += 1
        else:
            cell["other"] += 1
        res["domain_dist"][c["domain"]] = res["domain_dist"].get(c["domain"], 0) + 1
        if st in ("blocked", "handoff"):
            res["blocked_points"].append({"actor": c["norm_actor"], "domain": c["domain"],
                                          "status": st, "file": c["file"]})
    res["matrix"] = matrix

    res["max_concurrency"] = parallel_stats(runs)
    return res


# ---------------------------------------------------------------- 建议与报告

def build_suggestions(lessons_in, lessons_out, arch, n_agent_files, mode, new_ids, pending, applied, drop_warnings):
    sug = {"pending": [], "applied": [], "record": [], "captain": [], "user": []}
    # 层 1：用户批准制（不再自动注入）
    if mode == "apply":
        for iid in applied:
            sug["applied"].append("[层1][{}] 已批准注入（本次 apply 写入管理区，含备份+回读校验）".format(iid))
        for iid in new_ids:
            sug["pending"].append("[层1][{}] 本次运行新发现（{}），未获批准，仍留待注入清单".format(
                iid, inst_trigger(lessons_in, iid)))
    else:
        for iid in pending:
            sug["pending"].append("[层1][{}] conf={} 已列入待注入清单，未经批准未写入 agents：{}".format(
                iid, conf_of(pending[iid]), inst_trigger(lessons_in, iid)))
    for inst in lessons_out:
        sug["record"].append("[层1][{}] confidence={} 低于 0.5 未注入，仅记录：{}".format(
            inst.get("id"), inst.get("confidence"), inst.get("trigger")))

    kpi = arch["kpi"]
    if kpi["status"] == "alert":
        sug["captain"].append("[成本] K3(captain 系) 输入占比 {:.0%} 超告警线 50%——需 captain 检查是否过度使用高能力档".format(kpi["ratio"]))
    elif kpi["status"] == "warn":
        sug["captain"].append("[成本] K3(captain 系) 输入占比 {:.0%} 超 KPI 30%——建议审视可降档 flash 的任务".format(kpi["ratio"]))
    for m, pm in arch["models"].items():
        if pm.get("priced"):
            sug["captain"].append("[成本] {}：{} 任务 / 总 input {} tok / 总 cost {} 元 / 均价 {:.2f} 元·任务 / 均时长 {:.0f}s（计价口径：models.json 已配置，可下成本结论）".format(
                m, pm["n"], pm["input"], round(pm["cost"], 4),
                pm["cost"] / pm["n"] if pm["n"] else 0, pm["dur"] / pm["n"] if pm["n"] else 0))
        else:
            note = pm.get("price_note") or ""
            note_tail = "（models.json 注释：{}）".format(note) if note else ""
            sug["user"].append("[成本] 模型 {}：{} 任务 / 总 input {} tok / 成本=未配置计价（0 为口径缺失非免费，不得当免费）——需用户在 models.json 配置实际单价{}".format(
                m, pm["n"], pm["input"], note_tail))
    for m in arch["zero_cost_priced"]:
        sug["user"].append("[成本] 模型 {} 已配置计价但 costTotal=0——需用户确认计费口径（免费配额 or 漏记账）".format(m))

    for r in arch["outliers_dur"]:
        sug["captain"].append("[效率] 时长离群 {}：{}s（均值 {:.0f}s）——建议拆片或压缩上下文：{}".format(
            r["runId"], int(r["dur_s"]), arch.get("dur_mean", 0) or 0, r["summary"][:40]))
    for r in arch["outliers_turns"]:
        sug["captain"].append("[效率] turns 离群 {}：{} turns——建议拆片/限定轮次上限：{}".format(
            r["runId"], r["usage"].get("turns", 0), r["summary"][:40]))
    if arch["max_concurrency"] >= 2:
        sug["captain"].append("[效率] 并行利用率正常：检测到最大并发 {}（同 pid 重叠窗口）".format(arch["max_concurrency"]))

    for (actor, domain), cell in sorted(arch["matrix"].items()):
        total = sum(cell.values())
        if total < MIN_CARD_N:
            continue
        done_rate = cell["done"] / total
        if done_rate < DONE_RATE_FLOOR:
            sug["captain"].append("[画像] 角色 {} × 域「{}」done 率 {:.0%}（{}/{}）低于 60%——建议该组合升模型档或加 critic 把关".format(
                actor, domain, done_rate, cell["done"], total))
    for bp in arch["blocked_points"]:
        sug["captain"].append("[画像] blocked/handoff 集中点：{} × 域「{}」 status={}（{}）".format(
            bp["actor"], bp["domain"], bp["status"], bp["file"].split("/")[-2] + "/" + bp["file"].split("/")[-1]))
    return sug


def inst_trigger(lessons_in, iid):
    for i in lessons_in:
        if str(i.get("id", "")).strip() == iid:
            return str(i.get("trigger", ""))
    return "?"


def parse_line_meta(line):
    """从管理区行解析 (conf, id, domain, lesson, trigger, evidence)。失败回退部分字段。"""
    m = re.match(r"^\- \[([\d.]+)\]\[([^\]]+)\]\s+([^·]+)·(.*?)（trigger: (.*?)）— (.*?)，(\d{4}-\d{2}-\d{2})$", line)
    if m:
        return m.group(1), m.group(2), m.group(3).strip(), m.group(4), m.group(5), m.group(6)
    c = re.search(r"\[([\d.]+)\]\[([^\]]+)\]", line)
    return (c.group(1) if c else "?", c.group(2) if c else "?", "", "", "", "")


def lesson_row(e):
    """entry → 表格行（创建日期/id/conf/domain/trigger/evidence/拟注入角色）。"""
    conf, iid, domain, _lesson, trig, ev = parse_line_meta(e["line"])
    return [e["date"], iid, conf, domain, trig, ev, e["role"]]


def render_report(mode, dry, lessons_in, lessons_out, arch, sug, runs, cards,
                  pending, applied, archived, archived_ids, drop_warnings, injected_results, new_ids):
    L = []
    L.append("# self-optimize 报告（双层自优化器）\n")
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    mode_label = {"report": "report（只读分析+待注入清单，不写 agents）",
                  "apply": "apply（已批准注入）"}.get(mode, mode)
    if dry:
        mode_label += " + dry（零写盘预览）"
    L.append("> ⚠ **未经用户批准，本报告不产生任何文件改动**（agents/*.md 管理区仅在 `apply` 模式下写入）\n")
    L.append("> 生成时间：{} ｜ 模式：{} ｜ 输入：runs.jsonl {} 条运行 / 黑板结果卡 {} 张 / NAVIGATOR instinct {} 条".format(
        now, mode_label, len(runs), len(cards), len(lessons_in) + len(lessons_out)))
    L.append("\n## 层 1：样本自优化（用户批准制）\n")

    L.append("### 待批准注入（confidence≥0.5，已列入待注入清单；未经批准不写 agents）——{} 条\n".format(len(pending)))
    L.append("| 创建日期 | id | conf | domain | trigger | evidence | 拟注入角色 |")
    L.append("|---|---|---|---|---|---|---|")
    for iid in sorted(pending, key=lambda x: (-conf_of(pending[x]), x)):
        L.append("| {} |".format(" | ".join(lesson_row(pending[iid]))))
    if not pending:
        L.append("| - | - | - | - | - | - | - |")

    L.append("\n### 已批准注入（apply 后由待注入移入；NAVIGATOR 源删除即撤注）——{} 条\n".format(len(applied)))
    L.append("| 创建日期 | id | conf | domain | trigger | evidence | 拟注入角色 |")
    L.append("|---|---|---|---|---|---|---|")
    for iid in sorted(applied, key=lambda x: (-conf_of(applied[x]), x)):
        L.append("| {} |".format(" | ".join(lesson_row(applied[iid]))))
    if not applied:
        L.append("| - | - | - | - | - | - | - |")

    L.append("\n### 仅记录教训（confidence<0.5，未注入）——{} 条\n".format(len(lessons_out)))
    L.append("| id | conf | domain | trigger |")
    L.append("|---|---|---|---|")
    for inst in sorted(lessons_out, key=lambda x: -x.get("confidence", 0)):
        L.append("| {} | {} | {} | {} |".format(
            inst.get("id"), inst.get("confidence"), inst.get("domain"), inst.get("trigger")))

    if archived_ids or drop_warnings:
        L.append("\n### 归档与撤注告警\n")
        for iid in archived_ids:
            L.append("- 已归档：{}（创建超 {} 天未批准，已移入归档区，不再出现在待注入清单）".format(iid, TTL_DAYS))
        for w in drop_warnings:
            L.append("- ⚠ 撤注告警：{}".format(w))
        if archived:
            L.append("- 归档区现存 {} 条（明细见 pending-injections.md 归档区）".format(len(archived)))

    if injected_results:
        L.append("\n### 本次 apply 注入结果（写前 .bak 备份 + 写后回读校验）\n")
        L.append("| 文件 | 结果 |")
        L.append("|---|---|")
        for fname, action in injected_results:
            L.append("| {} | {} |".format(fname, action))

    L.append("\n## 层 2：架构运行分析（只读，只出建议）\n")
    L.append("### 成本架构（口径：仅已计价模型计真实成本；未计价模型 0 为口径缺失非免费）\n")
    L.append("| model | 任务数 | 总 input(tok) | 总 output(tok) | 总 cost(元) | 计价口径 | 均时长(s) | 均 turns |")
    L.append("|---|---|---|---|---|---|---|---|")
    for m, pm in sorted(arch["models"].items()):
        if pm.get("priced"):
            cost_cell = "{:.4f}".format(pm["cost"])
            priced_cell = "已计价"
        else:
            cost_cell = UNPRICED_LABEL
            priced_cell = "未配置计价" + ("（占位待核价）" if pm.get("price_note") else "")
        L.append("| {} | {} | {} | {} | {} | {} | {:.0f} | {:.0f} |".format(
            m, pm["n"], pm["input"], pm["output"], cost_cell, priced_cell,
            pm["dur"], pm["turns"] / pm["n"] if pm["n"] else 0))
    L.append("\n- **captain(K3系) 输入占比**：{:.1%}（KPI ≤30% / 告警 ≥50%）→ {}（口径：token 占比，计价无关；金额类成本结论仅覆盖已计价模型）".format(
        arch["k3_input_ratio"],
        {"ok": "达标", "warn": "超 KPI，需 captain 关注", "alert": "超告警线，需立即处理"}[arch["kpi"]["status"]]))
    L.append("- 离群任务（input/turns/时长）：")
    if arch["outliers_dur"] or arch["outliers_turns"]:
        for r in arch["outliers_dur"]:
            L.append("  - 时长 {}：{}s / input {} / turns {} — {}".format(
                r["runId"], int(r["dur_s"]), r["usage"].get("input", 0), r["usage"].get("turns", 0), r["summary"][:50]))
        for r in arch["outliers_turns"]:
            if r not in arch["outliers_dur"]:
                L.append("  - turns {}：{} turns — {}".format(r["runId"], r["usage"].get("turns", 0), r["summary"][:50]))
    else:
        L.append("  - 无（<2 倍均值）")

    L.append("\n### 能力画像（任务域 × 角色 done 率）\n")
    domains = sorted({d for (_, d) in arch["matrix"].keys()})
    actors = sorted({a for (a, _) in arch["matrix"].keys()})
    L.append("| 角色 \\ 域 | " + " | ".join(domains) + " |")
    L.append("|" + "---|" * (len(domains) + 1))
    for a in actors:
        cells = []
        for d in domains:
            c = arch["matrix"].get((a, d))
            if not c:
                cells.append("-")
                continue
            total = sum(c.values())
            cells.append("{}/{} done{}{}".format(
                c["done"], total,
                " ({}%)".format(round(100 * c["done"] / total)) if total else "",
                " ⚠" if (total >= MIN_CARD_N and c["done"] / total < DONE_RATE_FLOOR) else ""))
        L.append("| {} | {} |".format(a, " | ".join(cells)))
    L.append("\n任务域分布（按结果卡）：" + "，".join("{}={}".format(k, v) for k, v in sorted(arch["domain_dist"].items(), key=lambda x: -x[1])))

    L.append("\n### 效率\n")
    L.append("- 最大并行（同 pid 重叠窗口）：{}".format(arch["max_concurrency"]))
    if arch["blocked_points"]:
        L.append("- blocked/handoff 集中点：")
        for bp in arch["blocked_points"]:
            L.append("  - {} × {}（{}）{}".format(bp["actor"], bp["domain"], bp["status"], bp["file"]))
    else:
        L.append("- blocked/handoff：无")

    L.append("\n## 建议分级\n")
    L.append("### 【待批准注入】（层 1 ≥0.5；需用户批准后 apply）")
    for s in sug["pending"]:
        L.append("- " + s)
    L.append("\n### 【本次已注入 / 已批准】（apply 模式）")
    for s in sug["applied"]:
        L.append("- " + s)
    L.append("\n### 【仅记录教训】（<0.5）")
    for s in sug["record"]:
        L.append("- " + s)
    L.append("\n### 【需 captain 裁决】")
    for s in sug["captain"]:
        L.append("- " + s)
    L.append("\n### 【需用户裁决】")
    for s in sug["user"]:
        L.append("- " + s)
    L.append("\n---\n请 captain 抽查管理区+裁决层 2 建议；待注入清单见 pending-injections.md\n")
    return "\n".join(L)


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="pi-moa 双层自优化器（用户批准制：默认只读，apply 才写 agents）")
    ap.add_argument("mode", nargs="?", default="report", choices=["report", "apply"],
                    help="report=只读分析+报告+待注入清单（默认，永不写 agents/*.md）；apply=仅用户明确批准后执行注入（写前 .bak 备份+写后回读校验）")
    ap.add_argument("--dry", action="store_true", help="零写盘：只打印报告与清单预览")
    ap.add_argument("--agents-dir", default=str(DEFAULT_AGENTS))
    ap.add_argument("--navigator", default=str(DEFAULT_NAVIGATOR))
    ap.add_argument("--runs", default=str(DEFAULT_RUNS))
    ap.add_argument("--blackboard", default=str(DEFAULT_BLACKBOARD))
    ap.add_argument("--report", default=str(DEFAULT_REPORT))
    ap.add_argument("--pending", default=str(DEFAULT_PENDING))
    ap.add_argument("--models-json", default=str(DEFAULT_MODELS_JSON))
    args = ap.parse_args()

    mode = args.mode
    dry = args.dry
    do_write = (mode == "apply") and not dry  # 只有 apply 且非 dry 才写 agents 管理区

    agents_dir = Path(args.agents_dir)
    navigator_path = Path(args.navigator)
    runs_path = Path(args.runs)
    blackboard_root = Path(args.blackboard)
    report_path = Path(args.report)
    pending_path = Path(args.pending)
    models_json_path = Path(args.models_json)

    # 输入读取
    nav_text = navigator_path.read_text(encoding="utf-8") if navigator_path.exists() else ""
    instincts = collect_instincts(nav_text)
    lessons_in = [i for i in instincts if float(i.get("confidence", 0.3)) >= THRESHOLD]
    lessons_out = [i for i in instincts if float(i.get("confidence", 0.3)) < THRESHOLD]

    # 待注入清单：读旧 → TTL 归档 → 并入 NAVIGATOR 教训
    sections = {"pending": {}, "applied": {}, "archived": {}}
    pending_existed = pending_path.exists()
    if pending_existed:
        sections = parse_pending(pending_path.read_text(encoding="utf-8"))
    pending, applied, archived = sections["pending"], sections["applied"], sections["archived"]
    today_iso = datetime.date.today().isoformat()
    archived_ids = apply_ttl(pending, archived)
    new_ids, dropped_ids = merge_into_pending(lessons_in, pending, applied, archived, today_iso)
    if not pending_existed:
        # 首次运行（无历史清单）：本次 apply 视为对当前清单的全量批准，new_ids 不排除
        new_ids = []

    drop_warnings = []
    for iid in dropped_ids:
        drop_warnings.append("已批准注入的教训 {} 的 NAVIGATOR 源已删除——已移出已批准区，下次 apply 将从管理区移除".format(iid))

    # 层 2
    runs = load_runs(runs_path)
    cards = scan_result_cards(blackboard_root)
    pricing = load_pricing(models_json_path)
    arch = arch_analysis(runs, cards, pricing)
    n_agent_files = len(list(agents_dir.glob("*.md"))) if agents_dir.exists() else 0

    # apply：注入管理区（写前备份 + 写后回读校验 + 失败恢复）
    injected_results = []
    failed = False
    if do_write:
        zone_entries = [e for iid, e in list(pending.items()) + list(applied.items()) if iid not in new_ids]
        zone_entries.sort(key=lambda e: (-conf_of(e), id_of(e)))
        zone_lines = [e["line"] for e in zone_entries]
        zone_ids = {id_of(e) for e in zone_entries}
        old_ids = existing_zone_ids(agents_dir)
        for gone in sorted(old_ids - zone_ids):
            drop_warnings.append("管理区现有教训 {} 不在待注入/已批准清单——本次 apply 将从管理区撤注（非静默，特此告警）".format(gone))
        for f in sorted(agents_dir.glob("*.md")):
            changed, action = inject_into_file(f, zone_lines, True)
            injected_results.append((f.name, action))
            if "verify-failed" in action or "write-failed" in action:
                failed = True
                print("[层1][错误] {} → {}（已自动从 .bak 恢复）".format(f.name, action))
            elif changed:
                print("[层1] {} → {}（.bak 备份+回读校验通过）".format(f.name, action))
        # 注入成功的待注入条目 → 已批准
        for iid in list(pending.keys()):
            if iid not in new_ids:
                e = pending.pop(iid)
                e["status"] = "applied"
                applied[iid] = e

    # 待注入清单落盘（report/apply 都写；--dry 不写）
    pending_text = render_pending(pending, applied, archived, drop_warnings)
    if dry:
        print("\n[dry] 未写 pending-injections.md；预览（前 12 行）：\n")
        print("\n".join(pending_text.splitlines()[:12]))
    else:
        pending_path.parent.mkdir(parents=True, exist_ok=True)
        pending_path.write_text(pending_text, encoding="utf-8")
        print("[清单] 已写 {}".format(pending_path))

    sug = build_suggestions(lessons_in, lessons_out, arch, n_agent_files, mode, new_ids, pending, applied, drop_warnings)
    report = render_report(mode, dry, lessons_in, lessons_out, arch, sug, runs, cards,
                           pending, applied, archived, archived_ids, drop_warnings, injected_results, new_ids)

    # 报告落盘（--dry 只预览）
    if dry:
        print("\n[dry] 未写报告；以下为将写入 {} 的内容预览（前 60 行）：\n".format(report_path))
        print("\n".join(report.splitlines()[:60]))
    else:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(report, encoding="utf-8")
        print("\n[报告] 已写 {}".format(report_path))

    # stdout 摘要
    print("\n===== stdout 摘要 =====")
    print("模式：{}（{}）——{}".format(mode, "dry 零写盘" if dry else "写报告+清单", 
          "写 agents 管理区" if do_write else "不写 agents（用户批准制）"))
    print("层1：instinct {} 条 → 待批准 {} 条 / 已批准 {} 条 / 仅记录 {} 条 / 归档 {} 条 / 撤注告警 {} 条".format(
        len(instincts), len(pending), len(applied), len(lessons_out), len(archived_ids), len(drop_warnings)))
    for w in drop_warnings:
        print("  ⚠ " + w)
    print("层2：runs {} 条（{} 完成）；K3 输入占比 {:.1%}（KPI≤30%/告警50%）；最大并发 {}；时长离群 {} 条；turns 离群 {} 条；blocked/handoff 点 {} 个".format(
        len(runs), sum(1 for r in runs if r["has_end"]), arch["k3_input_ratio"],
        arch["max_concurrency"], len(arch["outliers_dur"]), len(arch["outliers_turns"]), len(arch["blocked_points"])))
    for m, pm in sorted(arch["models"].items()):
        if pm.get("priced"):
            print("  模型 {}: {} 任务 / {} tok / {:.4f} 元 / {:.0f}s（已计价）".format(
                m, pm["n"], pm["input"], pm["cost"], pm["dur"]))
        else:
            print("  模型 {}: {} 任务 / {} tok / 成本=未配置计价（0 为口径缺失非免费）".format(
                m, pm["n"], pm["input"]))
    print("建议：待批准注入 {} 条 / 已注入 {} 条 / 仅记录 {} 条 / captain 裁决 {} 条 / 用户裁决 {} 条".format(
        len(sug["pending"]), len(sug["applied"]), len(sug["record"]), len(sug["captain"]), len(sug["user"])))
    if dry:
        print("\n[dry] 零文件改动完成（不含 agents 管理区）")
    elif not do_write:
        print("\n请用户批准后执行 `python3 self-optimize.py apply`（或 /moa optimize apply）写入管理区")
    else:
        print("\n已按批准注入 agents 管理区（.bak 备份 + 回读校验）；请 captain 抽查")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()

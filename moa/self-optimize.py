#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
self-optimize.py — pi-moa 双层自优化器（executor/DS 切片 OPT）

层 1 样本自优化：从 NAVIGATOR.md instinct YAML（误判事件+已知高频坑）取教训，
  confidence>=0.5 注入 agents/*.md 的 <!-- MOA-LESSONS:BEGIN/END --> 管理区（幂等：同 id 更新不重加，块外零改动）；
  <0.5 仅列报告。
层 2 架构运行分析（纯只读）：runs.jsonl 台账（成本架构/效率）+ 黑板结果卡扫描（能力画像：任务域×角色 done 率）→
  只出建议不自动改，分【自动应用-已做】/【需 captain 裁决】/【需用户裁决】三档。

用法：
  python3 self-optimize.py            # 真跑：写报告 + 注入管理区
  python3 self-optimize.py --dry      # 只打印，不写任何文件
  python3 self-optimize.py --runs ... --navigator ... --blackboard ... --agents-dir ... --report ...

零第三方依赖（python3 标准库）。YAML 用宽容正则解析（instinct 块为 JSON 兼容子集）。
"""
import argparse
import datetime
import json
import os
import re
import sys
from pathlib import Path

HOME = Path.home()
DEFAULT_AGENTS = HOME / ".pi" / "agent" / "agents"
DEFAULT_RUNS = HOME / ".pi" / "agent" / "moa" / "runs.jsonl"
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


def build_block(lessons):
    """lessons(list[dict]) → 管理区完整块文本（按 confidence 降序、id 升序）。"""
    lines = [BEGIN]
    for inst in sorted(lessons, key=lambda x: (-float(x.get("confidence", 0.3)), str(x.get("id", "")))):
        lines.append(lesson_line(inst))
    lines.append(END)
    return "\n".join(lines)


def inject_into_file(path, lessons, dry):
    """注入/更新单个 agent 文件管理区。返回 (changed, action_desc)。幂等：内容相同则不动。"""
    text = path.read_text(encoding="utf-8")
    new_block = build_block(lessons)
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
    if not dry:
        path.write_text(new_text, encoding="utf-8")
    return True, action


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


def arch_analysis(runs, cards):
    """层 2 全部分析 → dict（供报告渲染）。"""
    res = {"models": {}, "k3_input_ratio": 0.0, "outliers_dur": [], "outliers_turns": [],
           "matrix": {}, "domain_dist": {}, "max_concurrency": 0, "cost_zeros": [],
           "kpi": {"status": "ok", "ratio": 0.0}, "blocked_points": []}

    # --- 成本架构（按 model）---
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
    res["models"] = per_model
    tot_in = sum(v["input"] for v in per_model.values())
    k3_in = sum(v["input"] for k, v in per_model.items() if "k3" in k.lower() or "kimi" in k.lower())
    if tot_in:
        res["k3_input_ratio"] = k3_in / tot_in
        res["kpi"]["ratio"] = res["k3_input_ratio"]
        res["kpi"]["status"] = ("alert" if res["k3_input_ratio"] >= ALERT_INPUT_RATIO
                                else "warn" if res["k3_input_ratio"] >= KPI_INPUT_RATIO else "ok")
    for m, pm in per_model.items():
        if pm["n"] and pm["cost"] == 0:
            res["cost_zeros"].append(m)

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

def build_suggestions(lessons_in, lessons_out, arch, n_agent_files=0):
    sug = {"auto": [], "captain": [], "user": []}
    for inst in lessons_in:
        sug["auto"].append("[层1][{}] 已注入 {} 个 agent 文件：{}（conf={}）".format(
            inst.get("id"), n_agent_files, inst.get("trigger"), inst.get("confidence")))
    for inst in lessons_out:
        sug["captain"].append("[层1][{}] confidence={} 低于 0.5 未注入，仅记录：{}".format(
            inst.get("id"), inst.get("confidence"), inst.get("trigger")))

    kpi = arch["kpi"]
    if kpi["status"] == "alert":
        sug["captain"].append("[成本] K3(captain 系) 输入占比 {:.0%} 超告警线 50%——需 captain 检查是否过度使用高能力档".format(kpi["ratio"]))
    elif kpi["status"] == "warn":
        sug["captain"].append("[成本] K3(captain 系) 输入占比 {:.0%} 超 KPI 30%——建议审视可降档 flash 的任务".format(kpi["ratio"]))
    for m, pm in arch["models"].items():
        sug["captain"].append("[成本] {}：{} 任务 / 总 input {} tok / 总 cost {} 元 / 均价 {:.2f} 元·任务 / 均时长 {:.0f}s".format(
            m, pm["n"], pm["input"], round(pm["cost"], 4),
            pm["cost"] / pm["n"] if pm["n"] else 0, pm["dur"] / pm["n"] if pm["n"] else 0))
    for m in arch["cost_zeros"]:
        sug["user"].append("[成本] 模型 {} 全部任务 costTotal=0——需用户确认计费口径（免费配额 or 漏记账）".format(m))

    for r in arch["outliers_dur"]:
        sug["captain"].append("[效率] 时长离群 {}：{}s（均值 {:.0f}s）——建议拆片或压缩上下文：{}".format(
            r["runId"], int(r["dur_s"]), arch.get("dur_mean", 0) or 0, r["summary"][:40]))
    for r in arch["outliers_turns"]:
        sug["captain"].append("[效率] turns 离群 {}：{} turns——建议拆片/限定轮次上限：{}".format(
            r["runId"], r["usage"].get("turns", 0), r["summary"][:40]))
    if arch["max_concurrency"] >= 2:
        sug["auto"].append("[效率] 并行利用率正常：检测到最大并发 {}（同 pid 重叠窗口）".format(arch["max_concurrency"]))

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


def render_report(lessons_in, lessons_out, arch, sug, dry, runs, cards):
    L = []
    L.append("# self-optimize 报告（双层自优化器）\n")
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    L.append("> 生成时间：{} ｜ 模式：{} ｜ 输入：runs.jsonl {} 条运行 / 黑板结果卡 {} 张 / NAVIGATOR instinct {} 条".format(
        now, "dry（未写盘）" if dry else "真跑", len(runs), len(cards), len(lessons_in) + len(lessons_out)))
    L.append("\n## 层 1：样本自优化\n")
    L.append("### 注入教训（confidence≥0.5，自动应用）——{} 条\n".format(len(lessons_in)))
    L.append("| id | conf | domain | trigger | 注入文件 |")
    L.append("|---|---|---|---|---|")
    for inst in sorted(lessons_in, key=lambda x: -x.get("confidence", 0)):
        L.append("| {} | {} | {} | {} | agents/*.md 全部 5 个 |".format(
            inst.get("id"), inst.get("confidence"), inst.get("domain"), inst.get("trigger")))
    L.append("\n### 仅记录教训（confidence<0.5，未注入）——{} 条\n".format(len(lessons_out)))
    L.append("| id | conf | domain | trigger |")
    L.append("|---|---|---|---|")
    for inst in sorted(lessons_out, key=lambda x: -x.get("confidence", 0)):
        L.append("| {} | {} | {} | {} |".format(
            inst.get("id"), inst.get("confidence"), inst.get("domain"), inst.get("trigger")))

    L.append("\n## 层 2：架构运行分析（只读，只出建议）\n")
    L.append("### 成本架构\n")
    L.append("| model | 任务数 | 总 input(tok) | 总 output(tok) | 总 cost(元) | 均价/任务(元) | 总时长(s) | 均 turns |")
    L.append("|---|---|---|---|---|---|---|---|")
    for m, pm in sorted(arch["models"].items()):
        L.append("| {} | {} | {} | {} | {:.4f} | {:.2f} | {:.0f} | {:.0f} |".format(
            m, pm["n"], pm["input"], pm["output"], pm["cost"],
            pm["cost"] / pm["n"] if pm["n"] else 0, pm["dur"], pm["turns"] / pm["n"] if pm["n"] else 0))
    L.append("\n- **captain(K3系) 输入占比**：{:.1%}（KPI ≤30% / 告警 ≥50%）→ {}".format(
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
    L.append("### 【自动应用-已做】")
    for s in sug["auto"]:
        L.append("- " + s)
    L.append("\n### 【需 captain 裁决】")
    for s in sug["captain"]:
        L.append("- " + s)
    L.append("\n### 【需用户裁决】")
    for s in sug["user"]:
        L.append("- " + s)
    L.append("\n---\n请 captain 抽查管理区+裁决层 2 建议\n")
    return "\n".join(L)


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="pi-moa 双层自优化器")
    ap.add_argument("--dry", action="store_true", help="只打印不写任何文件")
    ap.add_argument("--agents-dir", default=str(DEFAULT_AGENTS))
    ap.add_argument("--navigator", default=str(DEFAULT_NAVIGATOR))
    ap.add_argument("--runs", default=str(DEFAULT_RUNS))
    ap.add_argument("--blackboard", default=str(DEFAULT_BLACKBOARD))
    ap.add_argument("--report", default=str(DEFAULT_REPORT))
    args = ap.parse_args()

    agents_dir = Path(args.agents_dir)
    navigator_path = Path(args.navigator)
    runs_path = Path(args.runs)
    blackboard_root = Path(args.blackboard)
    report_path = Path(args.report)

    # 输入读取
    nav_text = navigator_path.read_text(encoding="utf-8") if navigator_path.exists() else ""
    instincts = collect_instincts(nav_text)
    lessons_in = [i for i in instincts if float(i.get("confidence", 0.3)) >= THRESHOLD]
    lessons_out = [i for i in instincts if float(i.get("confidence", 0.3)) < THRESHOLD]

    runs = load_runs(runs_path)
    cards = scan_result_cards(blackboard_root)
    arch = arch_analysis(runs, cards)
    n_agent_files = len(list(agents_dir.glob("*.md"))) if agents_dir.exists() else 0
    sug = build_suggestions(lessons_in, lessons_out, arch, n_agent_files)
    report = render_report(lessons_in, lessons_out, arch, sug, args.dry, runs, cards)

    # 层 1 写管理区
    if lessons_in:
        for f in sorted(agents_dir.glob("*.md")):
            changed, action = inject_into_file(f, lessons_in, args.dry)
            if changed:
                print("[层1] {} → {} (dry)" .format(f.name, action) if args.dry else "[层1] {} → {}".format(f.name, action))

    # 写报告
    if args.dry:
        print("\n[dry] 未写报告；以下为将写入 {} 的内容预览（前 60 行）：\n".format(report_path))
        print("\n".join(report.splitlines()[:60]))
    else:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(report, encoding="utf-8")
        print("\n[报告] 已写 {}".format(report_path))

    # stdout 摘要
    print("\n===== stdout 摘要 =====")
    print("层1：instinct {} 条 → 注入 {} 条（≥0.5，{} 个 agent 文件）/ 仅记录 {} 条".format(
        len(instincts), len(lessons_in), len(list(agents_dir.glob('*.md'))) if agents_dir.exists() else 0, len(lessons_out)))
    print("层2：runs {} 条（{} 完成）；K3 输入占比 {:.1%}（KPI≤30%/告警50%）；最大并发 {}；时长离群 {} 条；turns 离群 {} 条；blocked/handoff 点 {} 个".format(
        len(runs), sum(1 for r in runs if r["has_end"]), arch["k3_input_ratio"],
        arch["max_concurrency"], len(arch["outliers_dur"]), len(arch["outliers_turns"]), len(arch["blocked_points"])))
    for m, pm in sorted(arch["models"].items()):
        print("  模型 {}: {} 任务 / {} tok / {:.4f} 元 / {:.0f}s".format(
            m, pm["n"], pm["input"], pm["cost"], pm["dur"]))
    print("建议：自动应用 {} 条 / captain 裁决 {} 条 / 用户裁决 {} 条".format(
        len(sug["auto"]), len(sug["captain"]), len(sug["user"])))
    if not args.dry:
        print("\n请 captain 抽查管理区+裁决层 2 建议")


if __name__ == "__main__":
    main()

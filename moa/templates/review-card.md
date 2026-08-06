# 评审卡模板（review-card，多角色联合评审结构化留痕 · 供 Navigator 消费）

```yaml
review_card:
  topic: 评审主题
  run_id: review-<主题>-<日期>-<序号>
  captain: 调度模型
  lineup: [{role: analyst, model: ""}, {role: critic, model: ""}, {role: devil, model: ""}]
  skills_adopted: [采用的 skill 及理由]
  skills_rejected: [不采用及理由]

rounds:                              # 过程留痕（透明化要求：不只是 verdict）
  - round: 1
    actor_outputs: [{actor, verdict, key_findings: [带 文件:行号]}]
    key_disputes: [关键分歧点]
    rejected_proposals:              # 被否掉的方案+理由（最值钱的过程信息）
      - {proposal, rejected_by, reason}
  - round: 2
    cross_examination: [质询→回应摘要]
    position_changes: [谁修正了什么立场]

final_verdict: pass | pass_with_notes | fail | conditional
captain_ruling: [逐条裁决记录]
open_questions: [{question, owner: user|captain, threshold}]
misjudgment_events: [{actor, claim, reality, evidence}]   # 供 instinct YAML/可信度
tokens_by_model: {}
```

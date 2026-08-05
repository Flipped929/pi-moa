# 结果卡模板（子模型 → captain，≤300 字正文）

```yaml
result_card:
  status: done | partial | blocked | handoff
  summary: 结论（≤300字）
  artifacts: [产出文件路径]      # 细节在文件，卡里只有索引
  concerns: [风险/需上游决策的事，无则写"无"]

# status=handoff 时追加（对齐 Handoff-Protocol-v1.0 + dead_ends 反哺）
handoff_packet:
  suggest_next: k3 | <角色>
  what_done: 已完成的尝试（≤150字）
  current_state:
    files_touched: [...]
    decisions_made: [...]
  dead_ends: [确认走不通的路]    # 最值钱的部分
  open_question: 卡住的具体点
  artifacts: [...]

usage:                       # navigator 成本对比原料
  tokens_by_model: {}
  cost_actual: 0
```

# 任务卡模板（captain → 子模型）

```yaml
task_card:
  goal: 一句话目标
  scope: [可写路径列表]          # 写权限边界，多子模型时互不相交
  context_files: [需读路径]      # 不给全量历史，只给相关文件
  output: 结果卡要求（≤300字正文，落盘路径）
  playbook: 编码|评审|调研|写作|默认
  deadline_hint: 预计规模（分钟）

# 运行单元记录（对齐门禁检查表 §11/§9.3）
run_unit:
  session_id: ""
  run_id: ""
  actor: ""            # 角色+模型，如 executor@deepseek-v4-flash
  workspace_scope: ""  # 读写范围
  sandbox_profile: ""  # 权限边界
  risk_level: G0|G1|G2|G3
  approval_ref: ""
  tokens_by_model: {}  # {model: {input, output}} —— 成本对比原料
  cost_actual: 0
  cost_single_model_baseline: 0  # 同任务全 K3 估算值
```

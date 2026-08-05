#!/usr/bin/env bash
# pi-moa uninstaller — 移除安装的文件（不删你的策略/模板/黑板数据）
set -euo pipefail
PI_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"

echo "🐙 pi-moa uninstaller"
rm -f "$PI_DIR/extensions/moa-mode.ts" "$PI_DIR/extensions/scope-guard.ts"
rm -rf "$PI_DIR/extensions/subagent"
for a in executor analyst critic devil; do rm -f "$PI_DIR/agents/$a.md"; done
echo "✅ 已移除扩展与角色文件"
echo "ℹ️  保留：$PI_DIR/moa/（策略与模板）、各项目 .pi/moa/（黑板记录）——如需清理请手动删除"

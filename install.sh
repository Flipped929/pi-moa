#!/usr/bin/env bash
# pi-moa installer — 把多模型协作运行时装进 pi agent
# 用法: ./install.sh   （幂等；已有文件自动备份为 *.bak-时间戳）
set -euo pipefail

PI_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
SRC="$(cd "$(dirname "$0")" && pwd)"
TS=$(date +%Y%m%d-%H%M%S)

echo "🐙 pi-moa installer"
echo "   source: $SRC"
echo "   target: $PI_DIR"

command -v pi >/dev/null 2>&1 || { echo "⚠️ 未检测到 pi CLI，请先安装 pi agent"; exit 1; }

backup_if_exists() {
  local dst="$1"
  if [ -e "$dst" ]; then cp -R "$dst" "$dst.bak-$TS"; echo "   备份: $dst.bak-$TS"; fi
}

# 1. 扩展
mkdir -p "$PI_DIR/extensions/subagent"
backup_if_exists "$PI_DIR/extensions/moa-mode.ts"
cp "$SRC/extensions/moa-mode.ts" "$PI_DIR/extensions/moa-mode.ts"
backup_if_exists "$PI_DIR/extensions/navigator-watch.ts"
cp "$SRC/extensions/navigator-watch.ts" "$PI_DIR/extensions/navigator-watch.ts"
# scope-guard v3 起为目录结构；清理旧版平铺文件（避免双加载）
rm -f "$PI_DIR/extensions/scope-guard.ts"
mkdir -p "$PI_DIR/extensions/scope-guard"
for f in index.ts core.ts; do
  backup_if_exists "$PI_DIR/extensions/scope-guard/$f"
  cp "$SRC/extensions/scope-guard/$f" "$PI_DIR/extensions/scope-guard/$f"
done
for f in index.ts agents.ts; do
  backup_if_exists "$PI_DIR/extensions/subagent/$f"
  cp "$SRC/extensions/subagent/$f" "$PI_DIR/extensions/subagent/$f"
done

# 2. 角色（缺省模型为 roster 默认值，可改，见 docs/configuration.md）
mkdir -p "$PI_DIR/agents"
for f in "$SRC"/agents/*.md; do
  backup_if_exists "$PI_DIR/agents/$(basename "$f")"
  cp "$f" "$PI_DIR/agents/"
done

# 3. 模板与策略（不覆盖已有策略文件）
mkdir -p "$PI_DIR/moa/templates"
cp "$SRC"/moa/templates/*.md "$PI_DIR/moa/templates/"
if [ ! -f "$PI_DIR/moa/guard-policy.json" ]; then
  cp "$SRC/moa/guard-policy.example.json" "$PI_DIR/moa/guard-policy.json"
  echo "   已生成默认策略: $PI_DIR/moa/guard-policy.json（请按需修改）"
fi

echo ""
echo "✅ 安装完成。验证步骤："
echo "   1. 打开 pi，输入 /moa status —— 应看到 5 个角色 ✅"
echo "   2. /moa on 开启协同模式"
echo "   3. 跑 examples/demo-review 里的 5 分钟演示（见 README）"
echo ""
echo "📌 模型 roster：默认 executor/analyst/critic=deepseek-v4-flash, executor-k3/devil=kimi-coding/k3"
echo "   改成你持有的模型：编辑 $PI_DIR/agents/*.md 里的 model: 字段"

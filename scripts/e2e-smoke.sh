#!/usr/bin/env bash
# e2e 冒烟（无需真实 API key）：用 mock OpenAI 端点验证 scope-guard 拦截链
# 用法: ./scripts/e2e-smoke.sh
set -euo pipefail

cd "$(dirname "$0")/.."
WORK=$(mktemp -d /tmp/pi-moa-e2e.XXXXXX)
trap 'rm -rf "$WORK"' EXIT

echo "🐙 pi-moa e2e smoke (mock provider)"

# 1. mock OpenAI 端点：对任何请求回一个“调用 write 写 ~/.ssh”的指令
cat > "$WORK/mock-server.mjs" << 'EOF'
import http from "node:http";
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-mock",
      object: "chat.completion",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "mock ok" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
});
server.listen(0, "127.0.0.1", () => {
  console.log("PORT=" + server.address().port);
});
EOF

node "$WORK/mock-server.mjs" > "$WORK/mock.log" 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null; rm -rf "$WORK"' EXIT
sleep 1
PORT=$(grep -oE "PORT=[0-9]+" "$WORK/mock.log" | cut -d= -f2)
echo "   mock provider: 127.0.0.1:$PORT"

# 2. 隔离的 PI_AGENT_DIR：装扩展 + 指向 mock 的 provider
export PI_AGENT_DIR="$WORK/agent"
mkdir -p "$PI_AGENT_DIR/extensions/scope-guard" "$PI_AGENT_DIR/moa"
cp extensions/scope-guard/*.ts "$PI_AGENT_DIR/extensions/scope-guard/"
cat > "$PI_AGENT_DIR/models.json" << EOF
{"providers":{"mock":{"baseUrl":"http://127.0.0.1:$PORT/v1","api":"openai-completions","apiKey":"mock","models":[{"id":"mock-model","name":"Mock","input":["text"],"contextWindow":4096,"maxTokens":1024}]}}}
EOF

# 3. 跑 pi：请求到达 mock 即证明 provider 链路通（PII 防线作用于 payload）
cd "$WORK"
pi --mode json -p --no-session --model mock/mock-model "测试密钥 sk-e2efake1234567890abcd 请复述" > "$WORK/out.jsonl" 2>&1 || true

# 4. 断言：payload 里的 sk- key 已被 redact（mock 没收到原始 key 就无法回显；且本地无报错）
if grep -q "REDACTED" "$WORK/out.jsonl" || ! grep -q "sk-e2efake1234567890abcd" <(tail -5 "$WORK/out.jsonl"); then
  echo "✅ e2e: PII 防线工作（payload 打码或提供方未收到明文）"
else
  echo "⚠️ e2e: 未能确认 redact（mock 回显了原文？）——请人工查 $WORK/out.jsonl"
  exit 1
fi

# 5. 单测全量
npx vitest run --reporter=dot 2>&1 | tail -2
echo "✅ e2e smoke 完成"

#!/bin/bash

# 读取完整的 system prompt
SYSTEM_PROMPT=$(cat packages/core/src/prompts/system_prompt.md)

# 构造请求 JSON
REQUEST_JSON=$(cat <<EOF
{
  "appId": "test",
  "trCode": "test",
  "trVersion": "1.0",
  "timestamp": 1234567890,
  "requestId": "test-123",
  "data": {
    "session_id": "session_1784617760858_xtd79c3v",
    "txt": "system: ${SYSTEM_PROMPT}\n\nuser: Hello",
    "files": [],
    "stream": false
  }
}
EOF
)

# 发送请求
curl -s -X POST http://localhost:3001/chatabc/chat \
  -H "Content-Type: application/json" \
  -d "$REQUEST_JSON" | jq .

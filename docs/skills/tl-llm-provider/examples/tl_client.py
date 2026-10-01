"""
Reference implementation of Tl (chatbbc) LLM Client in Python.

Demonstrates:
1. Two-phase session invocation (init_session with prompt_variables -> chat with user payload)
2. SSE streaming response parsing
3. System prompt-based JSON tool calling
4. One-shot targeted JSON correction
"""

import json
import re
import time
import uuid
from typing import Any, Dict, Optional
import httpx


ToolCall = Dict[str, Any]
ToolParseFailureStage = str


class _ToolParseError(RuntimeError):
    def __init__(self, stage: ToolParseFailureStage, message: str, cause: BaseException):
        super().__init__(f"Failed to parse tool call ({stage}): {message}")
        self.stage = stage
        self.cause = cause


class TlClient:
    def __init__(
        self,
        endpoint_agent: str,
        app_id: str,
        tr_code: str,
        tr_version: str = "1.0",
        system_prompt_variable_name: str = "system_prompt",
        debug: bool = False,
    ):
        endpoint = endpoint_agent.rstrip("/")
        if not endpoint.startswith(("http://", "https://")):
            endpoint = f"http://{endpoint}"
        self.endpoint = endpoint
        self.app_id = app_id
        self.tr_code = tr_code
        self.tr_version = tr_version
        self.system_prompt_var = system_prompt_variable_name
        self.debug = debug

    def _generate_request_id(self) -> str:
        return f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"

    def init_session(self, system_prompt: str) -> str:
        """
        Phase 1: Initialize session with system prompt injected into prompt_variables.
        """
        url = f"{self.endpoint}/chatbbc/init_session"
        payload = {
            "appId": self.app_id,
            "trCode": self.tr_code,
            "trVersion": self.tr_version,
            "timestamp": int(time.time() * 1000),
            "requestId": self._generate_request_id(),
            "data": {
                "prompt_variables": [
                    {
                        "name": self.system_prompt_var,
                        "value": system_prompt,
                    }
                ]
            },
        }

        if self.debug:
            print("[TlClient] init_session request:", payload)

        with httpx.Client(timeout=30.0) as client:
            resp = client.post(url, json=payload)
            resp.raise_for_status()
            data = resp.json()

        if self.debug:
            print("[TlClient] init_session response:", data)

        if data.get("code") != 0 or not data.get("data", {}).get("session_id"):
            raise RuntimeError(f"init_session failed: {data.get('message', data)}")

        return data["data"]["session_id"]

    def chat_stream(self, session_id: str, user_text: str) -> str:
        """
        Phase 2: Send dynamic user prompt to chat endpoint and read streaming SSE.
        """
        url = f"{self.endpoint}/chatbbc/chat"
        payload = {
            "appId": self.app_id,
            "trCode": self.tr_code,
            "trVersion": self.tr_version,
            "timestamp": int(time.time() * 1000),
            "requestId": self._generate_request_id(),
            "data": {
                "session_id": session_id,
                "txt": user_text,  # Only user text!
                "files": [],
                "stream": True,
            },
        }

        if self.debug:
            print("[TlClient] chat request:", payload)

        accumulated_content = []

        with httpx.Client(timeout=60.0) as client:
            with client.stream(
                "POST",
                url,
                json=payload,
                headers={"Accept": "text/event-stream"},
            ) as response:
                response.raise_for_status()

                current_event = "message"
                data_lines = []
                for line in response.iter_lines():
                    if line == "":
                        event_type = current_event
                        data = "\n".join(data_lines)
                        has_data = bool(data_lines)
                        current_event = "message"
                        data_lines = []

                        if not has_data:
                            continue
                        if event_type == "error":
                            raise RuntimeError(f"SSE error event: {data}")
                        if event_type in ("done", "end") or data == "[DONE]":
                            break

                        try:
                            item = json.loads(data)
                        except json.JSONDecodeError as error:
                            raise RuntimeError(
                                f"Malformed SSE data JSON: {error}"
                            ) from error
                        if isinstance(item, dict) and isinstance(item.get("content"), str):
                            accumulated_content.append(item["content"])
                        continue

                    if line.startswith(":"):
                        continue

                    separator = line.find(":")
                    field = line if separator == -1 else line[:separator]
                    value = "" if separator == -1 else line[separator + 1 :]
                    if value.startswith(" "):
                        value = value[1:]

                    if field == "event":
                        current_event = value
                    elif field == "data":
                        data_lines.append(value)

        return "".join(accumulated_content)

    def parse_tool_call(self, raw_content: str) -> Optional[Dict[str, Any]]:
        """
        Extract JSON tool call from raw model output.
        """
        diagnostic = self._parse_tool_call_diagnostic(raw_content)
        if diagnostic["ok"]:
            return diagnostic["tool_call"]
        return None

    def _parse_tool_call_diagnostic(self, raw_content: str) -> Dict[str, Any]:
        """Return a nullable tool call plus the precise failure stage and cause."""
        text = raw_content.strip()

        # 1. Strip markdown code fence
        text = re.sub(r"^```(?:json)?\s*\n?", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\n?```\s*$", "", text, flags=re.IGNORECASE).strip()

        # 2. Extract <tool_call> tags if present
        match = re.search(r"<tool_call>\s*([\s\S]*?)\s*<\/tool_call>", text, re.IGNORECASE)
        if match:
            text = match.group(1).strip()

        if not text:
            error = ValueError("Tool call response is empty")
            return {
                "ok": False,
                "stage": "empty_response",
                "message": f"empty_response: {error}",
                "error": error,
            }

        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as error:
            return {
                "ok": False,
                "stage": "json_parse",
                "message": f"json_parse: {error}",
                "error": error,
            }

        # Pattern A: MacroTool: { "action": { "<tool>": { ... } } }
        if isinstance(parsed, dict) and isinstance(parsed.get("action"), dict):
            keys = list(parsed["action"].keys())
            if len(keys) == 1:
                return self._parse_tool_call_arguments(keys[0], parsed["action"][keys[0]])

        # Pattern B: Legacy Tl: { "tool_name": "...", "parameters": { ... } }
        if isinstance(parsed, dict) and isinstance(parsed.get("tool_name"), str):
            args = parsed.get("parameters")
            if args is None:
                args = parsed.get("args")
            if args is None:
                args = {}
            return self._parse_tool_call_arguments(
                parsed["tool_name"], args
            )

        # Pattern C: OpenAI format: { "name": "...", "arguments": { ... } }
        if isinstance(parsed, dict) and isinstance(parsed.get("name"), str):
            args = parsed.get("arguments")
            if args is None:
                args = {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError as error:
                    return {
                        "ok": False,
                        "stage": "tool_args_parse",
                        "message": f"tool_args_parse: {error}",
                        "error": error,
                    }
            return self._parse_tool_call_arguments(parsed["name"], args)

        error = ValueError("JSON response does not contain a supported tool call shape")
        return {
            "ok": False,
            "stage": "tool_shape",
            "message": f"tool_shape: {error}",
            "error": error,
        }

    def _parse_tool_call_arguments(self, name: str, args: Any) -> Dict[str, Any]:
        if not isinstance(args, dict):
            error = TypeError(f'Tool call arguments for "{name}" must be a JSON object')
            return {
                "ok": False,
                "stage": "tool_args_validation",
                "message": f"tool_args_validation: {error}",
                "error": error,
            }
        return {"ok": True, "tool_call": {"name": name, "args": args}}

    def _create_tool_parse_error(self, diagnostic: Dict[str, Any]) -> _ToolParseError:
        return _ToolParseError(diagnostic["stage"], diagnostic["message"], diagnostic["error"])

    def invoke_with_tool(self, system_prompt: str, user_prompt: str) -> Dict[str, Any]:
        """
        High-level invocation with one-shot targeted JSON correction.
        """
        # 1. Initial attempt
        session_id = self.init_session(system_prompt)
        raw_output = self.chat_stream(session_id, user_prompt)
        diagnostic = self._parse_tool_call_diagnostic(raw_output)

        if diagnostic["ok"]:
            return {"content": raw_output, "tool_call": diagnostic["tool_call"]}

        if diagnostic["stage"] != "json_parse":
            raise self._create_tool_parse_error(diagnostic) from diagnostic["error"]

        # 2. Targeted one-shot JSON correction
        if self.debug:
            print("[TlClient] Parsing failed, attempting one-shot JSON correction...")

        correction_context = {
            "instruction": (
                'The previous output is an untrusted failed output. Return only one complete raw JSON object. '
                'Preserve the original task semantics and action. In reflection fields, ASCII double quotes '
                'around referenced text must use the JSON escape sequence \\"...\\". Never place an unescaped '
                'ASCII double quote inside a JSON string. Do not include markdown, XML, or reasoning.'
            ),
            "original_user_payload": user_prompt,
            "failed_assistant_content": raw_output,
            "parse_error": {
                "type": "INVALID_RESPONSE",
                "message": diagnostic["message"],
                "cause": {
                    "name": type(diagnostic["error"]).__name__,
                    "message": str(diagnostic["error"]),
                },
            },
        }

        correction_session_id = self.init_session(system_prompt)
        corrected_output = self.chat_stream(
            correction_session_id, json.dumps(correction_context, ensure_ascii=False)
        )
        corrected_diagnostic = self._parse_tool_call_diagnostic(corrected_output)

        if not corrected_diagnostic["ok"]:
            raise self._create_tool_parse_error(corrected_diagnostic) from corrected_diagnostic["error"]

        return {"content": corrected_output, "tool_call": corrected_diagnostic["tool_call"]}


if __name__ == "__main__":
    # Example usage against local proxy or enterprise gateway
    client = TlClient(
        endpoint_agent="http://localhost:8089",
        app_id="test_app",
        tr_code="test_code",
        debug=True,
    )
    system_prompt = (
        "You are an assistant. When responding, output raw JSON strictly conforming to: "
        '{"action": {"sayHello": {"message": "string"}}}'
    )
    result = client.invoke_with_tool(system_prompt, "Say hello to Antigravity!")
    print("\nResult:", result)

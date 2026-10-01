import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("tl_client.py")
MODULE_SPEC = importlib.util.spec_from_file_location("tl_client_reference", MODULE_PATH)
if MODULE_SPEC is None or MODULE_SPEC.loader is None:
    raise RuntimeError(f"Unable to load {MODULE_PATH}")
tl_client_module = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(tl_client_module)
TlClient = tl_client_module.TlClient


class FakeResponse:
    def __init__(self, *, json_data=None, sse_text=None, status_code=200):
        self._json_data = json_data
        self._sse_lines = None if sse_text is None else sse_text.splitlines()
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._json_data

    def iter_lines(self):
        return iter(self._sse_lines or [])


class FakeHttpState:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []


class FakeClient:
    def __init__(self, state):
        self.state = state

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def post(self, url, json):
        self.state.requests.append(("post", url, json, None))
        return self._next_response()

    def stream(self, method, url, json, headers):
        self.state.requests.append((method, url, json, headers))
        return FakeStreamContext(self._next_response())

    def _next_response(self):
        if not self.state.responses:
            raise AssertionError("Unexpected HTTP request")
        return self.state.responses.pop(0)


class FakeStreamContext:
    def __init__(self, response):
        self.response = response

    def __enter__(self):
        return self.response

    def __exit__(self, exc_type, exc_value, traceback):
        return False


def init_response(session_id):
    return FakeResponse(json_data={"code": 0, "data": {"session_id": session_id}})


def stream_response(text):
    return FakeResponse(sse_text=text)


def chunk_event(content, event="chunk"):
    return f'event: {event}\ndata: {json.dumps({"content": content})}\n\n'


def done_event(event="done"):
    return f"event: {event}\ndata: {{\"finished\":true}}\n\n"


class TlClientReferenceTests(unittest.TestCase):
    def run_with_state(self, state, callback):
        with patch.object(
            tl_client_module.httpx,
            "Client",
            side_effect=lambda **kwargs: FakeClient(state),
        ):
            return callback()

    def create_client(self):
        return TlClient(
            endpoint_agent="http://tl.example.test",
            app_id="test-app",
            tr_code="test-code",
            tr_version="1.0",
        )

    def test_split_error_event_is_reported(self):
        state = FakeHttpState(
            [stream_response(f'{chunk_event("before-error")}event: error\ndata: gateway failure\n\n')]
        )

        with self.assertRaisesRegex(RuntimeError, "SSE error event: gateway failure"):
            self.run_with_state(state, lambda: self.create_client().chat_stream("session", "hello"))
        self.assertEqual(len(state.requests), 1)

    def test_done_event_stops_before_later_content(self):
        state = FakeHttpState(
            [stream_response(f'{chunk_event("kept")}{done_event()}{chunk_event("discarded")}')]
        )

        content = self.run_with_state(state, lambda: self.create_client().chat_stream("session", "hello"))
        self.assertEqual(content, "kept")

    def test_event_only_frame_resets_event_type(self):
        state = FakeHttpState(
            [stream_response('event: error\n\ndata: {"content":"kept"}\n\ndata: [DONE]\n\n')]
        )

        content = self.run_with_state(state, lambda: self.create_client().chat_stream("session", "hello"))
        self.assertEqual(content, "kept")

    def test_multiline_data_crlf_and_utf8(self):
        stream = "".join(
            [
                "event: message\r\n",
                'data: {"content":\r\n',
                'data: "你好"}\r\n',
                "\r\n",
                "data: [DONE]\r\n\r\n",
            ]
        )
        state = FakeHttpState([stream_response(stream)])

        content = self.run_with_state(state, lambda: self.create_client().chat_stream("session", "hello"))
        self.assertEqual(content, "你好")

    def test_lone_cr_and_unterminated_event(self):
        state = FakeHttpState(
            [stream_response('event: message\rdata: {"content":"kept"}\r\rdata: [DONE]\r\r')]
        )
        content = self.run_with_state(state, lambda: self.create_client().chat_stream("session", "hello"))
        self.assertEqual(content, "kept")

        state = FakeHttpState([stream_response('data: {"content":"ignored"}\n')])
        content = self.run_with_state(state, lambda: self.create_client().chat_stream("session", "hello"))
        self.assertEqual(content, "")

    def test_malformed_complete_sse_json_is_visible(self):
        state = FakeHttpState([stream_response("event: chunk\ndata: malformed\n\n")])

        with self.assertRaisesRegex(RuntimeError, "Malformed SSE data JSON"):
            self.run_with_state(state, lambda: self.create_client().chat_stream("session", "hello"))

    def test_chunk_and_message_content_are_accumulated(self):
        state = FakeHttpState(
            [stream_response(f'{chunk_event("first")}event: message\ndata: {{"content":" second"}}\n\n')]
        )

        content = self.run_with_state(state, lambda: self.create_client().chat_stream("session", "hello"))
        self.assertEqual(content, "first second")

    def test_parse_tool_call_remains_nullable_for_invalid_shapes(self):
        client = self.create_client()

        self.assertIsNone(client.parse_tool_call("null"))
        self.assertIsNone(client.parse_tool_call("[]"))
        self.assertIsNone(client.parse_tool_call('{"text":"ordinary response"}'))
        self.assertIsNone(client.parse_tool_call('{"name":"tool","arguments":"not-json"}'))
        self.assertIsNone(client.parse_tool_call('{"action":{"tool":null}}'))
        self.assertEqual(
            client.parse_tool_call('{"name":"tool","arguments":{"value":1}}'),
            {"name": "tool", "args": {"value": 1}},
        )

    def test_correction_has_actual_parse_error_and_same_system_prompt(self):
        system_prompt = "Keep the system contract"
        user_prompt = "Do the task"
        corrected = '{"action":{"sayHello":{"message":"hi"}}}'
        state = FakeHttpState(
            [
                init_response("initial-session"),
                stream_response(f'{chunk_event("not-json")}{done_event()}'),
                init_response("correction-session"),
                stream_response(f"{chunk_event(corrected)}{done_event()}"),
            ]
        )

        result = self.run_with_state(
            state, lambda: self.create_client().invoke_with_tool(system_prompt, user_prompt)
        )

        self.assertEqual(result["tool_call"], {"name": "sayHello", "args": {"message": "hi"}})
        init_requests = [request for request in state.requests if request[1].endswith("/init_session")]
        self.assertEqual(len(init_requests), 2)
        self.assertEqual(init_requests[0][2]["data"]["prompt_variables"][0]["value"], system_prompt)
        self.assertEqual(init_requests[1][2]["data"]["prompt_variables"][0]["value"], system_prompt)
        correction_chat = state.requests[3]
        self.assertEqual(correction_chat[2]["data"]["session_id"], "correction-session")
        correction_context = json.loads(correction_chat[2]["data"]["txt"])
        expected_error = None
        try:
            json.loads("not-json")
        except json.JSONDecodeError as error:
            expected_error = error
        self.assertIsNotNone(expected_error)
        self.assertEqual(correction_context["original_user_payload"], user_prompt)
        self.assertEqual(correction_context["failed_assistant_content"], "not-json")
        self.assertEqual(correction_context["parse_error"]["type"], "INVALID_RESPONSE")
        self.assertIn("json_parse", correction_context["parse_error"]["message"])
        self.assertEqual(
            correction_context["parse_error"]["cause"],
            {
                "name": type(expected_error).__name__,
                "message": str(expected_error),
            },
        )

    def test_non_json_parse_failures_do_not_retry(self):
        valid_non_tool = json.dumps({"text": "ordinary"})
        malformed_nested = json.dumps(
            {"name": "tool", "arguments": "not-json"}, separators=(",", ":")
        )
        cases = [
            ("empty response", done_event(), "empty_response"),
            ("valid non-tool JSON", chunk_event(valid_non_tool) + done_event(), "tool_shape"),
            (
                "malformed nested arguments",
                chunk_event(malformed_nested) + done_event(),
                "tool_args_parse",
            ),
            ("SSE error", "event: error\ndata: upstream failed\n\n", "SSE error event"),
        ]

        for case_name, stream, expected_error in cases:
            with self.subTest(case_name=case_name):
                state = FakeHttpState([init_response("session"), stream_response(stream)])
                with self.assertRaisesRegex(RuntimeError, expected_error):
                    self.run_with_state(state, lambda: self.create_client().invoke_with_tool("system", "user"))
                self.assertEqual(len(state.requests), 2)

    def test_failed_correction_makes_only_two_attempts(self):
        state = FakeHttpState(
            [
                init_response("initial-session"),
                stream_response(f'{chunk_event("not-json")}{done_event()}'),
                init_response("correction-session"),
                stream_response(f'{chunk_event("still-not-json")}{done_event()}'),
            ]
        )

        with self.assertRaisesRegex(RuntimeError, "json_parse"):
            self.run_with_state(state, lambda: self.create_client().invoke_with_tool("system", "user"))
        self.assertEqual(len(state.requests), 4)


if __name__ == "__main__":
    unittest.main()

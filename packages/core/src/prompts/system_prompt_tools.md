<macro_tool>
You have access to a set of tools that can be invoked through the `AgentOutput` macro tool. You MUST call the `AgentOutput` tool at every step. The `action` field in your output must contain exactly one tool call from the runtime tool definitions supplied with `AgentOutput` (or from the `<tools>` block in system-prompt tool-calling mode).

The output format is:

```json
{
    "evaluation_previous_goal": "...",
    "memory": "...",
    "next_goal": "...",
    "action": {
        "click_element_by_index": {
            "index": 12
        }
    }
}
```

The `click_element_by_index` action above is only an output-format example. Choose the action that matches the current goal.

Field semantics:

-   `evaluation_previous_goal`: Concise one-sentence analysis of your last action. Clearly state success, failure, or uncertain.
-   `memory`: 1-3 concise sentences of specific memory of this step and overall progress.
-   `next_goal`: State the next immediate goal and action to achieve it, in one clear sentence.
-   `action`: A single tool call. The key must be exactly the tool's `name` from the runtime tool definitions, and the value must match that tool's parameter schema.

Built-in action formats:

| Action                   | Parameters                                     | Purpose                                                                                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `done`                   | `{"text":"Task completed.","success":true}`    | Finish the task. `text` is required. `success` is optional and defaults to `true`; set it to `false` when the task is incomplete, failed, or uncertain.                                                                                            |
| `wait`                   | `{"seconds":1}`                                | Wait for the page to update. `seconds` must be a number from 1 to 10.                                                                                                                                                                              |
| `ask_user`               | `{"question":"Which option should I choose?"}` | Ask the user for missing information. `question` is required. This action is available only when a user-question callback is configured.                                                                                                           |
| `click_element_by_index` | `{"index":12}`                                 | Click an indexed interactive element. `index` must be a non-negative integer shown in `<browser_state>`.                                                                                                                                           |
| `input_text`             | `{"index":7,"text":"search terms"}`            | Click an indexed input, textarea, or contenteditable element and replace its text. Both `index` and `text` are required.                                                                                                                           |
| `select_dropdown_option` | `{"index":9,"text":"Option label"}`            | Select an option in an indexed native dropdown by its visible text. Both `index` and `text` are required.                                                                                                                                          |
| `scroll`                 | `{"down":true,"num_pages":0.5}`                | Scroll vertically. `down` defaults to `true`; use `false` to scroll up. Use either `num_pages` (0 to 10, default 0.1) or `pixels` (non-negative integer). Add an optional non-negative `index` to scroll an indexed container instead of the page. |
| `scroll_horizontally`    | `{"right":true,"pixels":300,"index":15}`       | Scroll horizontally. `right` defaults to `true`; `pixels` is a required non-negative integer. `index` is optional and targets an indexed container.                                                                                                |
| `execute_javascript`     | `{"script":"return document.title"}`           | Execute JavaScript in the current page. `script` is required. This action is available only when experimental script execution is enabled.                                                                                                         |

The runtime tool definitions are authoritative. Some built-in actions may be disabled, and custom actions may be added. Use an action only when its exact name and schema are present in the tool definitions supplied with `AgentOutput` or in the `<tools>` block.

CRITICAL RULES:

-   Call `AgentOutput` exactly once per step.
-   The `action` object must contain exactly one tool (do not call multiple tools in parallel).
-   Use the `done` tool to finish the task and reply to the user.
-   **STRICTLY FORBIDDEN**: You MUST use ONLY an exact tool name from the runtime tool definitions. DO NOT invent, abbreviate, or modify tool names. For example:
    -   ✅ CORRECT: `click_element_by_index`
    -   ❌ WRONG: `click`, `click_element`, `clickElement`
    -   ✅ CORRECT: `input_text`
    -   ❌ WRONG: `input`, `type_text`, `typeText`
-   If you need to perform an action not covered by these tools, use `done` to inform the user that the action is not available.
    </macro_tool>

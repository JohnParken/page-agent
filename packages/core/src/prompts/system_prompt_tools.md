<macro_tool>
You have access to a set of tools that can be invoked through the `AgentOutput` macro tool. You MUST call the `AgentOutput` tool at every step. The `action` field in your output must contain exactly one tool call from the tools provided in the `<tools>` block.

The output format is:

```json
{
    "evaluation_previous_goal": "...",
    "memory": "...",
    "next_goal": "...",
    "action": {
        "<tool_name>": {/* tool parameters */}
    }
}
```

Field semantics:

- `evaluation_previous_goal`: Concise one-sentence analysis of your last action. Clearly state success, failure, or uncertain.
- `memory`: 1-3 concise sentences of specific memory of this step and overall progress.
- `next_goal`: State the next immediate goal and action to achieve it, in one clear sentence.
- `action`: A single tool call. The key must be exactly the tool's `name` from the `<tools>` block, and the value is the tool's parameters object.

Available Tools (MUST use these exact names):

- `done`: Complete task and provide final response
- `wait`: Wait for specified seconds
- `ask_user`: Ask user a question
- `click_element_by_index`: Click element by its index
- `input_text`: Input text into an element
- `select_dropdown_option`: Select dropdown option
- `scroll`: Scroll vertically
- `scroll_horizontally`: Scroll horizontally
- `execute_javascript`: Execute JavaScript code

CRITICAL RULES:

- Call `AgentOutput` exactly once per step.
- The `action` object must contain exactly one tool (do not call multiple tools in parallel).
- Use the `done` tool to finish the task and reply to the user.
- **STRICTLY FORBIDDEN**: You MUST use ONLY the exact tool names listed above. DO NOT invent, abbreviate, or modify tool names. For example:
    - ✅ CORRECT: `click_element_by_index`
    - ❌ WRONG: `click`, `click_element`, `clickElement`
    - ✅ CORRECT: `input_text`
    - ❌ WRONG: `input`, `type_text`, `typeText`
- If you need to perform an action not covered by these tools, use `done` to inform the user that the action is not available.
  </macro_tool>

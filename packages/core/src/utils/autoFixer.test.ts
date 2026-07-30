import { describe, expect, it } from 'vitest'

import { normalizeResponse } from './autoFixer'

describe('normalizeResponse', () => {
	it('repairs paired unescaped quotes in JSON string values', () => {
		const rawContent =
			'{"evaluation_previous_goal": "成功打开了百度首页的新标签页，页面正在加载中。Verdict: Success","memory": "已打开百度首页（标签页 ID 1185995015），页面状态为 loading。下一步需要在百度搜索框中输入"微信"并执行搜索。","next_goal": "等待页面加载完成，然后在搜索框中输入"微信"并执行搜索。","action": {"wait": {"seconds": 2}}}'

		const normalized = normalizeResponse({
			choices: [
				{
					message: {
						role: 'assistant',
						content: rawContent,
					},
				},
			],
		})
		const args = JSON.parse(normalized.choices[0].message.tool_calls[0].function.arguments)

		expect(args).toEqual({
			evaluation_previous_goal: '成功打开了百度首页的新标签页，页面正在加载中。Verdict: Success',
			memory:
				'已打开百度首页（标签页 ID 1185995015），页面状态为 loading。下一步需要在百度搜索框中输入「微信」并执行搜索。',
			next_goal: '等待页面加载完成，然后在搜索框中输入「微信」并执行搜索。',
			action: { wait: { seconds: 2 } },
		})
	})
})

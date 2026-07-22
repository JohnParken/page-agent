import fs from 'fs'
import path from 'path'

// 读取 system_prompt.md
const systemPrompt = fs.readFileSync(
	path.join(process.cwd(), 'packages/core/src/prompts/system_prompt.md'),
	'utf-8'
)

const chatRequest = {
	appId: 'test',
	trCode: 'test',
	trVersion: '1.0',
	timestamp: Date.now(),
	requestId: 'test-chat-1',
	data: {
		session_id: 'session_test',
		txt: `system: ${systemPrompt}
user: 你好，请简单介绍一下你自己`,
		files: [],
		stream: false,
	},
}

console.log('📥 Testing chat with full system prompt...')
console.log(`System prompt length: ${systemPrompt.length} chars`)

const response = await fetch('http://localhost:8089/chatabc/chat', {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify(chatRequest),
})

const result = await response.json()
console.log('\n📤 Chat response:')
console.log(JSON.stringify(result, null, 2))

if (result.code === 0) {
	console.log('\n✅ Chat test passed!')
} else {
	console.log('\n❌ Chat test failed!')
	process.exit(1)
}

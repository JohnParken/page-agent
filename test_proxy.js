#!/usr/bin/env node
import fs from 'fs'
import path from 'path'

const SYSTEM_PROMPT = fs.readFileSync(
	path.join(process.cwd(), 'packages/core/src/prompts/system_prompt.md'),
	'utf-8'
)

async function testInitSession() {
	console.log('📥 Testing init_session...')
	const response = await fetch('http://localhost:3001/chatabc/init_session', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			appId: 'test',
			trCode: 'test',
			trVersion: '1.0',
			timestamp: 1234567890,
			requestId: 'test-123',
			data: {
				prompt_variables: [{ name: 'test', value: 'test' }],
			},
		}),
	})

	const data = await response.json()
	console.log('✅ init_session response:', JSON.stringify(data, null, 2))
	return data.data.session_id
}

async function testChat(sessionId) {
	console.log('\n📥 Testing chat...')
	const response = await fetch('http://localhost:3001/chatabc/chat', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			appId: 'test',
			trCode: 'test',
			trVersion: '1.0',
			timestamp: 1234567890,
			requestId: 'test-123',
			data: {
				session_id: sessionId,
				txt: `system: ${SYSTEM_PROMPT}\n\nuser: Hello`,
				files: [],
				stream: false,
			},
		}),
	})

	const data = await response.json()
	console.log('✅ chat response:', JSON.stringify(data, null, 2).substring(0, 500) + '...')
}

async function main() {
	try {
		const sessionId = await testInitSession()
		await testChat(sessionId)
		console.log('\n✅ All tests passed!')
	} catch (error) {
		console.error('❌ Test failed:', error)
		process.exit(1)
	}
}

main()

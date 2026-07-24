/**
 * 简单测试脚本，验证 TlProxyServer 是否正常工作
 * 直接测试代理的 HTTP 端点，不依赖完整的 TlClient
 */

const PROXY_URL = 'http://localhost:8089'

async function testInitSession() {
	console.log('📡 Testing /chatbbc/init_session...')

	const response = await fetch(`${PROXY_URL}/chatbbc/init_session`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			appId: 'test-app',
			trCode: 'test-code',
			trVersion: '1.0',
			timestamp: Date.now(),
			requestId: 'test-request-1',
			data: {
				prompt_variables: [{ name: 'name', value: 'qwen3.5-plus' }],
			},
		}),
	})

	if (!response.ok) {
		throw new Error(`Init session failed: ${response.status}`)
	}

	const result = await response.json()
	console.log('✅ Init session response:', result)

	if (result.code === 0 && result.data?.session_id) {
		console.log('✅ Session created successfully!')
		return result.data.session_id
	} else {
		throw new Error('Invalid response format')
	}
}

async function testChat(sessionId: string) {
	console.log('\n📡 Testing /chatbbc/chat...')

	const response = await fetch(`${PROXY_URL}/chatbbc/chat`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			appId: 'test-app',
			trCode: 'test-code',
			trVersion: '1.0',
			timestamp: Date.now(),
			requestId: 'test-request-2',
			data: {
				session_id: sessionId,
				txt: 'user: Hello, please respond with a simple JSON {"tool_name": "test", "parameters": {}}',
				files: [],
				stream: true,
			},
		}),
	})

	if (!response.ok) {
		throw new Error(`Chat failed: ${response.status}`)
	}

	const result = await response.text()
	console.log('✅ Chat response:', result)
	return result
}

async function main() {
	console.log('='.repeat(60))
	console.log('🧪 Testing TlProxyServer')
	console.log('='.repeat(60))

	try {
		// Test 1: Init session
		const sessionId = await testInitSession()

		// Test 2: Chat
		await testChat(sessionId)

		console.log('\n' + '='.repeat(60))
		console.log('🎉 All tests passed!')
		console.log('='.repeat(60))
		console.log('\nTlProxyServer is working correctly!')
		console.log('You can now use it with TlAiClient.')
	} catch (error) {
		console.error('\n❌ Test failed:', error)
		console.log('\nMake sure the proxy server is running:')
		console.log('  tsx src/TlProxyServer.ts')
		process.exit(1)
	}
}

// Run the tests
main()

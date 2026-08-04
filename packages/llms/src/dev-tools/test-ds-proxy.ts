/**
 * Smoke test for a running DsProxyServer.
 *
 * This script intentionally talks to the local proxy only. The proxy owns the
 * DeepSeek API key and performs the upstream request on behalf of this client.
 */

export {}

const PROXY_URL = (process.env.DS_PROXY_URL || 'http://127.0.0.1:8090').replace(/\/$/, '')

async function initSession(): Promise<string> {
	const response = await fetch(`${PROXY_URL}/chatbbc/init_session`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			appId: 'ds-proxy-smoke-test',
			trCode: 'smoke-test',
			trVersion: '1.0',
			timestamp: Date.now(),
			requestId: `smoke-${Date.now()}`,
			data: {
				prompt_variables: [{ name: 'name', value: process.env.DEEPSEEK_MODEL || 'deepseek-chat' }],
			},
		}),
	})
	if (!response.ok)
		throw new Error(`init_session failed: HTTP ${response.status} ${await response.text()}`)

	const payload = (await response.json()) as { data?: { session_id?: string } }
	if (!payload.data?.session_id)
		throw new Error('init_session response did not include data.session_id')
	return payload.data.session_id
}

async function testChat(sessionId: string): Promise<void> {
	const response = await fetch(`${PROXY_URL}/chatbbc/chat`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
		body: JSON.stringify({
			appId: 'ds-proxy-smoke-test',
			trCode: 'smoke-test',
			trVersion: '1.0',
			timestamp: Date.now(),
			requestId: `smoke-chat-${Date.now()}`,
			data: {
				session_id: sessionId,
				txt: 'system: Return a JSON object describing the result.\nuser: Reply with a short JSON greeting.',
				files: [],
				stream: true,
			},
		}),
	})
	const text = await response.text()
	if (!response.ok) throw new Error(`chat failed: HTTP ${response.status} ${text}`)
	if (!text.includes('event: chunk') || !text.includes('event: done')) {
		throw new Error(`chat response was not chatbbc SSE:\n${text}`)
	}
	console.log('✅ DsProxy chat response:\n', text)
}

async function main(): Promise<void> {
	console.log(`🧪 Testing DsProxyServer at ${PROXY_URL}`)
	const sessionId = await initSession()
	console.log('✅ Session created:', sessionId)
	await testChat(sessionId)
	console.log('🎉 DsProxyServer smoke test passed')
}

main().catch((error: unknown) => {
	console.error('❌ DsProxyServer smoke test failed:', error)
	console.error('Start the proxy first with: npm run start:ds-proxy')
	process.exitCode = 1
})

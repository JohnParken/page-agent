import { TlAiClient } from '../TlClient'
import { TlProxyServer } from './TlProxyServer'

// Configuration
const PROXY_PORT = 8089
const QWEN_BASE_URL = 'https://page-ag-testing-ohftxirgbn.cn-shanghai.fcapp.run'
const QWEN_MODEL = 'qwen3.5-plus'

async function testTlClientWithProxy() {
	console.log('='.repeat(60))
	console.log('Starting TlProxyServer...')
	console.log('='.repeat(60))

	// Start the proxy server
	const proxy = new TlProxyServer({
		port: PROXY_PORT,
		qwenBaseUrl: QWEN_BASE_URL,
		qwenModel: QWEN_MODEL,
	})
	proxy.start()

	// Wait a bit for server to start
	await new Promise((resolve) => setTimeout(resolve, 1000))

	console.log('\n' + '='.repeat(60))
	console.log('Testing TlAiClient with proxy...')
	console.log('='.repeat(60))

	// Test TlAiClient with the proxy
	try {
		const client = new TlAiClient({
			endpointAgent: `localhost:${PROXY_PORT}`, // Use http protocol in client
			model: 'test-model',
			appId: 'test-app',
			trCode: 'test-code',
			trVersion: '1.0',
		})

		console.log('✓ TlAiClient created successfully')
		console.log('  - endpointAgent:', `localhost:${PROXY_PORT}`)

		console.log('\nTesting complete!')
		console.log('You can now use:')
		console.log('  - endpointAgent: "localhost:8089"')
		console.log('  - in your TlAiClient configuration')
		console.log('\nPress Ctrl+C to stop the proxy server')
	} catch (error) {
		console.error('Error testing TlAiClient:', error)
		proxy.stop()
		process.exit(1)
	}
}

// Only run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
	testTlClientWithProxy()
}

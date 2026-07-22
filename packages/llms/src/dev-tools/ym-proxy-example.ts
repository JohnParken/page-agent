import { YimingAiClient } from './YmClient'
import { YmProxyServer } from './YmProxyServer'

// Configuration
const PROXY_PORT = 8089
const QWEN_BASE_URL = 'https://page-ag-testing-ohftxirgbn.cn-shanghai.fcapp.run'
const QWEN_MODEL = 'qwen3.5-plus'

async function testYmClientWithProxy() {
	console.log('='.repeat(60))
	console.log('Starting YmProxyServer...')
	console.log('='.repeat(60))

	// Start the proxy server
	const proxy = new YmProxyServer({
		port: PROXY_PORT,
		qwenBaseUrl: QWEN_BASE_URL,
		qwenModel: QWEN_MODEL,
	})
	proxy.start()

	// Wait a bit for server to start
	await new Promise((resolve) => setTimeout(resolve, 1000))

	console.log('\n' + '='.repeat(60))
	console.log('Testing YimingAiClient with proxy...')
	console.log('='.repeat(60))

	// Test YimingAiClient with the proxy
	try {
		const client = new YimingAiClient({
			endpointAgent: `localhost:${PROXY_PORT}`, // Use http protocol in client
			model: 'test-model',
			appId: 'test-app',
			trCode: 'test-code',
			trVersion: '1.0',
		})

		console.log('✓ YimingAiClient created successfully')
		console.log('  - endpointAgent:', `localhost:${PROXY_PORT}`)

		console.log('\nTesting complete!')
		console.log('You can now use:')
		console.log('  - endpointAgent: "localhost:8089"')
		console.log('  - in your YimingAiClient configuration')
		console.log('\nPress Ctrl+C to stop the proxy server')
	} catch (error) {
		console.error('Error testing YimingAiClient:', error)
		proxy.stop()
		process.exit(1)
	}
}

// Only run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
	testYmClientWithProxy()
}

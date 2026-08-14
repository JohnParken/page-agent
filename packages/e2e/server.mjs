import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as dotenvConfig } from 'dotenv'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(currentDirectory, '../..')
const fixturesDirectory = resolve(currentDirectory, 'fixtures')
const controllerDistDirectory = resolve(currentDirectory, '../page-controller/dist/lib')
const controllerIifeDistDirectory = resolve(currentDirectory, '../page-controller/dist/iife')
const pageAgentDistDirectory = resolve(currentDirectory, '../page-agent/dist/iife')

const DEFAULT_TL_ENDPOINT_AGENT = 'http://localhost:8089'
const TL_PROXY_PATH_PREFIX = '/api/tl'
const HOP_BY_HOP_HEADERS = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
])

// Load .env from project root
dotenvConfig({ path: resolve(projectRoot, '.env') })

/**
 * LLM configuration env vars, exposed to the browser via /api/env-config.
 * Prefix with PUBLIC_LLM_ to keep them separate from other env vars.
 */
function getEnvConfig() {
	return {
		LLM_PROVIDER: process.env.LLM_PROVIDER || 'tlclient',
		LLM_MODEL_NAME: process.env.LLM_MODEL_NAME || 'qwen3.5-plus',
		OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || '',
		OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
		TL_ENDPOINT_AGENT: process.env.TL_ENDPOINT_AGENT || DEFAULT_TL_ENDPOINT_AGENT,
		TL_APP_ID: process.env.TL_APP_ID || '',
		TL_TR_CODE: process.env.TL_TR_CODE || '',
		TL_TR_VERSION: process.env.TL_TR_VERSION || '',
		TL_TOOL_CALLING_MODE: process.env.TL_TOOL_CALLING_MODE || 'system_prompt',
	}
}

const contentTypes = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
}

const MAX_DEMO_REQUEST_BYTES = 1_000_000
let mockTlSessionSequence = 0

async function readJsonRequest(request) {
	let body = ''
	for await (const chunk of request) {
		body += chunk
		if (Buffer.byteLength(body) > MAX_DEMO_REQUEST_BYTES) {
			throw new Error('Demo request body is too large')
		}
	}
	return JSON.parse(body || '{}')
}

function indexedElement(prompt, id) {
	const line = prompt.split('\n').find((candidate) => candidate.includes(`id=${id}`))
	const match = line?.match(/\[(\d+)\]/)
	return match ? Number(match[1]) : undefined
}

function demoAgentOutput(prompt) {
	const completedSteps = prompt.match(/<step_\d+>/g)?.length ?? 0
	const actions = [
		{ id: 'parent-button', name: 'click_element_by_index', input: {} },
		{
			id: 'parent-input',
			name: 'input_text',
			input: { text: 'PageAgent Demo' },
		},
		{
			id: 'parent-select',
			name: 'select_dropdown_option',
			input: { text: 'Pro' },
		},
	]

	const action = actions[completedSteps]
	if (!action) {
		return {
			evaluation_previous_goal: 'The requested parent-page changes are visible.',
			memory: 'The button, input, and plan selection were updated.',
			next_goal: 'Finish the task.',
			action: {
				done: {
					text: '父页面操作已完成。',
					success: true,
				},
			},
		}
	}

	const index = indexedElement(prompt, action.id)
	if (index === undefined) {
		return {
			evaluation_previous_goal: 'The required parent element was not available.',
			memory: 'The scoped parent state did not expose the requested element.',
			next_goal: 'Stop without guessing an index.',
			action: {
				done: {
					text: `未找到父页面元素 ${action.id}。`,
					success: false,
				},
			},
		}
	}

	return {
		evaluation_previous_goal:
			completedSteps === 0 ? 'The task has started.' : 'The previous action completed.',
		memory: `Completed ${completedSteps} parent-page action(s).`,
		next_goal: `Operate ${action.id}.`,
		action: {
			[action.name]: {
				index,
				...action.input,
			},
		},
	}
}

function writeJson(response, status, value) {
	response
		.writeHead(status, {
			'Cache-Control': 'no-store',
			'Content-Type': 'application/json; charset=utf-8',
		})
		.end(JSON.stringify(value))
}

function headerTokens(value) {
	if (typeof value !== 'string') return new Set()
	return new Set(
		value
			.split(',')
			.map((token) => token.trim().toLowerCase())
			.filter(Boolean)
	)
}

function getProxyHeaders(headers, target) {
	const connectionTokens = headerTokens(headers.connection)
	const proxyHeaders = {}
	for (const [name, value] of Object.entries(headers)) {
		const lowerName = name.toLowerCase()
		if (HOP_BY_HOP_HEADERS.has(lowerName) || connectionTokens.has(lowerName)) continue
		if (value !== undefined) proxyHeaders[name] = value
	}
	proxyHeaders.host = target.host
	return proxyHeaders
}

function getForwardedResponseHeaders(headers) {
	const connectionTokens = headerTokens(headers.connection)
	const forwardedHeaders = {}
	for (const [name, value] of Object.entries(headers)) {
		const lowerName = name.toLowerCase()
		if (
			HOP_BY_HOP_HEADERS.has(lowerName) ||
			connectionTokens.has(lowerName) ||
			lowerName.startsWith('access-control-')
		)
			continue
		if (value !== undefined) forwardedHeaders[name] = value
	}
	return forwardedHeaders
}

function resolveTlProxyTarget(pathname, search) {
	const configuredEndpoint = process.env.TL_ENDPOINT_AGENT?.trim() || DEFAULT_TL_ENDPOINT_AGENT
	const endpointCandidate = /^[a-z][a-z\d+.-]*:\/\//i.test(configuredEndpoint)
		? configuredEndpoint
		: `http://${configuredEndpoint}`

	let endpoint
	try {
		endpoint = new URL(endpointCandidate)
	} catch {
		throw new Error('TL_ENDPOINT_AGENT must be a valid HTTP(S) URL')
	}
	if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
		throw new Error('TL_ENDPOINT_AGENT must use the http:// or https:// protocol')
	}

	const endpointPath = endpoint.pathname.replace(/\/+$/, '')
	const proxyPath = pathname.startsWith(TL_PROXY_PATH_PREFIX)
		? pathname.slice(TL_PROXY_PATH_PREFIX.length)
		: pathname
	endpoint.pathname = `${endpointPath}/${proxyPath.replace(/^\/+/, '')}`
	endpoint.search = search
	endpoint.hash = ''
	return endpoint
}

function writeTlProxyError(response, error, status = 502) {
	if (response.headersSent || response.destroyed) {
		response.destroy()
		return
	}
	const code = typeof error?.code === 'string' ? error.code : 'UPSTREAM_CONNECTION_ERROR'
	writeJson(response, status, {
		error: 'TL upstream connection failed',
		message: `Unable to connect to the TL endpoint (${code}). Check TL_ENDPOINT_AGENT and verify that the service is reachable.`,
	})
}

function proxySameOriginTlRequest(request, response, requestURL) {
	let target
	try {
		target = resolveTlProxyTarget(requestURL.pathname, requestURL.search)
	} catch (error) {
		writeTlProxyError(response, error, 502)
		return
	}

	const transport = target.protocol === 'https:' ? httpsRequest : httpRequest
	let upstreamRequest
	try {
		upstreamRequest = transport(
			target,
			{
				method: request.method,
				headers: getProxyHeaders(request.headers, target),
			},
			(upstreamResponse) => {
				const statusCode = upstreamResponse.statusCode || 502
				const forwardedHeaders = getForwardedResponseHeaders(upstreamResponse.headers)
				if (upstreamResponse.statusMessage) {
					response.writeHead(statusCode, upstreamResponse.statusMessage, forwardedHeaders)
				} else {
					response.writeHead(statusCode, forwardedHeaders)
				}
				upstreamResponse.on('error', (error) => {
					if (!response.writableEnded) response.destroy(error)
				})
				upstreamResponse.pipe(response)
			}
		)
	} catch (error) {
		writeTlProxyError(response, error)
		return
	}

	upstreamRequest.on('error', (error) => writeTlProxyError(response, error))
	request.on('aborted', () => upstreamRequest.destroy())
	request.on('close', () => {
		if (!request.complete) upstreamRequest.destroy()
	})
	response.on('close', () => {
		if (!response.writableEnded) upstreamRequest.destroy()
	})
	request.pipe(upstreamRequest)
}

async function serveSameOriginTlDemo(request, response, pathname) {
	if (request.method !== 'POST') {
		response.writeHead(405, { Allow: 'POST' }).end('Method not allowed')
		return
	}

	const body = await readJsonRequest(request)
	if (pathname.endsWith('/init_session')) {
		writeJson(response, 200, {
			code: 0,
			message: 'success',
			data: { session_id: `parent-bridge-demo-${++mockTlSessionSequence}` },
		})
		return
	}

	const prompt = typeof body?.data?.txt === 'string' ? body.data.txt : ''
	const content = JSON.stringify(demoAgentOutput(prompt))
	const splitAt = Math.ceil(content.length / 2)
	const stream =
		[content.slice(0, splitAt), content.slice(splitAt)]
			.map(
				(chunk, index) =>
					`id: ${index}\nevent: chunk\ndata: ${JSON.stringify({ content: chunk })}\n\n`
			)
			.join('') + 'event: done\ndata: {"finished":true}\n\n'

	response
		.writeHead(200, {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/event-stream; charset=utf-8',
		})
		.end(stream)
}

function resolveInside(root, relativePath) {
	const filePath = resolve(root, relativePath)
	if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) return null
	return filePath
}

function createFixtureServer(port) {
	const server = createServer(async (request, response) => {
		try {
			const requestURL = new URL(request.url || '/', `http://127.0.0.1:${port}`)
			if (requestURL.pathname === '/health') {
				response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('ok')
				return
			}

			if (
				port === 4174 &&
				(requestURL.pathname === '/api/tl/chatbbc/init_session' ||
					requestURL.pathname === '/api/tl/chatbbc/chat')
			) {
				if (process.env.PARENT_BRIDGE_DEMO_MOCK_TL === '1') {
					await serveSameOriginTlDemo(request, response, requestURL.pathname)
				} else {
					proxySameOriginTlRequest(request, response, requestURL)
				}
				return
			}

			// Expose LLM env config to the browser
			if (requestURL.pathname === '/api/env-config') {
				response.writeHead(200, {
					'Content-Type': 'application/json',
					'Cache-Control': 'no-store',
					'Access-Control-Allow-Origin': '*',
				})
				response.end(JSON.stringify(getEnvConfig()))
				return
			}

			const isLibraryAsset = requestURL.pathname.startsWith('/lib/')
			const isControllerIifeAsset = requestURL.pathname.startsWith('/controller-iife/')
			const isPageAgentAsset = requestURL.pathname.startsWith('/page-agent/')
			const relativePath = decodeURIComponent(requestURL.pathname)
				.replace(
					isLibraryAsset
						? /^\/lib\//
						: isControllerIifeAsset
							? /^\/controller-iife\//
							: isPageAgentAsset
								? /^\/page-agent\//
								: /^\/+/,
					''
				)
				.replace(/^\/+/, '')
			const root = isLibraryAsset
				? controllerDistDirectory
				: isControllerIifeAsset
					? controllerIifeDistDirectory
					: isPageAgentAsset
						? pageAgentDistDirectory
						: fixturesDirectory
			const filePath = resolveInside(root, relativePath || 'host.html')
			if (!filePath) {
				response.writeHead(403).end('Forbidden')
				return
			}

			const fileStats = await stat(filePath)
			if (!fileStats.isFile()) throw new Error('Not a file')

			const securityHeaders = {}
			if (requestURL.pathname === '/reverse-child.html') {
				securityHeaders['Content-Security-Policy'] =
					"frame-ancestors http://127.0.0.1:4173 http://127.0.0.1:4175; connect-src 'self'"
			}
			if (requestURL.pathname === '/reverse-parent.html') {
				securityHeaders['Content-Security-Policy'] = 'frame-src http://127.0.0.1:4174'
			}

			response.writeHead(200, {
				'Cache-Control': 'no-store',
				'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream',
				...securityHeaders,
			})
			createReadStream(filePath).pipe(response)
		} catch {
			response.writeHead(404).end('Not found')
		}
	})

	server.listen(port, '127.0.0.1')
	return server
}

// 4173 and 4175 represent two independently deployed parent applications;
// 4174 is the shared assistant/Vue child origin used by reverse parent-bridge
// tests. Keeping all listeners explicit makes origin/source checks observable.
const servers = [createFixtureServer(4173), createFixtureServer(4174), createFixtureServer(4175)]

function shutdown() {
	let remaining = servers.length
	for (const server of servers) {
		server.close(() => {
			remaining -= 1
			if (remaining === 0) process.exit(0)
		})
	}
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

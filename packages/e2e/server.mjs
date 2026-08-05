import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as dotenvConfig } from 'dotenv'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(currentDirectory, '../..')
const fixturesDirectory = resolve(currentDirectory, 'fixtures')
const controllerDistDirectory = resolve(currentDirectory, '../page-controller/dist/lib')
const controllerIifeDistDirectory = resolve(currentDirectory, '../page-controller/dist/iife')
const pageAgentDistDirectory = resolve(currentDirectory, '../page-agent/dist/iife')

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
		TL_ENDPOINT_AGENT: process.env.TL_ENDPOINT_AGENT || 'localhost:8089',
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

			response.writeHead(200, {
				'Cache-Control': 'no-store',
				'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream',
			})
			createReadStream(filePath).pipe(response)
		} catch {
			response.writeHead(404).end('Not found')
		}
	})

	server.listen(port, '127.0.0.1')
	return server
}

const servers = [createFixtureServer(4173), createFixtureServer(4174)]

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

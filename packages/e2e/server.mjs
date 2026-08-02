import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const fixturesDirectory = resolve(currentDirectory, 'fixtures')
const controllerDistDirectory = resolve(currentDirectory, '../page-controller/dist/lib')

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

			const isLibraryAsset = requestURL.pathname.startsWith('/lib/')
			const relativePath = decodeURIComponent(requestURL.pathname)
				.replace(isLibraryAsset ? /^\/lib\// : /^\/+/, '')
				.replace(/^\/+/, '')
			const root = isLibraryAsset ? controllerDistDirectory : fixturesDirectory
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

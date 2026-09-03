#!/usr/bin/env node
import { spawn } from 'child_process'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { createServer } from 'http'
import { dirname, extname, resolve, sep } from 'path'
import { fileURLToPath } from 'url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pageAgentDir = resolve(rootDir, 'packages/page-agent')
const outputDir = resolve(pageAgentDir, 'dist/iife')
const port = Number(process.env.PORT || 5174)
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const contentTypes = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
}

const builder = spawn(npmCommand, ['run', 'build:demo', '--', '--watch', '--mode', 'development'], {
	cwd: pageAgentDir,
	stdio: 'inherit',
})

const server = createServer(async (request, response) => {
	try {
		const requestURL = new URL(request.url || '/', 'http://localhost')
		const relativePath = decodeURIComponent(requestURL.pathname).replace(/^\/+/, '')
		const filePath = resolve(outputDir, relativePath || 'test-page.html')

		if (filePath !== outputDir && !filePath.startsWith(`${outputDir}${sep}`)) {
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

server.on('error', (error) => {
	if (!builder.killed) builder.kill('SIGTERM')
	console.error(`Failed to start the IIFE demo server: ${error.message}`)
	process.exit(1)
})

server.listen(port, '127.0.0.1', () => {
	console.log(`PageAgent IIFE demo: http://localhost:${port}/test-page.html`)
})

function shutdown(exitCode = 0) {
	if (!builder.killed) builder.kill('SIGTERM')
	server.close(() => process.exit(exitCode))
}

builder.on('exit', (code, signal) => {
	if (signal || code === 0) return
	console.error(`IIFE build watcher exited with code ${code}`)
	shutdown(code || 1)
})

process.on('SIGINT', () => shutdown())
process.on('SIGTERM', () => shutdown())

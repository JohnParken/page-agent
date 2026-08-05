#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const bundles = [
	{
		label: 'parent bridge',
		directory: resolve(repositoryRoot, 'packages/page-agent/dist/iife'),
		fileName: 'page-agent-frame-bridge.iife.min.js',
		globalName: 'PageAgentFrameBridge',
		prefix: 'page-agent-frame-bridge',
		allowedOtherJavaScript: ['page-agent.demo.js'],
	},
	{
		label: 'child host',
		directory: resolve(repositoryRoot, 'packages/page-controller/dist/iife'),
		fileName: 'page-agent-frame-host.iife.min.js',
		globalName: 'PageAgentFrameHost',
		prefix: 'page-agent-frame-host',
		allowedOtherJavaScript: [],
	},
]

const forbiddenPatterns = [
	[/@page-agent\//, 'a bare @page-agent dependency'],
	[/\brequire\s*\(/, 'a CommonJS require call'],
	[/\bimport\s*\(/, 'a dynamic import'],
	[/\bnode:(?:fs|path|crypto|http|url)\b/, 'a Node built-in module'],
]

for (const bundle of bundles) {
	const entries = await readdir(bundle.directory)
	const unexpectedJavaScript = entries.filter(
		(entry) =>
			entry.endsWith('.js') &&
			entry !== bundle.fileName &&
			!bundle.allowedOtherJavaScript.includes(entry)
	)
	if (unexpectedJavaScript.length > 0) {
		throw new Error(
			`${bundle.label} output contains unexpected JavaScript chunks: ${unexpectedJavaScript.join(
				', '
			)}`
		)
	}
	const relatedJavaScript = entries.filter(
		(entry) => entry.startsWith(bundle.prefix) && entry.endsWith('.js')
	)
	if (relatedJavaScript.length !== 1 || relatedJavaScript[0] !== bundle.fileName) {
		throw new Error(
			`${bundle.label} must produce exactly ${bundle.fileName}; found: ${
				relatedJavaScript.join(', ') || 'none'
			}`
		)
	}

	const filePath = resolve(bundle.directory, bundle.fileName)
	const sourceMapPath = `${filePath}.map`
	if ((await stat(filePath)).size === 0) throw new Error(`${bundle.label} bundle is empty`)
	if ((await stat(sourceMapPath)).size === 0) throw new Error(`${bundle.label} source map is empty`)

	const source = await readFile(filePath, 'utf8')
	for (const [pattern, description] of forbiddenPatterns) {
		if (pattern.test(source)) throw new Error(`${bundle.label} contains ${description}`)
	}
	if (!source.includes(bundle.globalName)) {
		throw new Error(`${bundle.label} does not declare ${bundle.globalName}`)
	}
}

console.log('Verified standalone iframe bridge IIFE bundles.')

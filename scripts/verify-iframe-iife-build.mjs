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
		allowedOtherJavaScript: ['page-agent-parent-host.iife.min.js'],
		requiredPatterns: [
			[/prepare-action/, 'iframe bridge v2 prepare phase'],
			[/commit-action/, 'iframe bridge v2 commit phase'],
		],
	},
	{
		label: 'parent-page host',
		directory: resolve(repositoryRoot, 'packages/page-controller/dist/iife'),
		fileName: 'page-agent-parent-host.iife.min.js',
		globalName: 'PageAgentParentHost',
		prefix: 'page-agent-parent-host',
		allowedOtherJavaScript: ['page-agent-frame-host.iife.min.js'],
		requiredPatterns: [
			[/authorized-child-frames/, 'authorized child-frame observation marker'],
			[/childFrames/, 'child-frame authorization configuration'],
			[/prepare-action/, 'child-frame prepare phase'],
			[/commit-action/, 'child-frame commit phase'],
		],
		forbiddenPatterns: [
			[/\bPageAgentCore\b/, 'PageAgentCore'],
			[/\bTlAiClient\b/, 'TlAiClient'],
			[/\bOpenAIClient\b/, 'OpenAIClient'],
			[/\bPanel\b/, 'UI Panel code'],
		],
		requiredAssets: ['page-agent-parent-host.css'],
		requiredAssetPatterns: [
			[/\.page-agent-parent-feedback/, 'parent feedback class'],
			[/data-page-agent-parent-feedback/, 'parent feedback marker'],
			[/data-page-agent-parent-cursor/, 'parent visual cursor marker'],
			[
				/--page-agent-parent-cursor-width-resolved\s*:\s*var\(--page-agent-parent-cursor-width,/,
				'inheritable parent cursor variables',
			],
			[/--page-agent-parent-cursor-ripple-radius/, 'cursor hotspot ripple configuration'],
			[/--page-agent-parent-cursor-gradient-start/, 'main cursor gradient configuration'],
			[/mask-image\s*:\s*url\('data:image\/svg\+xml;base64,/, 'main cursor SVG mask'],
			[/rotate\(-135deg\)\s+scale\(1\.2\)/, 'main cursor orientation'],
			[/position\s*:\s*fixed/, 'fixed parent visual feedback positioning'],
			[/pointer-events\s*:\s*none\s*!important/, 'non-blocking visual feedback policy'],
			[/@keyframes\s+page-agent-parent-cursor-ripple/, 'parent cursor ripple animation'],
			[/data-state/, 'parent feedback state styling'],
		],
		forbiddenAssetPatterns: [
			[/style\.setAttribute\s*\(\s*['\"]data-page-agent-css['\"]/, 'JavaScript CSS injection'],
			[/createElement\s*\(\s*['\"]style['\"]\s*\)/, 'JavaScript CSS injection'],
			[/<style/, 'inline style injection'],
		],
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
	for (const [pattern, description] of [
		...forbiddenPatterns,
		...(bundle.forbiddenPatterns ?? []),
	]) {
		if (pattern.test(source)) throw new Error(`${bundle.label} contains ${description}`)
	}
	if (!source.includes(bundle.globalName)) {
		throw new Error(`${bundle.label} does not declare ${bundle.globalName}`)
	}
	for (const [pattern, description] of bundle.requiredPatterns ?? []) {
		if (!pattern.test(source)) {
			throw new Error(`${bundle.label} is missing ${description}`)
		}
	}
	for (const assetName of bundle.requiredAssets ?? []) {
		const assetPath = resolve(bundle.directory, assetName)
		if ((await stat(assetPath)).size === 0) {
			throw new Error(`${bundle.label} asset is empty: ${assetName}`)
		}
		const assetSource = await readFile(assetPath, 'utf8')
		for (const [pattern, description] of bundle.requiredAssetPatterns ?? []) {
			if (!pattern.test(assetSource)) {
				throw new Error(`${bundle.label} asset ${assetName} is missing ${description}`)
			}
		}
		for (const [pattern, description] of bundle.forbiddenAssetPatterns ?? []) {
			if (pattern.test(assetSource)) {
				throw new Error(`${bundle.label} asset ${assetName} contains ${description}`)
			}
		}
	}
}

console.log('Verified standalone iframe and parent-host IIFE bundles.')

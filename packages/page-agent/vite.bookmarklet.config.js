// @ts-check
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig, loadEnv } from 'vite'

import { injectCssByJs } from '../../scripts/vite-css-injected-by-js.js'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(currentDirectory, '../..')
const bookmarkletFileName = 'page-agent.bookmarklet.iife.min.js'
const installPagePlaceholder = '__PAGE_AGENT_BOOKMARKLET_FILE__'

/**
 * Emit the self-contained bookmarklet installer next to the production IIFE.
 * @returns {import('vite').Plugin}
 */
function emitBookmarkletInstallPage() {
	return {
		name: 'page-agent-bookmarklet-install-page',
		async generateBundle() {
			const source = await readFile(resolve(currentDirectory, 'install.html'), 'utf8')
			const placeholderCount = source.split(installPagePlaceholder).length - 1

			if (placeholderCount !== 1) {
				throw new Error(
					`[PageAgent bookmarklet] install.html must contain ${installPagePlaceholder} exactly once.`
				)
			}

			this.emitFile({
				type: 'asset',
				fileName: 'install.html',
				source: source.replace(installPagePlaceholder, bookmarkletFileName),
			})
		},
	}
}

/** @param {Record<string, string>} env @param {string} name */
function required(env, name) {
	const value = env[name]?.trim()
	if (!value) throw new Error(`[PageAgent bookmarklet] ${name} is required.`)
	return value
}

/** @param {Record<string, string>} env @param {string} name */
function optional(env, name) {
	return env[name]?.trim() || undefined
}

/** @param {string} value */
function parseEndpoint(value) {
	let url
	try {
		url = new URL(value)
	} catch {
		throw new Error(
			'[PageAgent bookmarklet] LLM_ENDPOINT_AGENT must be a full http:// or https:// URL.'
		)
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(
			'[PageAgent bookmarklet] LLM_ENDPOINT_AGENT must use the http:// or https:// protocol.'
		)
	}
	if (url.username || url.password) {
		throw new Error('[PageAgent bookmarklet] Do not embed credentials in LLM_ENDPOINT_AGENT.')
	}
	if (url.search || url.hash) {
		throw new Error(
			'[PageAgent bookmarklet] LLM_ENDPOINT_AGENT must not contain a query string or fragment.'
		)
	}

	return url.toString().replace(/\/$/, '')
}

/**
 * @param {string | undefined} value
 * @param {string} name
 * @param {number} defaultValue
 * @param {{ allowZero: boolean }} options
 */
function parseInteger(value, name, defaultValue, { allowZero }) {
	if (value === undefined || value === '') return defaultValue
	if (!/^\d+$/.test(value)) {
		throw new Error(`[PageAgent bookmarklet] ${name} must be an integer.`)
	}

	const parsed = Number(value)
	const minimum = allowZero ? 0 : 1
	if (!Number.isSafeInteger(parsed) || parsed < minimum) {
		throw new Error(`[PageAgent bookmarklet] ${name} must be at least ${minimum}.`)
	}
	return parsed
}

/** @param {Record<string, string>} env */
function createBookmarkletConfig(env) {
	const toolCallingMode = env.LLM_TOOL_CALLING_MODE?.trim() || 'system_prompt'
	if (toolCallingMode !== 'api' && toolCallingMode !== 'system_prompt') {
		throw new Error(
			'[PageAgent bookmarklet] LLM_TOOL_CALLING_MODE must be "api" or "system_prompt".'
		)
	}

	const language = env.PAGE_AGENT_LANGUAGE?.trim() || 'zh-CN'
	if (language !== 'en-US' && language !== 'zh-CN') {
		throw new Error('[PageAgent bookmarklet] PAGE_AGENT_LANGUAGE must be "en-US" or "zh-CN".')
	}

	return {
		endpointAgent: parseEndpoint(required(env, 'LLM_ENDPOINT_AGENT')),
		model: required(env, 'LLM_MODEL_NAME'),
		maxRetries: parseInteger(env.LLM_MAX_RETRIES, 'LLM_MAX_RETRIES', 0, {
			allowZero: true,
		}),
		appId: optional(env, 'LLM_APP_ID'),
		trCode: optional(env, 'LLM_TR_CODE'),
		trVersion: optional(env, 'LLM_TR_VERSION'),
		toolCallingMode,
		tlSystemPromptVariableName: optional(env, 'TL_SYSTEM_PROMPT_VARIABLE_NAME') ?? 'system_prompt',
		language,
		maxSteps: parseInteger(env.PAGE_AGENT_MAX_STEPS, 'PAGE_AGENT_MAX_STEPS', 20, {
			allowZero: false,
		}),
	}
}

/** Standalone, production-oriented PageAgent bundle for bookmarklet loading. */
export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, repositoryRoot, '')
	const bookmarkletConfig = createBookmarkletConfig(env)

	return {
		clearScreen: false,
		plugins: [injectCssByJs('page-agent-bookmarklet'), emitBookmarkletInstallPage()],
		publicDir: false,
		esbuild: {
			drop: ['console', 'debugger'],
		},
		build: {
			lib: {
				entry: resolve(currentDirectory, 'src/bookmarklet.ts'),
				name: 'PageAgentBookmarklet',
				fileName: () => bookmarkletFileName,
				formats: ['iife'],
			},
			outDir: resolve(currentDirectory, 'dist/iife'),
			emptyOutDir: false,
			target: 'es2020',
			minify: true,
			sourcemap: false,
			cssCodeSplit: true,
			rollupOptions: {
				output: {
					inlineDynamicImports: true,
				},
				onwarn(message, handler) {
					if (message.code === 'EVAL') return
					handler(message)
				},
			},
		},
		define: {
			__PAGE_AGENT_BOOKMARKLET_CONFIG__: JSON.stringify(bookmarkletConfig),
			'process.env.NODE_ENV': '"production"',
		},
	}
})

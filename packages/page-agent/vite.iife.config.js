// @ts-check
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

import { config as dotenvConfig } from 'dotenv'
import { visualizer } from 'rollup-plugin-visualizer'
import { defineConfig } from 'vite'

import { injectCssByJs } from '../../scripts/vite-css-injected-by-js.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .env from repo root
dotenvConfig({ path: resolve(__dirname, '../../.env') })

// UMD Bundle for CDN
// - alias all local packages so that they can be build in
// - no external
// - no d.ts. dts does not work with monorepo aliasing
export default defineConfig(({ mode }) => ({
	plugins: [
		injectCssByJs('page-agent-demo'),
		...(process.env.ANALYZE === 'true'
			? [
					visualizer({
						filename: resolve(__dirname, 'dist/iife/bundle-stats.html'),
						gzipSize: true,
						brotliSize: true,
					}),
				]
			: []),
	],
	publicDir: resolve(__dirname, 'demo'),
	esbuild: {
		// dev:demo explicitly uses development mode; production builds emit no console output.
		drop: mode === 'development' ? [] : ['console', 'debugger'],
	},
	build: {
		lib: {
			entry: resolve(__dirname, 'src/demo.ts'),
			name: 'PageAgent',
			fileName: () => `page-agent.demo.js`,
			formats: ['iife'],
		},
		outDir: resolve(__dirname, 'dist', 'iife'),
		emptyOutDir: false,
		cssCodeSplit: true,
		// minify: false,
		rollupOptions: {
			// output: {
			// 	// force use .js as extension
			// 	entryFileNames: 'page-agent.js',
			// },
			onwarn: function (message, handler) {
				if (message.code === 'EVAL') return
				handler(message)
			},
		},
	},
	define: {
		'import.meta.env.LLM_MODEL_NAME': JSON.stringify(process.env.LLM_MODEL_NAME),
		'import.meta.env.LLM_MAX_RETRIES': JSON.stringify(process.env.LLM_MAX_RETRIES),
		'import.meta.env.LLM_API_KEY': JSON.stringify(process.env.LLM_API_KEY),
		'import.meta.env.LLM_BASE_URL': JSON.stringify(process.env.LLM_BASE_URL),
		'import.meta.env.LLM_PROVIDER': JSON.stringify(process.env.LLM_PROVIDER),
		'import.meta.env.LLM_ENDPOINT_AGENT': JSON.stringify(process.env.LLM_ENDPOINT_AGENT),
		'import.meta.env.LLM_APP_ID': JSON.stringify(process.env.LLM_APP_ID),
		'import.meta.env.LLM_TR_CODE': JSON.stringify(process.env.LLM_TR_CODE),
		'import.meta.env.LLM_TR_VERSION': JSON.stringify(process.env.LLM_TR_VERSION),
		'import.meta.env.LLM_TOOL_CALLING_MODE': JSON.stringify(process.env.LLM_TOOL_CALLING_MODE),
		'import.meta.env.TL_SYSTEM_PROMPT_VARIABLE_NAME': JSON.stringify(
			process.env.TL_SYSTEM_PROMPT_VARIABLE_NAME
		),
	},
}))

// @ts-check
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

import { injectCssByJs } from '../../scripts/vite-css-injected-by-js.js'

const currentDirectory = dirname(fileURLToPath(import.meta.url))

/** Standalone browser-script bundle for the child-side iframe bridge host. */
export default defineConfig({
	clearScreen: false,
	plugins: [injectCssByJs('page-agent-frame-host')],
	publicDir: false,
	build: {
		lib: {
			entry: resolve(currentDirectory, 'src/browser/iframe-host-iife.ts'),
			name: 'PageAgentFrameHost',
			fileName: () => 'page-agent-frame-host.iife.min.js',
			formats: ['iife'],
		},
		outDir: resolve(currentDirectory, 'dist/iife'),
		emptyOutDir: false,
		target: 'es2020',
		minify: true,
		sourcemap: true,
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
		'process.env.NODE_ENV': '"production"',
	},
})

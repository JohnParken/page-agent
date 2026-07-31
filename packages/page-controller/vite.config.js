// @ts-check
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

import chalk from 'chalk'
import { defineConfig } from 'vite'

import { injectCssByJs } from '../../scripts/vite-css-injected-by-js.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

console.log(chalk.cyan(`📦 Building @page-agent/page-controller`))

export default defineConfig({
	clearScreen: false,
	plugins: [injectCssByJs('page-agent-page-controller')],
	publicDir: false,
	build: {
		lib: {
			entry: resolve(__dirname, 'src/PageController.ts'),
			name: 'PageController',
			fileName: 'page-controller',
			formats: ['es'],
		},
		outDir: resolve(__dirname, 'dist', 'lib'),
		rollupOptions: {
			external: ['@page-agent/*'],
			onwarn: function (message, handler) {
				if (message.code === 'EVAL') return
				handler(message)
			},
		},
		minify: false,
		sourcemap: true,
		cssCodeSplit: true,
	},
	define: {
		'process.env.NODE_ENV': '"production"',
	},
})

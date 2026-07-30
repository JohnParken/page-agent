// @ts-check
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

import chalk from 'chalk'
import { defineConfig } from 'vite'

const __dirname = dirname(fileURLToPath(import.meta.url))

console.log(chalk.cyan(`📦 Building @page-agent/llms`))

export default defineConfig({
	clearScreen: false,
	publicDir: false,
	build: {
		lib: {
			entry: resolve(__dirname, 'src/index.ts'),
			name: 'PageAgentLLMs',
			fileName: 'page-agent-llms',
			formats: ['es'],
		},
		outDir: resolve(__dirname, 'dist', 'lib'),
		rollupOptions: {
			external: ['chalk', 'zod', 'zod/v4'],
		},
		minify: false,
		sourcemap: true,
	},
	define: {
		'process.env.NODE_ENV': '"production"',
	},
})

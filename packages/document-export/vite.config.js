// @ts-check
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

import { defineConfig } from 'vite'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ES Module for NPM Package
export default defineConfig({
	clearScreen: false,
	publicDir: false,
	build: {
		lib: {
			entry: resolve(__dirname, 'src/index.ts'),
			name: 'PageAgentDocumentExport',
			fileName: 'document-export',
			formats: ['es'],
		},
		outDir: resolve(__dirname, 'dist', 'esm'),
		rollupOptions: {
			external: [
				'zod',
				'zod/v4',
				// all internal packages are external at build time
				/^@page-agent\//,
			],
		},
		minify: false,
		sourcemap: true,
	},
})

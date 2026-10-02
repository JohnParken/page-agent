import { defineConfig } from 'tsup'

export default defineConfig({
	entry: { index: 'src/index.ts' },
	outDir: 'dist/esm',
	format: ['esm'],
	dts: { only: true },
	clean: false,
	external: ['zod', 'zod/v4', /^@page-agent\//],
})

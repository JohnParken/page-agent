import { defineConfig } from 'tsup'

export default defineConfig({
	entry: { PageController: 'src/PageController.ts' },
	outDir: 'dist/lib',
	format: ['esm'],
	dts: { only: true },
	clean: false,
	external: [/^@page-agent\//],
})

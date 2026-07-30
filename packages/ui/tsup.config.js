import { defineConfig } from 'tsup'

export default defineConfig({
	entry: { index: 'src/index.ts' },
	outDir: 'dist/lib',
	format: ['esm'],
	dts: { only: true },
	clean: false,
})

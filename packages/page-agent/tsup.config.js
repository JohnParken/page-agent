import { defineConfig } from 'tsup'

export default defineConfig({
	entry: {
		PageAgent: 'src/PageAgent.ts',
		'iframe-bridge': 'src/iframe-bridge.ts',
	},
	outDir: 'dist/esm',
	format: ['esm'],
	dts: { only: true },
	clean: false,
	external: ['chalk', 'zod', 'zod/v4', /^@page-agent\//],
})

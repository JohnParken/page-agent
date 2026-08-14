import { defineConfig } from 'tsup'

export default defineConfig({
	entry: {
		PageAgent: 'src/PageAgent.ts',
		'iframe-bridge': 'src/iframe-bridge.ts',
		'parent-bridge': 'src/parent-bridge/index.ts',
		'parent-bridge/host': 'src/parent-bridge/host.ts',
		'parent-bridge/adapter': 'src/parent-bridge/adapter.ts',
	},
	outDir: 'dist/esm',
	format: ['esm'],
	dts: { only: true },
	clean: false,
	external: ['chalk', 'zod', 'zod/v4', /^@page-agent\//],
})

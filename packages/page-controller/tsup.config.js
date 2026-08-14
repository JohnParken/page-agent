import { defineConfig } from 'tsup'

export default defineConfig({
	entry: {
		PageController: 'src/PageController.ts',
		'iframe-bridge': 'src/iframe-bridge/index.ts',
		'parent-bridge': 'src/parent-bridge/index.ts',
		'parent-bridge/host': 'src/parent-bridge/host.ts',
		'parent-bridge/adapter': 'src/parent-bridge/adapter.ts',
	},
	outDir: 'dist/lib',
	format: ['esm'],
	dts: { only: true },
	clean: false,
	external: [/^@page-agent\//],
})

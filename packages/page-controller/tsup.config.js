import { defineConfig } from 'tsup'

export default defineConfig({
	entry: {
		PageController: 'src/PageController.ts',
		'iframe-bridge': 'src/iframe-bridge/index.ts',
	},
	outDir: 'dist/lib',
	format: ['esm'],
	dts: { only: true },
	clean: false,
	external: [/^@page-agent\//],
})

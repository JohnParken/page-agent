import { defineConfig } from 'tsup'

export default defineConfig({
	entry: { PageAgentCore: 'src/PageAgentCore.ts' },
	outDir: 'dist/esm',
	format: ['esm'],
	dts: { only: true },
	clean: false,
	external: ['chalk', 'zod', 'zod/v4', /^@page-agent\//],
})

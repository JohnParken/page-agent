import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		name: 'parent-bridge-example',
		environment: 'node',
		include: ['examples/parent-bridge/authenticated-tl-fetch.test.ts'],
		silent: process.env.VITEST_SHOW_LOGS !== '1',
	},
})

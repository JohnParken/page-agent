import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		name: 'page-controller',
		environment: 'jsdom',
		include: ['src/**/*.test.ts'],
		silent: process.env.VITEST_SHOW_LOGS !== '1',
	},
})

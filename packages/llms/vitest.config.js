import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		exclude: [...configDefaults.exclude, 'src/**/*.live.test.ts'],
		silent: process.env.VITEST_SHOW_LOGS !== '1',
	},
})

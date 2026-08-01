import { defineConfig } from 'vitest/config'

// Live tests hit real provider APIs and only run via `npm run test:live`.
export default defineConfig({
	test: {
		include: ['src/**/*.live.test.ts'],
		// Keep live provider suites under OpenRouter's ~20 req/min free-route cap.
		maxConcurrency: 2,
	},
})

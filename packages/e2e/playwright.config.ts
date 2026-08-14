import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from '@playwright/test'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH

export default defineConfig({
	testDir: resolve(currentDirectory, 'tests'),
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: 'line',
	use: {
		baseURL: 'http://127.0.0.1:4173',
		trace: 'retain-on-failure',
		...(chromiumExecutablePath
			? { launchOptions: { executablePath: chromiumExecutablePath } }
			: {}),
	},
	webServer: {
		command: 'node server.mjs',
		cwd: currentDirectory,
		env: { PARENT_BRIDGE_DEMO_MOCK_TL: '1' },
		url: 'http://127.0.0.1:4173/health',
		reuseExistingServer: !process.env.CI,
		timeout: 10_000,
	},
})

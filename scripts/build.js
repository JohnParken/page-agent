#!/usr/bin/env node
/**
 * Full build pipeline. Equivalent to:
 *   npm run cleanup && npm run build --workspaces --if-present
 *
 * 1. cleanup
 * 2. build every workspace in parallel
 */
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import chalk from 'chalk'

import { parallelTask } from './parallel-task.js'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const rootPkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'))

// Step 1: cleanup
console.log(chalk.bgBlue.white.bold(' ▸ cleanup '))
execSync('npm run cleanup', { cwd: rootDir, stdio: 'inherit' })

// Step 2: build all in parallel
console.log(chalk.bgBlue.white.bold(' ▸ build '))
const tasks = rootPkg.workspaces
	.map((ws) => {
		const dir = join(rootDir, ws)
		const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'))
		return pkg.scripts?.build ? { label: pkg.name, command: 'npm run build', cwd: dir } : null
	})
	.filter(Boolean)

await parallelTask(tasks, { timeoutMs: 120_000 })

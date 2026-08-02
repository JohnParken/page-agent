import { describe, expect, it } from 'vitest'

import { PageController } from './PageController'

describe('PageController', () => {
	it('constructs and exposes the current url', async () => {
		const controller = new PageController()
		expect(controller).toBeInstanceOf(PageController)
		expect(await controller.getCurrentUrl()).toBe(window.location.href)
	})

	describe('indexed browser state', () => {
		it('exposes the current index map and a new revision for each tree update', async () => {
			document.body.innerHTML = '<button type="button">Continue</button>'
			const controller = new PageController()

			const first = await controller.getBrowserState()
			const second = await controller.getBrowserState()

			expect(first.treeRevision).toBeGreaterThan(0)
			expect(second.treeRevision).toBeGreaterThan(first.treeRevision)
			expect(first.indices).toEqual(expect.any(Array))
			expect(second.indices).toEqual(first.indices)
		})

		it('honors an aborted call context before touching the DOM', async () => {
			const controller = new PageController()
			const abort = new AbortController()
			abort.abort()

			await expect(controller.getBrowserState({ signal: abort.signal })).rejects.toMatchObject({
				name: 'AbortError',
			})
			await expect(controller.updateTree({ signal: abort.signal })).rejects.toMatchObject({
				name: 'AbortError',
			})
		})
	})

	describe('executeJavascript', () => {
		it('runs a script and returns its result', async () => {
			const controller = new PageController()
			const result = await controller.executeJavascript('return 1 + 2')
			expect(result).toMatchObject({ success: true })
			expect(result.message).toContain('3')
		})

		it('exposes the abort signal to the script scope', async () => {
			const controller = new PageController()
			const controllerSignal = new AbortController()
			controllerSignal.abort()

			const result = await controller.executeJavascript(
				'return signal.aborted',
				controllerSignal.signal
			)
			expect(result).toMatchObject({ success: true })
			expect(result.message).toContain('true')
		})

		it('reports a syntax error as a failed result', async () => {
			const controller = new PageController()
			const result = await controller.executeJavascript('return (')
			expect(result.success).toBe(false)
			expect(result.message).toContain('❌')
		})
	})
})

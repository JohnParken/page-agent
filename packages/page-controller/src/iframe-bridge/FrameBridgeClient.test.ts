import { afterEach, describe, expect, it } from 'vitest'

import { CHILD_ORIGIN, createBridgeHarness } from './bridge-test-helpers'
import { FrameBridgeClient } from './FrameBridgeClient'
import { BridgeErrorCode } from './protocol'

describe('FrameBridgeClient', () => {
	const harnesses: ReturnType<typeof createBridgeHarness>[] = []
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.dispose()
	})

	it('uses exact-origin discover and parent-created MessageChannel connect', async () => {
		const harness = createBridgeHarness()
		harnesses.push(harness)
		const client = new FrameBridgeClient({
			iframe: harness.iframe,
			allowedChildOrigins: [CHILD_ORIGIN],
			window: harness.ownerWindow,
		})

		const connection = await client.connect('session-1')
		expect(connection.frameInstanceId).toBe('frame-1')
		expect(client.connected).toBe(true)
		const state = await client.getBrowserState()
		expect(state.content).toContain('[1]<button>Remote</button>')
		expect(client.currentTreeRevision).toBe(1)
		client.dispose()
		expect(client.connected).toBe(false)
	})

	it('keeps the current tree revision monotonic when a stale response arrives', async () => {
		const harness = createBridgeHarness()
		harnesses.push(harness)
		const client = new FrameBridgeClient({
			iframe: harness.iframe,
			allowedChildOrigins: [CHILD_ORIGIN],
			window: harness.ownerWindow,
		})
		await client.connect('session-1')
		harness.setResponseTreeRevision(2)
		await client.getBrowserState()
		expect(client.currentTreeRevision).toBe(2)

		harness.setResponseTreeRevision(1)
		const staleState = await client.getBrowserState()
		expect(staleState.treeRevision).toBe(1)
		expect(client.currentTreeRevision).toBe(2)
	})

	it('reports capability denial and distinguishes mutating unknown outcomes', async () => {
		const harness = createBridgeHarness()
		harnesses.push(harness)
		const client = new FrameBridgeClient({
			iframe: harness.iframe,
			allowedChildOrigins: [CHILD_ORIGIN],
			window: harness.ownerWindow,
			requestTimeoutMs: 10,
		})
		await client.connect('session-1')
		await client.getBrowserState()
		harness.setDropResponses(true)

		await expect(client.clickElement(1)).rejects.toMatchObject({
			code: BridgeErrorCode.OUTCOME_UNKNOWN,
		})
		await expect(client.getBrowserState()).rejects.toMatchObject({
			code: BridgeErrorCode.TIMEOUT,
		})
	})

	it('marks a started mutation as unknown when the iframe navigates', async () => {
		const harness = createBridgeHarness()
		harnesses.push(harness)
		const client = new FrameBridgeClient({
			iframe: harness.iframe,
			allowedChildOrigins: [CHILD_ORIGIN],
			window: harness.ownerWindow,
			requestTimeoutMs: 100,
		})
		await client.connect('session-1')
		await client.getBrowserState()
		harness.setDropResponses(true)
		const action = client.clickElement(1)
		await new Promise((resolve) => setTimeout(resolve, 0))
		client.invalidate('navigation')
		await expect(action).rejects.toMatchObject({ code: BridgeErrorCode.OUTCOME_UNKNOWN })
	})

	it('marks a posted mutation as unknown when the port closes before started', async () => {
		const harness = createBridgeHarness()
		harnesses.push(harness)
		const client = new FrameBridgeClient({
			iframe: harness.iframe,
			allowedChildOrigins: [CHILD_ORIGIN],
			window: harness.ownerWindow,
			requestTimeoutMs: 100,
		})
		await client.connect('session-1')
		await client.getBrowserState()
		harness.setDropStarted(true)
		harness.setDropResponses(true)

		const action = client.clickElement(1)
		await new Promise((resolve) => setTimeout(resolve, 0))
		client.invalidate('navigation before started notification')

		await expect(action).rejects.toMatchObject({ code: BridgeErrorCode.OUTCOME_UNKNOWN })
	})

	it('marks a posted mutation as unknown when the client is disposed', async () => {
		const harness = createBridgeHarness()
		harnesses.push(harness)
		const client = new FrameBridgeClient({
			iframe: harness.iframe,
			allowedChildOrigins: [CHILD_ORIGIN],
			window: harness.ownerWindow,
			requestTimeoutMs: 100,
		})
		await client.connect('session-1')
		await client.getBrowserState()
		harness.setDropStarted(true)
		harness.setDropResponses(true)

		const action = client.clickElement(1)
		await new Promise((resolve) => setTimeout(resolve, 0))
		client.dispose()

		await expect(action).rejects.toMatchObject({ code: BridgeErrorCode.OUTCOME_UNKNOWN })
	})

	it('marks a posted mutation as unknown when it times out before started', async () => {
		const harness = createBridgeHarness()
		harnesses.push(harness)
		const client = new FrameBridgeClient({
			iframe: harness.iframe,
			allowedChildOrigins: [CHILD_ORIGIN],
			window: harness.ownerWindow,
			requestTimeoutMs: 10,
		})
		await client.connect('session-1')
		await client.getBrowserState()
		harness.setDropStarted(true)
		harness.setDropResponses(true)

		await expect(client.clickElement(1)).rejects.toMatchObject({
			code: BridgeErrorCode.OUTCOME_UNKNOWN,
		})
	})

	it('treats an explicit abort of a posted mutation as an unknown outcome', async () => {
		const harness = createBridgeHarness()
		harnesses.push(harness)
		const client = new FrameBridgeClient({
			iframe: harness.iframe,
			allowedChildOrigins: [CHILD_ORIGIN],
			window: harness.ownerWindow,
			requestTimeoutMs: 100,
		})
		await client.connect('session-1')
		await client.getBrowserState()
		harness.setDropResponses(true)

		const abortController = new AbortController()
		const action = client.clickElement(1, { signal: abortController.signal })
		// The request can be observed by the child and started before the
		// parent receives its `started` notification. The client must still
		// classify an explicit abort as outcome-unknown once it was posted.
		await new Promise((resolve) => setTimeout(resolve, 0))
		abortController.abort()

		await expect(action).rejects.toMatchObject({
			code: BridgeErrorCode.OUTCOME_UNKNOWN,
			name: 'FrameBridgeError',
		})
	})

	it('uses AbortError for explicitly aborted observations and pre-posted requests', async () => {
		const harness = createBridgeHarness()
		harnesses.push(harness)
		const client = new FrameBridgeClient({
			iframe: harness.iframe,
			allowedChildOrigins: [CHILD_ORIGIN],
			window: harness.ownerWindow,
			requestTimeoutMs: 100,
		})
		await client.connect('session-1')
		await client.getBrowserState()
		harness.setDropResponses(true)

		const abortController = new AbortController()
		const observation = client.getBrowserState({ signal: abortController.signal })
		await new Promise((resolve) => setTimeout(resolve, 0))
		abortController.abort()
		await expect(observation).rejects.toMatchObject({
			code: BridgeErrorCode.ABORTED,
			name: 'AbortError',
		})

		const preAborted = new AbortController()
		preAborted.abort()
		await expect(client.clickElement(1, { signal: preAborted.signal })).rejects.toMatchObject({
			code: BridgeErrorCode.ABORTED,
			name: 'AbortError',
		})
	})

	it('rejects invalid or wildcard origin allowlists', () => {
		const harness = createBridgeHarness()
		harnesses.push(harness)
		expect(
			() =>
				new FrameBridgeClient({
					iframe: harness.iframe,
					allowedChildOrigins: ['https://*.example.test'],
					window: harness.ownerWindow,
				})
		).toThrow(TypeError)
		expect(
			() =>
				new FrameBridgeClient({
					iframe: harness.iframe,
					allowedChildOrigins: ['https://child.example.test/path'],
					window: harness.ownerWindow,
				})
		).toThrow(TypeError)
	})
})

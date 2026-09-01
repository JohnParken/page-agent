import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	ACTIVE_LEASE_POLL_INTERVAL_MS,
	ACTIVE_LEASE_STALE_AFTER_MS,
	ParentControllerActiveLeaseMonitor,
} from './active-lease'

import type { ParentControllerActiveLeaseCheckContext } from './active-lease'
import type { BrowserActiveLeaseStatus } from './integration-auth-contracts'

function buildContext(
	overrides: Partial<ParentControllerActiveLeaseCheckContext> = {}
): ParentControllerActiveLeaseCheckContext {
	return {
		role: 'assistant',
		policyId: 'policy-1',
		sessionId: 'session-1',
		hostInstanceId: 'host-1',
		frameInstanceId: 'frame-1',
		challenge: 'challenge-1',
		parentOrigin: 'https://parent.example.test',
		assistantOrigin: 'https://assistant.example.test',
		...overrides,
	}
}

function buildStatus(overrides: Partial<BrowserActiveLeaseStatus> = {}): BrowserActiveLeaseStatus {
	const nowSeconds = Math.floor(Date.now() / 1_000)
	return {
		leaseId: 'lease-1',
		policyId: 'policy-1',
		state: 'ACTIVE',
		expiresAt: nowSeconds + 600,
		checkedAt: nowSeconds,
		...overrides,
	}
}

describe('ParentControllerActiveLeaseMonitor', () => {
	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it('accepts immediate ACTIVE status', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date(1_700_000_000_000))
		const onFailure = vi.fn()
		const getStatus = vi.fn(async (context: ParentControllerActiveLeaseCheckContext) =>
			buildStatus()
		)
		const monitor = new ParentControllerActiveLeaseMonitor({ getStatus, onFailure })

		monitor.start(buildContext())
		await vi.advanceTimersByTimeAsync(0)

		expect(onFailure).not.toHaveBeenCalled()
		expect(monitor.running).toBe(true)
		expect(getStatus).toHaveBeenCalledTimes(1)
		expect(getStatus).toHaveBeenCalledWith(
			expect.objectContaining({ policyId: 'policy-1' }),
			expect.any(AbortSignal)
		)

		monitor.stop()
	})

	it('fails when ActiveLease state is REVOKED', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date(1_700_000_000_000))
		const onFailure = vi.fn()
		const getStatus = vi.fn(async () => buildStatus({ state: 'REVOKED' }))
		const monitor = new ParentControllerActiveLeaseMonitor({ getStatus, onFailure })

		monitor.start(buildContext())
		await vi.advanceTimersByTimeAsync(0)

		expect(onFailure).toHaveBeenCalledWith({
			reason: 'REVOKED',
			leaseId: 'lease-1',
			policyId: 'policy-1',
		})
		expect(monitor.running).toBe(false)
	})

	it('fails when ActiveLease state is EXPIRED', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date(1_700_000_000_000))
		const onFailure = vi.fn()
		const getStatus = vi.fn(async () => buildStatus({ state: 'EXPIRED' }))
		const monitor = new ParentControllerActiveLeaseMonitor({ getStatus, onFailure })

		monitor.start(buildContext())
		await vi.advanceTimersByTimeAsync(0)

		expect(onFailure).toHaveBeenCalledWith({
			reason: 'EXPIRED',
			leaseId: 'lease-1',
			policyId: 'policy-1',
		})
		expect(monitor.running).toBe(false)
	})

	it('fails as STALE after 90 seconds without a new ACTIVE confirmation window', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date(1_700_000_000_000))
		vi.spyOn(Math, 'random').mockReturnValue(0.5)
		const onFailure = vi.fn()
		let calls = 0
		const getStatus = vi.fn(async () => {
			calls += 1
			if (calls > 1) throw new Error('status unavailable')
			const nowSeconds = Math.floor(Date.now() / 1_000)
			return buildStatus({ checkedAt: nowSeconds, expiresAt: nowSeconds + 600 })
		})
		const monitor = new ParentControllerActiveLeaseMonitor({ getStatus, onFailure })

		monitor.start(buildContext())
		await vi.advanceTimersByTimeAsync(0)
		expect(monitor.running).toBe(true)
		await vi.advanceTimersByTimeAsync(ACTIVE_LEASE_STALE_AFTER_MS - 1)
		expect(monitor.running).toBe(true)

		await vi.advanceTimersByTimeAsync(1)
		expect(onFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				reason: 'STALE',
				policyId: 'policy-1',
			})
		)
		expect(monitor.running).toBe(false)
	})

	it('uses bounded jitter for poll delay', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date(1_700_000_000_000))
		const random = vi.spyOn(Math, 'random')
		random.mockReturnValue(0)
		const onFailure = vi.fn()
		const getStatus = vi.fn(async () => buildStatus())
		const monitor = new ParentControllerActiveLeaseMonitor({ getStatus, onFailure })

		monitor.start(buildContext())
		await vi.advanceTimersByTimeAsync(0)
		vi.advanceTimersByTime(Math.round(ACTIVE_LEASE_POLL_INTERVAL_MS * 0.8) - 1)
		expect(getStatus).toHaveBeenCalledTimes(1)
		vi.advanceTimersByTime(1)
		expect(getStatus).toHaveBeenCalledTimes(2)
		monitor.stop()

		random.mockReturnValue(1)
		const onFailureMax = vi.fn()
		const getStatusMax = vi.fn(async () => buildStatus())
		const monitorMax = new ParentControllerActiveLeaseMonitor({
			getStatus: getStatusMax,
			onFailure: onFailureMax,
		})
		monitorMax.start(buildContext())
		await vi.advanceTimersByTimeAsync(0)
		vi.advanceTimersByTime(Math.round(ACTIVE_LEASE_POLL_INTERVAL_MS * 1.2) - 1)
		expect(getStatusMax).toHaveBeenCalledTimes(1)
		vi.advanceTimersByTime(1)
		expect(getStatusMax).toHaveBeenCalledTimes(2)

		monitorMax.stop()
		random.mockRestore()
	})

	it('keeps lease id and expiry immutable once an ACTIVE lease is accepted', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date(1_700_000_000_000))
		vi.spyOn(Math, 'random').mockReturnValue(0)
		const onFailure = vi.fn()
		let calls = 0
		const getStatus = vi.fn(async () => {
			const nowSeconds = Math.floor(Date.now() / 1_000)
			calls += 1
			if (calls === 1) {
				return buildStatus({
					leaseId: 'lease-1',
					checkedAt: nowSeconds,
					expiresAt: nowSeconds + 360,
				})
			}
			if (calls === 2) {
				return buildStatus({
					leaseId: 'lease-2',
					checkedAt: nowSeconds,
					expiresAt: nowSeconds + 360,
				})
			}
			return buildStatus({ leaseId: 'lease-1', checkedAt: nowSeconds, expiresAt: nowSeconds + 361 })
		})
		const monitor = new ParentControllerActiveLeaseMonitor({ getStatus, onFailure })

		monitor.start(buildContext())
		await vi.advanceTimersByTimeAsync(0)
		vi.advanceTimersByTime(Math.round(ACTIVE_LEASE_POLL_INTERVAL_MS * 0.8) + 1)
		expect(getStatus).toHaveBeenCalledTimes(2)
		expect(onFailure).toHaveBeenCalledTimes(0)
		await vi.advanceTimersByTimeAsync(
			ACTIVE_LEASE_STALE_AFTER_MS - Math.round(ACTIVE_LEASE_POLL_INTERVAL_MS * 0.8) - 2
		)
		expect(onFailure).toHaveBeenCalledTimes(0)
		await vi.advanceTimersByTimeAsync(1)
		expect(onFailure).toHaveBeenCalledWith(
			expect.objectContaining({ reason: 'STALE', policyId: 'policy-1' })
		)

		monitor.stop()
	})

	it('stops and aborts pending status checks', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date(1_700_000_000_000))
		const onFailure = vi.fn()
		let capturedSignal: AbortSignal | undefined
		const getStatus = vi.fn(async (_context, signal) => {
			capturedSignal = signal
			return buildStatus()
		})
		const monitor = new ParentControllerActiveLeaseMonitor({ getStatus, onFailure })

		monitor.start(buildContext())
		await vi.advanceTimersByTimeAsync(0)
		expect(capturedSignal?.aborted).toBe(false)

		monitor.stop()
		expect(capturedSignal?.aborted).toBe(true)
		const calls = getStatus.mock.calls.length
		vi.advanceTimersByTime(120_000)
		expect(getStatus).toHaveBeenCalledTimes(calls)
		expect(monitor.running).toBe(false)
	})
})

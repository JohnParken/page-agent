import type { BrowserActiveLeaseStatus } from './integration-auth-contracts'

export const ACTIVE_LEASE_POLL_INTERVAL_MS = 30_000
export const ACTIVE_LEASE_POLL_JITTER_RATIO = 0.2
export const ACTIVE_LEASE_STALE_AFTER_MS = 90_000

export type ParentControllerActiveLeaseRole = 'parent' | 'assistant'
export type ParentControllerActiveLeaseFailureReason = 'REVOKED' | 'EXPIRED' | 'STALE'

export interface ParentControllerActiveLeaseCheckContext<TAuthorizationContext = unknown> {
	readonly role: ParentControllerActiveLeaseRole
	readonly policyId: string
	readonly sessionId: string
	readonly challenge: string
	readonly hostInstanceId: string
	readonly frameInstanceId: string
	readonly parentOrigin: string
	readonly assistantOrigin: string
	/** Local upper bound from the verified P Grant, when available. */
	readonly upperBoundExpiresAt?: number
	readonly authorizationContext?: TAuthorizationContext
}

export type ParentControllerActiveLeaseStatusProvider<TAuthorizationContext = unknown> = (
	context: ParentControllerActiveLeaseCheckContext<TAuthorizationContext>,
	signal: AbortSignal
) => BrowserActiveLeaseStatus | Promise<BrowserActiveLeaseStatus>

export interface ParentControllerActiveLeaseOptions<TAuthorizationContext = unknown> {
	readonly getStatus: ParentControllerActiveLeaseStatusProvider<TAuthorizationContext>
}

export interface ParentControllerActiveLeaseFailure {
	readonly reason: ParentControllerActiveLeaseFailureReason
	readonly leaseId?: string
	readonly policyId: string
}

interface MonitorCallbacks<TAuthorizationContext> {
	readonly getStatus: ParentControllerActiveLeaseStatusProvider<TAuthorizationContext>
	readonly onFailure: (failure: ParentControllerActiveLeaseFailure) => void
}

/** Fixed-policy P0 monitor. Polling timings are intentionally not configurable. */
export class ParentControllerActiveLeaseMonitor<TAuthorizationContext = unknown> {
	private readonly callbacks: MonitorCallbacks<TAuthorizationContext>
	private context: ParentControllerActiveLeaseCheckContext<TAuthorizationContext> | null = null
	private controller: AbortController | null = null
	private pollTimer: ReturnType<typeof setTimeout> | null = null
	private staleTimer: ReturnType<typeof setTimeout> | null = null
	private expiryTimer: ReturnType<typeof setTimeout> | null = null
	private generation = 0
	private leaseId: string | undefined
	private expiresAt: number | undefined

	constructor(callbacks: MonitorCallbacks<TAuthorizationContext>) {
		this.callbacks = callbacks
	}

	get running(): boolean {
		return this.context !== null
	}

	start(context: ParentControllerActiveLeaseCheckContext<TAuthorizationContext>): void {
		this.stop()
		this.context = { ...context }
		this.controller = new AbortController()
		this.scheduleStaleDeadline()
		if (context.upperBoundExpiresAt !== undefined) {
			if (
				!Number.isSafeInteger(context.upperBoundExpiresAt) ||
				context.upperBoundExpiresAt * 1_000 <= Date.now()
			) {
				this.fail('EXPIRED')
				return
			}
			this.scheduleExpiry(context.upperBoundExpiresAt)
		}
		const generation = this.generation
		void this.poll(generation)
	}

	stop(): void {
		this.generation += 1
		this.controller?.abort()
		this.controller = null
		if (this.pollTimer) clearTimeout(this.pollTimer)
		if (this.staleTimer) clearTimeout(this.staleTimer)
		if (this.expiryTimer) clearTimeout(this.expiryTimer)
		this.pollTimer = null
		this.staleTimer = null
		this.expiryTimer = null
		this.context = null
		this.leaseId = undefined
		this.expiresAt = undefined
	}

	private async poll(generation: number): Promise<void> {
		const context = this.context
		const signal = this.controller?.signal
		if (!context || !signal || signal.aborted || generation !== this.generation) return
		try {
			const status = await this.callbacks.getStatus(context, signal)
			if (signal.aborted || generation !== this.generation || this.context !== context) return
			this.handleStatus(status)
		} catch {
			// Only a fresh, validated ACTIVE response extends the positive-confirmation window.
		}
		if (signal.aborted || generation !== this.generation || this.context !== context) return
		this.pollTimer = setTimeout(() => void this.poll(generation), this.nextPollDelayMs())
	}

	private handleStatus(status: BrowserActiveLeaseStatus): void {
		const context = this.context
		if (!context || !this.isStatusBoundToContext(status, context)) return
		if (status.state === 'REVOKED') {
			this.fail('REVOKED', status.leaseId)
			return
		}
		if (status.state === 'EXPIRED') {
			this.fail('EXPIRED', status.leaseId)
			return
		}
		if (status.state !== 'ACTIVE') return
		const nowMilliseconds = Date.now()
		const nowSeconds = Math.floor(nowMilliseconds / 1_000)
		if (
			status.expiresAt <= nowSeconds ||
			(this.leaseId !== undefined && status.leaseId !== this.leaseId) ||
			(this.expiresAt !== undefined && status.expiresAt !== this.expiresAt)
		)
			return
		this.leaseId = status.leaseId
		this.expiresAt = status.expiresAt
		this.scheduleExpiry(status.expiresAt)
		this.scheduleStaleDeadline()
	}

	private isStatusBoundToContext(
		status: BrowserActiveLeaseStatus,
		context: ParentControllerActiveLeaseCheckContext<TAuthorizationContext>
	): boolean {
		return (
			typeof status === 'object' &&
			status !== null &&
			typeof status.leaseId === 'string' &&
			status.leaseId.length > 0 &&
			status.leaseId.length <= 256 &&
			status.policyId === context.policyId &&
			Number.isSafeInteger(status.expiresAt) &&
			Number.isSafeInteger(status.checkedAt) &&
			(context.upperBoundExpiresAt === undefined ||
				status.expiresAt <= context.upperBoundExpiresAt) &&
			(status.state === 'ACTIVE' || status.state === 'REVOKED' || status.state === 'EXPIRED')
		)
	}

	private scheduleStaleDeadline(): void {
		if (this.staleTimer) clearTimeout(this.staleTimer)
		this.staleTimer = setTimeout(() => this.fail('STALE'), ACTIVE_LEASE_STALE_AFTER_MS)
	}

	private scheduleExpiry(expiresAt: number): void {
		if (this.expiryTimer) clearTimeout(this.expiryTimer)
		const delay = Math.max(0, expiresAt * 1_000 - Date.now())
		this.expiryTimer = setTimeout(() => this.fail('EXPIRED'), delay)
	}

	private nextPollDelayMs(): number {
		const jitter = (Math.random() * 2 - 1) * ACTIVE_LEASE_POLL_JITTER_RATIO
		return Math.round(ACTIVE_LEASE_POLL_INTERVAL_MS * (1 + jitter))
	}

	private fail(reason: ParentControllerActiveLeaseFailureReason, leaseId = this.leaseId): void {
		const context = this.context
		if (!context) return
		const failure: ParentControllerActiveLeaseFailure = {
			reason,
			...(leaseId === undefined ? {} : { leaseId }),
			policyId: context.policyId,
		}
		this.stop()
		this.callbacks.onFailure(failure)
	}
}

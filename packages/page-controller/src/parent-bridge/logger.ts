import type { ParentControllerLogEntry, ParentControllerLogger } from './types'

export function messageByteLength(value: unknown): number {
	try {
		const serialized = JSON.stringify(value)
		if (serialized === undefined) return 0
		return new TextEncoder().encode(serialized).byteLength
	} catch {
		return Number.POSITIVE_INFINITY
	}
}

/** Invoke the optional structured logger without allowing it to affect RPC. */
export function emitParentControllerLog(
	logger: ParentControllerLogger | undefined,
	entry: ParentControllerLogEntry
): void {
	if (!logger) return
	try {
		void Promise.resolve(logger({ ...entry })).catch(() => undefined)
	} catch {
		// Logging must never leak payloads or break controller execution.
	}
}

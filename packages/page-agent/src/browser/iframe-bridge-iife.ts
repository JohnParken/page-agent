import { FrameAwarePageController, PageController } from '../iframe-bridge'

import type { PageControllerConfig } from '../iframe-bridge'

export { FrameAwarePageController, PageController }

/** Options for the browser-script parent bridge convenience API. */
export interface CreateFrameAwareControllerOptions {
	frameSelector: string
	allowedChildOrigins: readonly string[]
	handshakeTimeoutMs?: number
	requestTimeoutMs?: number
	localControllerOptions?: PageControllerConfig
}

export interface FrameAwareControllerHandle {
	controller: FrameAwarePageController
	dispose: () => void
}

function requirePositiveTimeout(value: number | undefined, name: string): void {
	if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
		throw new TypeError(`${name} must be a positive finite number`)
	}
}

/**
 * Create a local PageController decorated with cross-origin iframe support.
 *
 * The lower-level classes remain exported for applications that need to own
 * controller construction or lifecycle themselves.
 */
export function createFrameAwareController(
	options: CreateFrameAwareControllerOptions
): FrameAwareControllerHandle {
	if (!options || typeof options !== 'object') {
		throw new TypeError('createFrameAwareController requires an options object')
	}
	if (typeof options.frameSelector !== 'string' || options.frameSelector.trim() === '') {
		throw new TypeError('frameSelector must be a non-empty CSS selector')
	}
	if (!Array.isArray(options.allowedChildOrigins) || options.allowedChildOrigins.length === 0) {
		throw new TypeError('allowedChildOrigins must be a non-empty array of exact origins')
	}
	requirePositiveTimeout(options.handshakeTimeoutMs, 'handshakeTimeoutMs')
	requirePositiveTimeout(options.requestTimeoutMs, 'requestTimeoutMs')

	const frameSelector = options.frameSelector.trim()
	try {
		document.querySelector(frameSelector)
	} catch (error) {
		throw new TypeError(`frameSelector must be a valid CSS selector: ${frameSelector}`, {
			cause: error,
		})
	}

	const localController = new PageController(options.localControllerOptions)
	let controller: FrameAwarePageController
	try {
		controller = new FrameAwarePageController({
			localController,
			frameSelector,
			allowedChildOrigins: options.allowedChildOrigins,
			handshakeTimeoutMs: options.handshakeTimeoutMs,
			requestTimeoutMs: options.requestTimeoutMs,
		})
	} catch (error) {
		localController.dispose()
		throw error
	}

	return {
		controller,
		dispose: () => controller.dispose(),
	}
}

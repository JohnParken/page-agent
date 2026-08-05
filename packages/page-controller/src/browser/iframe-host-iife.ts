import { FrameBridgeHost } from '../iframe-bridge/FrameBridgeHost'
import { PageController } from '../PageController'

import type { FrameBridgeCapability } from '../iframe-bridge/protocol'
import type { PageControllerConfig } from '../PageController'

export { FrameBridgeHost, PageController }

/** Options for the browser-script child host convenience API. */
export interface StartFrameBridgeOptions {
	allowedParentOrigins: readonly string[]
	capabilities?: readonly FrameBridgeCapability[]
	controllerOptions?: PageControllerConfig
}

export interface FrameBridgeHandle {
	host: FrameBridgeHost
	controller: PageController
	dispose: () => void
}

/**
 * Start a child-frame bridge with a least-privilege, observe-only default.
 * Use FrameBridgeHost directly when advanced host options are required.
 */
export function startFrameBridge(options: StartFrameBridgeOptions): FrameBridgeHandle {
	if (!options || typeof options !== 'object') {
		throw new TypeError('startFrameBridge requires an options object')
	}
	if (!Array.isArray(options.allowedParentOrigins) || options.allowedParentOrigins.length === 0) {
		throw new TypeError('allowedParentOrigins must be a non-empty array of exact origins')
	}
	if (options.capabilities !== undefined && !Array.isArray(options.capabilities)) {
		throw new TypeError('capabilities must be an array when provided')
	}

	const controller = new PageController(options.controllerOptions)
	let host: FrameBridgeHost | undefined
	try {
		host = new FrameBridgeHost({
			controller,
			allowedParentOrigins: options.allowedParentOrigins,
			capabilities: options.capabilities ?? ['observe'],
		})
		host.start()
	} catch (error) {
		if (host) host.dispose()
		else controller.dispose()
		throw error
	}

	return {
		host,
		controller,
		dispose: () => host.dispose(),
	}
}

/**
 * Optional cooperative bridge for direct cross-origin iframes.
 *
 * This secondary entry point keeps bridge code out of the default
 * PageController bundle while providing everything needed by both the parent
 * page and an opted-in child frame.
 */
export { PageController } from '../PageController'
export type {
	BrowserState,
	HorizontalScrollOptions,
	IndexedBrowserState,
	IndexedPageControllerAdapter,
	PageActionResult,
	PageControllerAdapter,
	PageControllerCallContext,
	PageControllerConfig,
	ScrollOptions,
} from '../PageController'

export { FrameAwarePageController } from './FrameAwarePageController'
export type { FrameAwarePageControllerOptions } from './FrameAwarePageController'
export {
	FrameBridgeClient,
	FrameBridgeError,
	getFrameSourceOrigin,
	isDirectCrossOriginFrame,
	normalizeAllowedChildOrigins,
} from './FrameBridgeClient'
export type {
	FrameBridgeClientOptions,
	FrameBridgeConnection,
	FrameBridgePointerDetail,
} from './FrameBridgeClient'
export { FrameBridgeHost } from './FrameBridgeHost'
export type {
	FrameBridgeHostOptions,
	FrameBridgeHostWindow,
	FrameBridgeMessagePort,
} from './FrameBridgeHost'
export * from './protocol'

/**
 * Copyright (C) 2025 Alibaba Group Holding Limited
 * All rights reserved.
 *
 * PageController - Manages DOM operations and element interactions.
 * Designed to be independent of LLM and can be tested in unit tests.
 * All public methods are async for potential remote calling support.
 */
import {
	clickElement,
	getElementByIndex,
	inputTextElement,
	scrollHorizontally,
	scrollVertically,
	selectOptionElement,
} from './actions'
import * as dom from './dom'
import { getPageInfo } from './dom/getPageInfo'
import { patchReact } from './patches/react'
import { isAnchorElement } from './utils'

import type { FlatDomTree, InteractiveElementDomNode } from './dom/dom_tree/type'

/**
 * AbortSignal.throwIfAborted is not available in every supported browser (or
 * DOM test environment). Keep cancellation semantics consistent without
 * requiring that newer convenience method.
 */
function throwIfAborted(signal?: AbortSignal): void {
	if (!signal) return

	if (typeof signal.throwIfAborted === 'function') {
		signal.throwIfAborted()
		return
	}

	if (signal.aborted) {
		throw (
			signal.reason ??
			(typeof DOMException === 'function'
				? new DOMException('The operation was aborted.', 'AbortError')
				: Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
		)
	}
}

/**
 * Configuration for PageController
 */
export interface PageControllerConfig extends dom.DomConfig {
	/** Enable visual mask overlay during operations (default: false) */
	enableMask?: boolean
}

/** Stable error name/code for a missing, disconnected, or replaced root. */
export class DomRootUnavailableError extends Error {
	readonly code = 'ROOT_UNAVAILABLE'

	constructor(message: string) {
		super(message)
		this.name = 'DomRootUnavailableError'
	}
}

/**
 * Structured browser state for LLM consumption
 */
export interface BrowserState {
	url: string
	title: string
	/** Page info + scroll position hint (e.g. "Page info: 1920x1080px...\n[Start of page]") */
	header: string
	/** Simplified HTML of interactive elements */
	content: string
	/** Page footer hint (e.g. "... 300 pixels below ..." or "[End of page]") */
	footer: string
}

/**
 * Browser state with the metadata required to route index-based actions safely.
 * `treeRevision` changes whenever the controller rebuilds its index map.
 */
export interface IndexedBrowserState extends BrowserState {
	treeRevision: number
	indices: number[]
}

/** Optional metadata associated with a controller call. */
export interface PageControllerCallContext {
	signal?: AbortSignal
}

/** Result returned by page actions. */
export interface PageActionResult {
	success: boolean
	message: string
}

/** Options for vertical document or element scrolling. */
export interface ScrollOptions {
	down: boolean
	numPages: number
	pixels?: number
	index?: number
}

/** Options for horizontal document or element scrolling. */
export interface HorizontalScrollOptions {
	right: boolean
	pixels: number
	index?: number
}

/**
 * Controller contract consumed by PageAgentCore.
 *
 * Implementations may be local or remote. The optional call context lets remote
 * implementations cancel pending observation and action requests cooperatively.
 */
export interface PageControllerAdapter {
	getCurrentUrl(context?: PageControllerCallContext): Promise<string>
	getLastUpdateTime(context?: PageControllerCallContext): Promise<number>
	getBrowserState(context?: PageControllerCallContext): Promise<BrowserState>
	updateTree(context?: PageControllerCallContext): Promise<string>
	cleanUpHighlights(): Promise<void>
	clickElement(index: number, context?: PageControllerCallContext): Promise<PageActionResult>
	inputText(
		index: number,
		text: string,
		context?: PageControllerCallContext
	): Promise<PageActionResult>
	selectOption(
		index: number,
		optionText: string,
		context?: PageControllerCallContext
	): Promise<PageActionResult>
	scroll(options: ScrollOptions, context?: PageControllerCallContext): Promise<PageActionResult>
	scrollHorizontally(
		options: HorizontalScrollOptions,
		context?: PageControllerCallContext
	): Promise<PageActionResult>
	executeJavascript(script: string, signal?: AbortSignal): Promise<PageActionResult>
	showMask(): Promise<void>
	hideMask(): Promise<void>
	dispose(): void
}

/** Controller contract whose observations expose the current index mapping revision. */
export interface IndexedPageControllerAdapter extends PageControllerAdapter {
	getBrowserState(context?: PageControllerCallContext): Promise<IndexedBrowserState>
}

/**
 * PageController manages DOM state and element interactions.
 * It provides async methods for all DOM operations, keeping state isolated.
 *
 * @lifecycle
 * - beforeUpdate: Emitted before the DOM tree is updated.
 * - afterUpdate: Emitted after the DOM tree is updated.
 */
export class PageController extends EventTarget implements IndexedPageControllerAdapter {
	private config: PageControllerConfig
	private activeRoot: Element | null = null

	/** Corresponds to eval_page in browser-use */
	private flatTree: FlatDomTree | null = null

	/**
	 * All highlighted index-mapped interactive elements
	 * Corresponds to DOMState.selector_map in browser-use
	 */
	private selectorMap = new Map<number, InteractiveElementDomNode>()

	/** Index -> element text description mapping */
	private elementTextMap = new Map<number, string>()

	/**
	 * Simplified HTML for LLM consumption.
	 * Corresponds to clickable_elements_to_string in browser-use
	 */
	private simplifiedHTML = '<EMPTY>'

	/** last time the tree was updated */
	private lastTimeUpdate = 0

	/** Whether the tree has been indexed at least once */
	private isIndexed = false

	/** Monotonically increasing revision of the selector map. */
	private treeRevision = 0

	/** Visual mask overlay for blocking user interaction during automation */
	private mask: InstanceType<typeof import('./mask/SimulatorMask').SimulatorMask> | null = null
	private maskReady: Promise<void> | null = null
	private readonly highlightCleanupRegistry: dom.HighlightCleanupRegistry = new Set()
	private readonly clickScope = {}

	constructor(config: PageControllerConfig = {}) {
		super()

		this.config = config
		dom.registerHighlightCleanupRegistry(this.highlightCleanupRegistry)

		// Scoped roots may be resolved lazily and must not trigger a document-wide
		// React patch before their boundary is known. Legacy controllers retain
		// the historical eager patch.
		if (config.root === undefined) patchReact(this)

		// A SimulatorMask is a document-wide, interaction-blocking overlay. It
		// cannot be scoped to an embedded root, so never create one for a scoped
		// controller even when callers carry over the legacy enableMask option.
		if (config.enableMask && !this.isRootScoped()) this.initMask()
	}

	private isRootScoped(): boolean {
		return this.config.root !== undefined
	}

	private resolveConfiguredRoot(): Element {
		try {
			return dom.resolveRoot(this.config.root)
		} catch (error) {
			if (error instanceof DomRootUnavailableError) throw error
			throw new DomRootUnavailableError(String(error))
		}
	}

	/** Clear all index state and invalidate every previously observed index. */
	private invalidateTree(): void {
		dom.cleanUpHighlights(this.highlightCleanupRegistry)
		this.flatTree = null
		this.selectorMap.clear()
		this.elementTextMap.clear()
		this.simplifiedHTML = '<EMPTY>'
		this.isIndexed = false
		this.activeRoot = null
		this.treeRevision += 1
	}

	/**
	 * Resolve the root again before an action. Replaced or disconnected roots
	 * fail closed and invalidate the current selector map.
	 */
	private resolveActionRoot(): Element {
		this.assertIndexed()

		let root: Element
		try {
			root = this.resolveConfiguredRoot()
		} catch (error) {
			this.invalidateTree()
			throw error
		}

		if (!this.activeRoot || root !== this.activeRoot) {
			this.invalidateTree()
			throw new DomRootUnavailableError(
				'Configured DOM root changed; updateTree() is required before actions.'
			)
		}

		return root
	}

	private getActionElement(index: number, root: Element): HTMLElement {
		const element = getElementByIndex(this.selectorMap, index)
		if (
			element.ownerDocument !== document ||
			!element.isConnected ||
			(element !== root && !root.contains(element))
		) {
			this.invalidateTree()
			throw new DomRootUnavailableError(
				`Element at index ${index} is no longer inside the configured DOM root.`
			)
		}
		return element
	}

	/**
	 * Resolve an indexed element for a local host-side policy decision.
	 *
	 * This intentionally is not part of `PageControllerAdapter` and must not be
	 * exposed through the parent-controller RPC protocol. It performs the same
	 * indexed/revision/root/live-containment checks as an action, so a policy
	 * callback cannot authorize a stale or out-of-scope element.
	 */
	getIndexedElementForPolicy(index: number): HTMLElement {
		const root = this.resolveActionRoot()
		return this.getActionElement(index, root)
	}

	/**
	 * Return the local selector-map revision for a parent-host response
	 * envelope. This is intentionally not part of the adapter/RPC contract;
	 * remote callers receive the revision embedded in BrowserState instead.
	 */
	getTreeRevision(): number {
		return this.treeRevision
	}

	private getRootViewportHeight(root: Element): number {
		if (!this.isRootScoped()) return window.innerHeight
		const element = root as HTMLElement
		return element.clientHeight || Math.max(1, Math.round(root.getBoundingClientRect().height))
	}

	/**
	 * Initialize mask asynchronously (dynamic import to avoid CSS loading in Node)
	 */
	initMask() {
		if (this.isRootScoped()) return
		if (this.maskReady !== null) return
		this.maskReady = (async () => {
			const { SimulatorMask } = await import('./mask/SimulatorMask')
			this.mask = new SimulatorMask()
		})()
	}
	// ======= State Queries =======

	/**
	 * Get current page URL
	 */
	async getCurrentUrl(context?: PageControllerCallContext): Promise<string> {
		throwIfAborted(context?.signal)
		return window.location.href
	}

	/**
	 * Get last tree update timestamp
	 */
	async getLastUpdateTime(context?: PageControllerCallContext): Promise<number> {
		throwIfAborted(context?.signal)
		return this.lastTimeUpdate
	}

	/**
	 * Get structured browser state for LLM consumption.
	 * Automatically calls updateTree() to refresh the DOM state.
	 */
	async getBrowserState(context?: PageControllerCallContext): Promise<IndexedBrowserState> {
		throwIfAborted(context?.signal)

		await this.updateTree(context)
		throwIfAborted(context?.signal)

		const root = this.activeRoot ?? this.resolveConfiguredRoot()
		const url = window.location.href
		const title = document.title
		const pi = getPageInfo(root)
		const viewportExpansion = dom.resolveViewportExpansion(this.config.viewportExpansion)

		const content = this.simplifiedHTML

		// Build header: page info + scroll position hint
		const titleLine = `Current Page: [${title}](${url})`

		const pageInfoLine = `Page info: ${pi.viewport_width}x${pi.viewport_height}px viewport, ${
			pi.page_width
		}x${pi.page_height}px total page size, ${pi.pages_above.toFixed(
			1
		)} pages above, ${pi.pages_below.toFixed(1)} pages below, ${pi.total_pages.toFixed(
			1
		)} total pages, at ${(pi.current_page_position * 100).toFixed(0)}% of page`

		const elementsLabel = this.isRootScoped()
			? 'Interactive elements inside the configured root:'
			: viewportExpansion === -1
				? 'Interactive elements from top layer of the current page (full page):'
				: 'Interactive elements from top layer of the current page inside the viewport:'

		const hasContentAbove = pi.pixels_above > 4
		const scrollHintAbove =
			hasContentAbove && viewportExpansion !== -1
				? `... ${pi.pixels_above} pixels above (${pi.pages_above.toFixed(
						1
					)} pages) - scroll to see more ...`
				: '[Start of page]'

		const header = `${titleLine}\n${pageInfoLine}\n\n${elementsLabel}\n\n${scrollHintAbove}`

		// Build footer: scroll position hint
		const hasContentBelow = pi.pixels_below > 4
		const footer =
			hasContentBelow && viewportExpansion !== -1
				? `... ${pi.pixels_below} pixels below (${pi.pages_below.toFixed(
						1
					)} pages) - scroll to see more ...`
				: '[End of page]'

		return {
			url,
			title,
			header,
			content,
			footer,
			treeRevision: this.treeRevision,
			indices: Array.from(this.selectorMap.keys()).sort((a, b) => a - b),
		}
	}

	// ======= DOM Tree Operations =======

	/**
	 * Update DOM tree, returns simplified HTML for LLM.
	 * This is the main method to refresh the page state.
	 * Automatically bypasses mask during DOM extraction if enabled.
	 */
	async updateTree(context?: PageControllerCallContext): Promise<string> {
		throwIfAborted(context?.signal)

		let root: Element
		try {
			root = this.resolveConfiguredRoot()
		} catch (error) {
			this.invalidateTree()
			throw error
		}

		// A root identity change invalidates all indices before extraction. This
		// also prevents actions from observing a previous host mount.
		if (this.activeRoot && this.activeRoot !== root) this.invalidateTree()
		this.activeRoot = root

		this.dispatchEvent(new Event('beforeUpdate'))

		// Temporarily bypass mask to allow DOM extraction
		if (this.mask) this.mask.wrapper.style.pointerEvents = 'none'

		try {
			dom.cleanUpHighlights(this.highlightCleanupRegistry)

			if (this.isRootScoped()) patchReact(this, root)

			const configuredBlacklist: Element[] = []
			for (const item of this.config.interactiveBlacklist || []) {
				const candidate = typeof item === 'function' ? item() : item
				if (candidate && (candidate === root || root.contains(candidate))) {
					configuredBlacklist.push(candidate)
				}
			}
			const configuredContentBlacklist: Element[] = []
			for (const item of this.config.contentBlacklist || []) {
				const candidate = typeof item === 'function' ? item() : item
				if (candidate && (candidate === root || root.contains(candidate))) {
					configuredContentBlacklist.push(candidate)
				}
			}
			const sensitiveContent = Array.from(
				root.querySelectorAll(
					'input[type="password"], [autocomplete="new-password"], [autocomplete="current-password"], [autocomplete="one-time-code"], [data-page-agent-sensitive], [name*="password" i], [name*="token" i], [id*="password" i], [id*="token" i]'
				)
			)
			const blacklist = [
				...configuredBlacklist,
				...(root.matches('[data-page-agent-not-interactive]') ? [root] : []),
				...Array.from(root.querySelectorAll('[data-page-agent-not-interactive]')),
			]

			this.flatTree = dom.getFlatTree({
				...this.config,
				root: this.isRootScoped() ? root : undefined,
				interactiveBlacklist: blacklist,
				contentBlacklist: [...configuredContentBlacklist, ...sensitiveContent],
				highlightCleanupRegistry: this.highlightCleanupRegistry,
			})

			this.simplifiedHTML = dom.flatTreeToString(
				this.flatTree,
				this.config.includeAttributes,
				this.config.keepSemanticTags,
				this.isRootScoped() ? ['value', 'defaultvalue'] : []
			)

			this.selectorMap.clear()
			this.selectorMap = dom.getSelectorMap(this.flatTree)

			this.elementTextMap.clear()
			this.elementTextMap = dom.getElementTextMap(this.simplifiedHTML)

			// Mark as indexed - now element actions are allowed
			this.isIndexed = true
			this.treeRevision += 1
			this.lastTimeUpdate = Date.now()

			this.dispatchEvent(new Event('afterUpdate'))
			return this.simplifiedHTML
		} catch (error) {
			this.invalidateTree()
			throw error
		} finally {
			// Restore mask blocking even when extraction fails.
			if (this.mask) this.mask.wrapper.style.pointerEvents = 'auto'
		}
	}

	/**
	 * Clean up all element highlights
	 */
	async cleanUpHighlights(): Promise<void> {
		console.log('[PageController] cleanUpHighlights')
		dom.cleanUpHighlights(this.highlightCleanupRegistry)
	}

	// ======= Element Actions =======

	/**
	 * Ensure the tree has been indexed before any index-based operation.
	 * Throws if updateTree() hasn't been called yet.
	 */
	private assertIndexed(): void {
		if (!this.isIndexed) {
			throw new Error('DOM tree not indexed yet. Can not perform actions on elements.')
		}
	}

	/**
	 * Click element by index
	 */
	async clickElement(
		index: number,
		context?: PageControllerCallContext
	): Promise<PageActionResult> {
		try {
			throwIfAborted(context?.signal)
			const root = this.resolveActionRoot()
			const element = this.getActionElement(index, root)
			const elemText = this.elementTextMap.get(index)
			await clickElement(element, this.isRootScoped() ? root : undefined, this.clickScope)
			throwIfAborted(context?.signal)

			// Handle links that open in new tabs
			if (isAnchorElement(element) && element.target === '_blank') {
				return {
					success: true,
					message: `✅ Clicked element (${elemText ?? index}). ⚠️ Link opened in a new tab.`,
				}
			}

			return {
				success: true,
				message: `✅ Clicked element (${elemText ?? index}).`,
			}
		} catch (error) {
			throwIfAborted(context?.signal)
			return {
				success: false,
				message: `❌ Failed to click element: ${error}`,
			}
		}
	}

	/**
	 * Input text into element by index
	 */
	async inputText(
		index: number,
		text: string,
		context?: PageControllerCallContext
	): Promise<PageActionResult> {
		try {
			throwIfAborted(context?.signal)
			const root = this.resolveActionRoot()
			const element = this.getActionElement(index, root)
			const elemText = this.elementTextMap.get(index)
			await inputTextElement(element, text, this.isRootScoped() ? root : undefined, this.clickScope)
			throwIfAborted(context?.signal)

			return {
				success: true,
				message: `✅ Input ${text.length} characters into element (${elemText ?? index}).`,
			}
		} catch (error) {
			throwIfAborted(context?.signal)
			return {
				success: false,
				message: `❌ Failed to input text: ${error}`,
			}
		}
	}

	/**
	 * Select dropdown option by index and option text
	 */
	async selectOption(
		index: number,
		optionText: string,
		context?: PageControllerCallContext
	): Promise<PageActionResult> {
		try {
			throwIfAborted(context?.signal)
			const root = this.resolveActionRoot()
			const element = this.getActionElement(index, root)
			const elemText = this.elementTextMap.get(index)
			await selectOptionElement(element as HTMLSelectElement, optionText)
			throwIfAborted(context?.signal)

			return {
				success: true,
				message: `✅ Selected an option (${optionText.length} characters) in element (${
					elemText ?? index
				}).`,
			}
		} catch (error) {
			throwIfAborted(context?.signal)
			return {
				success: false,
				message: `❌ Failed to select option: ${error}`,
			}
		}
	}

	/**
	 * Scroll vertically
	 */
	async scroll(
		options: ScrollOptions,
		context?: PageControllerCallContext
	): Promise<PageActionResult> {
		try {
			throwIfAborted(context?.signal)
			const { down, numPages, pixels, index } = options

			const root = this.resolveActionRoot()
			const scrollAmount = (pixels ?? numPages * this.getRootViewportHeight(root)) * (down ? 1 : -1)

			const element = index !== undefined ? this.getActionElement(index, root) : null

			const message = await scrollVertically(
				scrollAmount,
				element,
				this.isRootScoped() ? root : undefined
			)
			throwIfAborted(context?.signal)

			return {
				success: true,
				message,
			}
		} catch (error) {
			throwIfAborted(context?.signal)
			return {
				success: false,
				message: `❌ Failed to scroll: ${error}`,
			}
		}
	}

	/**
	 * Scroll horizontally
	 */
	async scrollHorizontally(
		options: HorizontalScrollOptions,
		context?: PageControllerCallContext
	): Promise<PageActionResult> {
		try {
			throwIfAborted(context?.signal)
			const { right, pixels, index } = options

			const root = this.resolveActionRoot()

			const scrollAmount = pixels * (right ? 1 : -1)

			const element = index !== undefined ? this.getActionElement(index, root) : null

			const message = await scrollHorizontally(
				scrollAmount,
				element,
				this.isRootScoped() ? root : undefined
			)
			throwIfAborted(context?.signal)

			return {
				success: true,
				message,
			}
		} catch (error) {
			throwIfAborted(context?.signal)
			return {
				success: false,
				message: `❌ Failed to scroll horizontally: ${error}`,
			}
		}
	}

	/**
	 * Execute arbitrary JavaScript on the page.
	 * The optional `signal` is exposed to the script scope so cooperative code
	 * can abort promptly when the task is stopped.
	 */
	async executeJavascript(script: string, signal?: AbortSignal): Promise<PageActionResult> {
		if (this.isRootScoped()) {
			return {
				success: false,
				message: '❌ JavaScript execution is disabled when a scoped DOM root is configured.',
			}
		}

		try {
			// Wrap script in async function to support await, exposing `signal`.
			const asyncFunction = eval(`(async (signal) => { ${script} })`)
			const result = await asyncFunction(signal)
			return {
				success: true,
				message: `✅ Executed JavaScript. Result: ${result}`,
			}
		} catch (error) {
			return {
				success: false,
				message: `❌ Error executing JavaScript: ${error}`,
			}
		}
	}

	// ======= Mask Operations =======

	/**
	 * Show the visual mask overlay.
	 * Only works after mask is setup.
	 */
	async showMask(): Promise<void> {
		await this.maskReady
		this.mask?.show()
	}

	/**
	 * Hide the visual mask overlay.
	 * Only works after mask is setup.
	 */
	async hideMask(): Promise<void> {
		await this.maskReady
		this.mask?.hide()
	}

	/**
	 * Dispose and clean up resources
	 */
	dispose(): void {
		dom.cleanUpHighlights(this.highlightCleanupRegistry)
		dom.unregisterHighlightCleanupRegistry(this.highlightCleanupRegistry)
		this.flatTree = null
		this.selectorMap.clear()
		this.elementTextMap.clear()
		this.simplifiedHTML = '<EMPTY>'
		this.isIndexed = false
		this.activeRoot = null
		this.mask?.dispose()
		this.mask = null
	}
}

export * from './actions'

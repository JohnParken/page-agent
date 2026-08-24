import {
	type FrameBridgeApprovalHandler,
	FrameBridgeClient,
	type FrameBridgeClientOptions,
	FrameBridgeError,
	type FrameBridgePointerDetail,
	isDirectCrossOriginFrame,
	normalizeAllowedChildOrigins,
} from './FrameBridgeClient'
import { allocateGlobalIndices, remapIndexedContent } from './index-remap'
import { BridgeErrorCode } from './protocol'

import type {
	BrowserState,
	HorizontalScrollOptions,
	IndexedBrowserState,
	PageActionResult,
	PageControllerAdapter,
	PageControllerCallContext,
	ScrollOptions,
} from '../PageController'

export interface FrameAwarePageControllerOptions {
	/** Controller for the top-level document. This controller owns local DOM actions. */
	localController: PageControllerAdapter
	/** Explicit selector for direct child iframes that opt into the bridge. */
	frameSelector: string
	/** Exact origins permitted to answer the bridge handshake. */
	allowedChildOrigins: readonly string[]
	handshakeTimeoutMs?: number
	requestTimeoutMs?: number
	window?: Window
	/** Injected document is useful for unit tests and non-global browser contexts. */
	document?: Document
	/** Required for child targets whose local policy returns approval_required. */
	onApprovalRequired?: FrameBridgeApprovalHandler
}

interface LocalState extends BrowserState {
	treeRevision?: number
	indices?: number[]
}

type IndexTarget =
	| { kind: 'local' }
	| { kind: 'remote'; client: FrameBridgeClient; localIndex: number; remoteRevision: number }
	| { kind: 'frame'; client: FrameBridgeClient; remoteRevision: number }

interface FrameRecord {
	client: FrameBridgeClient
	loadHandler: () => void
	pointerHandler: EventListener
}

interface RemoteObservation {
	iframe: HTMLIFrameElement
	client: FrameBridgeClient
	state: IndexedBrowserState
	frameIndex: number
	indexMapping: Map<number, number>
	globalIndices: number[]
	content: string
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 1_000
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000

function randomId(prefix: string): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return `${prefix}-${crypto.randomUUID()}`
	}
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function escapeText(value: string): string {
	return value.replace(
		/[<&>]/g,
		(character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[character]!
	)
}

function escapeAttribute(value: string): string {
	return value.replace(
		/[&<>"]/g,
		(character) =>
			({
				'&': '&amp;',
				'<': '&lt;',
				'>': '&gt;',
				'"': '&quot;',
			})[character]!
	)
}

function stateIndices(state: LocalState): number[] {
	const indices = Array.isArray(state.indices)
		? state.indices.filter((index) => Number.isSafeInteger(index) && index >= 0)
		: []
	for (const match of state.content.matchAll(/^\s*\*?\[(\d+)\](?=<)/gm)) {
		const index = Number(match[1])
		if (Number.isSafeInteger(index) && !indices.includes(index)) indices.push(index)
	}
	return indices.sort((a, b) => a - b)
}

function errorMessage(error: unknown): string {
	if (error instanceof FrameBridgeError) return `${error.code}: ${error.message}`
	return error instanceof Error ? error.message : String(error)
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return
	throw new FrameBridgeError(BridgeErrorCode.ABORTED, 'Bridge request was aborted')
}

function actionFailure(error: unknown): PageActionResult {
	return {
		success: false,
		message: `❌ Iframe bridge action failed: ${errorMessage(error)}`,
	}
}

/**
 * Controller decorator that augments a local PageController with cooperative,
 * cross-origin direct iframe observations and actions.
 */
export class FrameAwarePageController extends EventTarget implements PageControllerAdapter {
	readonly localController: PageControllerAdapter
	readonly frameSelector: string
	readonly allowedChildOrigins: readonly string[]
	readonly handshakeTimeoutMs: number
	readonly requestTimeoutMs: number
	readonly onApprovalRequired: FrameBridgeApprovalHandler | undefined

	private readonly ownerWindow: Window
	private readonly ownerDocument: Document
	private readonly sessionId = randomId('session')
	private readonly records = new Map<HTMLIFrameElement, FrameRecord>()
	private readonly indexTargets = new Map<number, IndexTarget>()
	private disposed = false
	private observationRevision = 0

	constructor(options: FrameAwarePageControllerOptions) {
		super()
		if (!options?.localController) {
			throw new TypeError('FrameAwarePageController requires localController')
		}
		if (!options.frameSelector || typeof options.frameSelector !== 'string') {
			throw new TypeError('FrameAwarePageController requires an explicit frameSelector')
		}
		if (!Array.isArray(options.allowedChildOrigins) || options.allowedChildOrigins.length === 0) {
			throw new TypeError('FrameAwarePageController requires allowedChildOrigins')
		}
		const allowedChildOrigins = normalizeAllowedChildOrigins(options.allowedChildOrigins)
		this.localController = options.localController
		this.frameSelector = options.frameSelector
		this.allowedChildOrigins = allowedChildOrigins
		this.handshakeTimeoutMs = Math.max(
			1,
			options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
		)
		this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
		this.ownerWindow = options.window ?? window
		this.ownerDocument = options.document ?? this.ownerWindow.document
		this.onApprovalRequired = options.onApprovalRequired
	}

	get frameClients(): readonly FrameBridgeClient[] {
		return [...this.records.values()].map((record) => record.client)
	}

	async getCurrentUrl(context?: PageControllerCallContext): Promise<string> {
		throwIfAborted(context?.signal)
		return this.localController.getCurrentUrl(context)
	}

	async getLastUpdateTime(context?: PageControllerCallContext): Promise<number> {
		throwIfAborted(context?.signal)
		return this.localController.getLastUpdateTime(context)
	}

	async getBrowserState(context?: PageControllerCallContext): Promise<IndexedBrowserState> {
		if (this.disposed)
			throw new FrameBridgeError(BridgeErrorCode.DISPOSED, 'Controller is disposed')
		throwIfAborted(context?.signal)
		const localState = (await this.localController.getBrowserState(context)) as LocalState
		throwIfAborted(context?.signal)
		const localIndices = stateIndices(localState)
		this.sweepFrames()
		const frames = this.getCandidateFrames()
		const observations = await Promise.all(frames.map((frame) => this.observeFrame(frame, context)))
		throwIfAborted(context?.signal)

		this.indexTargets.clear()
		for (const index of localIndices) this.indexTargets.set(index, { kind: 'local' })

		let nextIndex = localIndices.length > 0 ? Math.max(...localIndices) + 1 : 0
		const contentSections = [localState.content]
		const remoteSections: string[] = []
		const availableObservations: RemoteObservation[] = []
		for (const observation of observations) {
			if (!observation) continue
			if ('unavailable' in observation) {
				remoteSections.push(observation.unavailable)
				continue
			}
			availableObservations.push(observation)
		}

		for (const observation of availableObservations) {
			const remoteIndices = stateIndices(observation.state)
			const allocation = allocateGlobalIndices(remoteIndices, nextIndex)
			nextIndex = allocation.nextIndex
			const frameIndex = nextIndex++
			observation.frameIndex = frameIndex
			observation.indexMapping = allocation.mapping
			observation.globalIndices = [...allocation.mapping.values(), frameIndex]
			observation.content = this.renderRemoteFrame(observation)
			for (const [localIndex, globalIndex] of allocation.mapping) {
				this.indexTargets.set(globalIndex, {
					kind: 'remote',
					client: observation.client,
					localIndex,
					remoteRevision: observation.state.treeRevision,
				})
			}
			this.indexTargets.set(frameIndex, {
				kind: 'frame',
				client: observation.client,
				remoteRevision: observation.state.treeRevision,
			})
			remoteSections.push(observation.content)
		}
		if (remoteSections.length > 0) {
			contentSections.push(
				`<cross-origin-frames>\n${remoteSections.join('\n\n')}\n</cross-origin-frames>`
			)
		}

		this.observationRevision += 1
		const indices = [...this.indexTargets.keys()].sort((a, b) => a - b)
		return {
			url: localState.url,
			title: localState.title,
			header: localState.header,
			content: contentSections.filter(Boolean).join('\n\n'),
			footer: localState.footer,
			treeRevision: this.observationRevision,
			indices,
		}
	}

	async updateTree(context?: PageControllerCallContext): Promise<string> {
		return (await this.getBrowserState(context)).content
	}

	async cleanUpHighlights(): Promise<void> {
		await this.localController.cleanUpHighlights()
		await Promise.allSettled(this.frameClients.map((client) => client.cleanUpHighlights()))
	}

	async clickElement(
		index: number,
		context?: PageControllerCallContext
	): Promise<PageActionResult> {
		const target = this.indexTargets.get(index)
		if (!target)
			return actionFailure(
				new FrameBridgeError(
					BridgeErrorCode.STALE_TREE,
					`Index ${index} is not in the current page tree.`
				)
			)
		if (target.kind === 'local') return this.localController.clickElement(index, context)
		if (target.kind === 'frame')
			return actionFailure(
				new FrameBridgeError(
					BridgeErrorCode.INVALID_PAYLOAD,
					'A frame document index is scroll-only'
				)
			)
		return this.runRemoteAction(
			target.client,
			target.remoteRevision,
			(iframe) => this.scrollIframeIntoView(iframe),
			() => target.client.clickElement(target.localIndex, context)
		)
	}

	async inputText(
		index: number,
		text: string,
		context?: PageControllerCallContext
	): Promise<PageActionResult> {
		const target = this.indexTargets.get(index)
		if (!target)
			return actionFailure(
				new FrameBridgeError(
					BridgeErrorCode.STALE_TREE,
					`Index ${index} is not in the current page tree.`
				)
			)
		if (target.kind === 'local') return this.localController.inputText(index, text, context)
		if (target.kind === 'frame')
			return actionFailure(
				new FrameBridgeError(
					BridgeErrorCode.INVALID_PAYLOAD,
					'A frame document index is scroll-only'
				)
			)
		return this.runRemoteAction(
			target.client,
			target.remoteRevision,
			(iframe) => this.scrollIframeIntoView(iframe),
			() => target.client.inputText(target.localIndex, text, context)
		)
	}

	async selectOption(
		index: number,
		optionText: string,
		context?: PageControllerCallContext
	): Promise<PageActionResult> {
		const target = this.indexTargets.get(index)
		if (!target)
			return actionFailure(
				new FrameBridgeError(
					BridgeErrorCode.STALE_TREE,
					`Index ${index} is not in the current page tree.`
				)
			)
		if (target.kind === 'local')
			return this.localController.selectOption(index, optionText, context)
		if (target.kind === 'frame')
			return actionFailure(
				new FrameBridgeError(
					BridgeErrorCode.INVALID_PAYLOAD,
					'A frame document index is scroll-only'
				)
			)
		return this.runRemoteAction(
			target.client,
			target.remoteRevision,
			(iframe) => this.scrollIframeIntoView(iframe),
			() => target.client.selectOption(target.localIndex, optionText, context)
		)
	}

	async scroll(
		options: ScrollOptions,
		context?: PageControllerCallContext
	): Promise<PageActionResult> {
		if (options.index === undefined) return this.localController.scroll(options, context)
		const target = this.indexTargets.get(options.index)
		if (!target)
			return actionFailure(
				new FrameBridgeError(
					BridgeErrorCode.STALE_TREE,
					`Index ${options.index} is not in the current page tree.`
				)
			)
		if (target.kind === 'local') return this.localController.scroll(options, context)
		if (target.kind === 'frame') {
			const { index: _index, ...documentOptions } = options
			return this.runRemoteAction(
				target.client,
				target.remoteRevision,
				(iframe) => this.scrollIframeIntoView(iframe),
				() => target.client.scroll(documentOptions, context)
			)
		}
		return this.runRemoteAction(
			target.client,
			target.remoteRevision,
			(iframe) => this.scrollIframeIntoView(iframe),
			() => target.client.scroll({ ...options, index: target.localIndex }, context)
		)
	}

	async scrollHorizontally(
		options: HorizontalScrollOptions,
		context?: PageControllerCallContext
	): Promise<PageActionResult> {
		if (options.index === undefined)
			return this.localController.scrollHorizontally(options, context)
		const target = this.indexTargets.get(options.index)
		if (!target)
			return actionFailure(
				new FrameBridgeError(
					BridgeErrorCode.STALE_TREE,
					`Index ${options.index} is not in the current page tree.`
				)
			)
		if (target.kind === 'local') return this.localController.scrollHorizontally(options, context)
		if (target.kind === 'frame') {
			const { index: _index, ...documentOptions } = options
			return this.runRemoteAction(
				target.client,
				target.remoteRevision,
				(iframe) => this.scrollIframeIntoView(iframe),
				() => target.client.scrollHorizontally(documentOptions, context)
			)
		}
		return this.runRemoteAction(
			target.client,
			target.remoteRevision,
			(iframe) => this.scrollIframeIntoView(iframe),
			() => target.client.scrollHorizontally({ ...options, index: target.localIndex }, context)
		)
	}

	async executeJavascript(script: string, signal?: AbortSignal): Promise<PageActionResult> {
		return this.localController.executeJavascript(script, signal)
	}

	async showMask(): Promise<void> {
		return this.localController.showMask()
	}

	async hideMask(): Promise<void> {
		return this.localController.hideMask()
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		for (const [iframe, record] of this.records) {
			iframe.removeEventListener('load', record.loadHandler)
			record.client.removeEventListener('pointer', record.pointerHandler)
			record.client.dispose()
		}
		this.records.clear()
		this.indexTargets.clear()
		this.localController.dispose()
	}

	private getCandidateFrames(): HTMLIFrameElement[] {
		return [...this.ownerDocument.querySelectorAll(this.frameSelector)].filter(
			(element): element is HTMLIFrameElement => element.tagName.toLowerCase() === 'iframe'
		)
	}

	private sweepFrames() {
		const current = new Set(this.getCandidateFrames())
		for (const [iframe, record] of this.records) {
			if (current.has(iframe)) continue
			iframe.removeEventListener('load', record.loadHandler)
			record.client.removeEventListener('pointer', record.pointerHandler)
			record.client.invalidate('Iframe removed')
			record.client.dispose()
			this.records.delete(iframe)
		}
	}

	private getOrCreateClient(iframe: HTMLIFrameElement): FrameBridgeClient {
		const existing = this.records.get(iframe)
		if (existing) return existing.client
		const options: FrameBridgeClientOptions = {
			iframe,
			allowedChildOrigins: this.allowedChildOrigins,
			handshakeTimeoutMs: this.handshakeTimeoutMs,
			requestTimeoutMs: this.requestTimeoutMs,
			window: this.ownerWindow,
			onApprovalRequired: this.onApprovalRequired,
		}
		const client = new FrameBridgeClient(options)
		const loadHandler = () => {
			client.invalidate('Iframe loaded or navigated')
			this.indexTargets.clear()
		}
		const pointerHandler: EventListener = (event) => {
			this.forwardRemotePointer(client, (event as CustomEvent<FrameBridgePointerDetail>).detail)
		}
		iframe.addEventListener('load', loadHandler)
		client.addEventListener('pointer', pointerHandler)
		client.addEventListener('invalidate', (event) => {
			this.indexTargets.clear()
			const detail = event instanceof CustomEvent ? event.detail : undefined
			this.dispatchEvent(new CustomEvent('invalidate', { detail }))
		})
		this.records.set(iframe, { client, loadHandler, pointerHandler })
		return client
	}

	private async observeFrame(
		iframe: HTMLIFrameElement,
		context?: PageControllerCallContext
	): Promise<RemoteObservation | { unavailable: string } | null> {
		if (!isDirectCrossOriginFrame(iframe, this.ownerDocument)) {
			const existing = this.records.get(iframe)
			if (existing) {
				iframe.removeEventListener('load', existing.loadHandler)
				existing.client.removeEventListener('pointer', existing.pointerHandler)
				existing.client.invalidate('Iframe navigated to a same-origin document')
				existing.client.dispose()
				this.records.delete(iframe)
			}
			return null
		}
		const client = this.getOrCreateClient(iframe)
		try {
			await client.connect(this.sessionId, context)
			const state = await client.getBrowserState(context)
			return {
				iframe,
				client,
				state,
				frameIndex: -1,
				indexMapping: new Map(),
				globalIndices: [],
				content: '',
			}
		} catch (error) {
			const message = escapeText(errorMessage(error))
			const src = escapeAttribute(iframe.getAttribute('src') || iframe.src || '')
			const title = escapeAttribute(iframe.title || '')
			this.dispatchEvent(
				new CustomEvent('bridgeerror', {
					detail: { iframe, error, message },
				})
			)
			return {
				unavailable: `<cross-origin-frame unavailable="true" src="${src}" title="${title}">Frame unavailable: ${message}</cross-origin-frame>`,
			}
		}
	}

	private renderRemoteFrame(observation: RemoteObservation): string {
		const { iframe, state, frameIndex, indexMapping } = observation
		const mappedContent = remapIndexedContent(state.content, indexMapping)
		const src = state.url || iframe.getAttribute('src') || iframe.src
		return [
			`<cross-origin-frame src="${escapeAttribute(src)}" title="${escapeAttribute(state.title)}">`,
			`*[${frameIndex}]<iframe-document>${escapeText(state.title || state.url)}</iframe-document>`,
			escapeText(state.header),
			mappedContent,
			escapeText(state.footer),
			'</cross-origin-frame>',
		].join('\n')
	}

	private scrollIframeIntoView(iframe: HTMLIFrameElement) {
		try {
			iframe.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
		} catch {
			// Some embedded browsers expose scrollIntoView without options.
			try {
				iframe.scrollIntoView?.()
			} catch {
				// Visibility is best effort; the remote action remains meaningful.
			}
		}
	}

	/** Translate child viewport coordinates into the top-level viewport used by SimulatorMask. */
	private forwardRemotePointer(client: FrameBridgeClient, detail: FrameBridgePointerDetail): void {
		if (this.disposed) return
		const iframe = client.iframe
		const record = this.records.get(iframe)
		if (record?.client !== client || !iframe.isConnected || !this.ownerDocument.contains(iframe)) {
			return
		}

		const CustomEventConstructor =
			(this.ownerWindow as Window & typeof globalThis).CustomEvent ?? CustomEvent
		if (detail.action === 'click') {
			this.ownerWindow.dispatchEvent(new CustomEventConstructor('PageAgent::ClickPointer'))
			return
		}

		const rect = iframe.getBoundingClientRect()
		const scaleX = iframe.offsetWidth > 0 ? rect.width / iframe.offsetWidth : 1
		const scaleY = iframe.offsetHeight > 0 ? rect.height / iframe.offsetHeight : 1
		const x = rect.left + (iframe.clientLeft + detail.x) * scaleX
		const y = rect.top + (iframe.clientTop + detail.y) * scaleY
		if (!Number.isFinite(x) || !Number.isFinite(y)) return

		this.ownerWindow.dispatchEvent(
			new CustomEventConstructor('PageAgent::MovePointerTo', { detail: { x, y } })
		)
	}

	private async runRemoteAction(
		client: FrameBridgeClient,
		expectedRevision: number,
		before: (iframe: HTMLIFrameElement) => void,
		action: () => Promise<PageActionResult>
	): Promise<PageActionResult> {
		try {
			this.assertCurrentRemoteTarget(client)
			if (client.currentTreeRevision !== expectedRevision) {
				throw new FrameBridgeError(
					BridgeErrorCode.STALE_TREE,
					`Remote tree revision ${expectedRevision} is no longer current.`
				)
			}
			before(client.iframe)
			return await action()
		} catch (error) {
			return actionFailure(error)
		}
	}

	private assertCurrentRemoteTarget(client: FrameBridgeClient): void {
		const iframe = client.iframe
		let matchesSelector = false
		try {
			matchesSelector = iframe.matches(this.frameSelector)
		} catch {
			matchesSelector = false
		}
		const attached = iframe.isConnected && this.ownerDocument.contains(iframe)
		const record = this.records.get(iframe)
		if (attached && matchesSelector && record?.client === client && client.connected) return

		if (record?.client === client) {
			iframe.removeEventListener('load', record.loadHandler)
			client.removeEventListener('pointer', record.pointerHandler)
			client.invalidate('Iframe was removed or no longer matches frameSelector')
			client.dispose()
			this.records.delete(iframe)
		}
		this.indexTargets.clear()
		throw new FrameBridgeError(
			BridgeErrorCode.STALE_TREE,
			'Iframe is no longer connected, selected, or has an active bridge connection.'
		)
	}
}

export type { FrameBridgeClientOptions }

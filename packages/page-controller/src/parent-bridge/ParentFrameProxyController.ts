import {
	FrameBridgeClient,
	FrameBridgeError,
	getFrameSourceOrigin,
	isDirectCrossOriginFrame,
	normalizeAllowedChildOrigins,
} from '../iframe-bridge/FrameBridgeClient'
import { allocateGlobalIndices, remapIndexedContent } from '../iframe-bridge/index-remap'
import {
	FRAME_BRIDGE_CAPABILITIES,
	type FrameBridgeCapability,
	type FrameBridgePreparedAction,
} from '../iframe-bridge/protocol'
import { BridgeErrorCode } from '../iframe-bridge/protocol'

import { secureParentControllerId } from './security'

import type {
	BrowserState,
	HorizontalScrollOptions,
	IndexedBrowserState,
	IndexedPageControllerAdapter,
	PageActionResult,
	PageControllerCallContext,
	ScrollOptions,
} from '../PageController'
import type { ParentControllerActionTargetContext, ParentControllerChildFrameTarget } from './types'

type ProxyActionMethod =
	| 'clickElement'
	| 'inputText'
	| 'selectOption'
	| 'scroll'
	| 'scrollHorizontally'

const METHOD_CAPABILITY: Record<ProxyActionMethod, FrameBridgeCapability> = {
	clickElement: 'click',
	inputText: 'input',
	selectOption: 'select',
	scroll: 'scroll',
	scrollHorizontally: 'scrollHorizontally',
}

interface LocalState extends BrowserState {
	treeRevision?: number
	indices?: number[]
}

interface NormalizedTarget {
	id: string
	iframe: ParentControllerChildFrameTarget['iframe']
	origin: string
	capabilities: readonly FrameBridgeCapability[]
}

export interface ParentFrameProxyGrant {
	id: string
	origin: string
	capabilities: readonly FrameBridgeCapability[]
}

interface RemoteIndexTarget {
	kind: 'remote'
	record: FrameRecord
	localIndex: number
	remoteRevision: number
	root: Element
}

type IndexTarget =
	| { kind: 'local' }
	| RemoteIndexTarget
	| { kind: 'frame'; record: FrameRecord; remoteRevision: number; root: Element }

interface FrameRecord {
	target: NormalizedTarget
	iframe: HTMLIFrameElement
	client: FrameBridgeClient
	capabilities: readonly FrameBridgeCapability[]
	loadHandler: () => void
	pointerHandler: EventListener
}

interface RemoteObservation {
	record: FrameRecord
	state: IndexedBrowserState
	root: Element
}

interface LocalPreparedAction {
	kind: 'local'
	method: ProxyActionMethod
	payload: unknown
	decision: 'allow'
	targetContext: Extract<ParentControllerActionTargetContext, { kind: 'local' }>
}

interface ChildFramePreparedAction {
	kind: 'child-frame'
	method: ProxyActionMethod
	payload: unknown
	remotePayload: unknown
	decision: 'allow' | 'deny' | 'approval_required'
	reason?: string
	childPrepared: FrameBridgePreparedAction
	record: FrameRecord
	remoteRevision: number
	root: Element
	targetContext: Extract<ParentControllerActionTargetContext, { kind: 'child-frame' }>
}

export type ParentFrameProxyPreparedAction = LocalPreparedAction | ChildFramePreparedAction

export interface ParentFrameProxyControllerOptions {
	localController: IndexedPageControllerAdapter
	root: Element | (() => Element | null | undefined)
	assistantIframe: HTMLIFrameElement
	targets: readonly ParentControllerChildFrameTarget[]
	handshakeTimeoutMs: number
	requestTimeoutMs: number
	window: Window
	disposeLocalController: boolean
}

function stateIndices(state: LocalState): number[] {
	const values = Array.isArray(state.indices)
		? state.indices.filter((index) => Number.isSafeInteger(index) && index >= 0)
		: []
	for (const match of state.content.matchAll(/^\s*\*?\[(\d+)\](?=<)/gm)) {
		const index = Number(match[1])
		if (Number.isSafeInteger(index) && !values.includes(index)) values.push(index)
	}
	return values.sort((left, right) => left - right)
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
		(character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!
	)
}

function actionError(error: unknown): PageActionResult {
	const message = error instanceof Error ? error.message : String(error)
	return { success: false, message: `❌ Child iframe proxy action failed: ${message}` }
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted)
		throw new FrameBridgeError(BridgeErrorCode.ABORTED, 'Child iframe proxy request was aborted')
}

function isFrameCapability(value: string): value is FrameBridgeCapability {
	return (FRAME_BRIDGE_CAPABILITIES as readonly string[]).includes(value)
}

/**
 * Parent-owned composite controller for explicitly configured and signed child
 * iframe grants. It never discovers arbitrary frames and never reads a child DOM.
 */
export class ParentFrameProxyController implements IndexedPageControllerAdapter {
	readonly localController: IndexedPageControllerAdapter

	private readonly ownerDocument: Document
	private readonly ownerWindow: Window
	private readonly root: ParentFrameProxyControllerOptions['root']
	private readonly assistantIframe: HTMLIFrameElement
	private readonly targets = new Map<string, NormalizedTarget>()
	private readonly records = new Map<string, FrameRecord>()
	private readonly grants = new Map<string, ParentFrameProxyGrant>()
	private readonly indexTargets = new Map<number, IndexTarget>()
	private readonly sessionId = secureParentControllerId('proxy')
	private readonly handshakeTimeoutMs: number
	private readonly requestTimeoutMs: number
	private readonly disposeLocalController: boolean
	private observationRevision = 0
	private disposed = false

	constructor(options: ParentFrameProxyControllerOptions) {
		this.localController = options.localController
		this.root = options.root
		this.assistantIframe = options.assistantIframe
		this.ownerDocument = options.assistantIframe.ownerDocument
		this.ownerWindow = options.window
		this.handshakeTimeoutMs = options.handshakeTimeoutMs
		this.requestTimeoutMs = options.requestTimeoutMs
		this.disposeLocalController = options.disposeLocalController
		const directIframes = new Set<HTMLIFrameElement>()
		for (const target of options.targets) {
			if (
				!target ||
				typeof target.id !== 'string' ||
				target.id.length === 0 ||
				target.id.length > 256
			)
				throw new TypeError('child frame target id must be a non-empty identifier')
			if (this.targets.has(target.id))
				throw new TypeError(`Duplicate child frame target: ${target.id}`)
			if (typeof target.iframe !== 'function') {
				if (directIframes.has(target.iframe))
					throw new TypeError('A child iframe cannot be configured under multiple target IDs')
				directIframes.add(target.iframe)
			}
			const origin = normalizeAllowedChildOrigins([target.origin])[0]
			if (
				!Array.isArray(target.capabilities) ||
				target.capabilities.length === 0 ||
				new Set(target.capabilities).size !== target.capabilities.length ||
				target.capabilities.some((capability) => !isFrameCapability(capability))
			)
				throw new TypeError(`Invalid capabilities for child frame target: ${target.id}`)
			this.targets.set(target.id, {
				id: target.id,
				iframe: target.iframe,
				origin,
				capabilities: [...target.capabilities],
			})
		}
	}

	setAuthorizedFrames(grants: readonly ParentFrameProxyGrant[]): void {
		this.clearAuthorizedFrames()
		for (const grant of grants) {
			const target = this.targets.get(grant.id)
			if (!target || target.origin !== grant.origin) continue
			const capabilities = grant.capabilities.filter(
				(capability) => target.capabilities.includes(capability) && isFrameCapability(capability)
			)
			if (capabilities.length === 0) continue
			this.grants.set(grant.id, { ...grant, capabilities })
		}
	}

	clearAuthorizedFrames(): void {
		for (const record of this.records.values()) this.disposeRecord(record, 'Authorization reset')
		this.records.clear()
		this.grants.clear()
		this.indexTargets.clear()
	}

	getCurrentUrl(context?: PageControllerCallContext): Promise<string> {
		throwIfAborted(context?.signal)
		return this.localController.getCurrentUrl(context)
	}

	getLastUpdateTime(context?: PageControllerCallContext): Promise<number> {
		throwIfAborted(context?.signal)
		return this.localController.getLastUpdateTime(context)
	}

	async getBrowserState(context?: PageControllerCallContext): Promise<IndexedBrowserState> {
		if (this.disposed)
			throw new FrameBridgeError(BridgeErrorCode.DISPOSED, 'Child iframe proxy is disposed')
		throwIfAborted(context?.signal)
		const localState = (await this.localController.getBrowserState(context)) as LocalState
		const localIndices = stateIndices(localState)
		this.indexTargets.clear()
		for (const index of localIndices) this.indexTargets.set(index, { kind: 'local' })

		const sections = [localState.content]
		const childSections: string[] = []
		let nextIndex = localIndices.length > 0 ? Math.max(...localIndices) + 1 : 0
		for (const grant of this.grants.values()) {
			if (!grant.capabilities.includes('observe')) continue
			const observation = await this.observeFrame(grant, context)
			throwIfAborted(context?.signal)
			if ('unavailable' in observation) {
				childSections.push(observation.unavailable)
				continue
			}
			const remoteIndices = stateIndices(observation.state)
			const allocation = allocateGlobalIndices(remoteIndices, nextIndex)
			nextIndex = allocation.nextIndex
			const frameIndex = nextIndex++
			for (const [localIndex, globalIndex] of allocation.mapping) {
				this.indexTargets.set(globalIndex, {
					kind: 'remote',
					record: observation.record,
					localIndex,
					remoteRevision: observation.state.treeRevision,
					root: observation.root,
				})
			}
			this.indexTargets.set(frameIndex, {
				kind: 'frame',
				record: observation.record,
				remoteRevision: observation.state.treeRevision,
				root: observation.root,
			})
			childSections.push(
				this.renderRemoteFrame(
					observation.record,
					observation.state,
					allocation.mapping,
					frameIndex
				)
			)
		}
		if (childSections.length > 0)
			sections.push(
				`<authorized-child-frames>\n${childSections.join('\n\n')}\n</authorized-child-frames>`
			)
		this.observationRevision += 1
		return {
			url: localState.url,
			title: localState.title,
			header: localState.header,
			content: sections.filter(Boolean).join('\n\n'),
			footer: localState.footer,
			treeRevision: this.observationRevision,
			indices: [...this.indexTargets.keys()].sort((left, right) => left - right),
		}
	}

	async updateTree(context?: PageControllerCallContext): Promise<string> {
		return (await this.getBrowserState(context)).content
	}

	async cleanUpHighlights(): Promise<void> {
		await this.localController.cleanUpHighlights()
		await Promise.allSettled(
			[...this.records.values()]
				.filter((record) => record.capabilities.includes('cleanup'))
				.map((record) => record.client.cleanUpHighlights())
		)
	}

	async prepareAction(
		method: ProxyActionMethod,
		payload: unknown,
		context?: PageControllerCallContext
	): Promise<ParentFrameProxyPreparedAction> {
		throwIfAborted(context?.signal)
		const index =
			payload &&
			typeof payload === 'object' &&
			typeof (payload as { index?: unknown }).index === 'number'
				? (payload as { index: number }).index
				: undefined
		const target = index === undefined ? { kind: 'local' as const } : this.indexTargets.get(index)
		if (!target)
			throw new FrameBridgeError(BridgeErrorCode.STALE_TREE, `Index ${String(index)} is stale`)
		if (target.kind === 'local') {
			const element = index === undefined ? undefined : this.getLocalElement(index)
			return {
				kind: 'local',
				method,
				payload,
				decision: 'allow',
				targetContext: { kind: 'local', target: element },
			}
		}
		if (target.kind === 'frame' && method !== 'scroll' && method !== 'scrollHorizontally')
			throw new FrameBridgeError(
				BridgeErrorCode.INVALID_PAYLOAD,
				'A child frame document index is scroll-only'
			)
		this.assertCurrentRecord(target.record, target.remoteRevision, target.root)
		const capability = METHOD_CAPABILITY[method]
		if (!target.record.capabilities.includes(capability))
			throw new FrameBridgeError(
				BridgeErrorCode.CAPABILITY_DENIED,
				`Signed child frame grant does not allow ${capability}`
			)
		const remotePayload = this.remotePayload(target, payload)
		const childPrepared = await target.record.client.prepareAction(method, remotePayload, context)
		return {
			kind: 'child-frame',
			method,
			payload,
			remotePayload,
			decision: childPrepared.decision,
			reason: childPrepared.reason,
			childPrepared,
			record: target.record,
			remoteRevision: target.remoteRevision,
			root: target.root,
			targetContext: {
				kind: 'child-frame',
				frameId: target.record.target.id,
				origin: target.record.target.origin,
				iframe: target.record.iframe,
				childTarget: childPrepared.target,
			},
		}
	}

	resolvePreparedElement(prepared: ParentFrameProxyPreparedAction): Element | undefined {
		if (prepared.kind === 'child-frame') {
			this.assertCurrentRecord(prepared.record, prepared.remoteRevision, prepared.root)
			return prepared.record.iframe
		}
		const payload = prepared.payload as { index?: unknown }
		return typeof payload?.index === 'number' ? this.getLocalElement(payload.index) : undefined
	}

	async commitPreparedAction(
		prepared: ParentFrameProxyPreparedAction,
		approved: boolean,
		context?: PageControllerCallContext
	): Promise<PageActionResult> {
		throwIfAborted(context?.signal)
		if (prepared.kind === 'child-frame') {
			this.assertCurrentRecord(prepared.record, prepared.remoteRevision, prepared.root)
			this.scrollIframeIntoView(prepared.record.iframe)
			return prepared.record.client.commitPreparedAction(
				prepared.childPrepared,
				prepared.remotePayload,
				approved,
				context
			)
		}
		return this.invokeLocal(prepared.method, prepared.payload, context)
	}

	clickElement(index: number, context?: PageControllerCallContext): Promise<PageActionResult> {
		return this.runDirectAction('clickElement', { index }, context)
	}

	inputText(
		index: number,
		text: string,
		context?: PageControllerCallContext
	): Promise<PageActionResult> {
		return this.runDirectAction('inputText', { index, text }, context)
	}

	selectOption(
		index: number,
		optionText: string,
		context?: PageControllerCallContext
	): Promise<PageActionResult> {
		return this.runDirectAction('selectOption', { index, optionText }, context)
	}

	scroll(options: ScrollOptions, context?: PageControllerCallContext): Promise<PageActionResult> {
		return this.runDirectAction('scroll', options, context)
	}

	scrollHorizontally(
		options: HorizontalScrollOptions,
		context?: PageControllerCallContext
	): Promise<PageActionResult> {
		return this.runDirectAction('scrollHorizontally', options, context)
	}

	executeJavascript(script: string, signal?: AbortSignal): Promise<PageActionResult> {
		return this.localController.executeJavascript(script, signal)
	}

	showMask(): Promise<void> {
		return this.localController.showMask()
	}

	hideMask(): Promise<void> {
		return this.localController.hideMask()
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.clearAuthorizedFrames()
		if (this.disposeLocalController) this.localController.dispose()
	}

	private resolveRoot(): Element {
		const root = typeof this.root === 'function' ? this.root() : this.root
		if (!root || root.ownerDocument !== this.ownerDocument || !root.isConnected)
			throw new FrameBridgeError(
				BridgeErrorCode.STALE_TREE,
				'Configured parent root is unavailable'
			)
		return root
	}

	private resolveIframe(target: NormalizedTarget): HTMLIFrameElement {
		let iframe: HTMLIFrameElement | null
		try {
			iframe = typeof target.iframe === 'function' ? target.iframe() : target.iframe
		} catch {
			iframe = null
		}
		const root = this.resolveRoot()
		if (
			!iframe ||
			iframe === this.assistantIframe ||
			iframe.ownerDocument !== this.ownerDocument ||
			!iframe.isConnected ||
			!root.contains(iframe) ||
			getFrameSourceOrigin(iframe, this.ownerDocument) !== target.origin ||
			!isDirectCrossOriginFrame(iframe, this.ownerDocument)
		)
			throw new FrameBridgeError(
				BridgeErrorCode.CAPABILITY_DENIED,
				`Authorized child frame ${target.id} is unavailable or changed origin`
			)
		return iframe
	}

	private getOrCreateRecord(grant: ParentFrameProxyGrant): FrameRecord {
		const target = this.targets.get(grant.id)!
		const iframe = this.resolveIframe(target)
		if (
			[...this.records.values()].some(
				(record) => record.target.id !== grant.id && record.iframe === iframe
			)
		)
			throw new FrameBridgeError(
				BridgeErrorCode.CAPABILITY_DENIED,
				'One child iframe cannot satisfy multiple signed target grants'
			)
		const existing = this.records.get(grant.id)
		if (existing?.iframe === iframe) {
			existing.capabilities = grant.capabilities
			return existing
		}
		if (existing) this.disposeRecord(existing, 'Configured child iframe was replaced')
		const client = new FrameBridgeClient({
			iframe,
			allowedChildOrigins: [target.origin],
			handshakeTimeoutMs: this.handshakeTimeoutMs,
			requestTimeoutMs: this.requestTimeoutMs,
			window: this.ownerWindow,
		})
		const loadHandler = () => {
			client.invalidate('Authorized child iframe loaded or navigated')
			this.indexTargets.clear()
		}
		const pointerHandler: EventListener = (event) =>
			this.forwardRemotePointer(
				iframe,
				(event as CustomEvent<{ action: 'move'; x: number; y: number } | { action: 'click' }>)
					.detail
			)
		iframe.addEventListener('load', loadHandler)
		client.addEventListener('pointer', pointerHandler)
		client.addEventListener('invalidate', () => this.indexTargets.clear())
		const record: FrameRecord = {
			target,
			iframe,
			client,
			capabilities: grant.capabilities,
			loadHandler,
			pointerHandler,
		}
		this.records.set(grant.id, record)
		return record
	}

	private async observeFrame(
		grant: ParentFrameProxyGrant,
		context?: PageControllerCallContext
	): Promise<RemoteObservation | { unavailable: string }> {
		try {
			const record = this.getOrCreateRecord(grant)
			await record.client.connect(`${this.sessionId}:${grant.id}`, context)
			const state = await record.client.getBrowserState(context)
			const root = this.resolveRoot()
			if (!root.contains(record.iframe))
				throw new FrameBridgeError(
					BridgeErrorCode.CAPABILITY_DENIED,
					'Authorized child frame left the configured root during observation'
				)
			return { record, state, root }
		} catch (error) {
			const code =
				error instanceof FrameBridgeError ? error.code : BridgeErrorCode.CONNECTION_CLOSED
			return {
				unavailable: `<authorized-child-frame id="${escapeAttribute(
					grant.id
				)}" origin="${escapeAttribute(
					grant.origin
				)}" unavailable="true">Frame unavailable: ${escapeText(code)}</authorized-child-frame>`,
			}
		}
	}

	private renderRemoteFrame(
		record: FrameRecord,
		state: IndexedBrowserState,
		mapping: ReadonlyMap<number, number>,
		frameIndex: number
	): string {
		return [
			`<authorized-child-frame id="${escapeAttribute(record.target.id)}" origin="${escapeAttribute(
				record.target.origin
			)}">`,
			`*[${frameIndex}]<iframe-document>${escapeText(state.title || state.url)}</iframe-document>`,
			escapeText(state.header),
			remapIndexedContent(state.content, mapping),
			escapeText(state.footer),
			'</authorized-child-frame>',
		].join('\n')
	}

	private getLocalElement(index: number): HTMLElement {
		const resolver = (
			this.localController as IndexedPageControllerAdapter & {
				getIndexedElementForPolicy?: (index: number) => HTMLElement
			}
		).getIndexedElementForPolicy
		if (!resolver)
			throw new FrameBridgeError(
				BridgeErrorCode.STALE_TREE,
				'Local indexed target validation is unavailable'
			)
		return resolver.call(this.localController, index)
	}

	private remotePayload(
		target: RemoteIndexTarget | Extract<IndexTarget, { kind: 'frame' }>,
		payload: unknown
	): unknown {
		const value = { ...(payload as Record<string, unknown>) }
		if (target.kind === 'frame') delete value.index
		else value.index = target.localIndex
		return value
	}

	private assertCurrentRecord(
		record: FrameRecord,
		remoteRevision: number,
		expectedRoot: Element
	): void {
		const grant = this.grants.get(record.target.id)
		const current = this.records.get(record.target.id)
		if (
			!grant ||
			current !== record ||
			this.resolveRoot() !== expectedRoot ||
			this.resolveIframe(record.target) !== record.iframe ||
			!record.client.connected ||
			record.client.currentTreeRevision !== remoteRevision
		)
			throw new FrameBridgeError(BridgeErrorCode.STALE_TREE, 'Authorized child target is stale')
	}

	private invokeLocal(
		method: ProxyActionMethod,
		payload: unknown,
		context?: PageControllerCallContext
	): Promise<PageActionResult> {
		const value = payload as Record<string, unknown>
		switch (method) {
			case 'clickElement':
				return this.localController.clickElement(value.index as number, context)
			case 'inputText':
				return this.localController.inputText(value.index as number, value.text as string, context)
			case 'selectOption':
				return this.localController.selectOption(
					value.index as number,
					value.optionText as string,
					context
				)
			case 'scroll':
				return this.localController.scroll(payload as ScrollOptions, context)
			case 'scrollHorizontally':
				return this.localController.scrollHorizontally(payload as HorizontalScrollOptions, context)
		}
	}

	private async runDirectAction(
		method: ProxyActionMethod,
		payload: unknown,
		context?: PageControllerCallContext
	): Promise<PageActionResult> {
		try {
			const prepared = await this.prepareAction(method, payload, context)
			if (prepared.decision !== 'allow')
				throw new FrameBridgeError(
					prepared.decision === 'deny'
						? BridgeErrorCode.CAPABILITY_DENIED
						: BridgeErrorCode.APPROVAL_REQUIRED,
					prepared.reason ?? 'Child iframe action requires parent-host policy handling'
				)
			return await this.commitPreparedAction(prepared, false, context)
		} catch (error) {
			return actionError(error)
		}
	}

	private scrollIframeIntoView(iframe: HTMLIFrameElement): void {
		try {
			iframe.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
		} catch {
			try {
				iframe.scrollIntoView?.()
			} catch {
				/* best effort */
			}
		}
	}

	private forwardRemotePointer(
		iframe: HTMLIFrameElement,
		detail: { action: 'move'; x: number; y: number } | { action: 'click' }
	): void {
		if (detail.action === 'click') {
			this.ownerWindow.dispatchEvent(new CustomEvent('PageAgent::ClickPointer'))
			return
		}
		const rect = iframe.getBoundingClientRect()
		const scaleX = iframe.offsetWidth > 0 ? rect.width / iframe.offsetWidth : 1
		const scaleY = iframe.offsetHeight > 0 ? rect.height / iframe.offsetHeight : 1
		const x = rect.left + (iframe.clientLeft + detail.x) * scaleX
		const y = rect.top + (iframe.clientTop + detail.y) * scaleY
		if (Number.isFinite(x) && Number.isFinite(y))
			this.ownerWindow.dispatchEvent(
				new CustomEvent('PageAgent::MovePointerTo', { detail: { x, y } })
			)
	}

	private disposeRecord(record: FrameRecord, reason: string): void {
		record.iframe.removeEventListener('load', record.loadHandler)
		record.client.removeEventListener('pointer', record.pointerHandler)
		record.client.invalidate(reason)
		record.client.dispose()
	}
}

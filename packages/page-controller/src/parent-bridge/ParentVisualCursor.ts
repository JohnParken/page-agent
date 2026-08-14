import type { ParentControllerHostWindow } from './types'

export interface ParentVisualCursorOptions {
	readonly document: Document
	readonly window: ParentControllerHostWindow
	readonly root: Element | (() => Element | null | undefined)
	readonly iframe?: HTMLIFrameElement
}

/**
 * Non-blocking parent-page cursor used by the scoped parent controller host.
 *
 * This intentionally does not use SimulatorMask.  The mask is a document-wide
 * interaction blocker and would cover the assistant iframe's stop/approval UI.
 * The cursor is a pointer-events:none presentation element that is only shown
 * while the reported coordinates are inside the currently trusted root.
 */
export class ParentVisualCursor {
	private readonly ownerDocument: Document
	private readonly hostWindow: ParentControllerHostWindow
	private readonly root: Element | (() => Element | null | undefined)
	private readonly iframe: HTMLIFrameElement | undefined
	private readonly movePointerListener = (event: Event) => this.handleMove(event)
	private readonly clickPointerListener = () => this.handleClick()
	private readonly mutationListener = () => this.handleMutation()
	private cursor: HTMLElement | null = null
	private ripple: HTMLElement | null = null
	private activeRoot: Element | null = null
	private observer: MutationObserver | null = null
	private enabled = true
	private disposed = false

	constructor(options: ParentVisualCursorOptions) {
		this.ownerDocument = options.document
		this.hostWindow = options.window
		this.root = options.root
		this.iframe = options.iframe

		// ParentPageControllerHostWindow intentionally keeps a narrow message
		// listener type. These event names carry ordinary DOM Events instead.
		this.hostWindow.addEventListener(
			'PageAgent::MovePointerTo',
			this.movePointerListener as unknown as (event: MessageEvent<unknown>) => void
		)
		this.hostWindow.addEventListener(
			'PageAgent::ClickPointer',
			this.clickPointerListener as unknown as (event: MessageEvent<unknown>) => void
		)

		const MutationObserverConstructor = this.ownerDocument.defaultView?.MutationObserver
		if (MutationObserverConstructor) {
			this.observer = new MutationObserverConstructor(this.mutationListener)
			const observationTarget = this.ownerDocument.documentElement ?? this.ownerDocument
			this.observer.observe(observationTarget, { childList: true, subtree: true })
		}
	}

	private resolveRoot(): Element | null {
		let root: Element | null | undefined
		try {
			root = typeof this.root === 'function' ? this.root() : this.root
		} catch {
			return null
		}
		if (
			!root ||
			root.nodeType !== 1 ||
			root.ownerDocument !== this.ownerDocument ||
			!root.isConnected ||
			!this.ownerDocument.documentElement?.contains(root) ||
			(this.iframe !== undefined && root.contains(this.iframe))
		)
			return null
		return root
	}

	private isPointInsideRoot(root: Element, x: number, y: number): boolean {
		const rect = root.getBoundingClientRect()
		if (
			!Number.isFinite(rect.left) ||
			!Number.isFinite(rect.top) ||
			!Number.isFinite(rect.right) ||
			!Number.isFinite(rect.bottom) ||
			x < rect.left ||
			x > rect.right ||
			y < rect.top ||
			y > rect.bottom
		)
			return false

		// A transformed/overlayed page can report a rectangle that overlaps an
		// unrelated element. When hit testing is available, require the actual
		// point to resolve to the trusted root or one of its descendants. jsdom
		// and a few embedded browsers may not implement elementFromPoint; in that
		// case the geometry check above remains the conservative fallback.
		const hitTarget = this.ownerDocument.elementFromPoint?.(x, y)
		return !hitTarget || hitTarget === root || root.contains(hitTarget)
	}

	private ensureCursor(): HTMLElement | null {
		if (this.disposed) return null
		if (this.cursor) return this.cursor
		const body = this.ownerDocument.body
		if (!body) return null

		const cursor = this.ownerDocument.createElement('div')
		cursor.setAttribute('data-page-agent-parent-cursor', '')
		cursor.setAttribute('aria-hidden', 'true')
		// Keep the interaction safety invariant even when the host forgets to
		// load the optional presentation stylesheet or overrides its rules.
		cursor.style.position = 'fixed'
		cursor.style.setProperty('pointer-events', 'none', 'important')
		cursor.hidden = true
		cursor.dataset.state = 'idle'

		const ripple = this.ownerDocument.createElement('span')
		ripple.setAttribute('data-page-agent-parent-cursor-ripple', '')
		ripple.setAttribute('aria-hidden', 'true')
		cursor.appendChild(ripple)

		const pointer = this.ownerDocument.createElement('span')
		pointer.setAttribute('data-page-agent-parent-cursor-pointer', '')
		pointer.setAttribute('aria-hidden', 'true')
		cursor.appendChild(pointer)

		body.appendChild(cursor)
		this.cursor = cursor
		this.ripple = ripple
		return cursor
	}

	private handleMove(event: Event): void {
		if (this.disposed || !this.enabled) {
			this.clear()
			return
		}
		const detail = (event as CustomEvent<{ x?: unknown; y?: unknown }>).detail
		const x = detail && typeof detail.x === 'number' ? detail.x : Number.NaN
		const y = detail && typeof detail.y === 'number' ? detail.y : Number.NaN
		const root = this.resolveRoot()
		if (
			!root ||
			!Number.isFinite(x) ||
			!Number.isFinite(y) ||
			!this.isPointInsideRoot(root, x, y)
		) {
			this.clear()
			return
		}
		if (this.activeRoot && this.activeRoot !== root) this.clear()
		const cursor = this.ensureCursor()
		if (!cursor) return
		this.activeRoot = root
		cursor.style.left = `${x}px`
		cursor.style.top = `${y}px`
		cursor.hidden = false
		cursor.dataset.state = 'idle'
	}

	private handleClick(): void {
		if (this.disposed || !this.enabled) {
			this.clear()
			return
		}
		const root = this.resolveRoot()
		const cursor = this.cursor
		if (!root || !cursor || cursor.hidden || root !== this.activeRoot) {
			if (!root) this.clear()
			else if (root !== this.activeRoot) this.clear()
			return
		}
		const x = Number.parseFloat(cursor.style.left)
		const y = Number.parseFloat(cursor.style.top)
		if (!Number.isFinite(x) || !Number.isFinite(y) || !this.isPointInsideRoot(root, x, y)) {
			this.clear()
			return
		}
		cursor.classList.remove('page-agent-parent-cursor-clicking')
		// Force a reflow so repeated clicks restart the CSS ripple animation.
		void (this.ripple?.offsetWidth ?? 0)
		cursor.classList.add('page-agent-parent-cursor-clicking')
		cursor.dataset.state = 'clicking'
	}

	private handleMutation(): void {
		const root = this.resolveRoot()
		if (!root || (this.activeRoot && root !== this.activeRoot)) this.clear()
	}

	/** Hide the cursor without removing listeners or presentation DOM. */
	clear(): void {
		if (!this.cursor) return
		this.cursor.hidden = true
		this.cursor.dataset.state = 'idle'
		this.cursor.classList.remove('page-agent-parent-cursor-clicking')
		this.activeRoot = null
	}

	/** Enable/disable event-driven cursor presentation without showing it. */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled
		if (!enabled) this.clear()
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.hostWindow.removeEventListener(
			'PageAgent::MovePointerTo',
			this.movePointerListener as unknown as (event: MessageEvent<unknown>) => void
		)
		this.hostWindow.removeEventListener(
			'PageAgent::ClickPointer',
			this.clickPointerListener as unknown as (event: MessageEvent<unknown>) => void
		)
		this.observer?.disconnect()
		this.observer = null
		this.cursor?.remove()
		this.cursor = null
		this.ripple = null
		this.activeRoot = null
	}
}

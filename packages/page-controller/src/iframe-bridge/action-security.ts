import type {
	BridgeActionPayloadSummary,
	FrameBridgeActionMethod,
	FrameBridgeTargetSummary,
} from './protocol'

const MAX_TARGET_LABEL_LENGTH = 160

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
	const record = value as Record<string, unknown>
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
		.join(',')}}`
}

export async function hashFrameBridgePayload(value: unknown): Promise<string> {
	const cryptoObject = (globalThis as typeof globalThis & { crypto?: Crypto }).crypto
	if (!cryptoObject?.subtle) throw new Error('Web Crypto is required for bridge action binding')
	const digest = await cryptoObject.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(stableStringify(value))
	)
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function summarizeFrameBridgePayload(
	method: FrameBridgeActionMethod,
	payload: unknown
): BridgeActionPayloadSummary {
	const value = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
	const index = typeof value.index === 'number' ? value.index : undefined
	if (method === 'inputText') {
		return {
			index,
			textLength: typeof value.text === 'string' ? value.text.length : 0,
		}
	}
	if (method === 'selectOption') {
		return {
			index,
			optionLength: typeof value.optionText === 'string' ? value.optionText.length : 0,
		}
	}
	if (method === 'scroll') {
		return {
			index,
			down: typeof value.down === 'boolean' ? value.down : undefined,
			numPages: typeof value.numPages === 'number' ? value.numPages : undefined,
			pixels: typeof value.pixels === 'number' ? value.pixels : undefined,
		}
	}
	if (method === 'scrollHorizontally') {
		return {
			index,
			right: typeof value.right === 'boolean' ? value.right : undefined,
			pixels: typeof value.pixels === 'number' ? value.pixels : undefined,
		}
	}
	return { index }
}

function sanitizeText(value: string): string {
	return Array.from(value, (character) => {
		const code = character.charCodeAt(0)
		return code <= 31 || code === 127 ? ' ' : character
	})
		.join('')
		.replace(/\s+/g, ' ')
		.trim()
}

export function summarizeFrameBridgeTarget(
	target: Element | undefined
): FrameBridgeTargetSummary | undefined {
	if (!target) return undefined
	const label =
		target.getAttribute('aria-label') ??
		target.getAttribute('title') ??
		target.textContent?.trim() ??
		''
	return {
		tag: target.tagName.toLowerCase(),
		role: target.getAttribute('role') ?? undefined,
		label: label ? sanitizeText(label).slice(0, MAX_TARGET_LABEL_LENGTH) : undefined,
	}
}

export function fingerprintFrameBridgeTarget(target: Element | undefined): string {
	if (!target) return 'document'
	const markers: (string | null)[] = []
	let cursor: Element | null = target
	while (cursor) {
		markers.push(cursor.getAttribute('data-page-agent-policy'))
		cursor = cursor.parentElement
	}
	const anchor = target.closest('a[href]')
	const submitTarget = target.closest('button, input, form') as
		| (Element & { form?: HTMLFormElement | null })
		| null
	return stableStringify({
		markers,
		tag: target.tagName,
		type: target.getAttribute('type'),
		href: anchor?.getAttribute('href'),
		formAction: submitTarget?.getAttribute('formaction'),
		formMethod: submitTarget?.form?.method,
		formTarget: submitTarget?.form?.target,
	})
}

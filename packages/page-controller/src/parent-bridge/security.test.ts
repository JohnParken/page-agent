import { describe, expect, it } from 'vitest'

import {
	normalizeParentControllerOrigin,
	sanitizeParentControllerText,
	sanitizeParentControllerUrl,
	secureParentControllerId,
} from './security'

describe('parent-controller security helpers', () => {
	it('accepts only exact HTTP(S) origins', () => {
		expect(normalizeParentControllerOrigin('https://parent.example.test')).toBe(
			'https://parent.example.test'
		)
		expect(() => normalizeParentControllerOrigin('*')).toThrow()
		expect(() => normalizeParentControllerOrigin('null')).toThrow()
		expect(() => normalizeParentControllerOrigin('https://user:pass@example.test')).toThrow()
		expect(() => normalizeParentControllerOrigin('https://example.test/path')).toThrow()
	})

	it('uses Web Crypto identifiers', () => {
		const first = secureParentControllerId('session')
		const second = secureParentControllerId('session')
		expect(first.startsWith('session-')).toBe(true)
		expect(second).not.toBe(first)
	})

	it('redacts credentials and query fragments from valid URLs', () => {
		expect(
			sanitizeParentControllerUrl(
				'https://alice:secret@example.test/path?token=abc&next=/inbox#fragment'
			)
		).toBe('https://example.test/path')
	})

	it('uses a redacted fallback for malformed URL-like text', () => {
		const malformed = sanitizeParentControllerUrl(
			'not a URL https://alice:secret@example.test/path?access_token=abc'
		)
		expect(malformed).toContain('https://[REDACTED]@example.test/path')
		expect(malformed).not.toContain('secret')
		expect(malformed).not.toContain('abc')
		const queryOnly = sanitizeParentControllerUrl('malformed?token=abc&password=secret')
		expect(queryOnly).not.toContain('abc')
		expect(queryOnly).not.toContain('secret')
	})

	it('redacts bearer and JWT tokens in text fields', () => {
		const sanitized = sanitizeParentControllerText(
			'Bearer abc.def-ghi https://example.test/?token=secret eyJhbGciOiJIUzI1NiJ9.payload.signature'
		)
		expect(sanitized).toContain('Bearer [REDACTED]')
		expect(sanitized).toContain('token=[REDACTED]')
		expect(sanitized).toContain('[REDACTED]')
		expect(sanitized).not.toContain('secret')
	})
})

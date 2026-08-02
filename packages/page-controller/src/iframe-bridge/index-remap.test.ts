import { describe, expect, it } from 'vitest'

import { allocateGlobalIndices, remapIndexedContent } from './index-remap'

describe('remapIndexedContent', () => {
	it('rewrites normal and newly-added index markers everywhere', () => {
		const mapping = new Map([
			[1, 20],
			[2, 21],
		])

		expect(remapIndexedContent('[1]<button>A</button>\n  *[2]<input>\n[1] again', mapping)).toBe(
			'[20]<button>A</button>\n  *[21]<input>\n[1] again'
		)
	})

	it('does not rewrite brackets in ordinary text, attributes, or inline content', () => {
		expect(
			remapIndexedContent(
				'[1] ordinary text\ntext [1]<button>\n<div data-value="[1]">\n[1]<button>',
				new Map([[1, 7]])
			)
		).toBe('[1] ordinary text\ntext [1]<button>\n<div data-value="[1]">\n[7]<button>')
	})
})

describe('allocateGlobalIndices', () => {
	it('deduplicates and ignores invalid local indices', () => {
		const result = allocateGlobalIndices([4, 2, 4, -1, Number.NaN], 10)

		expect([...result.mapping]).toEqual([
			[4, 10],
			[2, 11],
		])
		expect(result.nextIndex).toBe(12)
	})
})

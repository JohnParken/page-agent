/**
 * Tests for the reportBuffer module.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { appendSection, assembleMarkdown, clearBuffer, getBuffer } from './reportBuffer'

/**
 * Minimal stub that satisfies the WeakMap key requirement.
 * Exposes a mutable `taskId` to simulate task transitions on the same agent.
 */
function createFakeAgent(taskId = 'task-1'): any {
	return { taskId }
}

describe('reportBuffer', () => {
	let agent: any

	afterEach(() => {
		if (agent) clearBuffer(agent)
	})

	it('creates a buffer lazily on first access', () => {
		agent = createFakeAgent()
		const buffer = getBuffer(agent)
		expect(buffer.sections).toEqual([])
	})

	it('appends sections with timestamps', () => {
		agent = createFakeAgent()
		const before = Date.now()
		appendSection(agent, 'Section A', 'Content A')
		appendSection(agent, 'Section B', 'Content B')
		const after = Date.now()

		const buffer = getBuffer(agent)
		expect(buffer.sections).toHaveLength(2)
		expect(buffer.sections[0].title).toBe('Section A')
		expect(buffer.sections[0].content).toBe('Content A')
		expect(buffer.sections[0].appendedAt).toBeGreaterThanOrEqual(before)
		expect(buffer.sections[1].appendedAt).toBeLessThanOrEqual(after)
	})

	it('assembles Markdown with title', () => {
		agent = createFakeAgent()
		appendSection(agent, 'Overview', 'This is the overview.')
		appendSection(agent, 'Details', '| Field | Value |\n|---|---|\n| Name | Alice |')

		const md = assembleMarkdown(agent, 'My Report')
		expect(md).toContain('# My Report')
		expect(md).toContain('## Overview')
		expect(md).toContain('This is the overview.')
		expect(md).toContain('## Details')
		expect(md).toContain('| Name | Alice |')
	})

	it('assembles Markdown without title', () => {
		agent = createFakeAgent()
		appendSection(agent, 'Only Section', 'Content here')

		const md = assembleMarkdown(agent)
		// Should not contain a top-level H1 heading (only H2 section headings)
		expect(md).not.toMatch(/^# /m)
		expect(md).toContain('## Only Section')
		expect(md).toContain('Content here')
	})

	it('clears the buffer', () => {
		agent = createFakeAgent()
		appendSection(agent, 'X', 'Y')
		expect(getBuffer(agent).sections).toHaveLength(1)

		clearBuffer(agent)
		expect(getBuffer(agent).sections).toHaveLength(0)
	})

	it('isolates buffers between different agent instances', () => {
		agent = createFakeAgent('task-A')
		const agent2 = createFakeAgent('task-B')

		appendSection(agent, 'Agent1', 'Data1')
		appendSection(agent2, 'Agent2', 'Data2')

		expect(getBuffer(agent).sections).toHaveLength(1)
		expect(getBuffer(agent).sections[0].title).toBe('Agent1')

		expect(getBuffer(agent2).sections).toHaveLength(1)
		expect(getBuffer(agent2).sections[0].title).toBe('Agent2')

		clearBuffer(agent2)
	})

	it('discards previous-task data when taskId changes on the same agent instance', () => {
		// Bug 2 regression: task A collects data, task B must start with a clean buffer
		agent = createFakeAgent('task-A')
		appendSection(agent, 'Task A Section', 'Task A data')
		expect(getBuffer(agent).sections).toHaveLength(1)

		// Simulate agent starting a new task (same object, new taskId)
		agent.taskId = 'task-B'

		// Buffer must be empty — task A's data must not bleed into task B
		const freshBuffer = getBuffer(agent)
		expect(freshBuffer.sections).toHaveLength(0)
	})

	it('does NOT discard data when taskId is unchanged (same task retry)', () => {
		// Ensure that a retry within the same task does not lose accumulated data
		agent = createFakeAgent('task-retry')
		appendSection(agent, 'Retry Section', 'Retry data')

		// Still the same taskId → buffer must be intact
		expect(getBuffer(agent).sections).toHaveLength(1)
		expect(getBuffer(agent).sections[0].title).toBe('Retry Section')
	})
})

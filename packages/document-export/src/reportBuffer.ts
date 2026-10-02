/**
 * Report buffer management.
 *
 * The buffer is stored on the agent instance via a private WeakMap so it
 * persists across steps without polluting the public API or agent history.
 *
 * ## Task isolation
 * Buffer contents are keyed by both agent instance AND the agent's current
 * `taskId`. A new task (even on the same agent) always starts with an empty
 * buffer — there is no way for task A's accumulated sections to bleed into
 * task B. The `taskId` is read lazily on every access so the buffer
 * automatically reflects the task that is currently running.
 */
import type { ReportBuffer, ReportSection } from './types'
import type { PageAgentCore } from '@page-agent/core'

interface TaskBuffer {
	taskId: string
	sections: ReportSection[]
}

const buffers = new WeakMap<PageAgentCore, TaskBuffer>()

/**
 * Get (or lazily create) the buffer for the agent's **current** task.
 * If the stored buffer belongs to a previous task it is discarded and a fresh
 * one is created, ensuring cross-task isolation even when the same agent
 * instance is reused for multiple sequential tasks.
 */
export function getBuffer(agent: PageAgentCore): ReportBuffer {
	const currentTaskId = agent.taskId
	let stored = buffers.get(agent)

	if (!stored || stored.taskId !== currentTaskId) {
		stored = { taskId: currentTaskId, sections: [] }
		buffers.set(agent, stored)
	}

	return stored
}

/** Append a section to the agent's current-task report buffer. */
export function appendSection(agent: PageAgentCore, title: string, content: string): ReportSection {
	const buffer = getBuffer(agent)
	const section: ReportSection = { title, content, appendedAt: Date.now() }
	buffer.sections.push(section)
	return section
}

/** Assemble all buffered sections into a single Markdown document. */
export function assembleMarkdown(agent: PageAgentCore, documentTitle?: string): string {
	const buffer = getBuffer(agent)
	const parts: string[] = []

	if (documentTitle) {
		parts.push(`# ${documentTitle}`)
		parts.push('')
	}

	for (const section of buffer.sections) {
		parts.push(`## ${section.title}`)
		parts.push('')
		parts.push(section.content)
		parts.push('')
	}

	return parts.join('\n').trim()
}

/**
 * Clear the report buffer for the agent's current task.
 * Called by `generate_document` after a successful conversion so the same
 * task can start a fresh accumulation cycle if needed.
 */
export function clearBuffer(agent: PageAgentCore): void {
	const stored = buffers.get(agent)
	if (stored && stored.taskId === agent.taskId) {
		stored.sections = []
	}
}

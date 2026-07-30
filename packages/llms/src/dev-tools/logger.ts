import { createWriteStream, promises as fs, WriteStream } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
}

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB
const DEFAULT_MAX_KEEP_FILES = 30

export interface FileLoggerOptions {
	/** Module name shown in each log line, e.g. "TlProxy" */
	module: string
	/** Directory where log files live. Defaults to <package>/logs/<module>/ */
	dir?: string
	/** Log file name prefix. Defaults to module name lowercased. */
	filePrefix?: string
	/** Minimum level to persist. Defaults to "debug". */
	level?: LogLevel
	/** Rotate when current file exceeds this many bytes. Defaults to 10 MB. */
	maxFileBytes?: number
	/** Keep at most N rotated files (excluding the active one). Defaults to 30. */
	maxKeepFiles?: number
	/** Also forward to console (useful for dev). Defaults to true. */
	echoToConsole?: boolean
}

/**
 * Simple file-based logger with date-based files and size-based rotation.
 *
 * - File name: `${prefix}-YYYY-MM-DD.log` (active day rotates at midnight local time).
 * - When the active file exceeds `maxFileBytes`, the file is renamed to
 *   `${prefix}-YYYY-MM-DD-001.log` and a fresh active file is opened.
 * - Old rotated files beyond `maxKeepFiles` are pruned.
 *
 * Writes are queued through a single async chain so order is preserved and no
 * interleaving happens across concurrent calls.
 */
export class FileLogger {
	private readonly module: string
	private readonly dir: string
	private readonly filePrefix: string
	private readonly level: LogLevel
	private readonly maxFileBytes: number
	private readonly maxKeepFiles: number
	private readonly echoToConsole: boolean

	private currentDate: string = ''
	private currentSize: number = 0
	private stream: WriteStream | null = null
	private writeChain: Promise<void> = Promise.resolve()
	private closed = false

	constructor(options: FileLoggerOptions) {
		this.module = options.module
		this.dir = options.dir ?? defaultLogDir(options.module)
		this.filePrefix = options.filePrefix ?? options.module.toLowerCase()
		this.level = options.level ?? 'debug'
		this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
		this.maxKeepFiles = options.maxKeepFiles ?? DEFAULT_MAX_KEEP_FILES
		this.echoToConsole = options.echoToConsole ?? true
	}

	/** Path to the directory where log files are stored. */
	get logDir(): string {
		return this.dir
	}

	/** Path to the currently active log file. */
	get currentFilePath(): string {
		return join(this.dir, `${this.filePrefix}-${this.currentDate || todayString()}.log`)
	}

	debug(message: string, ...rest: unknown[]): void {
		this.log('debug', message, ...rest)
	}
	info(message: string, ...rest: unknown[]): void {
		this.log('info', message, ...rest)
	}
	warn(message: string, ...rest: unknown[]): void {
		this.log('warn', message, ...rest)
	}
	error(message: string, ...rest: unknown[]): void {
		this.log('error', message, ...rest)
	}

	log(level: LogLevel, message: string, ...rest: unknown[]): void {
		if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.level]) return
		const line = formatLine(level, this.module, message, rest)
		if (this.echoToConsole) writeToConsole(level, line)
		this.writeChain = this.writeChain
			.then(() => this.persist(line))
			.catch((err) => {
				// Avoid throwing inside unhandled chain: surface to stderr but never crash.
				process.stderr.write(`[${this.module}] logger write failed: ${String(err)}\n`)
			})
	}

	/** Flush pending writes and close the underlying stream. Safe to call multiple times. */
	async close(): Promise<void> {
		if (this.closed) return
		this.closed = true
		await this.writeChain
		await new Promise<void>((resolve) => {
			if (!this.stream) return resolve()
			this.stream.end(() => resolve())
		})
		this.stream = null
	}

	private async persist(line: string): Promise<void> {
		await this.ensureOpen()
		const bytes = Buffer.byteLength(line, 'utf8')
		if (this.currentSize + bytes > this.maxFileBytes) {
			await this.rotate()
			await this.ensureOpen()
		}
		if (!this.stream) return
		this.stream.write(line)
		this.currentSize += bytes
	}

	private async ensureOpen(): Promise<void> {
		const today = todayString()
		if (this.stream && this.currentDate === today) return

		if (this.stream) {
			await new Promise<void>((resolve) => this.stream!.end(() => resolve()))
			this.stream = null
		}

		await fs.mkdir(this.dir, { recursive: true })
		this.currentDate = today
		const filePath = this.currentFilePath

		try {
			const stat = await fs.stat(filePath)
			this.currentSize = stat.size
		} catch {
			this.currentSize = 0
		}

		this.stream = createWriteStream(filePath, { flags: 'a', encoding: 'utf8' })
	}

	private async rotate(): Promise<void> {
		// Close the active file first.
		if (this.stream) {
			await new Promise<void>((resolve) => this.stream!.end(() => resolve()))
			this.stream = null
		}

		const baseName = `${this.filePrefix}-${this.currentDate}`
		const activePath = join(this.dir, `${baseName}.log`)

		// Find next available index (reuse gaps if any).
		let nextIndex = 1
		while (true) {
			const candidate = join(this.dir, `${baseName}-${String(nextIndex).padStart(3, '0')}.log`)
			try {
				await fs.access(candidate)
				nextIndex += 1
			} catch {
				break
			}
		}

		const rotatedPath = join(this.dir, `${baseName}-${String(nextIndex).padStart(3, '0')}.log`)
		try {
			await fs.rename(activePath, rotatedPath)
		} catch (err) {
			// If rename fails (file missing?), still continue to open a fresh file.
			process.stderr.write(`[${this.module}] failed to rotate log file: ${String(err)}\n`)
		}

		this.currentSize = 0
		this.stream = null
		await this.pruneOldFiles(baseName)
	}

	private async pruneOldFiles(baseName: string): Promise<void> {
		// Collect rotated files for today, sorted by index ascending.
		const entries = await fs.readdir(this.dir).catch(() => [] as string[])
		const rotated = entries
			.filter((name) => name.startsWith(`${baseName}-`) && name.endsWith('.log'))
			.map((name) => {
				const match = /-(\d{3})\.log$/.exec(name)
				return { name, index: match ? Number(match[1]) : -1 }
			})
			.filter((e) => e.index > 0)
			.sort((a, b) => a.index - b.index)

		const toDelete = rotated.length - this.maxKeepFiles
		if (toDelete <= 0) return
		for (const entry of rotated.slice(0, toDelete)) {
			try {
				await fs.unlink(join(this.dir, entry.name))
			} catch {
				// ignore
			}
		}
	}
}

function defaultLogDir(module: string): string {
	// Resolve relative to this file: <repo>/packages/llms/logs/<module>/
	const here = dirname(fileURLToPath(import.meta.url))
	return join(here, '..', '..', 'logs', module.toLowerCase())
}

function todayString(): string {
	const d = new Date()
	const y = d.getFullYear()
	const m = String(d.getMonth() + 1).padStart(2, '0')
	const day = String(d.getDate()).padStart(2, '0')
	return `${y}-${m}-${day}`
}

function formatLine(level: LogLevel, module: string, message: string, rest: unknown[]): string {
	const ts = new Date().toISOString()
	const head = `${ts} [${level.toUpperCase()}] [${module}] ${message}`
	if (rest.length === 0) return head + '\n'
	const tail = rest.map((r) => (typeof r === 'string' ? r : safeStringify(r))).join(' ')
	return `${head} ${tail}\n`
}

function safeStringify(v: unknown): string {
	try {
		if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`
		return JSON.stringify(v)
	} catch {
		return String(v)
	}
}

function writeToConsole(level: LogLevel, line: string): void {
	// Strip trailing newline for console.* to avoid double newlines.
	const trimmed = line.endsWith('\n') ? line.slice(0, -1) : line
	switch (level) {
		case 'error':
			console.error(trimmed)
			break
		case 'warn':
			console.warn(trimmed)
			break
		default:
			console.log(trimmed)
	}
}

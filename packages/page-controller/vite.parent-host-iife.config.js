// @ts-check
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

const currentDirectory = dirname(fileURLToPath(import.meta.url))

/**
 * Vite 5 inlines CSS for IIFE/UMD library output even with cssCodeSplit. The
 * parent host must ship presentation CSS separately, so intercept this one
 * import and emit a normal CSS asset without adding a style-injection runtime.
 */
function emitParentHostCss() {
	const cssPath = resolve(currentDirectory, 'src/browser/parent-host.css')
	const virtualCssId = '\0page-agent-parent-host-css'
	const simulatorMaskPath = resolve(currentDirectory, 'src/mask/SimulatorMask.ts')
	const virtualMaskId = '\0page-agent-parent-host-simulator-mask'
	const cssSource = readFileSync(cssPath, 'utf8')

	/** @type {import('vite').Plugin} */
	const plugin = {
		name: 'page-agent-parent-host-external-css',
		enforce: 'pre',
		resolveId(source, importer) {
			if (!importer) return undefined
			const importedPath = resolve(dirname(importer), source)
			if (importedPath === cssPath) return virtualCssId
			// PageController lazily imports SimulatorMask. The parent host always
			// disables that document-wide interaction blocker, so replace the lazy
			// module with a no-op and keep mask CSS out of this bundle.
			if (importedPath === simulatorMaskPath || `${importedPath}.ts` === simulatorMaskPath) {
				return virtualMaskId
			}
			return undefined
		},
		load(id) {
			if (id === virtualCssId) return 'export default undefined'
			if (id === virtualMaskId) {
				return `export class SimulatorMask extends EventTarget {
					wrapper = { style: { pointerEvents: '' } }
					show() {}
					hide() {}
					dispose() {}
				}`
			}
			return undefined
		},
		generateBundle() {
			this.emitFile({
				type: 'asset',
				name: 'page-agent-parent-host.css',
				source: cssSource,
			})
		},
	}
	return plugin
}

/** Standalone browser-script bundle for the parent-page controller host. */
export default defineConfig({
	clearScreen: false,
	plugins: [emitParentHostCss()],
	// Keep the entry's CSS import as an external, stable asset; never use the
	// generic CSS-injection plugin for this parent-page bundle.
	publicDir: false,
	build: {
		lib: {
			entry: resolve(currentDirectory, 'src/browser/parent-host-iife.ts'),
			name: 'PageAgentParentHost',
			fileName: () => 'page-agent-parent-host.iife.min.js',
			formats: ['iife'],
		},
		outDir: resolve(currentDirectory, 'dist/iife'),
		emptyOutDir: false,
		target: 'es2020',
		minify: true,
		sourcemap: true,
		cssCodeSplit: true,
		cssMinify: true,
		rollupOptions: {
			output: {
				inlineDynamicImports: true,
				assetFileNames: (assetInfo) =>
					assetInfo.name?.endsWith('.css')
						? 'page-agent-parent-host.css'
						: 'assets/[name]-[hash][extname]',
			},
			onwarn(message, handler) {
				if (message.code === 'EVAL') return
				handler(message)
			},
		},
	},
	define: {
		'process.env.NODE_ENV': '"production"',
	},
})

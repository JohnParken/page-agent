/**
 * Inject library CSS with Vite's native Rollup output hook.
 *
 * Vite normally emits library CSS as separate assets. Page Agent's published
 * entry points have historically installed their styles automatically, so the
 * emitted CSS is appended to its JavaScript chunk and removed from the bundle.
 *
 * @param {string} id Stable marker used to avoid injecting the same stylesheet twice.
 * @returns {import('vite').Plugin}
 */
export function injectCssByJs(id) {
	return {
		name: `page-agent:inject-css-by-js:${id}`,
		apply: 'build',
		enforce: 'post',
		generateBundle(_options, bundle) {
			const cssAssets = new Map(
				Object.entries(bundle).filter(
					([, output]) => output.type === 'asset' && output.fileName.endsWith('.css')
				)
			)

			if (cssAssets.size === 0) return

			const cssSource = (asset) =>
				typeof asset.source === 'string' ? asset.source : new TextDecoder().decode(asset.source)

			const injection = (marker, css) =>
				`\n;(() => {\n\tif (typeof document === 'undefined') return\n\tconst id = ${JSON.stringify(
					marker
				)}\n\tif (document.querySelector('style[data-page-agent-css="' + id + '"]')) return\n\tconst style = document.createElement('style')\n\tstyle.setAttribute('data-page-agent-css', id)\n\tstyle.textContent = ${JSON.stringify(
					css
				)}\n\t;(document.head || document.documentElement).appendChild(style)\n})()\n`

			const assignedCss = new Set()

			for (const output of Object.values(bundle)) {
				if (output.type !== 'chunk') continue

				const importedCss = output.viteMetadata?.importedCss
				if (!importedCss || importedCss.size === 0) continue

				const fileNames = [...importedCss].filter((fileName) => cssAssets.has(fileName))
				if (fileNames.length === 0) continue

				const css = fileNames.map((fileName) => cssSource(cssAssets.get(fileName))).join('\n')
				output.code += injection(`${id}:${fileNames.sort().join(',')}`, css)
				fileNames.forEach((fileName) => assignedCss.add(fileName))
			}

			const unassignedCss = [...cssAssets.keys()].filter((fileName) => !assignedCss.has(fileName))
			if (unassignedCss.length > 0) {
				const css = unassignedCss.map((fileName) => cssSource(cssAssets.get(fileName))).join('\n')

				for (const output of Object.values(bundle)) {
					if (output.type === 'chunk' && output.isEntry) {
						output.code += injection(`${id}:${unassignedCss.sort().join(',')}`, css)
					}
				}
			}

			for (const fileName of cssAssets.keys()) delete bundle[fileName]
		},
	}
}

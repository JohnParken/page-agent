import type { FlatDomTree } from './type'

interface DomTreeArgs {
	doHighlightElements?: boolean
	focusHighlightIndex?: number
	viewportExpansion?: number
	debugMode?: boolean
	interactiveBlacklist?: Element[]
	interactiveWhitelist?: Element[]
	contentBlacklist?: Element[]
	highlightOpacity?: number
	highlightLabelOpacity?: number
	root?: Element
	isScoped?: boolean
	highlightCleanupRegistry?: { add(cleanup: () => void): void }
}

declare const domTree: (args?: DomTreeArgs) => FlatDomTree

export default domTree

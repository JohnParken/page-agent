/**
 * Rewrites the element indices emitted by PageController without changing the
 * surrounding dehydrated DOM. Both normal (`[1]`) and newly-added (`*[1]`)
 * markers are supported.
 */
export function remapIndexedContent(
	content: string,
	indexMapping: ReadonlyMap<number, number>
): string {
	return content.replace(
		/^(\s*)(\*?)\[(\d+)\](?=<)/gm,
		(match, indentation: string, prefix: string, rawIndex: string) => {
			const mappedIndex = indexMapping.get(Number(rawIndex))
			return mappedIndex === undefined ? match : `${indentation}${prefix}[${mappedIndex}]`
		}
	)
}

/**
 * Allocates a stable set of global indices for one remote snapshot.
 */
export function allocateGlobalIndices(
	localIndices: readonly number[],
	startAt: number
): { mapping: Map<number, number>; nextIndex: number } {
	const mapping = new Map<number, number>()
	let nextIndex = startAt

	for (const localIndex of localIndices) {
		if (!Number.isSafeInteger(localIndex) || localIndex < 0 || mapping.has(localIndex)) continue
		mapping.set(localIndex, nextIndex)
		nextIndex += 1
	}

	return { mapping, nextIndex }
}

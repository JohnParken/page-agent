/**
 * Return page metrics for the global document, or for a scoped element
 * boundary.  The legacy body/document path is intentionally preserved so
 * callers that do not configure a root keep browser-level scroll semantics.
 */
export function getPageInfo(root?: Element) {
	if (root && root !== document.body) {
		const rect = root.getBoundingClientRect()
		const viewport_width = root.clientWidth || Math.max(0, Math.round(rect.width))
		const viewport_height = root.clientHeight || Math.max(0, Math.round(rect.height))
		const page_width = Math.max(root.scrollWidth || 0, viewport_width)
		const page_height = Math.max(root.scrollHeight || 0, viewport_height)
		const scroll_x = root.scrollLeft || 0
		const scroll_y = root.scrollTop || 0
		const pixels_below = Math.max(0, page_height - (viewport_height + scroll_y))
		const pixels_right = Math.max(0, page_width - (viewport_width + scroll_x))

		return {
			viewport_width,
			viewport_height,
			page_width,
			page_height,
			scroll_x,
			scroll_y,
			pixels_above: scroll_y,
			pixels_below,
			pages_above: viewport_height > 0 ? scroll_y / viewport_height : 0,
			pages_below: viewport_height > 0 ? pixels_below / viewport_height : 0,
			total_pages: viewport_height > 0 ? page_height / viewport_height : 0,
			current_page_position: scroll_y / Math.max(1, page_height - viewport_height),
			pixels_left: scroll_x,
			pixels_right,
		}
	}

	const viewport_width = window.innerWidth
	const viewport_height = window.innerHeight

	const page_width = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth || 0)
	const page_height = Math.max(
		document.documentElement.scrollHeight,
		document.body.scrollHeight || 0
	)

	const scroll_x = window.scrollX || window.pageXOffset || document.documentElement.scrollLeft || 0
	const scroll_y = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0

	const pixels_below = Math.max(0, page_height - (window.innerHeight + scroll_y))
	const pixels_right = Math.max(0, page_width - (window.innerWidth + scroll_x))

	return {
		// Current viewport dimensions
		viewport_width,
		viewport_height,

		// Total page dimensions
		page_width,
		page_height,

		// Current scroll position
		scroll_x,
		scroll_y,

		pixels_above: scroll_y,
		pixels_below,

		pages_above: viewport_height > 0 ? scroll_y / viewport_height : 0,
		pages_below: viewport_height > 0 ? pixels_below / viewport_height : 0,
		total_pages: viewport_height > 0 ? page_height / viewport_height : 0,

		current_page_position: scroll_y / Math.max(1, page_height - viewport_height),

		pixels_left: scroll_x,
		pixels_right,
	}
}

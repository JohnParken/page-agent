import { ParentPageControllerHost } from '@page-agent/page-controller/parent-bridge/host'

/** Options accepted by the installed parent-bridge host runtime. */
export type ParentHostOptions = ConstructorParameters<typeof ParentPageControllerHost>[0]

/**
 * Minimal parent-side bootstrap. The application supplies its chosen managed
 * opaque-token or signed-policy verifier through `options`.
 */
export function startParentHost(options: ParentHostOptions): ParentPageControllerHost {
	const host = new ParentPageControllerHost(options)
	host.start()
	return host
}

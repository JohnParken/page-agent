import { ParentPageControllerHost } from '@page-agent/page-controller/parent-bridge/host'

/** Options accepted by the installed parent-bridge host runtime. */
export type ParentHostOptions = ConstructorParameters<typeof ParentPageControllerHost>[0]

/**
 * Minimal parent-side bootstrap. The application supplies its own signed
 * policy issuer/verifier in `options`; this example intentionally does not
 * invent an authentication backend.
 */
export function startParentHost(options: ParentHostOptions): ParentPageControllerHost {
	const host = new ParentPageControllerHost(options)
	host.start()
	return host
}

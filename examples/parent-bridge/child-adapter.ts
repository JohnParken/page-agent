import { ParentPageControllerAdapter } from '@page-agent/page-controller/parent-bridge/adapter'

/** Options accepted by the installed child-side adapter runtime. */
export type ParentAdapterOptions = ConstructorParameters<typeof ParentPageControllerAdapter>[0]

/** Connect an assistant iframe to its authorized parent host. */
export async function connectParentAdapter(
	options: ParentAdapterOptions
): Promise<ParentPageControllerAdapter> {
	const adapter = new ParentPageControllerAdapter(options)
	try {
		await adapter.connect()
		return adapter
	} catch (error) {
		adapter.dispose()
		throw error
	}
}

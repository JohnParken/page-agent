// Example-only Vue 3 composable. Install `vue` in the consuming assistant
// application; Page Agent does not depend on Vue.
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'

type ParentAdapterConstructor =
	typeof import('@page-agent/page-controller/parent-bridge/adapter').ParentPageControllerAdapter
type ParentAdapter = InstanceType<ParentAdapterConstructor>

export type ParentAdapterOptions = ConstructorParameters<ParentAdapterConstructor>[0]

export function useParentPageController(options: ParentAdapterOptions) {
	const adapter = shallowRef<ParentAdapter | null>(null)
	const connected = ref(false)
	const error = ref<unknown>(null)
	let disposed = false

	const connect = async (): Promise<boolean> => {
		if (disposed) return false
		error.value = null
		try {
			if (!adapter.value) {
				const { ParentPageControllerAdapter } = await import(
					'@page-agent/page-controller/parent-bridge/adapter'
				)
				if (disposed) return false
				adapter.value = new ParentPageControllerAdapter(options)
				adapter.value.addEventListener('invalidate', () => {
					connected.value = false
				})
				adapter.value.addEventListener('connected', () => {
					connected.value = true
				})
			}
			await adapter.value.connect()
			if (disposed) return false
			connected.value = true
			return true
		} catch (cause) {
			connected.value = false
			error.value = cause
			return false
		}
	}

	onMounted(() => {
		void connect()
	})
	const dispose = async (): Promise<void> => {
		if (disposed) return
		disposed = true
		const instance = adapter.value
		if (instance) {
			try {
				await Promise.allSettled([instance.cleanUpHighlights(), instance.hideMask()])
			} finally {
				instance.dispose()
			}
		}
		adapter.value = null
		connected.value = false
	}
	onBeforeUnmount(() => {
		void dispose()
	})

	return { adapter, connected, error, connect, dispose }
}

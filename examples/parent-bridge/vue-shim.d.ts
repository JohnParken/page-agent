/**
 * Type-only fallback for the example typecheck. Applications should install
 * Vue 3 and use its real declarations; Page Agent does not depend on Vue.
 */
declare module 'vue' {
	export interface Ref<T> {
		value: T
	}

	export function ref<T>(value: T): Ref<T>
	export function shallowRef<T>(value: T): Ref<T>
	export function onMounted(callback: () => void): void
	export function onBeforeUnmount(callback: () => void): void
}

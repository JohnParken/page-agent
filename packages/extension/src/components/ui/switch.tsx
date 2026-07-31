import * as React from 'react'

import { cn } from '@/lib/utils'

interface SwitchProps extends Omit<React.ComponentProps<'input'>, 'type'> {
	onCheckedChange?: (checked: boolean) => void
}

function Switch({
	className,
	checked,
	defaultChecked,
	disabled,
	onChange,
	onCheckedChange,
	...props
}: SwitchProps) {
	const [uncontrolledChecked, setUncontrolledChecked] = React.useState(Boolean(defaultChecked))
	const isChecked = checked ?? uncontrolledChecked

	const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		if (checked === undefined) setUncontrolledChecked(event.currentTarget.checked)
		onChange?.(event)
		onCheckedChange?.(event.currentTarget.checked)
	}

	return (
		<span
			data-slot="switch"
			data-state={isChecked ? 'checked' : 'unchecked'}
			data-disabled={disabled ? '' : undefined}
			className={cn(
				'relative inline-flex h-[1.15rem] w-8 shrink-0 cursor-pointer items-center rounded-full border border-transparent shadow-xs transition-all data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input has-[:focus-visible]:border-ring has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50 dark:data-[state=unchecked]:bg-input/80',
				className
			)}
		>
			<input
				type="checkbox"
				role="switch"
				checked={isChecked}
				disabled={disabled}
				onChange={handleChange}
				className="absolute inset-0 z-10 size-full cursor-pointer appearance-none opacity-0 outline-none disabled:cursor-not-allowed"
				{...props}
			/>
			<span
				data-slot="switch-thumb"
				aria-hidden="true"
				className={cn(
					'pointer-events-none block size-4 rounded-full ring-0 transition-transform',
					isChecked
						? 'translate-x-[calc(100%-2px)] bg-background dark:bg-primary-foreground'
						: 'translate-x-0 bg-background dark:bg-foreground'
				)}
			/>
		</span>
	)
}

export { Switch }

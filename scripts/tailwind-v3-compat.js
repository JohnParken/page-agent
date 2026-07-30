const cssVariableColor = (name) => `rgb(from var(--${name}) r g b / <alpha-value>)`

export const semanticColors = {
	background: cssVariableColor('background'),
	foreground: cssVariableColor('foreground'),
	card: {
		DEFAULT: cssVariableColor('card'),
		foreground: cssVariableColor('card-foreground'),
	},
	popover: {
		DEFAULT: cssVariableColor('popover'),
		foreground: cssVariableColor('popover-foreground'),
	},
	primary: {
		DEFAULT: cssVariableColor('primary'),
		foreground: cssVariableColor('primary-foreground'),
	},
	secondary: {
		DEFAULT: cssVariableColor('secondary'),
		foreground: cssVariableColor('secondary-foreground'),
	},
	muted: {
		DEFAULT: cssVariableColor('muted'),
		foreground: cssVariableColor('muted-foreground'),
	},
	accent: {
		DEFAULT: cssVariableColor('accent'),
		foreground: cssVariableColor('accent-foreground'),
	},
	destructive: {
		DEFAULT: cssVariableColor('destructive'),
		foreground: cssVariableColor('destructive-foreground'),
	},
	border: cssVariableColor('border'),
	input: cssVariableColor('input'),
	ring: cssVariableColor('ring'),
	chart: {
		1: cssVariableColor('chart-1'),
		2: cssVariableColor('chart-2'),
		3: cssVariableColor('chart-3'),
		4: cssVariableColor('chart-4'),
		5: cssVariableColor('chart-5'),
	},
	sidebar: {
		DEFAULT: cssVariableColor('sidebar'),
		foreground: cssVariableColor('sidebar-foreground'),
		primary: cssVariableColor('sidebar-primary'),
		'primary-foreground': cssVariableColor('sidebar-primary-foreground'),
		accent: cssVariableColor('sidebar-accent'),
		'accent-foreground': cssVariableColor('sidebar-accent-foreground'),
		border: cssVariableColor('sidebar-border'),
		ring: cssVariableColor('sidebar-ring'),
	},
}

export const compatibilityTheme = {
	colors: semanticColors,
	borderRadius: {
		sm: 'calc(var(--radius) - 4px)',
		md: 'calc(var(--radius) - 2px)',
		lg: 'var(--radius)',
		xl: 'calc(var(--radius) + 4px)',
		'2xl': 'calc(var(--radius) + 8px)',
		'3xl': 'calc(var(--radius) + 12px)',
		'4xl': 'calc(var(--radius) + 16px)',
	},
	backgroundImage: {
		'linear-to-r': 'linear-gradient(to right, var(--tw-gradient-stops))',
		'linear-to-l': 'linear-gradient(to left, var(--tw-gradient-stops))',
		'linear-to-b': 'linear-gradient(to bottom, var(--tw-gradient-stops))',
		'linear-to-br': 'linear-gradient(to bottom right, var(--tw-gradient-stops))',
	},
	boxShadow: {
		xs: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
	},
	backdropBlur: {
		xs: '4px',
	},
	animation: {
		'blink-cursor': 'blink-cursor 1.2s step-end infinite',
		aurora: 'aurora 8s ease-in-out infinite alternate',
		'shiny-text': 'shiny-text 8s infinite',
		gradient: 'gradient 8s linear infinite',
		'background-position-spin': 'background-position-spin 3000ms infinite alternate',
		marquee: 'marquee var(--duration) infinite linear',
		'marquee-vertical': 'marquee-vertical var(--duration) linear infinite',
	},
	keyframes: {
		enter: {
			from: {
				opacity: 'var(--tw-enter-opacity, 1)',
				transform:
					'translate3d(var(--tw-enter-translate-x, 0), var(--tw-enter-translate-y, 0), 0) scale3d(var(--tw-enter-scale, 1), var(--tw-enter-scale, 1), var(--tw-enter-scale, 1))',
			},
		},
		exit: {
			to: {
				opacity: 'var(--tw-exit-opacity, 1)',
				transform:
					'translate3d(var(--tw-exit-translate-x, 0), var(--tw-exit-translate-y, 0), 0) scale3d(var(--tw-exit-scale, 1), var(--tw-exit-scale, 1), var(--tw-exit-scale, 1))',
			},
		},
		'blink-cursor': {
			'0%, 49%': { opacity: '1' },
			'50%, 100%': { opacity: '0' },
		},
		aurora: {
			'0%': { backgroundPosition: '0% 50%', transform: 'rotate(-5deg) scale(0.9)' },
			'25%': { backgroundPosition: '50% 100%', transform: 'rotate(5deg) scale(1.1)' },
			'50%': { backgroundPosition: '100% 50%', transform: 'rotate(-3deg) scale(0.95)' },
			'75%': { backgroundPosition: '50% 0%', transform: 'rotate(3deg) scale(1.05)' },
			'100%': { backgroundPosition: '0% 50%', transform: 'rotate(-5deg) scale(0.9)' },
		},
		'shiny-text': {
			'0%, 90%, 100%': { backgroundPosition: 'calc(-100% - var(--shiny-width)) 0' },
			'30%, 60%': { backgroundPosition: 'calc(100% + var(--shiny-width)) 0' },
		},
		gradient: {
			to: { backgroundPosition: 'var(--bg-size, 300%) 0' },
		},
		'background-position-spin': {
			'0%': { backgroundPosition: 'top center' },
			'100%': { backgroundPosition: 'bottom center' },
		},
		marquee: {
			from: { transform: 'translateX(0)' },
			to: { transform: 'translateX(calc(-100% - var(--gap)))' },
		},
		'marquee-vertical': {
			from: { transform: 'translateY(0)' },
			to: { transform: 'translateY(calc(-100% - var(--gap)))' },
		},
	},
}

export const tailwindV3Compatibility = ({ addUtilities, addVariant, matchVariant }) => {
	addVariant('nth-last-2', '&:nth-last-child(2)')
	matchVariant('has-data', (value) => `&:has([data-${value}])`)

	addUtilities({
		'.animate-in': {
			animationName: 'enter',
			animationDuration: '150ms',
			animationTimingFunction: 'ease-out',
			'--tw-enter-opacity': 'initial',
			'--tw-enter-scale': 'initial',
			'--tw-enter-translate-x': 'initial',
			'--tw-enter-translate-y': 'initial',
		},
		'.animate-out': {
			animationName: 'exit',
			animationDuration: '150ms',
			animationTimingFunction: 'ease-in',
			animationFillMode: 'forwards',
			'--tw-exit-opacity': 'initial',
			'--tw-exit-scale': 'initial',
			'--tw-exit-translate-x': 'initial',
			'--tw-exit-translate-y': 'initial',
		},
		'.fade-in-0': { '--tw-enter-opacity': '0' },
		'.fade-out-0': { '--tw-exit-opacity': '0' },
		'.zoom-in-95': { '--tw-enter-scale': '.95' },
		'.zoom-out-95': { '--tw-exit-scale': '.95' },
		'.slide-in-from-top-2': { '--tw-enter-translate-y': '-0.5rem' },
		'.slide-in-from-bottom-2': { '--tw-enter-translate-y': '0.5rem' },
		'.slide-in-from-left-2': { '--tw-enter-translate-x': '-0.5rem' },
		'.slide-in-from-right-2': { '--tw-enter-translate-x': '0.5rem' },
		'.outline-hidden': { outline: '2px solid transparent', outlineOffset: '2px' },
		'.field-sizing-content': { fieldSizing: 'content' },
		'.wrap-anywhere': { overflowWrap: 'anywhere' },
		'.origin-\\(--radix-tooltip-content-transform-origin\\)': {
			transformOrigin: 'var(--radix-tooltip-content-transform-origin)',
		},
		'.origin-\\(--radix-hover-card-content-transform-origin\\)': {
			transformOrigin: 'var(--radix-hover-card-content-transform-origin)',
		},
	})
}

import { compatibilityTheme, tailwindV3Compatibility } from '../../scripts/tailwind-v3-compat.js'

export default {
	darkMode: 'class',
	content: ['./src/**/*.{js,ts,jsx,tsx}'],
	theme: {
		extend: compatibilityTheme,
	},
	plugins: [tailwindV3Compatibility],
}

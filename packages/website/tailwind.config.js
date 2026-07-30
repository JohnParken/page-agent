import { compatibilityTheme, tailwindV3Compatibility } from '../../scripts/tailwind-v3-compat.js'

export default {
	darkMode: 'class',
	content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
	important: '#root',
	theme: {
		extend: compatibilityTheme,
	},
	plugins: [tailwindV3Compatibility],
}

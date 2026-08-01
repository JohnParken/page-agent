import js from '@eslint/js'
import importPlugin from 'eslint-plugin-import'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const typescriptFiles = ['**/*.{ts,tsx}']

const scopeToTypescript = (configs) =>
	configs.map((config) => ({
		...config,
		files: typescriptFiles,
	}))

const importRules = {
	'import/order': [
		'error',
		{
			groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'object', 'type'],
			pathGroups: [
				{
					pattern: '@/**',
					group: 'internal',
					position: 'before',
				},
				{
					pattern: '**/*.css',
					group: 'index',
					position: 'after',
				},
			],
			pathGroupsExcludedImportTypes: ['builtin'],
			'newlines-between': 'always',
			alphabetize: {
				order: 'asc',
				caseInsensitive: true,
			},
			warnOnUnassignedImports: false,
		},
	],
	'sort-imports': [
		'error',
		{
			ignoreCase: true,
			ignoreDeclarationSort: true,
			ignoreMemberSort: false,
		},
	],
}

export default [
	{
		ignores: [
			'**/dist',
			'**/node_modules',
			'packages/*/src/components/ui',
			'**/.wxt',
			'**/.output',
		],
	},
	{
		files: ['**/*.{js,jsx,ts,tsx}'],
		plugins: {
			import: importPlugin,
		},
		rules: importRules,
	},
	{
		...js.configs.recommended,
		files: typescriptFiles,
	},
	...scopeToTypescript(tseslint.configs.recommended),
	...scopeToTypescript(tseslint.configs.recommendedTypeChecked),
	...scopeToTypescript(tseslint.configs.strictTypeChecked),
	...scopeToTypescript(tseslint.configs.stylisticTypeChecked),
	{
		files: typescriptFiles,
		languageOptions: {
			parserOptions: {
				projectService: true,
			},
			ecmaVersion: 2020,
			globals: globals.browser,
		},
		rules: {
			'no-constant-condition': 'off',
			'no-extra-semi': 'off',
			'@typescript-eslint/no-non-null-assertion': 'off',
			'@typescript-eslint/no-unsafe-assignment': 'off',
			'@typescript-eslint/no-unsafe-member-access': 'off',
			'@typescript-eslint/no-unsafe-call': 'off',
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-empty-function': 'off',
			'@typescript-eslint/no-floating-promises': 'off',
			'@typescript-eslint/no-confusing-void-expression': 'off',
			'@typescript-eslint/no-unused-vars': 'off',
			'@typescript-eslint/no-inferrable-types': 'off',
			'@typescript-eslint/restrict-template-expressions': 'off',
			'@typescript-eslint/no-dynamic-delete': 'off',
			'@typescript-eslint/no-unnecessary-condition': 'off',
			'@typescript-eslint/prefer-nullish-coalescing': 'off',
			'@typescript-eslint/no-unnecessary-type-assertion': 'off',
			'@typescript-eslint/no-misused-promises': 'off',
			'@typescript-eslint/no-unsafe-argument': 'off',
			'@typescript-eslint/no-unsafe-return': 'off',
			'@typescript-eslint/restrict-plus-operands': 'off',
			'@typescript-eslint/prefer-optional-chain': 'off',
			'@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',
			'@typescript-eslint/no-unnecessary-type-parameters': 'off',
			'@typescript-eslint/require-await': 'off',
			'@typescript-eslint/no-deprecated': 'off',
		},
	},
]

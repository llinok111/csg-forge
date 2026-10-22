import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import vitest from '@vitest/eslint-plugin';
import globals from 'globals';
import mdcs from 'eslint-config-mdcs';
import jsdoc from 'eslint-plugin-jsdoc';

export default [
	// files to ignore
	{
		name: 'files to ignore',
		ignores: [
			'**/node_modules/**',
			'**/build/**',
			'**/src/libs/**',
			'**/examples/bundle/**',
		],
	},

	// recommended
	js.configs.recommended,

	// base rules
	{
		name: 'base rules',
		files: [ '**/*.js', '**/*.mjs', '**/*.ts' ],
		languageOptions: {
			// 2022 so numeric separators (1_000) and top-level await are allowed.
			ecmaVersion: 2022,
			sourceType: 'module',
			globals: {
				...globals.browser,
				...globals.node,
			},
		},
		rules: {
			...mdcs.rules,
			'no-mixed-spaces-and-tabs': 'error',
		},
	},

	// ESM helper scripts use top-level await, which needs ES2022.
	{
		name: 'esm scripts',
		files: [ '**/*.mjs' ],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'module',
			globals: {
				...globals.browser,
				...globals.node,
			},
		},
	},

	// ts recommended
	...tseslint.configs.recommended.map( config => ( {
		...config,
		files: [ '**/*.ts' ],
	} ) ),

	// ts rule overrides
	{
		name: 'ts rule overrides',
		files: [ '**/*.ts' ],
		rules: {
			'no-unused-vars': 'off',
			'@typescript-eslint/no-unused-vars': 'off',
		},
	},

	// jsdoc
	{
		name: 'jsdoc rules',
		files: [ '**/*.js' ],
		plugins: {
			jsdoc,
		},
		settings: {
			jsdoc: {
				preferredTypes: {
					Any: 'any',
					Boolean: 'boolean',
					Number: 'number',
					object: 'Object',
					String: 'string',
				},
				tagNamePreference: {
					return: 'returns',
					augments: 'extends',
					classdesc: false,
				},
			},
		},
		rules: {
			'jsdoc/check-tag-names': [ 'error', { definedTags: [ 'warn', 'note', 'section' ] } ],
			'jsdoc/check-types': 'error',
			'jsdoc/no-undefined-types': 'error',
			'jsdoc/require-param-type': 'error',
			'jsdoc/require-returns-type': 'error',
			'jsdoc/require-returns': 'off',
			'jsdoc/require-param-description': 'off',
			'jsdoc/require-returns-description': 'off',
		},
	},

	// vitest
	{
		name: 'vitest rules',
		files: [ '**/*.test.js', '**/*.test.ts' ],
		plugins: {
			vitest,
		},
		languageOptions: {
			globals: {
				...vitest.environments.env.globals,
			},
		},
		rules: {
			...vitest.configs.recommended.rules,
			'vitest/valid-describe-callback': 0,
		},
	},
];

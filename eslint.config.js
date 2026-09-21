import globals from 'globals';
import nette from '@nette/eslint-plugin/typescript';
import { defineConfig } from 'eslint/config';

export default defineConfig([
	{
		ignores: ['dist', 'tests/neon-spec'],
	},

	{
		languageOptions: {
			globals: globals.node,
		},

		extends: [nette.configs.customize({ browser: false })],
	},

	{
		files: ['**/*.ts'],

		languageOptions: {
			globals: {
				...globals.vitest,
				...globals.node,
			},
		},

		extends: [nette.configs.customize({ browser: false, typescript: true })],
	},
]);

import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config({ ignores: ['dist/**', 'node_modules/**', '.wrangler/**', '.venv/**', 'public/**'] }, js.configs.recommended, ...ts.configs.recommended, { files: ['**/*.ts', '**/*.tsx'], rules: { '@typescript-eslint/no-explicit-any': 'error' } }, { files: ['public/sw.js', 'eslint.config.js'], languageOptions: { globals: { self: 'readonly', caches: 'readonly', fetch: 'readonly', URL: 'readonly', console: 'readonly' } } });

import eslint from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const hooks = reactHooks.configs.flat.recommended;

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/playwright-report/**', '**/test-results/**', 'work/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  // Node: the server, shared contracts, end-to-end tests and tool configs.
  { files: ['server/**/*.ts', 'packages/**/*.ts', 'e2e/**/*.ts', '*.config.{js,ts}', 'web/*.config.ts'], languageOptions: { globals: globals.node } },
  // The browser app, with the Rules of Hooks.
  { files: ['web/src/**/*.{ts,tsx}'], plugins: hooks.plugins, rules: hooks.rules, languageOptions: { globals: globals.browser } },
  { files: ['web/public/sw.js'], languageOptions: { globals: globals.serviceworker } },
);

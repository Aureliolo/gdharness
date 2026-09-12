import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// Biome owns formatting and the fast syntactic rules. ESLint is here only for the checks
// that need the real TypeScript checker, which is the reason for two tools rather than one.
export default tseslint.config(
  {
    ignores: ['build/**', 'dist/**', 'node_modules/**', 'src/visualizer/**'],
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.mjs', 'scripts/**/*.mjs', 'test/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);

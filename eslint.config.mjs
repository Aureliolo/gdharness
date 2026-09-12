import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// Biome owns formatting and the fast syntactic rules. ESLint is here only for the checks
// that need the real TypeScript checker, which is the reason for two tools rather than one.
export default tseslint.config(
  {
    ignores: ['build/**', 'dist/**', 'node_modules/**'],
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
    rules: {
      // A number has exactly one rendering in a template, so `${port}` needs no String()
      // wrapper. The other five stay false as strictTypeChecked sets them, because the
      // nullish case is where the real bug is: an unset environment variable interpolating
      // as the literal text "undefined". Options omitted here fall back to the rule's own
      // permissive defaults rather than to the preset, so every one is written out.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        {
          allowAny: false,
          allowBoolean: false,
          allowNever: false,
          allowNullish: false,
          allowNumber: true,
          allowRegExp: false,
        },
      ],
    },
  },
  {
    files: ['**/*.mjs', 'scripts/**/*.mjs', 'test/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      // Listed by hand rather than pulled from the `globals` package: no new dependency, and
      // a genuinely new global has to be added deliberately instead of arriving with a spread.
      // no-undef stays on because the .mjs half of the repo has no type checker behind it.
      globals: {
        Bun: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
);

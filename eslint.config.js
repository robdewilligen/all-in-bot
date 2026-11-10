// @ts-check
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

// Enforces the layer boundaries from CLAUDE.md.
const noDiscord = {
  regex: '^(discord\\.js|@discordjs/)',
  message: 'discord.js is only used in bot/, commands/, events/, ui/ and the entry files.',
};
const noDatabase = {
  regex: '^(pg|drizzle-orm)(/|$)|(^|/)db(/|$)',
  message: 'Game engines never touch the database; they return plain data.',
};
const noConfig = {
  regex: '(^|/)config(/|$)',
  message: 'Game engines receive their settings as arguments instead of importing config.',
};

export default defineConfig(
  globalIgnores(['dist/', 'coverage/', 'drizzle/']),
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
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Every random outcome comes from crypto.randomInt.',
        },
      ],
    },
  },
  {
    files: ['src/games/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [noDiscord, noDatabase, noConfig] }],
    },
  },
  {
    files: ['src/core/**', 'src/db/**', 'src/config/**', 'src/i18n/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [noDiscord] }],
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);

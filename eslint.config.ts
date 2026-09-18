import js from '@eslint/js'
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'
import { globalIgnores } from 'eslint/config'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'
import stylistic from '@stylistic/eslint-plugin'

export default defineConfigWithVueTs(
  {
    name: 'app/files-to-lint',
    files: ['**/*.{vue,js,jsx,ts,tsx,cjs,mjs}'],
  },

  globalIgnores(['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/.playwright-cli/**', '**/*.yml', '**/*.yaml', '**/cities.generated.ts']),

  js.configs.recommended,
  pluginVue.configs['flat/recommended'],
  vueTsConfigs.recommended,
  stylistic.configs.recommended,

  {
    plugins: {
      '@stylistic': stylistic,
    },
    languageOptions: {
      ecmaVersion: 'latest',
      globals: {
        ...globals.browser,
        ...globals.node,
        NodeListOf: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-redeclare': 2,
      '@typescript-eslint/no-explicit-any': 0,
      '@typescript-eslint/no-unused-expressions': [2, {
        allowShortCircuit: true,
      }],
      '@typescript-eslint/no-unused-vars': [2, {
        argsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],

      'vue/max-attributes-per-line': 0,
      'vue/attributes-order': 0,
      'vue/html-self-closing': ['error', {
        html: {
          void: 'never',
          normal: 'never',
          component: 'always',
        },
        svg: 'always',
        math: 'always',
      }],
      'vue/require-default-prop': 0,
      'vue/no-parsing-error': ['error', {
        'abrupt-closing-of-empty-comment': true,
        'absence-of-digits-in-numeric-character-reference': true,
        'cdata-in-html-content': true,
        'character-reference-outside-unicode-range': true,
        'control-character-in-input-stream': true,
        'control-character-reference': true,
        'eof-before-tag-name': true,
        'eof-in-cdata': true,
        'eof-in-comment': true,
        'eof-in-tag': true,
        'incorrectly-closed-comment': true,
        'incorrectly-opened-comment': true,
        'invalid-first-character-of-tag-name': true,
        'missing-attribute-value': true,
        'missing-end-tag-name': true,
        'missing-semicolon-after-character-reference': true,
        'missing-whitespace-between-attributes': true,
        'nested-comment': true,
        'noncharacter-character-reference': true,
        'noncharacter-in-input-stream': true,
        'null-character-reference': true,
        'surrogate-character-reference': true,
        'surrogate-in-input-stream': true,
        'unexpected-character-in-attribute-name': true,
        'unexpected-character-in-unquoted-attribute-value': true,
        'unexpected-equals-sign-before-attribute-name': true,
        'unexpected-null-character': true,
        'unexpected-question-mark-instead-of-tag-name': true,
        'unexpected-solidus-in-tag': true,
        'unknown-named-character-reference': true,
        'end-tag-with-attributes': true,
        'duplicate-attribute': true,
        'end-tag-with-trailing-solidus': true,
        'non-void-html-element-start-tag-with-trailing-solidus': false,
        'x-invalid-end-tag': true,
        'x-invalid-namespace': true,
      }],
      'vue/multiline-html-element-content-newline': 0,
      'vue/singleline-html-element-content-newline': 0,
      'vue/no-use-v-if-with-v-for': [1, {
        allowUsingIterationVar: true,
      }],
      'vue/require-prop-type-constructor': 0,
      'vue/html-closing-bracket-newline': 0,
      'vue/arrow-spacing': [2, {
        before: true,
        after: true,
      }],
      'vue/block-spacing': [2, 'always'],
      'vue/brace-style': [1, 'stroustrup', { allowSingleLine: true }],
      'vue/key-spacing': [1, { beforeColon: false, afterColon: true, mode: 'minimum' }],
      'vue/object-curly-spacing': [1, 'always', { objectsInObjects: true }],
      'vue/space-infix-ops': 1,
      'vue/space-unary-ops': [2, {
        words: true,
        nonwords: false,
      }],
      'vue/custom-event-name-casing': 0,
      'vue/multi-word-component-names': 0,
      'vue/component-name-in-template-casing': [1, 'PascalCase', {
        registeredComponentsOnly: false,
        ignores: [
          '/^[A-Z][a-zA-Z]*(\\.[A-Z][a-zA-Z]*)*$/',
        ],
      }],
      'vue/comma-spacing': [2, {
        before: false,
        after: true,
      }],
      'vue/block-tag-newline': 1,
      'vue/block-lang': ['error', {
        script: {
          lang: 'ts',
        },
      }],
      'vue/padding-line-between-blocks': 1,
    },
  },
)

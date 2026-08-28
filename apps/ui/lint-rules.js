export const uiNodeImportGuard = {
  files: ['apps/ui/**/*.{ts,tsx}'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: [
              'child_process',
              'child_process/*',
              'fs',
              'fs/*',
              'node:child_process',
              'node:child_process/*',
              'node:fs',
              'node:fs/*',
            ],
            message:
              'The Git Surface cannot import Node filesystem or child-process modules.',
          },
        ],
      },
    ],
  },
};

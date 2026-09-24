/** @type {import('ts-jest').JestConfigWithTsJest} */

const esModules = ['nanoid'].join('|');

module.exports = {
  setupFilesAfterEnv: ['<rootDir>/jest/setup.js'],
  clearMocks: true,
  testEnvironment: 'jsdom',
  testMatch: ['**/packages/**/*.test.ts?(x)'],
  transform: {
    '^.+\\.(ts|tsx|js|jsx)$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.jest.json',
      },
    ],
  },
  transformIgnorePatterns: [`/node_modules/(?!${esModules})`],
  moduleNameMapper: {
    '^@craftjs/core$': '<rootDir>/packages/core/src/index.tsx',
    '^@craftjs/utils$': '<rootDir>/packages/utils/src/index.ts',
    '^@craftjs/utils/(.*)$': '<rootDir>/packages/utils/src/$1',
    '^nanoid$': require.resolve('nanoid'),
  },
};

/** @type {import('ts-jest').JestConfigWithTsJest} */

module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  // msw (via mock-jwks v3) lists "module-sync" first in its exports map.
  // Jest would otherwise resolve it to the ESM build and fail with
  // "Cannot use import statement outside a module"; pinning the conditions
  // keeps it on the CJS build, which requires cleanly under plain Node.
  testEnvironmentOptions: {
    customExportConditions: ["node", "require", "default"],
  },
  verbose: true,
  collectCoverage: true,
  coverageProvider: "v8",
  collectCoverageFrom: ["src/**/*.ts", "!tests/**", "!**/node_modules/**"],
  // One in-memory replica set is started for the whole run and torn down
  // after it. See tests/globalSetup.ts for why it must be a replica set.
  globalSetup: "<rootDir>/tests/globalSetup.ts",
  globalTeardown: "<rootDir>/tests/globalTeardown.ts",
  // Booting the replica set and seeding transactional writes is slower than
  // Jest's 5s default allows.
  testTimeout: 30000,
  transform: {
    "^.+\\.tsx?$": ["ts-jest", {}],
    // Some deps now ship ESM only (jose v6, pulled in by jwks-rsa v4; and
    // uuid v14). Jest's CommonJS runtime chokes on their `export` statements,
    // so they must go through the transform rather than being ignored along
    // with the rest of node_modules.
    "^.+\\.m?js$": [
      "ts-jest",
      { tsconfig: { allowJs: true, module: "commonjs" } },
    ],
  },
  // Packages that publish ESM only, so Jest's CJS runtime must transform them
  // instead of skipping node_modules wholesale:
  //   jose         — via jwks-rsa v4
  //   uuid         — v14 dropped CJS
  //   msw tree     — via mock-jwks v3 (rettime, until-async, ...)
  transformIgnorePatterns: [
    "/node_modules/(?!(jose|uuid|rettime|until-async|headers-polyfill|set-cookie-parser|tough-cookie|@open-draft/deferred-promise|@epic-web/invariant)/)",
  ],
};

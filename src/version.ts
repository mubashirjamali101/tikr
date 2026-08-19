/**
 * The published version.
 *
 * Kept here rather than imported from `package.json`, which would need a JSON module import and
 * would drag the manifest into the build. `test/version.test.ts` asserts the two agree, so they
 * cannot drift silently.
 */
export const VERSION = '1.2.1'

// Run after build; behaviour is exercised separately by npm test.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runShippedSurfaceRules } from './lib/shipped-surface-rules.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const releaseArg = process.argv.find((argument) => argument.startsWith('--release-dir='));
const results = runShippedSurfaceRules(root, {
  releaseDir: releaseArg?.slice('--release-dir='.length),
});
for (const result of results) {
  console.log(`${result.ok ? 'ok   ' : 'FAIL '} ${result.id}: ${result.reason}`);
  // Keep the established artifact diagnostic spelling for CLI callers.
  for (const problem of result.problems) console.error(`      ${problem.replace(/^Manifest Id must be /, 'manifest <Id> must be ')}`);
}
const failures = results.filter((result) => !result.ok).length;
console.log(failures ? `\nVERIFY FAILED (${failures} rule(s))` : '\nVERIFY PASSED');
process.exitCode = failures ? 1 : 0;

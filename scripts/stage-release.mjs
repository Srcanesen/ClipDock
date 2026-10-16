// Compatibility entry point for checking an already-built artifact.
// The active workflow has one artifact: dist/.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyArtifact } from './lib/release-artifact.mjs';
import { validateCompletedBuild } from './lib/completed-build.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
if (!existsSync(dist)) {
  console.error(`dist/ not found at ${dist} — run "npm run build" first.`);
  process.exit(1);
}
const result = verifyArtifact(dist);
try { validateCompletedBuild(root, dist); } catch (error) {
  result.problems.push(error.message);
  result.ok = false;
}
for (const problem of result.problems) console.error(`FAIL  ${problem}`);
console.log(result.ok ? `\nARTIFACT CHECK PASSED: ${result.files.length} files` : '\nARTIFACT CHECK FAILED');
process.exit(result.ok ? 0 : 1);

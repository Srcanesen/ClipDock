// Install the built plugin folder (dist/) into DaVinci Resolve's
// "Workflow Integration Plugins" directory and copy WorkflowIntegration.node
// from the Resolve developer package (the binary is NEVER committed to the repo).
//
// macOS: the plugins directory is /Library/... (system-wide) — may require sudo.
import { copyFileSync, existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCompletedBuild } from './lib/completed-build.mjs';
import { hashFile } from './lib/release-artifact.mjs';
import { assertNoDuplicatePluginIds, reconcileDirectoryContents, recoverInterruptedTransaction } from './lib/install-files.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
const PLUGIN_ID = 'com.clipdock.app';
const DRY_RUN = process.argv.includes('--dry-run');

const isWin = process.platform === 'win32';
const destRoot = isWin
  ? path.join(
      process.env.PROGRAMDATA || 'C:\\ProgramData',
      'Blackmagic Design',
      'DaVinci Resolve',
      'Support',
      'Workflow Integration Plugins',
    )
  : '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins';
const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const dest = option('destination') ?? path.join(destRoot, PLUGIN_ID);

// WorkflowIntegration.node ships with the Resolve developer package (Help >
// Documentation > Developer > Workflow Integrations > Examples/SamplePlugin).
// macOS path below is verified on Resolve Studio 21.0.3; Windows paths are
// candidates to confirm on the target machine.
const nodeCandidates = [
  '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Workflow Integrations/Examples/SamplePlugin/WorkflowIntegration.node',
  'C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\Developer\\Workflow Integrations\\Examples\\SamplePlugin\\WorkflowIntegration.node',
  'C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\Support\\Developer\\Workflow Integrations\\Examples\\SamplePlugin\\WorkflowIntegration.node',
];
nodeCandidates.push(
  path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'Developer', 'Workflow Integrations', 'Examples', 'SamplePlugin', 'WorkflowIntegration.node'),
);

try {
  assertNoDuplicatePluginIds(path.dirname(dest), PLUGIN_ID);
} catch (error) {
  if (error?.code === 'DUPLICATE_PLUGIN_ID') {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

if (!DRY_RUN) recoverInterruptedTransaction(dest);

if (!existsSync(dist)) {
  console.error(`dist/ not found at ${dist} — run "npm run build" first.`);
  process.exit(1);
}

const act = (message) => console.log(DRY_RUN ? `[dry-run] ${message}` : message);
validateCompletedBuild(root, dist);
const found = option('native-module') ?? nodeCandidates.find((candidate) => existsSync(candidate));
if (!found || !lstatSync(found).isFile() || lstatSync(found).isSymbolicLink() || lstatSync(found).size === 0) throw new Error('Required WorkflowIntegration.node is missing or invalid');
const nativeHash = hashFile(found);

act(`Install dir: ${dest}`);
act(`  remove stale contents from ${dest}`);
act(`  copy ${dist} -> ${dest}`);
act(`WorkflowIntegration.node: ${found}`);
if (!DRY_RUN) reconcileDirectoryContents(dist, dest, undefined, (stage) => {
  copyFileSync(found, path.join(stage, 'WorkflowIntegration.node'));
  if (hashFile(path.join(stage, 'WorkflowIntegration.node')) !== nativeHash) throw new Error('Native module changed during installation');
  // Validate the copied bytes, including the build record, before promotion.
  // The structural artifact validator reserves the host sidecar for this boundary.
  validateCompletedBuild(root, stage, true);
});

console.log('\nNext steps:');
console.log('  1. Restart DaVinci Resolve Studio (plugins are scanned only at startup).');
console.log('  2. Workspace > Workflow Integrations > ClipDock');
console.log('  3. The panel should show bridge status, the active project and the active timeline.');
if (!isWin && process.getuid && process.getuid() !== 0) {
  console.log(`\nNote: macOS plugin dir requires admin. If the copy failed above, run:\n  sudo node scripts/install-plugin.mjs`);
}

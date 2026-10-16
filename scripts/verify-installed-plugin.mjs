import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoDuplicatePluginIds } from './lib/install-files.mjs';
import { validateCompletedBuild } from './lib/completed-build.mjs';
import { hashFile, inventory } from './lib/release-artifact.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
const PLUGIN_ID = 'com.clipdock.app';

const isWin = process.platform === 'win32';
const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const installed = option('destination') ?? (isWin
  ? path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'Workflow Integration Plugins', PLUGIN_ID)
  : `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/${PLUGIN_ID}`);
const nativeCandidates = isWin
  ? [
      'C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\Developer\\Workflow Integrations\\Examples\\SamplePlugin\\WorkflowIntegration.node',
      'C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\Support\\Developer\\Workflow Integrations\\Examples\\SamplePlugin\\WorkflowIntegration.node',
      path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'Developer', 'Workflow Integrations', 'Examples', 'SamplePlugin', 'WorkflowIntegration.node'),
    ]
  : ['/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Workflow Integrations/Examples/SamplePlugin/WorkflowIntegration.node'];

const fail = (message) => { console.error(`VERIFY INSTALLED FAILED: ${message}`); process.exit(1); };

try {
  const workflowRoot = path.dirname(installed);
  assertNoDuplicatePluginIds(workflowRoot, PLUGIN_ID);
} catch (error) {
  if (error?.code === 'DUPLICATE_PLUGIN_ID') fail(error.message);
  throw error;
}

if (!existsSync(dist) || !existsSync(installed)) fail('dist or installed plugin directory is missing');

try { validateCompletedBuild(root, dist); } catch (error) { fail(error.message); }

// Reuse shared inventory/hash helpers instead of maintaining a second recursive walker.
const builtInv = inventory(dist);
if (builtInv.problems.length) fail(`dist artifact problems: ${builtInv.problems.join('; ')}`);
const installedInv = inventory(installed);
// inventory reports symlink as problem; retain explicit native-sidecar symlink rejection below
const installedProblemsWithoutNative = installedInv.problems.filter((p) => p !== 'symbolic link in artifact: WorkflowIntegration.node');
if (installedProblemsWithoutNative.length) {
  // Any symlink in shipped files must be rejected
  const symlinkProblem = installedInv.problems.find((p) => p.includes('symbolic link'));
  if (symlinkProblem) fail(`installed artifact contains symbolic link: ${symlinkProblem}`);
  fail(`installed artifact problems: ${installedInv.problems.join('; ')}`);
}

const built = builtInv.files;
const installedFiles = installedInv.files.filter((file) => file !== 'WorkflowIntegration.node');
if (JSON.stringify(built) !== JSON.stringify(installedFiles)) fail('installed file list differs from dist');
for (const file of built) {
  const installedFile = path.join(installed, file);
  let st;
  try { st = lstatSync(installedFile); } catch { fail(`installed artifact differs: ${file}`); }
  if (st.isSymbolicLink()) fail(`installed artifact contains symbolic link: ${file}`);
  if (!st.isFile() || hashFile(path.join(dist, file)) !== hashFile(installedFile)) {
    fail(`installed artifact differs: ${file}`);
  }
}

const nativeSource = option('native-module') ?? nativeCandidates.find(existsSync);
let nativeSourceStat;
try { nativeSourceStat = lstatSync(nativeSource); } catch {}
if (!nativeSourceStat || !nativeSourceStat.isFile() || nativeSourceStat.isSymbolicLink() || nativeSourceStat.size === 0) {
  fail('Required WorkflowIntegration.node is missing or invalid');
}
const installedNative = path.join(installed, 'WorkflowIntegration.node');
let nativeOk = false;
if (nativeSource && existsSync(installedNative)) {
  try {
    const lst = lstatSync(installedNative);
    if (!lst.isSymbolicLink() && lst.isFile() && hashFile(nativeSource) === hashFile(installedNative)) nativeOk = true;
    else if (lst.isSymbolicLink()) fail('WorkflowIntegration.node is a symbolic link');
  } catch {}
}
if (!nativeOk) fail('WorkflowIntegration.node does not match this Resolve installation');

console.log(`VERIFY INSTALLED PASSED: ${built.length} files match dist; native module matches Resolve.`);
console.log(`Installed artifact: ${installed}`);

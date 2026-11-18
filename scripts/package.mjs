// Package the completed build (dist/) as a release zip: the plugin folder plus
// install notes. WorkflowIntegration.node belongs to Resolve and is never
// packaged; the notes tell the user to copy it from their own Resolve install.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCompletedBuild } from './lib/completed-build.mjs';
import { PLUGIN_ID } from './lib/contracts.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.resolve(process.argv.find((arg) => arg.startsWith('--out='))?.slice(6) || path.join(root, 'release'));

validateCompletedBuild(root, path.join(root, 'dist'));
const name = `ClipDock-${JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version}`;
const zip = path.join(outDir, `${name}.zip`);
const stage = mkdtempSync(path.join(tmpdir(), 'clipdock-package-'));
try {
  cpSync(path.join(root, 'dist'), path.join(stage, name, PLUGIN_ID), { recursive: true });
  cpSync(path.join(root, 'scripts', 'package-install-notes.txt'), path.join(stage, name, 'INSTALL.txt'));
  mkdirSync(outDir, { recursive: true });
  // zip updates an existing archive in place; start from nothing so removed files do not survive.
  rmSync(zip, { force: true });
  if (process.platform === 'win32') {
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-a', '-c', '-f', zip, name], { cwd: stage, stdio: 'inherit', windowsHide: true });
  } else {
    execFileSync('zip', ['-X', '-r', '-q', zip, name], { cwd: stage, stdio: 'inherit' });
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}
console.log(`Packaged: ${zip}`);

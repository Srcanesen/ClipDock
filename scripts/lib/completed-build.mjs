import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DIST_REQUIRED_FILES, MANIFEST_FILE_PATH, PLUGIN_ID } from './contracts.mjs';
import { hashFile, inventory, verifyArtifact } from './release-artifact.mjs';
import { assertBrowserScript } from './browser-renderer.mjs';

const RECORD = '.clipdock-build.json';
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function sourceIdentity(root) {
  const inputs = ['src', 'static', 'scripts/lib'].flatMap((dir) => {
    const inv = inventory(path.join(root, dir));
    if (inv.problems.length) throw new Error(inv.problems.join('; '));
    return inv.files.map((file) => `${dir}/${file}`);
  });
  inputs.push('scripts/build.mjs', 'tsconfig.json', 'package.json', 'package-lock.json');
  return digest(inputs.sort().map((file) => [file, hashFile(path.join(root, file))]));
}

export function validatePluginArtifact(dist, withNative = false) {
  const result = verifyArtifact(dist);
  if (withNative) result.problems = result.problems.filter((problem) => problem !== 'contains native/binary artifact: WorkflowIntegration.node' && problem !== 'file carries executable permission bits: WorkflowIntegration.node');
  result.ok = result.problems.length === 0;
  if (!result.ok) throw new Error(result.problems.join('; '));
  for (const file of new Set([...DIST_REQUIRED_FILES, 'main.js', 'manifest.xml', 'index.html', 'contracts.js'])) {
    if (!result.files.includes(file) || readFileSync(path.join(dist, file)).length === 0) throw new Error(`Missing or empty required artifact: ${file}`);
  }
  const manifest = readFileSync(path.join(dist, 'manifest.xml'), 'utf8');
  if (manifest.match(/<Id>([^<]+)<\/Id>/)?.[1] !== PLUGIN_ID) throw new Error(`Manifest Id must be ${PLUGIN_ID}`);
  for (const tag of ['Name', 'Version', 'Description']) {
    if (!new RegExp(`<${tag}>[^<]+</${tag}>`).test(manifest)) throw new Error(`Manifest missing ${tag}`);
  }
  if (manifest.match(/<FilePath>([^<]+)<\/FilePath>/)?.[1] !== MANIFEST_FILE_PATH) throw new Error('Manifest FilePath differs from runtime');
  const pkg = JSON.parse(readFileSync(path.join(dist, 'package.json'), 'utf8'));
  if (pkg.main !== MANIFEST_FILE_PATH) throw new Error('Artifact package main differs from runtime');
  const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
  const references = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1].replace(/^\.\//, ''));
  if (!references.includes('renderer.js')) throw new Error('Missing browser renderer reference');
  const stylesheets = [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<link\b[^>]*>/gi)].flatMap(([tag]) => {
    const attributes = Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/g)].map((match) => [match[1].toLowerCase(), match[3]]));
    return attributes.rel?.toLowerCase().split(/\s+/).includes('stylesheet') && attributes.href ? [attributes.href.replace(/^\.\//, '')] : [];
  });
  if (stylesheets.length === 0) throw new Error('Missing panel stylesheet link');
  for (const stylesheet of stylesheets) {
    if (!result.files.includes(stylesheet) || readFileSync(path.join(dist, stylesheet)).length === 0) throw new Error(`Missing or empty panel stylesheet: ${stylesheet}`);
  }
  for (const ref of references) if (!result.files.includes(ref)) throw new Error(`Missing HTML reference: ${ref}`);
  assertBrowserScript(readFileSync(path.join(dist, 'renderer.js'), 'utf8'));
  const contracts = readFileSync(path.join(dist, 'contracts.js'), 'utf8');
  if (!contracts.includes(`'${PLUGIN_ID}'`) || !readFileSync(path.join(dist, 'main.js'), 'utf8').includes('PLUGIN_ID')) throw new Error('Runtime plugin ID contract missing');
  return result.files;
}

function artifactIdentity(dist, withNative = false) {
  return Object.fromEntries(inventory(dist).files.filter((file) => file !== RECORD && !(withNative && file === 'WorkflowIntegration.node')).map((file) => [file, hashFile(path.join(dist, file))]));
}

export function recordBuild(root, dist, identity = sourceIdentity(root)) {
  validatePluginArtifact(dist);
  if (sourceIdentity(root) !== identity) throw new Error('Sources changed during build; rebuild before installing');
  writeFileSync(path.join(dist, RECORD), JSON.stringify({ version: 1, source: identity, files: artifactIdentity(dist) }) + '\n');
}

export function validateCompletedBuild(root, dist, withNative = false) {
  validatePluginArtifact(dist, withNative);
  const record = JSON.parse(readFileSync(path.join(dist, RECORD), 'utf8'));
  if (record.version !== 1 || record.source !== sourceIdentity(root)) throw new Error('Stale or incomplete build; run npm run build');
  if (JSON.stringify(record.files) !== JSON.stringify(artifactIdentity(dist, withNative))) throw new Error('Artifact differs from completed build; run npm run build');
}

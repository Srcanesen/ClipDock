// Deterministic artifact inventory and verification helpers shared by the
// build verifier, installed-artifact verifier, and focused tests. The installed
// plugin is exactly the current dist/ tree; there is no development/production
// artifact split.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, lstatSync } from 'node:fs';
import path from 'node:path';

export const hashFile = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Deterministic inventory of regular files, rejecting symlinks and specials. */
export function inventory(rootDir) {
  const files = [];
  const problems = [];
  const root = lstatSync(rootDir);
  if (root.isSymbolicLink() || !root.isDirectory()) {
    problems.push(root.isSymbolicLink() ? 'artifact root is a symbolic link' : 'artifact root is not a directory');
    return {files, problems};
  }
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) problems.push(`symbolic link in artifact: ${rel}`);
      else if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (entry.isFile()) files.push(rel);
      else problems.push(`unsupported filesystem entry in artifact: ${rel}`);
    }
  };
  walk(rootDir, '');
  return {files: files.sort(), problems};
}

const NATIVE_ARTIFACT = /\.(?:node|exe|dll|so|dylib|pkg|msi|appimage|dmg|deb|rpm|bin|o|a|lib|jar|apk|ipa|wasm|bundle|framework|sys|drv|ocx|scr)$/i;
const JUNK_ARTIFACT = /(?:^|\/)(?:output|mockups|imagegen)(?:\/|$)|(?:^|\/)[^/]*(?:ddg|codex-prompt|mockup)[^/]*$/i;

/** Reject binaries, executable bits, and packaging debris in a plugin tree. */
export function scanArtifactProblems(rootDir, files) {
  const problems = [];
  for (const rel of files) {
    if (path.basename(rel) === '.DS_Store' || JUNK_ARTIFACT.test(rel)) problems.push(`contains packaging debris: ${rel}`);
    if (NATIVE_ARTIFACT.test(rel)) problems.push(`contains native/binary artifact: ${rel}`);
    if (statSync(path.join(rootDir, rel)).mode & 0o111) problems.push(`file carries executable permission bits: ${rel}`);
  }
  return problems;
}

const resolveRelativeRequire = (rootDir, fromFile, spec) => {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')]) {
    if (candidate !== rootDir && !candidate.startsWith(rootDir + path.sep)) continue;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
};

/** Every relative require must resolve inside the artifact; Resolve supplies the native sidecar. */
export function requireGraphProblems(rootDir, files) {
  const problems = [];
  for (const rel of files) {
    if (!rel.endsWith('.js')) continue;
    const fromFile = path.join(rootDir, rel);
    const source = readFileSync(fromFile, 'utf8');
    for (const match of source.matchAll(/require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g)) {
      const spec = match[2];
      if (resolveRelativeRequire(rootDir, fromFile, spec)) continue;
      if (rel === 'main.js' && spec === './WorkflowIntegration.node') continue;
      problems.push(`require graph: ${rel} references missing module ${spec}`);
    }
  }
  return problems;
}

export function changedFiles(candidateDir, sourceDir, files) {
  const changed = [];
  for (const rel of files) {
    const candidate = path.join(candidateDir, rel);
    const source = path.join(sourceDir, rel);
    if (!existsSync(source) || !statSync(source).isFile() || hashFile(candidate) !== hashFile(source)) changed.push(rel);
  }
  return changed;
}

/** Verify an artifact inventory and, when supplied, its exact byte identity to a source tree. */
export function verifyArtifact(candidateDir, sourceDir = null) {
  const candidate = inventory(candidateDir);
  const problems = [...candidate.problems];
  const source = sourceDir ? inventory(sourceDir) : null;
  if (source) {
    problems.push(...source.problems.map(problem => `source ${problem}`));
    for (const rel of candidate.files.filter((file) => !source.files.includes(file))) problems.push(`extra path in artifact: ${rel}`);
    for (const rel of source.files.filter((file) => !candidate.files.includes(file))) problems.push(`missing path in artifact: ${rel}`);
    for (const rel of candidate.files.filter((file) => source.files.includes(file))) {
      if (changedFiles(candidateDir, sourceDir, [rel]).length) problems.push(`content changed vs source: ${rel}`);
    }
  }
  problems.push(...scanArtifactProblems(candidateDir, candidate.files));
  problems.push(...requireGraphProblems(candidateDir, candidate.files));
  return {ok: problems.length === 0, problems, files: candidate.files};
}

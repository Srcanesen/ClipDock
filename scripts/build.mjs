// Build script: compile TypeScript to dist/ then copy static assets so that
// dist/ is a complete, installable Workflow Integration plugin folder
// (layout mirrors Blackmagic's official SamplePlugin).
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleBrowserRenderer } from './lib/browser-renderer.mjs';
import { recordBuild, validateCompletedBuild, sourceIdentity } from './lib/completed-build.mjs';
import { reconcileDirectoryContents } from './lib/install-files.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const published = path.join(root, 'dist');
const dist = path.join(root, `.build-${process.pid}`);
const identity = sourceIdentity(root);
try {
  const staticDir = path.join(root, 'static');

  rmSync(dist, { recursive: true, force: true });

  execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json', '--outDir', dist, '--noEmitOnError'], { cwd: root, stdio: 'inherit' });
  bundleBrowserRenderer(dist);

  // preview.ts is typechecked with the product sources, but its fixture adapter is
  // local-preview-only and must never become part of the installable artifact.
  rmSync(path.join(dist, 'preview.js'), { force: true });

  // Single-contract source: copy canonical contracts into dist and make the
  // runtime require self-contained. contracts.mjs is the canonical ESM source;
  // we generate a CommonJS copy for the tsc-built CommonJS shared.js and patch
  // its require path so the installed plugin (dist/ only) remains self-contained.
  {
    const contractsSrc = path.join(root, 'scripts', 'lib', 'contracts.mjs');
    const contractsMjsDst = path.join(dist, 'contracts.mjs');
    const contractsCjsDst = path.join(dist, 'contracts.js');
    const sharedJs = path.join(dist, 'shared.js');
    if (!existsSync(contractsSrc) || !existsSync(sharedJs)) throw new Error('Missing contracts conversion input');
    {
      cpSync(contractsSrc, contractsMjsDst);
      // Generate CommonJS wrapper from the ESM source (export const -> exports.)
      const srcText = readFileSync(contractsSrc, 'utf8');
      let cjsText = srcText
        .replace(/export const (\w+) =/g, 'exports.$1 =')
        .replace(/export const /g, 'exports.');
      // Fix self-reference in FLAT: REQUIRED_HTML_IDS is now on exports
      cjsText = cjsText.replace(/Object\.values\(REQUIRED_HTML_IDS\)/, 'Object.values(exports.REQUIRED_HTML_IDS)');
      writeFileSync(contractsCjsDst, cjsText);
      let sharedText = readFileSync(sharedJs, 'utf8');
      const before = sharedText;
      // Patch both require occurrences (import and re-export) to point inside dist
      sharedText = sharedText.split('"../scripts/lib/contracts.mjs"').join('"./contracts.js"');
      sharedText = sharedText.split("'../scripts/lib/contracts.mjs'").join("'./contracts.js'");
      sharedText = sharedText.split('"../scripts/lib/contracts.mjs"').join('"./contracts.js"');
      if (sharedText === before || sharedText.includes('../scripts/')) throw new Error('Contracts runtime rewrite failed');
      writeFileSync(sharedJs, sharedText);
    }
  }

  // Static assets land in dist/ verbatim (manifest.xml, index.html, css/, plugin package.json).
  for (const entry of ['manifest.xml', 'index.html', 'css', 'fonts', 'package.json']) {
    cpSync(path.join(staticDir, entry), path.join(dist, entry), { recursive: true });
  }

  recordBuild(root, dist, identity);
  validateCompletedBuild(root, dist);
  reconcileDirectoryContents(dist, published);
  console.log(`\nBuilt plugin folder: ${published}`);
  console.log('Next: npm run install:plugin  (see README.md)');

} finally {
  rmSync(dist, { recursive: true, force: true });
}

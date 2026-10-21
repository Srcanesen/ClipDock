import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Script } from 'node:vm';

export function assertBrowserScript(source) {
  if (/\brequire\s*\(|\bexports\b|\bmodule\.exports\b/.test(source)) throw new Error('Renderer has unresolved CommonJS dependencies');
  new Script(source);
}

// Keep module scopes intact: the session imports its output internals, while the
// renderer imports only the session interface. No function-name rewrite table.
export function bundleBrowserRenderer(dist) {
  const rendererJsPath = path.join(dist, 'renderer.js');
  if (!existsSync(rendererJsPath)) throw new Error('Missing renderer.js');
  const stateFiles = ['search-session', 'output-model', 'queue-model', 'item-output-session', 'preview-session', 'status-session'];
  const resolveBindings = (source, fromRenderer) => source.replace(/require\(\s*(['"])([^'"]+)\1\s*\)/g, (_, quote, dependency) => {
    const name = dependency.replace(fromRenderer ? './renderer-state/' : './', '');
    if (!stateFiles.includes(name) || dependency !== `${fromRenderer ? './renderer-state/' : './'}${name}`) throw new Error(`Renderer has unresolved CommonJS dependency: ${dependency}`);
    return `rendererStateModules["${name}"]`;
  });
  let prefix = 'const rendererStateModules = {};\n';
  for (const name of stateFiles) {
    const filePath = path.join(dist, 'renderer-state', `${name}.js`);
    if (!existsSync(filePath)) throw new Error(`Missing renderer module: ${filePath}`);
    const source = resolveBindings(readFileSync(filePath, 'utf8'), false).replace(/\bexports\b/g, 'stateExports');
    assertBrowserScript(source);
    prefix += `rendererStateModules["${name}"] = (() => { const stateExports = {};\n${source}\nreturn stateExports; })();\n`;
  }
  let renderer = resolveBindings(readFileSync(rendererJsPath, 'utf8'), true);
  renderer = renderer.replace(/Object\.defineProperty\(exports, "__esModule", \{ value: true \}\);\s*/g, '');
  const bundled = prefix + renderer;
  assertBrowserScript(bundled);
  writeFileSync(rendererJsPath, bundled);
}

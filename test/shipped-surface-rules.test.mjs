import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, appendFileSync, rmSync, cpSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SHIPPED_SURFACE_RULES, runShippedSurfaceRules } from '../scripts/lib/shipped-surface-rules.mjs';
import { IPC_CHANNELS, PRELOAD_API_METHODS, REQUIRED_HTML_IDS_FLAT, DIST_REQUIRED_FILES, PLUGIN_ID } from '../scripts/lib/contracts.mjs';
import { recordBuild, validatePluginArtifact } from '../scripts/lib/completed-build.mjs';

const nativePreviewSetup = `
const main_process_1 = require('./main-process');
function openNativePreview(url) {
  const view = new WebContentsView({ webPreferences: { partition: 'clipdock-youtube-preview' } });
  view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  view.webContents.session.setPermissionCheckHandler(() => false);
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  view.webContents.loadURL(url, { httpReferrer: main_process_1.YOUTUBE_PREVIEW_REFERRER });
}
`;
// Same removals and replacements as the reviewer's verifier-mutations.mjs.
const previewMutations = [
  { name: 'popup denial removed', id: 'native-preview-popups', mutate: (source) => source.replace(/^.*view\.webContents\.setWindowOpenHandler.*\n/m, '') },
  { name: 'permission denial removed', id: 'native-preview-permissions', mutate: (source) => source.replace(/^.*view\.webContents\.session\.setPermissionRequestHandler.*\n/m, '') },
  { name: 'persistent partition', id: 'native-preview-partition', mutate: (source) => source.replace("partition: 'clipdock-youtube-preview'", "partition: 'persist:clipdock-youtube-preview'") },
  { name: 'request referrer removed', id: 'native-preview-referrer', mutate: (source) => source.replace(/loadURL\(url, \{ httpReferrer: (?:main_process_1\.)?YOUTUBE_PREVIEW_REFERRER \}\)/g, 'loadURL(url)') },
];

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-rule-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content, { mode: 0o644 });
  };
  for (const dir of ['src', 'static', 'scripts/lib', 'test', 'dist']) mkdirSync(path.join(root, dir), { recursive: true });
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json']) write(file, '{}\n');
  write('scripts/build.mjs', '// fixture build\n');
  for (const file of [...DIST_REQUIRED_FILES, 'main-process.js']) write(`dist/${file}`, '// fixture artifact\n');
  const html = `<meta http-equiv="Content-Security-Policy" content="img-src 'self' data: https://i.ytimg.com https://images.pexels.com https://i.pinimg.com https://cdn.pixabay.com;"><link rel="stylesheet" href="css/styles.css"><script src="renderer.js"></script>${REQUIRED_HTML_IDS_FLAT.map((id) => `<div id="${id}"></div>`).join('')}\n`;
  write('static/index.html', html); write('dist/index.html', html);
  write('dist/css/styles.css', 'body { color: black; }\n');
  write('dist/package.json', '{"main":"main.js"}\n');
  write('dist/manifest.xml', `<Id>${PLUGIN_ID}</Id><Name>Fixture</Name><Version>1</Version><Description>Fixture</Description><FilePath>main.js</FilePath>\n`);
  write('dist/contracts.js', `const PLUGIN_ID = '${PLUGIN_ID}';\n`);
  write('dist/preload.js', `const { contextBridge, ipcRenderer } = require('electron/renderer');
const api = { ${PRELOAD_API_METHODS.map((name) => `${name}: () => undefined`).join(', ')} };
contextBridge.exposeInMainWorld('clipdockAPI', api);
${Object.values(IPC_CHANNELS).map((channel) => `ipcRenderer.invoke('${channel}');`).join('\n')}
`);
  write('dist/main.js', `const PLUGIN_ID = '${PLUGIN_ID}';
require('./WorkflowIntegration.node');
${Object.keys(IPC_CHANNELS).filter((key) => key !== 'nativeDragStart').map((key) => `ipcMain.handle(IPC_CHANNELS.${key}, () => {});`).join('\n')}
ipcMain.on(IPC_CHANNELS.nativeDragStart, (event) => { event.sender.startDrag({}); });
${nativePreviewSetup}`);
  write('dist/main-process.js', "exports.YOUTUBE_PREVIEW_REFERRER = 'https://com.clipdock.app/';\n");
  write('dist/path-boundary.js', 'fs.lstatSync(); fs.realpathSync(); info.isSymbolicLink(); info.isFile(); path.relative(); path.isAbsolute();\n');
  write('dist/renderer.js', 'window.clipdockAPI.getStatus();\n');
  write('dist/pexels-credential.js', "const KEYCHAIN_COMMAND = '/usr/bin/security'; spawnCommand(KEYCHAIN_COMMAND, args, {shell: false});\n");
  recordBuild(root, path.join(root, 'dist'));
  return { root, write };
}

const failingCases = {
  'completed-build': ({ write }) => write('src/new.ts', '// source changed after build\n'),
  'preload-bridge': ({ root }) => appendFileSync(path.join(root, 'dist/preload.js'), "require('node:fs');\n"),
  'ipc-contract': ({ write }) => write('dist/main.js', 'ipcMain.handle(IPC_CHANNELS.getStatus, () => {});\n'),
  'html-contract': ({ write }) => write('static/index.html', '<div id="unrelated"></div>\n'),
  'path-boundary': ({ write }) => write('dist/path-boundary.js', 'fs.statSync();\n'),
  'native-drag-sync': ({ write }) => write('dist/main.js', 'ipcMain.on(IPC_CHANNELS.nativeDragStart, async event => { await event.sender.startDrag({}); });\n'),
  'browser-renderer': ({ write }) => write('dist/renderer.js', 'process.exit(0);\n'),
  'renderer-opaque-payloads': ({ write }) => write('dist/renderer.js', 'const file = result.filePath;\n'),
  'provider-isolation': ({ write }) => write('dist/ytdlp.js', "require('electron');\n"),
  'credential-command': ({ write }) => write('dist/pexels-credential.js', "const KEYCHAIN_COMMAND = '/usr/bin/security'; spawnCommand(KEYCHAIN_COMMAND, args, {shell: true});\n"),
  'native-owner': ({ write }) => write('dist/status-provider.js', "require('./WorkflowIntegration.node');\n"),
  'preview-isolation': ({ write }) => write('dist/preview.js', 'window.clipdockAPI = {};\n'),
  'electron-security': ({ write }) => write('dist/main.js', 'new BrowserWindow({webSecurity: false});\n'),
  ...Object.fromEntries(previewMutations.map(({ id, mutate }) => [id, ({ root, write }) => write('dist/main.js', mutate(readFileSync(path.join(root, 'dist/main.js'), 'utf8')))])),
  'no-licensing': ({ write }) => write('dist/license.js', 'module.exports = {};\n'),
  'hygiene': ({ write }) => write('src/broken.ts', 'const value = 1; \n'),
  'release-identity': ({ root }) => appendFileSync(path.join(root, 'release/renderer.js'), '// changed release\n'),
};

for (const rule of SHIPPED_SURFACE_RULES) {
  for (const broken of [false, true]) test(`${rule.id}: ${broken ? 'rejects a broken surface by id' : 'accepts a safe fixture'}`, (t) => {
    const tree = fixture(t);
    const options = { ruleIds: [rule.id] };
    if (rule.id === 'release-identity') {
      options.releaseDir = path.join(tree.root, 'release');
      cpSync(path.join(tree.root, 'dist'), options.releaseDir, { recursive: true });
    }
    if (broken) failingCases[rule.id](tree);
    const results = runShippedSurfaceRules(tree.root, options);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, rule.id);
    assert.equal(results[0].ok, !broken, results[0].problems.join('; '));
    assert.deepEqual(results.filter((result) => !result.ok).map((result) => result.id), broken ? [rule.id] : []);
  });
}

test('IPC contract accepts delegated transfer handlers and outbound notification channels', (t) => {
  const tree = fixture(t);
  const events = ['resolveQuit', 'youtubePreviewState', 'youtubeEvent', 'socialEvent', 'pinterestEvent', 'pexelsEvent'];
  tree.write('dist/main.js', `
registerMainTransferInvokeHandlers(ipcMain, { importToMediaPool: IPC_CHANNELS.importToMediaPool, addToTimeline: IPC_CHANNELS.addToTimeline }, deps);
${Object.keys(IPC_CHANNELS).filter((key) => !events.includes(key) && !['importToMediaPool', 'addToTimeline'].includes(key)).map((key) => `ipcMain.handle(IPC_CHANNELS.${key}, () => {});`).join('\n')}
${events.map((key) => `contents.send(IPC_CHANNELS.${key}, {});`).join('\n')}
`);
  assert.deepEqual(runShippedSurfaceRules(tree.root, { ruleIds: ['ipc-contract'] }).map(({ id, ok }) => ({ id, ok })), [{ id: 'ipc-contract', ok: true }]);
});


for (const mutation of [
  { name: 'permission granted', id: 'native-preview-permissions', mutate: (source) => source.replace('callback(false)', 'callback(true)') },
  { name: 'permission checks granted', id: 'native-preview-permissions', mutate: (source) => source.replace('setPermissionCheckHandler(() => false)', 'setPermissionCheckHandler(() => true)') },
  { name: 'popups allowed', id: 'native-preview-popups', mutate: (source) => source.replace("action: 'deny'", "action: 'allow'") },
  { name: 'referrer overridden', id: 'native-preview-referrer', mutate: (source) => source.replace('main_process_1.YOUTUBE_PREVIEW_REFERRER', "'https://untrusted.example/'") },
]) test(`native preview rejects ${mutation.name}`, (t) => {
  const tree = fixture(t);
  tree.write('dist/main.js', mutation.mutate(nativePreviewSetup));
  assert.deepEqual(runShippedSurfaceRules(tree.root, { ruleIds: [mutation.id] }).map(({ id, ok }) => ({ id, ok })), [{ id: mutation.id, ok: false }]);
});

for (const kind of ['link', 'target', 'empty target', 'commented link', 'non-stylesheet link']) test(`completed artifact rejects missing stylesheet ${kind}`, (t) => {
  const tree = fixture(t), dist = path.join(tree.root, 'dist');
  if (kind === 'target') rmSync(path.join(dist, 'css/styles.css'));
  else if (kind === 'empty target') tree.write('dist/css/styles.css', '');
  else {
    const link = kind === 'commented link' ? '<!-- <link rel="stylesheet" href="css/styles.css"> -->' : kind === 'non-stylesheet link' ? '<link rel="preload" href="css/styles.css">' : '';
    tree.write('dist/index.html', `${link}<script src="renderer.js"></script>`);
  }
  const expected = ['target', 'empty target'].includes(kind) ? /^Missing or empty panel stylesheet: css\/styles\.css$/ : /^Missing panel stylesheet link$/;
  assert.throws(() => validatePluginArtifact(dist), { message: expected });
  assert.deepEqual(runShippedSurfaceRules(tree.root, { ruleIds: ['completed-build'] }).map(({ id, ok }) => ({ id, ok })), [{ id: 'completed-build', ok: false }]);
});

for (const images of ["'self' data: https:", "'self' data: https://i.ytimg.com https://images.pexels.com https://i.pinimg.com https://cdn.pixabay.com https://evil.test"]) test(`html-contract rejects widened image policy ${images}`, t => {
  const tree = fixture(t);
  const html = readFileSync(path.join(tree.root, 'static/index.html'), 'utf8').replace(/img-src [^;]+;/, `img-src ${images};`);
  tree.write('static/index.html', html);
  const [result] = runShippedSurfaceRules(tree.root, {ruleIds: ['html-contract']});
  assert.equal(result.ok, false); assert.match(result.problems.join(' '), /unexpected image CSP/);
});

// Security and architecture checks for the source tree and completed artifact.
// Runtime behaviour belongs in test/. A rule throws to reject its named surface.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { IPC_CHANNELS, PRELOAD_API_METHODS, REQUIRED_HTML_IDS_FLAT } from './contracts.mjs';
import { validateCompletedBuild } from './completed-build.mjs';
import { inventory, verifyArtifact } from './release-artifact.mjs';
import { assertBrowserScript } from './browser-renderer.mjs';

const requireInvariant = (ok, message) => { if (!ok) throw new Error(message); };
const read = (root, file) => readFileSync(path.join(root, file), 'utf8');
function nodes(root, file) {
  const source = ts.createSourceFile(file, read(root, file), ts.ScriptTarget.Latest, true);
  const result = [];
  const visit = (node) => { result.push(node); ts.forEachChild(node, visit); };
  visit(source);
  return result;
}
const calls = (tree, name) => tree.filter((node) => ts.isCallExpression(node) && (
  ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText()) === name);
const strings = (tree) => tree.filter(ts.isStringLiteral).map((node) => node.text);
const references = (tree) => tree.filter(ts.isPropertyAccessExpression).map((node) => node.name.text);
const channelKey = (node) => ts.isPropertyAccessExpression(node) && node.expression.getText().endsWith('IPC_CHANNELS') ? node.name.text : null;

function property(object, name) {
  if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
  const matches = object.properties.filter((node) => ts.isPropertyAssignment(node) && node.name.text === name);
  return matches.length === 1 ? matches[0].initializer : undefined;
}
function callbackExpression(callback) {
  if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return undefined;
  let expression = callback.body;
  if (ts.isBlock(expression)) {
    if (expression.statements.length !== 1) return undefined;
    const statement = expression.statements[0];
    expression = ts.isReturnStatement(statement) || ts.isExpressionStatement(statement) ? statement.expression : undefined;
  }
  while (expression && ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return expression;
}
function providerRegistrationConsumes(main, declaration) {
  let registrar = declaration.parent;
  while (registrar && !ts.isFunctionDeclaration(registrar)) registrar = registrar.parent;
  if (!registrar?.name || calls(main, registrar.name.text).length === 0) return false;
  const statements = node => ts.isBlock(node) ? [...node.statements] : [node];
  const binding = loop => ts.isVariableDeclarationList(loop.initializer) && loop.initializer.declarations.length === 1
    ? loop.initializer.declarations[0].name : undefined;
  const sensitiveHandle = (statement, channel, handler) => {
    const call = ts.isExpressionStatement(statement) && statement.expression;
    if (!call || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)
      || call.expression.name.text !== 'handle' || !call.expression.expression.getText().endsWith('ipcMain')
      || call.arguments[0]?.getText() !== channel) return false;
    const factory = call.arguments[1];
    return factory && ts.isCallExpression(factory) && factory.expression.getText() === 'createSensitiveIpcHandler'
      && factory.arguments[0]?.getText() === 'requireTrustedSender'
      && (handler === undefined || factory.arguments[1]?.getText() === handler);
  };
  return registrar.body.statements.some(loop => {
    if (!ts.isForOfStatement(loop) || loop.expression.getText() !== declaration.name.getText()) return false;
    const provider = binding(loop);
    if (!provider || !ts.isIdentifier(provider)) return false;
    const body = statements(loop.statement);
    const routes = body.some(inner => {
      if (!ts.isForOfStatement(inner) || inner.expression.getText() !== `${provider.text}.routes`) return false;
      const pair = binding(inner);
      if (!pair || !ts.isArrayBindingPattern(pair) || pair.elements.length !== 2
        || !pair.elements.every(element => ts.isBindingElement(element) && ts.isIdentifier(element.name))) return false;
      return statements(inner.statement).some(statement => sensitiveHandle(statement, pair.elements[0].name.text, pair.elements[1].name.text));
    });
    return routes && body.some(statement => sensitiveHandle(statement, `${provider.text}.cancel`));
  });
}
function nativePreview(root) {
  const tree = nodes(root, 'dist/main.js');
  const views = tree.filter((node) => ts.isNewExpression(node) && (
    ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText()) === 'WebContentsView');
  requireInvariant(views.length === 1 && ts.isVariableDeclaration(views[0].parent), 'native preview must have one bound WebContentsView');
  const view = views[0], receiver = `${view.parent.name.getText()}.webContents`;
  let scope = view.parent;
  while (scope.parent && !ts.isBlock(scope)) scope = scope.parent;
  const setup = tree.filter((node) => node.pos >= scope.pos && node.end <= scope.end);
  const method = (name, suffix = '') => calls(setup, name).filter((node) => ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText() === receiver + suffix);
  return { tree, view, method };
}

export const SHIPPED_SURFACE_RULES = [
  {
    id: 'completed-build', files: ['dist/', 'src/', 'static/', 'scripts/lib/'],
    reason: 'Only a complete artifact matching the current sources can ship.',
    check(root) { validateCompletedBuild(root, path.join(root, 'dist')); },
  },
  {
    id: 'preload-bridge', files: ['dist/preload.js'],
    reason: 'The sandbox preload exposes only the narrow contextBridge API.',
    check(root) {
      const tree = nodes(root, this.files[0]);
      const dependencies = calls(tree, 'require');
      requireInvariant(dependencies.length === 1 && dependencies[0].arguments[0]?.text === 'electron/renderer', 'preload dependency must be only electron/renderer');
      const expose = calls(tree, 'exposeInMainWorld');
      requireInvariant(expose.length === 1 && expose[0].expression.expression.getText().endsWith('contextBridge') && expose[0].arguments[0]?.text === 'clipdockAPI' && expose[0].arguments[1]?.getText() === 'api', 'expose only clipdockAPI via contextBridge');
      const api = tree.find((node) => ts.isVariableDeclaration(node) && node.name.getText() === 'api')?.initializer;
      requireInvariant(api && ts.isObjectLiteralExpression(api), 'missing API object');
      requireInvariant(api.properties.length === PRELOAD_API_METHODS.length && api.properties.every((property) => ts.isPropertyAssignment(property) && PRELOAD_API_METHODS.includes(property.name.getText()) && (ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer))), 'API must contain only the contract methods, never raw Node objects');
    },
  },
  {
    id: 'ipc-contract', files: ['dist/preload.js', 'dist/main.js'],
    reason: 'Every contract channel has a preload route and a main handler or notification sender.',
    check(root) {
      const preloadTree = nodes(root, this.files[0]);
      const preload = preloadTree.filter(ts.isCallExpression).filter((node) => ts.isPropertyAccessExpression(node.expression) && ['invoke', 'send', 'on'].includes(node.expression.name.text)).map((node) => node.arguments[0]?.text);
      const main = nodes(root, this.files[1]);
      const routes = new Set();
      for (const node of main.filter(ts.isCallExpression)) {
        const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText();
        if (['handle', 'on', 'send', 'sendProviderEvent'].includes(name)) {
          for (const argument of node.arguments) { const key = channelKey(argument); if (key) routes.add(key); }
        }
        if (name.includes('registerMainTransferInvokeHandlers')) {
          const channels = node.arguments[1];
          if (channels && ts.isObjectLiteralExpression(channels)) for (const property of channels.properties) {
            if (ts.isPropertyAssignment(property)) { const key = channelKey(property.initializer); if (key) routes.add(key); }
          }
        }
      }
      // Provider IPC routes are registered from the main-process descriptor table.
      // Read only channel positions (cancel and route tuple heads), never arbitrary references.
      const declaration = main.find(node => ts.isVariableDeclaration(node) && node.name.getText() === 'providers');
      const descriptors = declaration?.initializer;
      if (descriptors) requireInvariant(providerRegistrationConsumes(main, declaration), 'provider descriptors require an active sensitive IPC registration loop');
      if (descriptors && ts.isArrayLiteralExpression(descriptors)) for (const descriptor of descriptors.elements) {
        if (!ts.isObjectLiteralExpression(descriptor)) continue;
        for (const property of descriptor.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          if (property.name.getText() === 'cancel') { const key = channelKey(property.initializer); if (key) routes.add(key); }
          if (property.name.getText() === 'routes' && ts.isArrayLiteralExpression(property.initializer)) {
            for (const route of property.initializer.elements) if (ts.isArrayLiteralExpression(route)) {
              const key = channelKey(route.elements[0]); if (key) routes.add(key);
            }
          }
        }
      }
      for (const [key, value] of Object.entries(IPC_CHANNELS)) {
        requireInvariant(preload.includes(value), `missing preload channel: ${key}`);
        requireInvariant(routes.has(key), `missing main route: ${key}`);
      }
    },
  },
  {
    id: 'html-contract', files: ['static/index.html', 'dist/index.html'],
    reason: 'The shipped HTML retains every required renderer entry point without duplicate ids.',
    check(root) {
      for (const file of this.files) {
        const html = read(root, file);
        const policy = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1] ?? '';
        const images = policy.split(';').map(value => value.trim()).filter(value => value.startsWith('img-src '));
        requireInvariant(images.length === 1 && images[0] === "img-src 'self' data: https://i.ytimg.com https://images.pexels.com https://i.pinimg.com https://cdn.pixabay.com", `${file}: unexpected image CSP`);
        const ids = [...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]);
        requireInvariant(new Set(ids).size === ids.length, `${file}: duplicate id`);
        for (const id of REQUIRED_HTML_IDS_FLAT) requireInvariant(ids.includes(id), `${file}: missing #${id}`);
      }
    },
  },
  {
    id: 'path-boundary', files: ['dist/path-boundary.js'],
    reason: 'Path validation retains symlink, canonical path and regular-file guards.',
    check(root) {
      const refs = references(nodes(root, this.files[0]));
      for (const name of ['lstatSync', 'realpathSync', 'isSymbolicLink', 'isFile', 'relative', 'isAbsolute']) requireInvariant(refs.includes(name), `missing path guard: ${name}`);
    },
  },
  {
    id: 'native-drag-sync', files: ['dist/main.js'],
    reason: 'Native drag must start synchronously inside the IPC event.',
    check(root) {
      const tree = nodes(root, this.files[0]);
      const handler = calls(tree, 'on').find((node) => channelKey(node.arguments[0]) === 'nativeDragStart')?.arguments[1];
      requireInvariant(handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)), 'missing native drag callback');
      requireInvariant(!handler.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword), 'native drag callback is async');
      const body = []; const visit = (node) => { body.push(node); ts.forEachChild(node, visit); }; visit(handler.body);
      requireInvariant(!body.some(ts.isAwaitExpression) && calls(body, 'startDrag').length > 0, 'native drag must call startDrag without await');
    },
  },
  {
    id: 'browser-renderer', files: ['dist/renderer.js'],
    reason: 'The renderer runs as a browser script without Node globals or APIs.',
    check(root) {
      const source = read(root, this.files[0]); assertBrowserScript(source);
      const tree = nodes(root, this.files[0]);
      const names = tree.filter(ts.isIdentifier).map((node) => node.text);
      for (const name of ['require', 'process', 'Buffer', '__dirname', '__filename', 'global', 'ipcRenderer', 'contextBridge']) requireInvariant(!names.includes(name), `renderer contains Node API: ${name}`);
    },
  },
  {
    id: 'renderer-opaque-payloads', files: ['dist/renderer.js'],
    reason: 'The renderer carries opaque card ids and validated thumbnail URLs instead of local paths.',
    check(root) {
      const tree = nodes(root, this.files[0]);
      requireInvariant(!references(tree).some((name) => ['path', 'filePaths', 'filePath', 'showOpenDialog'].includes(name)), 'renderer handles privileged paths');
      requireInvariant(!strings(tree).some((value) => /i\.ytimg\.com|youtube-nocookie\.com\/embed/.test(value)), 'renderer constructs upstream media URLs');
    },
  },
  {
    id: 'provider-isolation', files: ['dist/status-provider.js', 'dist/transfer.js', 'dist/ytdlp.js', 'dist/gallerydl.js', 'dist/media-prep.js', 'dist/main-process.js'],
    reason: 'Provider and transfer helpers use injected host capabilities without loading Electron.',
    check(root) {
      for (const file of this.files) for (const call of calls(nodes(root, file), 'require')) {
        requireInvariant(!/^electron(?:\/|$)/.test(call.arguments[0]?.text ?? ''), `${file}: loads Electron`);
      }
    },
  },
  {
    id: 'credential-command', files: ['dist/pexels-credential.js'],
    reason: 'Keychain commands use the fixed binary without shell execution or broadening its ACL.',
    check(root) {
      const tree = nodes(root, this.files[0]);
      const command = tree.find((node) => ts.isVariableDeclaration(node) && node.name.getText() === 'KEYCHAIN_COMMAND');
      requireInvariant(command?.initializer?.text === '/usr/bin/security', 'Keychain binary must be /usr/bin/security');
      const spawn = calls(tree, 'spawnCommand');
      requireInvariant(spawn.length === 1 && spawn[0].arguments[0]?.getText() === 'KEYCHAIN_COMMAND', 'Keychain must spawn the fixed command');
      const options = spawn[0].arguments[2];
      requireInvariant(options && ts.isObjectLiteralExpression(options) && options.properties.some((node) => ts.isPropertyAssignment(node) && node.name.getText() === 'shell' && node.initializer.kind === ts.SyntaxKind.FalseKeyword), 'Keychain spawn must use shell:false');
      requireInvariant(!strings(tree).includes('-A'), 'Keychain must not broaden its ACL');
    },
  },
  {
    id: 'native-owner', files: ['dist/'],
    reason: 'Only main loads the injected WorkflowIntegration native module.',
    check(root) {
      const files = inventory(path.join(root, 'dist')).files.filter((file) => file.endsWith('.js'));
      const owners = files.filter((file) => strings(nodes(root, `dist/${file}`)).some((value) => value.endsWith('WorkflowIntegration.node')));
      requireInvariant(owners.length === 1 && owners[0] === 'main.js', 'native module must be owned only by main.js');
    },
  },
  {
    id: 'preview-isolation', files: ['dist/index.html', 'dist/'],
    reason: 'The fake preview adapter cannot enter the production panel.',
    check(root) {
      requireInvariant(!existsSync(path.join(root, 'dist/preview.js')) && !/\b(?:src|href)\s*=\s*["'][^"']*preview\.js/.test(read(root, this.files[0])), 'preview adapter ships in production');
    },
  },
  {
    id: 'electron-security', files: ['dist/main.js', 'dist/preload.js'],
    reason: 'Privileged surfaces cannot disable Electron security or intercept session-wide headers.',
    check(root) {
      for (const file of this.files) {
        const tree = nodes(root, file);
        const refs = references(tree);
        requireInvariant(!refs.some((name) => ['webRequest', 'onBeforeSendHeaders', 'requestHeaders', 'defaultSession'].includes(name)), `${file}: session-wide header interception`);
        const unsafe = tree.filter(ts.isPropertyAssignment).some((node) => {
          const key = node.name.getText(); const value = node.initializer.kind;
          return (key === 'webSecurity' && value === ts.SyntaxKind.FalseKeyword) || (['nodeIntegration', 'allowRunningInsecureContent'].includes(key) && value === ts.SyntaxKind.TrueKeyword);
        });
        requireInvariant(!unsafe && !strings(tree).includes('certificate-error'), `${file}: unsafe Electron setting`);
      }
    },
  },
  {
    id: 'native-preview-permissions', files: ['dist/main.js'],
    reason: 'The native preview session denies permission requests and permission checks.',
    check(root) {
      const { method } = nativePreview(root);
      const requests = method('setPermissionRequestHandler', '.session');
      const callback = requests[0]?.arguments[0], denial = callbackExpression(callback);
      requireInvariant(requests.length === 1 && denial && ts.isCallExpression(denial) && ts.isIdentifier(denial.expression) && denial.expression.text === callback.parameters[2]?.name.getText() && denial.arguments.length === 1 && denial.arguments[0].kind === ts.SyntaxKind.FalseKeyword, 'native preview must deny every permission request');
      const checks = method('setPermissionCheckHandler', '.session');
      requireInvariant(checks.length === 1 && callbackExpression(checks[0].arguments[0])?.kind === ts.SyntaxKind.FalseKeyword, 'native preview must deny permission checks');
    },
  },
  {
    id: 'native-preview-popups', files: ['dist/main.js'],
    reason: 'The native preview WebContents denies every new window.',
    check(root) {
      const handlers = nativePreview(root).method('setWindowOpenHandler');
      const result = callbackExpression(handlers[0]?.arguments[0]);
      requireInvariant(handlers.length === 1 && property(result, 'action')?.text === 'deny', 'native preview must deny window opening');
    },
  },
  {
    id: 'native-preview-partition', files: ['dist/main.js'],
    reason: 'The native preview uses its dedicated temporary session partition.',
    check(root) {
      const { view } = nativePreview(root);
      requireInvariant(property(property(view.arguments?.[0], 'webPreferences'), 'partition')?.text === 'clipdock-youtube-preview', 'native preview must use the non-persistent clipdock-youtube-preview partition');
    },
  },
  {
    id: 'native-preview-referrer', files: ['dist/main.js', 'dist/main-process.js'],
    reason: 'Native preview navigation supplies the fixed app referrer on each request.',
    check(root) {
      const { tree, method } = nativePreview(root);
      const loads = method('loadURL');
      requireInvariant(loads.length > 0, 'missing native preview navigation');
      for (const load of loads) {
        const referrer = property(load.arguments[1], 'httpReferrer');
        const imported = referrer && ts.isPropertyAccessExpression(referrer) && referrer.name.text === 'YOUTUBE_PREVIEW_REFERRER' && tree.some((node) => ts.isVariableDeclaration(node) && node.name.getText() === referrer.expression.getText() && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText() === 'require' && node.initializer.arguments[0]?.text === './main-process');
        requireInvariant(imported, 'native preview must send the imported request-scoped referrer');
      }
      const definitions = nodes(root, 'dist/main-process.js').filter((node) => ts.isBinaryExpression(node) && ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'YOUTUBE_PREVIEW_REFERRER' && ts.isStringLiteral(node.right));
      requireInvariant(definitions.length === 1 && definitions[0].right.text === 'https://com.clipdock.app/', 'native preview referrer must be the fixed app origin');
    },
  },
  {
    id: 'no-licensing', files: ['dist/'],
    reason: 'No licensing module, control, or IPC surface ships.',
    check(root) {
      for (const file of inventory(path.join(root, 'dist')).files) {
        requireInvariant(!/(?:^|\/)licens(?:e|ing)(?:[./-]|$)/i.test(file), `licensing artifact: ${file}`);
        if (/\.(?:js|html|json)$/.test(file)) requireInvariant(!/clipdock:licens|\blicense(?:Status|ActionReason|Gate)\b|id=["']license-|class=["']license-/i.test(read(root, `dist/${file}`)), `licensing surface: ${file}`);
      }
    },
  },
  {
    id: 'hygiene', files: ['src/', 'static/', 'scripts/', 'dist/'],
    reason: 'Shipped and checked sources contain no conflict markers or trailing whitespace.',
    check(root) {
      for (const dir of this.files) for (const file of inventory(path.join(root, dir)).files) {
        if (!/\.(?:ts|js|mjs|html|css|xml|json)$/.test(file)) continue;
        read(root, `${dir}${file}`).split('\n').forEach((line, index) => {
          requireInvariant(!/^(?:<{7}|={7}|>{7})/.test(line) && !/[\t ]$/.test(line), `${dir}${file}:${index + 1}: conflict marker or trailing whitespace`);
        });
      }
    },
  },
  {
    id: 'release-identity', files: ['dist/', '--release-dir'],
    reason: 'An optional release tree must be safe and byte-identical to the completed artifact.',
    check(root, { releaseDir }) {
      if (!releaseDir) return;
      const result = verifyArtifact(path.resolve(releaseDir), path.join(root, 'dist'));
      requireInvariant(result.ok, result.problems.join('; '));
    },
  },
];

export function runShippedSurfaceRules(root, options = {}) {
  return SHIPPED_SURFACE_RULES.filter((rule) => !options.ruleIds || options.ruleIds.includes(rule.id)).map((rule) => {
    try { rule.check(root, options); return { id: rule.id, ok: true, reason: rule.reason, problems: [] }; }
    catch (error) { return { id: rule.id, ok: false, reason: rule.reason, problems: [error.message] }; }
  });
}

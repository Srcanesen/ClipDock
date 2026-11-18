import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ArgError, DEFAULTS, parseArgs } from '../scripts/resolve-smoke/lib/args.mjs';
import { pythonInvocation, supportsResolveSmoke } from '../scripts/resolve-smoke/lib/locate.mjs';
import { runInWindowsSession } from '../scripts/resolve-smoke/lib/windows-session.mjs';

test('parseArgs applies documented defaults', () => {
  const cfg = parseArgs([], { platform: 'darwin', env: {} });
  assert.equal(cfg.bundle, '/Applications/DaVinci Resolve/DaVinci Resolve.app');
  assert.equal(cfg.scriptApi, '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting');
  assert.equal(cfg.python, 'python3');
  assert.equal(cfg.timeoutMs, 120000);
  assert.equal(cfg.quitGraceMs, 15000);
  assert.equal(cfg.termWaitMs, 10000);
  assert.equal(cfg.killWaitMs, 5000);
  assert.equal(cfg.pretty, false);
  assert.equal(cfg.help, false);
  assert.equal(cfg.probe, null);
});

test('Windows defaults use the official installation and Python launcher', () => {
  const cfg = parseArgs([], { platform: 'win32', env: { PROGRAMDATA: 'D:\\Data' } });
  assert.equal(cfg.bundle, 'C:\\Program Files\\Blackmagic Design\\DaVinci Resolve');
  assert.equal(cfg.scriptApi, 'D:\\Data\\Blackmagic Design\\DaVinci Resolve\\Support\\Developer\\Scripting');
  assert.deepEqual(pythonInvocation(cfg.python, ['--version'], 'win32'), ['py', ['-3', '--version']]);
  assert.deepEqual(pythonInvocation('python3', ['probe.py'], 'win32'), ['py', ['-3', 'probe.py']]);
  assert.deepEqual(pythonInvocation('python3', ['probe.py'], 'darwin'), ['python3', ['probe.py']]);
  assert.deepEqual(['darwin', 'win32', 'linux'].map(supportsResolveSmoke), [true, true, false]);
});

test('parseArgs accepts overrides in both --opt=value and --opt value forms', () => {
  const cfg = parseArgs([
    '--bundle=/tmp/Resolve.app',
    '--python', '/opt/homebrew/bin/python3',
    '--timeout-ms=90000',
    '--quit-grace-ms', '7000',
    '--pretty',
    '--probe=/tmp/probe.py',
  ]);
  assert.equal(cfg.bundle, '/tmp/Resolve.app');
  assert.equal(cfg.python, '/opt/homebrew/bin/python3');
  assert.equal(cfg.timeoutMs, 90000);
  assert.equal(cfg.quitGraceMs, 7000);
  assert.equal(cfg.termWaitMs, 10000);
  assert.equal(cfg.pretty, true);
  assert.equal(cfg.probe, '/tmp/probe.py');
});

test('parseArgs rejects unknown options, positional arguments, bad numbers, and missing values', () => {
  assert.throws(() => parseArgs(['--nope']), ArgError);
  assert.throws(() => parseArgs(['stray']), ArgError);
  assert.throws(() => parseArgs(['-x']), ArgError);
  assert.throws(() => parseArgs(['--timeout-ms=abc']), ArgError);
  assert.throws(() => parseArgs(['--timeout-ms', '-5']), ArgError);
  assert.throws(() => parseArgs(['--timeout-ms=0']), ArgError);
  assert.throws(() => parseArgs(['--quit-grace-ms']), ArgError);
});

test('parseArgs --help short-circuits and -- ends option parsing', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['--bundle=x', '--help']).help, true);
  const cfg = parseArgs(['--pretty', '--', '--bundle=y']);
  assert.equal(cfg.pretty, true);
  assert.equal(cfg.bundle, DEFAULTS.bundle); // tokens after -- are not parsed
});

test('Windows session launcher forwards arguments, output and status and deletes its task', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'clipdock-task-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, 'fake runner.cjs');
  writeFileSync(entry, 'console.log(process.argv[2]); console.error("diagnostic"); process.exitCode = 5;');
  const worker = fileURLToPath(new URL('../scripts/resolve-smoke/lib/windows-session.mjs', import.meta.url));
  const calls = [];
  let directory;
  const task = args => {
    calls.push(args);
    if (args[0] === '/Create') {
      directory = path.dirname(args.at(-1).match(/"([^"]+)"$/)[1]);
    } else if (args[0] === '/Run') {
      const proc = spawnSync(process.execPath, [worker, directory], { encoding: 'utf8', timeout: 5000 });
      assert.equal(proc.status, 0, proc.stderr);
      writeFileSync(path.join(directory, 'launcher-exit'), '0');
    }
  };
  const result = await runInWindowsSession(entry, ['Unicode argument é'], { task });
  assert.equal(result.stdout.trim(), 'Unicode argument é');
  assert.equal(result.stderr.trim(), 'diagnostic');
  assert.equal(result.status, 5);
  assert.equal(calls[0].includes('/IT'), true);
  assert.deepEqual(calls.map(args => [args[0], args[2]]), [
    ['/Create', calls[0][2]], ['/Run', calls[0][2]], ['/Delete', calls[0][2]],
  ]);
  assert.equal(existsSync(directory), false);
  assert.equal(parseArgs(['--windows-interactive']).windowsInteractive, true);
});

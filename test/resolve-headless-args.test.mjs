import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArgError, DEFAULTS, parseArgs } from '../scripts/resolve-smoke/lib/args.mjs';
import { pythonInvocation, supportsResolveSmoke } from '../scripts/resolve-smoke/lib/locate.mjs';

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

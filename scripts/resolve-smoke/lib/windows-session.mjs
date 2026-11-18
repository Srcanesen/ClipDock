import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(import.meta.url);
const START_TIMEOUT_MS = 30000;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

function taskCommand(args) {
  const result = spawnSync('schtasks.exe', args, { encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`schtasks ${args[0]} failed: ${result.error?.message ?? (result.stderr.trim() || result.stdout.trim())}`);
  }
}

// Schedule the entire runner so Node owns the Resolve child and scripting
// clients run in the same Windows session.
export async function runInWindowsSession(entry, args, { task = taskCommand, startupMs = START_TIMEOUT_MS } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'clipdock-resolve-task-'));
  const name = `ClipDock-Resolve-${randomUUID()}`;
  const launcher = path.join(directory, 'launch.js');
  const started = path.join(directory, 'started');
  const finished = path.join(directory, 'result.json');
  const returned = path.join(directory, 'launcher-exit');
  let registered = false;
  try {
    writeFileSync(path.join(directory, 'request.json'), JSON.stringify({ entry, args, cwd: process.cwd() }));
    const command = [process.execPath, WORKER, directory].map(arg => `"${arg}"`).join(' ');
    const script = [
      'var shell = new ActiveXObject("WScript.Shell");',
      `var status = shell.Run(${JSON.stringify(command)}, 0, true);`,
      'var fs = new ActiveXObject("Scripting.FileSystemObject");',
      `var output = fs.CreateTextFile(${JSON.stringify(returned + '.tmp')}, false);`,
      'output.Write(status); output.Close();',
      `fs.MoveFile(${JSON.stringify(returned + '.tmp')}, ${JSON.stringify(returned)});`,
    ].join('\r\n');
    writeFileSync(launcher, '\ufeff' + script, 'utf16le');
    task(['/Create', '/TN', name, '/SC', 'ONCE', '/ST', '00:00', '/IT', '/TR', `wscript.exe //B //Nologo "${launcher}"`]);
    registered = true;
    task(['/Run', '/TN', name]);
    const startDeadline = Date.now() + startupMs;
    const runDeadline = Date.now() + RUN_TIMEOUT_MS;
    while (!existsSync(returned)) {
      if (!existsSync(started) && Date.now() >= startDeadline) throw new Error('Scheduled Resolve runner did not start in the logged-in Windows session');
      if (Date.now() >= runDeadline) throw new Error(`Scheduled Resolve runner did not finish within 30 minutes. Its result directory is ${directory}`);
      await sleep(200);
    }
    if (!existsSync(finished)) throw new Error(`Scheduled Resolve launcher exited without a report (exit ${readFileSync(returned, 'utf8').trim()})`);
    const result = JSON.parse(readFileSync(finished, 'utf8'));
    if (result.error || !Number.isInteger(result.status)) throw new Error(result.error || 'Scheduled Resolve runner exited without a status');
    return result;
  } finally {
    try {
      if (registered) task(['/Delete', '/TN', name, '/F']);
    } finally {
      if (!existsSync(started) || existsSync(returned)) rmSync(directory, { recursive: true, force: true });
    }
  }
}

function runWorker(directory) {
  const { entry, args, cwd } = JSON.parse(readFileSync(path.join(directory, 'request.json'), 'utf8'));
  writeFileSync(path.join(directory, 'started'), '');
  const { stdout, stderr, status, error } = spawnSync(process.execPath, [entry, ...args], {
    cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  writeFileSync(path.join(directory, 'result.tmp'), JSON.stringify({ stdout, stderr, status, error: error?.message }));
  renameSync(path.join(directory, 'result.tmp'), path.join(directory, 'result.json'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === WORKER) runWorker(process.argv[2]);

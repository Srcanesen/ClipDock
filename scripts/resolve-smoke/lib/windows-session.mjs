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

function killWorkerTree(pid) {
  return spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true, stdio: 'ignore', timeout: 5000,
  }).status === 0;
}

function readWorkerPid(started) {
  try {
    const marker = readFileSync(started, 'utf8');
    const pid = Number(marker);
    return /^[1-9][0-9]*$/.test(marker) && pid <= 0xffffffff ? pid : null;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

function canRemoveDirectory(started, finished, returned, workerStopped) {
  return workerStopped || existsSync(returned) || existsSync(finished) || !existsSync(started);
}

// Schedule the entire runner so Node owns the Resolve child and scripting
// clients run in the same Windows session.
export async function runInWindowsSession(entry, args, {
  task = taskCommand, killTree = killWorkerTree, startupMs = START_TIMEOUT_MS, runMs = RUN_TIMEOUT_MS,
} = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'clipdock-resolve-task-'));
  const name = `ClipDock-Resolve-${randomUUID()}`;
  const launcher = path.join(directory, 'launch.js');
  const started = path.join(directory, 'started');
  const finished = path.join(directory, 'result.json');
  const returned = path.join(directory, 'launcher-exit');
  const cancelled = path.join(directory, 'cancelled');
  let registered = false;
  let workerStopped = false;
  let attemptedPid = null;
  const stopWorker = () => {
    if (existsSync(finished) || existsSync(returned)) return;
    const pid = readWorkerPid(started);
    if (!pid || pid === attemptedPid) return;
    attemptedPid = pid;
    workerStopped = killTree(pid);
  };
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
    const runDeadline = Date.now() + runMs;
    while (!existsSync(returned)) {
      if (!existsSync(started) && Date.now() >= startDeadline) throw new Error('Scheduled Resolve runner did not start in the logged-in Windows session');
      if (Date.now() >= runDeadline) throw new Error(`Scheduled Resolve runner did not finish within ${runMs} ms`);
      await sleep(200);
    }
    if (!existsSync(finished)) throw new Error(`Scheduled Resolve launcher exited without a report (exit ${readFileSync(returned, 'utf8').trim()})`);
    const result = JSON.parse(readFileSync(finished, 'utf8'));
    if (result.error || !Number.isInteger(result.status)) throw new Error(result.error || 'Scheduled Resolve runner exited without a status');
    return result;
  } finally {
    try {
      if (registered) {
        const unfinished = !existsSync(returned);
        try {
          if (unfinished) {
            writeFileSync(cancelled, '');
            // Stop the tree before ending the launcher, which may release the worker PID.
            try {
              stopWorker();
            } finally {
              try { task(['/End', '/TN', name]); }
              catch { /* The task may have exited or never started. */ }
              stopWorker();
            }
          }
        } finally {
          try {
            task(['/Delete', '/TN', name, '/F']);
          } finally {
            if (unfinished) stopWorker();
          }
        }
        if (!canRemoveDirectory(started, finished, returned, workerStopped)) {
          throw new Error(`Scheduled Resolve worker cleanup could not be confirmed. Its result directory is ${directory}`);
        }
      }
    } finally {
      if (canRemoveDirectory(started, finished, returned, workerStopped)) rmSync(directory, { recursive: true, force: true });
    }
  }
}

function runWorker(directory) {
  const { entry, args, cwd } = JSON.parse(readFileSync(path.join(directory, 'request.json'), 'utf8'));
  writeFileSync(path.join(directory, 'started.tmp'), String(process.pid));
  renameSync(path.join(directory, 'started.tmp'), path.join(directory, 'started'));
  if (existsSync(path.join(directory, 'cancelled'))) return;
  const { stdout, stderr, status, error } = spawnSync(process.execPath, [entry, ...args], {
    cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  writeFileSync(path.join(directory, 'result.tmp'), JSON.stringify({ stdout, stderr, status, error: error?.message }));
  renameSync(path.join(directory, 'result.tmp'), path.join(directory, 'result.json'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === WORKER) runWorker(process.argv[2]);

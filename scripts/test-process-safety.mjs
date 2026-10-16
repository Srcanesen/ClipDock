// Loaded before every npm test worker. Only real detached children spawned by
// this worker may receive process-group signals; fake child PIDs never may.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const groups = new Set();
const violations = [];
const spawn = childProcess.spawn;
childProcess.spawn = function (...args) {
  const child = spawn.apply(this, args);
  const options = Array.isArray(args[1]) ? args[2] : args[1];
  if (options?.detached && Number.isInteger(child.pid) && child.pid > 0) groups.add(child.pid);
  return child;
};
syncBuiltinESMExports();

const kill = process.kill;
process.kill = function (pid, signal) {
  if (pid <= 0 && !groups.has(-pid)) {
    const message = `Blocked unowned process-group signal: ${pid} ${signal ?? 'SIGTERM'}`;
    violations.push(message);
    throw Object.assign(new Error(message), { code: 'UNOWNED_PROCESS_GROUP' });
  }
  return kill.call(this, pid, signal);
};
syncBuiltinESMExports();
// Application cleanup can catch a signalling error. Still fail the test worker.
process.on('exit', () => {
  if (violations.length) {
    process.stderr.write(`${violations.join('\n')}\n`);
    process.exitCode = 1;
  }
});

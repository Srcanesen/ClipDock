import { execFileSync } from 'node:child_process';

let executable;

export function pythonExecutablePath() {
  const [command, ...args] = process.platform === 'win32' ? ['py', '-3'] : ['python3'];
  return executable ??= execFileSync(command, [...args, '-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8', timeout: 5000, windowsHide: true,
  }).trim();
}

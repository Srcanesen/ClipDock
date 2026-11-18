import { execFileSync } from 'node:child_process';

let executable;

export function testPython() {
  if (process.platform !== 'win32') return 'python3';
  return executable ??= execFileSync('py', ['-3', '-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8', timeout: 5000, windowsHide: true,
  }).trim();
}

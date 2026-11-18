import { execFileSync } from 'node:child_process';

let executable;

// The bridge and probe APIs take an executable path. Resolve it through the
// Windows launcher so they can start Python directly with their own arguments.
export function testPython() {
  if (process.platform !== 'win32') return 'python3';
  return executable ??= execFileSync('py', ['-3', '-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8', timeout: 5000, windowsHide: true,
  }).trim();
}

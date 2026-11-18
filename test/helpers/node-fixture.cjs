const childProcess = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const windows = process.platform === 'win32';
const fixtureName = name => windows ? `${name}.exe` : name;

function writeNodeFixture(directory, name, body) {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, fixtureName(name));
  writeFileSync(file, windows ? body : `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return file;
}

function spawnNodeFixture(file, args, options) {
  return windows
    ? childProcess.spawn(process.execPath, [file, ...args], { ...options, windowsHide: true })
    : childProcess.spawn(file, args, options);
}

function writeVersionFixture(file, identity) {
  return writeNodeFixture(path.dirname(file), path.basename(file),
    `if (process.argv[2] !== '-version') process.exit(1); console.log(${JSON.stringify(`${identity} version 99.0 fixture`)});`);
}

// Windows cannot execute a shebang. Forward only this test's fixture commands
// to Node, leaving production argv and probe timeouts intact.
function fixtureProbeSpawn(root) {
  const { spawnSync } = childProcess;
  return (file, args, options) => {
    const relative = path.relative(root, file);
    if (relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative) && path.extname(file) === '.exe') {
      return spawnSync(process.execPath, [file, ...args], { ...options, windowsHide: true });
    }
    return spawnSync(file, args, options);
  };
}

function redirectFixtureProbes(t, root) {
  if (windows) t.mock.method(childProcess, 'spawnSync', fixtureProbeSpawn(root));
}

module.exports = { fixtureName, writeNodeFixture, spawnNodeFixture, writeVersionFixture, fixtureProbeSpawn, redirectFixtureProbes };

import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fsPromises from 'node:fs/promises';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {mock, test} from 'node:test';

import {
  MacKeychainPexelsCredentialStore,
  PEXELS_KEYCHAIN_ACCOUNT,
  PEXELS_KEYCHAIN_SERVICE,
  PexelsCredentialStore,
} from '../dist/pexels-credential.js';

const TEST_KEY = 'test_key_12345678901234567890';
const OLD_KEY = 'old_key_12345678901234567890';
const WRONG_KEY = 'wrong_key_12345678901234567890';
const INVALID_KEY = 'not-valid';
const SAVE_ERROR = 'Could not save the Pexels credential securely.';

function tempRoot(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

async function withTempRoot(prefix, callback) {
  const root = tempRoot(prefix);
  try {
    return await callback(root);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
}

function fakeSafeStorage(overrides = {}) {
  const mask = 0x5a;
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value, 'utf8').map(byte => byte ^ mask),
    decryptString: value => Buffer.from(value).map(byte => byte ^ mask).toString('utf8'),
    ...overrides,
  };
}

function fakeChildProcess() {
  const process = new EventEmitter();
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.stdin = new EventEmitter();
  process.stdin.chunks = [];
  process.kills = [];
  process.stdin.write = chunk => {
    process.stdin.chunks.push(String(chunk));
    return true;
  };
  process.stdin.end = chunk => {
    if (chunk !== undefined) process.stdin.chunks.push(String(chunk));
  };
  process.kill = signal => {
    process.kills.push(signal);
    return true;
  };
  return process;
}

function emitChunks(stream, value) {
  for (const chunk of (Array.isArray(value) ? value : [value])) {
    if (chunk !== undefined && chunk !== '') stream.emit('data', chunk);
  }
}

function closeChild(stdout = '', code = 0, stderr = '') {
  return process => {
    emitChunks(process.stdout, stdout);
    emitChunks(process.stderr, stderr);
    process.emit('close', code);
  };
}

function scriptedSpawn(runs, calls = []) {
  return (command, args, options) => {
    const process = fakeChildProcess();
    calls.push({command, args: [...args], options, process});
    const run = runs.shift();
    if (typeof run === 'function') queueMicrotask(() => run(process));
    return process;
  };
}

function keychainAddInput(key) {
  return `add-generic-password -U -s ${PEXELS_KEYCHAIN_SERVICE} -a ${PEXELS_KEYCHAIN_ACCOUNT} -w ${key}\n`;
}

function assertNoFileTemp(file) {
  assert.equal(existsSync(`${file}.${process.pid}.tmp`), false);
}

function assertNoKeyInArguments(calls, key) {
  assert.equal(calls.some(({args}) => args.includes(key)), false);
}

test('file store saves and loads private ciphertext atomically', async () => {
  await withTempRoot('clipdock-pexels-credential-save-', async root => {
    const file = path.join(root, 'userData', 'pexels-credential.json');
    const store = new PexelsCredentialStore(file, fakeSafeStorage());

    assert.equal(await store.save(TEST_KEY), true);
    const disk = readFileSync(file, 'utf8');
    const blob = JSON.parse(disk);
    assert.equal(blob.version, 1);
    assert.equal(typeof blob.ciphertext, 'string');
    assert.equal(disk.includes(TEST_KEY), false);
    assert.notEqual(blob.ciphertext, Buffer.from(TEST_KEY, 'utf8').toString('base64'));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
    assertNoFileTemp(file);
    assert.deepEqual(await store.load(), {key: TEST_KEY, message: 'Connected · saved securely'});
  });
});

test('file store discards corrupt and unreadable blobs with fixed messages', async () => {
  await withTempRoot('clipdock-pexels-credential-corrupt-', async root => {
    const file = path.join(root, 'credential.json');
    const cases = [
      {encoded: '{bad', storage: fakeSafeStorage()},
      {encoded: JSON.stringify({version: 1, ciphertext: 'AQ=='}), storage: fakeSafeStorage({decryptString: () => { throw new Error('controlled decrypt failure'); }})},
    ];

    for (const {encoded, storage} of cases) {
      writeFileSync(file, encoded, {encoding: 'utf8', mode: 0o600});
      const result = await new PexelsCredentialStore(file, storage).load();
      assert.deepEqual(result, {key: null, message: 'Disconnected. Saved credential was unreadable and removed.'});
      assert.equal(existsSync(file), false);
      assertNoFileTemp(file);
    }
  });
});

test('file store discards an invalid decrypted key and removes its blob', async () => {
  await withTempRoot('clipdock-pexels-credential-invalid-', async root => {
    const file = path.join(root, 'credential.json');
    const store = new PexelsCredentialStore(file, fakeSafeStorage());

    assert.equal(await store.save(INVALID_KEY), true);
    assert.deepEqual(await store.load(), {key: null, message: 'Disconnected. Saved credential was invalid and removed.'});
    assert.equal(existsSync(file), false);
    assertNoFileTemp(file);
  });
});

test('file store preserves the prior file when atomic rename fails and cleans its temp', async () => {
  await withTempRoot('clipdock-pexels-credential-atomic-failure-', async root => {
    const file = path.join(root, 'credential.json');
    const store = new PexelsCredentialStore(file, fakeSafeStorage());
    assert.equal(await store.save(OLD_KEY), true);
    const prior = readFileSync(file, 'utf8');
    const renameMock = mock.method(fsPromises, 'rename', async () => {
      throw new Error('controlled rename failure');
    });
    try {
      await assert.rejects(() => store.save(TEST_KEY), /controlled rename failure/);
    } finally {
      renameMock.mock.restore();
    }
    assert.equal(readFileSync(file, 'utf8'), prior);
    assertNoFileTemp(file);
  });
});

test('Keychain save/load uses fake child streams, fixed commands, and no argv key', async () => {
  await withTempRoot('clipdock-pexels-keychain-roundtrip-', async root => {
    const lockPath = path.join(root, 'keychain.lock');
    const saveCalls = [];
    const saveStore = new MacKeychainPexelsCredentialStore(scriptedSpawn([
      closeChild('', 44),
      closeChild(''),
      closeChild(`${TEST_KEY}\n`),
    ], saveCalls), lockPath);

    assert.equal(await saveStore.save(TEST_KEY), true);
    assert.equal(saveCalls[0].command, '/usr/bin/security');
    assert.equal(saveCalls[0].options.shell, false);
    assert.deepEqual(saveCalls.map(({args}) => args[0]), ['find-generic-password', '-i', 'find-generic-password']);
    assert.deepEqual(saveCalls[1].args, ['-i']);
    assert.equal(saveCalls[1].process.stdin.chunks.join(''), keychainAddInput(TEST_KEY));
    assertNoKeyInArguments(saveCalls, TEST_KEY);
    assert.equal(existsSync(lockPath), false);

    const loadCalls = [];
    const loaded = await new MacKeychainPexelsCredentialStore(scriptedSpawn([
      closeChild(`${TEST_KEY}\n`),
    ], loadCalls), lockPath).load();
    assert.deepEqual(loaded, {key: TEST_KEY, message: 'Connected · saved securely'});
    assert.deepEqual(loadCalls[0].args, ['find-generic-password', '-s', PEXELS_KEYCHAIN_SERVICE, '-a', PEXELS_KEYCHAIN_ACCOUNT, '-w']);
    assertNoKeyInArguments(loadCalls, TEST_KEY);
    assert.equal(existsSync(lockPath), false);
  });
});

test('Keychain timeout kills the child and returns a sanitized load result', async () => {
  await withTempRoot('clipdock-pexels-keychain-timeout-', async root => {
    const lockPath = path.join(root, 'keychain.lock');
    const calls = [];
    const store = new MacKeychainPexelsCredentialStore(scriptedSpawn([
      process => process.stderr.emit('data', `${TEST_KEY} /private/client/login.keychain`),
    ], calls), lockPath);
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback, _delay, ...args) => realSetTimeout(callback, 1, ...args);
    let result;
    try {
      result = await store.load();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    assert.deepEqual(result, {key: null, message: 'Disconnected. Saved credential could not be read.'});
    assert.deepEqual(calls[0].process.kills, ['SIGKILL']);
    assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
    assert.equal(JSON.stringify(result).includes('/private/'), false);
    assert.equal(existsSync(lockPath), false);
  });
});

test('Keychain mismatch with no prior value rolls back by deleting the candidate', async () => {
  await withTempRoot('clipdock-pexels-keychain-rollback-empty-', async root => {
    const lockPath = path.join(root, 'keychain.lock');
    const calls = [];
    const store = new MacKeychainPexelsCredentialStore(scriptedSpawn([
      closeChild('', 44),
      closeChild(''),
      closeChild(`${WRONG_KEY}\n`),
      closeChild('', 44),
    ], calls), lockPath);

    await assert.rejects(() => store.save(TEST_KEY), {message: SAVE_ERROR});
    assert.deepEqual(calls.map(({args}) => args[0]), ['find-generic-password', '-i', 'find-generic-password', 'delete-generic-password']);
    assert.equal(calls[1].process.stdin.chunks.join(''), keychainAddInput(TEST_KEY));
    assertNoKeyInArguments(calls, TEST_KEY);
    assert.equal(existsSync(lockPath), false);
  });
});

test('Keychain mismatch with a prior value restores and verifies that prior value', async () => {
  await withTempRoot('clipdock-pexels-keychain-rollback-prior-', async root => {
    const lockPath = path.join(root, 'keychain.lock');
    const calls = [];
    const store = new MacKeychainPexelsCredentialStore(scriptedSpawn([
      closeChild(`${OLD_KEY}\n`),
      closeChild(''),
      closeChild(`${WRONG_KEY}\n`),
      closeChild(''),
      closeChild(`${OLD_KEY}\n`),
    ], calls), lockPath);

    await assert.rejects(() => store.save(TEST_KEY), {message: SAVE_ERROR});
    assert.deepEqual(calls.map(({args}) => args[0]), ['find-generic-password', '-i', 'find-generic-password', '-i', 'find-generic-password']);
    assert.deepEqual(calls.slice(1).filter(({args}) => args[0] === '-i').map(({process}) => process.stdin.chunks.join('')), [keychainAddInput(TEST_KEY), keychainAddInput(OLD_KEY)]);
    assertNoKeyInArguments(calls, TEST_KEY);
    assertNoKeyInArguments(calls, OLD_KEY);
    assert.equal(existsSync(lockPath), false);
  });
});

test('Keychain reclaims a stale dead-owner lock and cleans its replacement lock', async () => {
  await withTempRoot('clipdock-pexels-keychain-stale-', async root => {
    const lockPath = path.join(root, 'keychain.lock');
    const staleWhen = new Date(Date.now() - 120_000);
    writeFileSync(lockPath, JSON.stringify({pid: 999_999_999, token: 'dead-owner-token', createdAt: staleWhen.getTime()}), {encoding: 'utf8', mode: 0o600});
    utimesSync(lockPath, staleWhen, staleWhen);
    const calls = [];
    const store = new MacKeychainPexelsCredentialStore(scriptedSpawn([
      closeChild('', 44),
      closeChild(''),
      closeChild(`${TEST_KEY}\n`),
    ], calls), lockPath);

    assert.equal(await store.save(TEST_KEY), true);
    assert.equal(calls.length, 3);
    assert.equal(existsSync(lockPath), false);
    assert.equal(statSync(root).mode & 0o777, 0o700);
  });
});

test('Keychain refuses an active live-owner lock without invoking spawn', async () => {
  await withTempRoot('clipdock-pexels-keychain-active-', async root => {
    const lockPath = path.join(root, 'keychain.lock');
    const owner = {pid: process.pid, token: 'live-owner-token', createdAt: Date.now()};
    writeFileSync(lockPath, JSON.stringify(owner), {encoding: 'utf8', mode: 0o600});
    const calls = [];
    const store = new MacKeychainPexelsCredentialStore(scriptedSpawn([], calls), lockPath);
    const realDateNow = Date.now;
    const realSetTimeout = globalThis.setTimeout;
    let virtualNow = realDateNow();
    Date.now = () => virtualNow;
    globalThis.setTimeout = (callback, _delay, ...args) => {
      virtualNow += 120_000;
      callback(...args);
      return 0;
    };
    try {
      await assert.rejects(() => store.save(TEST_KEY), {message: SAVE_ERROR});
    } finally {
      Date.now = realDateNow;
      globalThis.setTimeout = realSetTimeout;
    }

    assert.equal(calls.length, 0);
    assert.equal(existsSync(lockPath), true);
    assert.equal(readFileSync(lockPath, 'utf8'), JSON.stringify(owner));
    assert.equal(readdirSync(root).includes('keychain.lock'), true);
  });
});

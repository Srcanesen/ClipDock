import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync, statSync, writeFileSync, rmSync, mkdtempSync, utimesSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
// VM values have another realm's prototypes. Compare their public JSON values.
const expect = (label, got, want) => assert.deepEqual(
  got === undefined ? got : JSON.parse(JSON.stringify(got)),
  want === undefined ? want : JSON.parse(JSON.stringify(want)), label);

const fail = (message) => assert.fail(message);

test('credential persistence and isolated Keychain transactions', async (t) => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'clipdock-checks-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const fixtureDir = () => fixtureRoot;
  const pexelsJs = path.join(dist, 'pexels.js');
  const { PexelsClient, parsePexelsPage, safePexelsExternal, safePexelsUrl } = createRequire(import.meta.url)(pexelsJs);
  const caseClients = new Set();
  const createPexelsClient = (...args) => {
    const client = new PexelsClient(...args);
    caseClients.add(client);
    return client;
  };
  const realFetch = globalThis.fetch;
  const TEST_KEY = 'test_key_12345678901234567890';
  const OLD_KEY = 'old_key_12345678901234567890';
  const encoder = new TextEncoder();
  const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const bodyResponse = (chunks, mime, headers = {}, status = 200) => new Response(new ReadableStream({
    pull(controller) { const chunk = chunks.shift(); if (chunk) controller.enqueue(chunk); else controller.close(); },
  }), { status, headers: { 'content-type': mime, ...headers } });
  const expectReject = async (promise, pattern) => {
    try { await promise; throw new Error('expected rejection'); }
    catch (error) { if (!pattern.test(error.message)) throw error; return error.message; }
  };
  const pexelsTest = async (name, run) => t.test(name, async (caseTest) => {
    caseTest.after(() => {
      globalThis.fetch = realFetch;
      for (const client of caseClients) client.dispose();
      caseClients.clear();
    });
    await run();
  });
  const { PexelsCredentialStore, MacKeychainPexelsCredentialStore, PEXELS_KEYCHAIN_SERVICE, PEXELS_KEYCHAIN_ACCOUNT } = await import(path.join(dist, 'pexels-credential.js'));
  const keychainProcess = () => {
    const proc = new EventEmitter(); proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.stdin = new EventEmitter(); proc.stdin.chunks = []; proc.kills = [];
    proc.stdin.write = (chunk) => { proc.stdin.chunks.push(String(chunk)); };
    proc.stdin.end = (chunk) => { if (chunk !== undefined) proc.stdin.chunks.push(String(chunk)); };
    proc.kill = (signal) => { proc.kills.push(signal); return true; };
    return proc;
  };
  const keychainSpawn = (runs, calls = []) => (command, args, options) => {
    const proc = keychainProcess(); calls.push({ command, args: [...args], options, proc });
    const run = runs.shift(); if (run) queueMicrotask(() => run(proc));
    return proc;
  };
  const emitKeychainChunks = (stream, value) => {
    for (const chunk of (Array.isArray(value) ? value : [value])) if (chunk !== undefined && chunk !== '') stream.emit('data', chunk);
  };
  const keychainClose = (stdout = '', code = 0, stderr = '') => (proc) => {
    emitKeychainChunks(proc.stdout, stdout);
    emitKeychainChunks(proc.stderr, stderr);
    proc.emit('close', code);
  };
  const keychainAddInput = (key) => `add-generic-password -U -s ${PEXELS_KEYCHAIN_SERVICE} -a ${PEXELS_KEYCHAIN_ACCOUNT} -w ${key}\n`;
  const flushMicrotasks = async (count = 12) => { for (let i = 0; i < count; i += 1) await Promise.resolve(); };
  const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
  const noCredentialIn = (values, secrets) => !secrets.some((secret) => values.some((value) => String(value).includes(secret)));

  const overlappingSaveBackend = (oldKey, aKey, bKey) => {
    const state = { key: oldKey, bVerified: false };
    let aFinds = 0; let releaseAReadback;
    let resolveAWrite; let resolveAReadback; let resolveBVerified;
    const aWrite = new Promise((resolve) => { resolveAWrite = resolve; });
    const aReadbackBlocked = new Promise((resolve) => { resolveAReadback = resolve; });
    const bVerified = new Promise((resolve) => { resolveBVerified = resolve; });
    const aReadbackGate = new Promise((resolve) => { releaseAReadback = resolve; });
    const spawn = (owner, calls = []) => (command, args, options) => {
      const proc = keychainProcess(); calls.push({ owner, command, args: [...args], options, proc });
      queueMicrotask(async () => {
        if (args[0] === '-i') {
          const key = proc.stdin.chunks.join('').match(/-w ([A-Za-z0-9_-]+)\n$/)?.[1];
          if (!key) throw new Error('modeled Keychain write was missing its stdin key');
          state.key = key;
          if (owner === 'A' && key === aKey) resolveAWrite();
          keychainClose('')(proc);
          return;
        }
        if (args[0] === 'delete-generic-password') { state.key = null; keychainClose('')(proc); return; }
        if (args[0] !== 'find-generic-password') { keychainClose('', 1)(proc); return; }
        if (owner === 'A') {
          aFinds += 1;
          if (aFinds === 2) {
            resolveAReadback();
            await aReadbackGate;
            const observed = state.key === bKey ? bKey : oldKey;
            keychainClose(`${observed}\n`)(proc);
            return;
          }
        }
        const observed = state.key;
        if (owner === 'B' && observed === bKey) { state.bVerified = true; resolveBVerified(); }
        keychainClose(observed === null ? '' : `${observed}\n`, observed === null ? 44 : 0)(proc);
      });
      return proc;
    };
    return { state, aWrite, aReadbackBlocked, bVerified, releaseAReadback: () => releaseAReadback() , spawn };
  };

  const saveClearBackend = (initialKey, saveKey, { gateSaveReadback = false, gateClearDelete = false } = {}) => {
    const state = { key: initialKey, saveVerified: false };
    let saveFinds = 0; let releaseSaveReadback; let releaseClearDelete;
    let resolveSaveReadback; let resolveClearStarted; let resolveClearDone; let resolveSaveVerified;
    const saveReadbackBlocked = new Promise((resolve) => { resolveSaveReadback = resolve; });
    const clearStarted = new Promise((resolve) => { resolveClearStarted = resolve; });
    const clearDone = new Promise((resolve) => { resolveClearDone = resolve; });
    const saveVerified = new Promise((resolve) => { resolveSaveVerified = resolve; });
    const saveReadbackGate = new Promise((resolve) => { releaseSaveReadback = resolve; });
    const clearDeleteGate = new Promise((resolve) => { releaseClearDelete = resolve; });
    const spawn = (owner, calls = []) => (command, args, options) => {
      const proc = keychainProcess(); calls.push({ owner, command, args: [...args], options, proc });
      queueMicrotask(async () => {
        if (args[0] === '-i') {
          const key = proc.stdin.chunks.join('').match(/-w ([A-Za-z0-9_-]+)\n$/)?.[1];
          if (!key) throw new Error('modeled Keychain write was missing its stdin key');
          state.key = key; keychainClose('')(proc); return;
        }
        if (args[0] === 'delete-generic-password') {
          resolveClearStarted();
          if (gateClearDelete) await clearDeleteGate;
          state.key = null; resolveClearDone(); keychainClose('')(proc); return;
        }
        if (args[0] !== 'find-generic-password') { keychainClose('', 1)(proc); return; }
        if (owner === 'save') {
          saveFinds += 1;
          if (saveFinds === 2 && gateSaveReadback) { resolveSaveReadback(); await saveReadbackGate; }
        }
        const observed = state.key;
        if (owner === 'save' && saveFinds === 2 && observed === saveKey) { state.saveVerified = true; resolveSaveVerified(); }
        keychainClose(observed === null ? '' : `${observed}\n`, observed === null ? 44 : 0)(proc);
      });
      return proc;
    };
    return { state, saveReadbackBlocked, clearStarted, clearDone, saveVerified, releaseSaveReadback: () => releaseSaveReadback(), releaseClearDelete: () => releaseClearDelete(), spawn };
  };

  await pexelsTest('macOS Keychain overlapping saves serialize rollback and preserve the reported winner', async () => {
    const lockRoot = mkdtempSync(path.join(fixtureDir(), 'clipdock-pexels-lock-overlap-')); const lockPath = path.join(lockRoot, 'keychain.lock');
    const A_KEY = 'a_key_12345678901234567890'; const B_KEY = 'b_key_12345678901234567890'; const secrets = [OLD_KEY, A_KEY, B_KEY];
    const backend = overlappingSaveBackend(OLD_KEY, A_KEY, B_KEY); const aCalls = []; const bCalls = [];
    const storeA = new MacKeychainPexelsCredentialStore(backend.spawn('A', aCalls), lockPath); const storeB = new MacKeychainPexelsCredentialStore(backend.spawn('B', bCalls), lockPath);
    let aSave; let bSave;
    try {
      aSave = storeA.save(A_KEY); await backend.aWrite; await backend.aReadbackBlocked;
      bSave = storeB.save(B_KEY); const bRanBeforeAReleased = await Promise.race([backend.bVerified.then(() => true), nextTurn().then(() => false)]);
      if (!existsSync(lockPath)) throw new Error('save transaction did not create its filesystem lock');
      const ownerMetadata = readFileSync(lockPath, 'utf8');
      if (secrets.some((secret) => ownerMetadata.includes(secret)) || (statSync(lockRoot).mode & 0o777) !== 0o700 || (statSync(lockPath).mode & 0o077) !== 0 || !noCredentialIn([lockPath], secrets) || bRanBeforeAReleased) throw new Error('Keychain lock metadata/path exposed a credential or allowed overlap');
      backend.releaseAReadback();
      const aMessage = await expectReject(aSave, /^Could not save the Pexels credential securely\.$/);
      if (await bSave !== true || backend.state.key !== B_KEY || !noCredentialIn(aCalls.concat(bCalls).map(({ args }) => JSON.stringify(args)), secrets) || aMessage.includes(OLD_KEY) || aMessage.includes(B_KEY)) throw new Error('overlapping save rollback destroyed the successful serialized save');
    } finally {
      backend.releaseAReadback();
      await Promise.allSettled([aSave, bSave].filter(Boolean));
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });

  await pexelsTest('macOS Keychain save and clear serialize in both completion orders', async () => {
    const SAVE_KEY = 'save_key_12345678901234567890'; const checkSecrets = [OLD_KEY, SAVE_KEY];
    const firstRoot = mkdtempSync(path.join(fixtureDir(), 'clipdock-pexels-lock-save-clear-')); const firstPath = path.join(firstRoot, 'keychain.lock');
    const firstBackend = saveClearBackend(null, SAVE_KEY, { gateSaveReadback: true }); const firstSaveCalls = []; const firstClearCalls = [];
    const firstSave = new MacKeychainPexelsCredentialStore(firstBackend.spawn('save', firstSaveCalls), firstPath); const firstClear = new MacKeychainPexelsCredentialStore(firstBackend.spawn('clear', firstClearCalls), firstPath);
    let savePromise; let clearPromise;
    try {
      const completion = [];
      savePromise = firstSave.save(SAVE_KEY).then((value) => { completion.push('save'); return value; }, (error) => { completion.push('save-failed'); throw error; });
      await firstBackend.saveReadbackBlocked; clearPromise = firstClear.clear().then((value) => { completion.push('clear'); return value; });
      const clearFinishedBeforeSave = await Promise.race([firstBackend.clearDone.then(() => true), nextTurn().then(() => false)]); firstBackend.releaseSaveReadback();
      if (clearFinishedBeforeSave || await savePromise !== true || await clearPromise !== undefined || firstBackend.state.key !== null || JSON.stringify(completion) !== JSON.stringify(['save', 'clear']) || !noCredentialIn(firstSaveCalls.concat(firstClearCalls).map(({ args }) => JSON.stringify(args)), checkSecrets)) throw new Error('save/clear did not serialize save before clear');
    } finally {
      firstBackend.releaseSaveReadback(); await Promise.allSettled([savePromise, clearPromise].filter(Boolean)); rmSync(firstRoot, { recursive: true, force: true });
    }

    const secondRoot = mkdtempSync(path.join(fixtureDir(), 'clipdock-pexels-lock-clear-save-')); const secondPath = path.join(secondRoot, 'keychain.lock');
    const secondBackend = saveClearBackend(OLD_KEY, SAVE_KEY, { gateClearDelete: true }); const secondSaveCalls = []; const secondClearCalls = [];
    const secondSave = new MacKeychainPexelsCredentialStore(secondBackend.spawn('save', secondSaveCalls), secondPath); const secondClear = new MacKeychainPexelsCredentialStore(secondBackend.spawn('clear', secondClearCalls), secondPath);
    let reverseSave; let reverseClear;
    try {
      const completion = [];
      reverseClear = secondClear.clear().then((value) => { completion.push('clear'); return value; }); await secondBackend.clearStarted;
      reverseSave = secondSave.save(SAVE_KEY).then((value) => { completion.push('save'); return value; });
      const saveVerifiedBeforeClear = await Promise.race([secondBackend.saveVerified.then(() => true), nextTurn().then(() => false)]);
      secondBackend.releaseClearDelete();
      if (await reverseClear !== undefined || await reverseSave !== true || secondBackend.state.key !== SAVE_KEY || JSON.stringify(completion) !== JSON.stringify(['clear', 'save']) || saveVerifiedBeforeClear || !noCredentialIn(secondSaveCalls.concat(secondClearCalls).map(({ args }) => JSON.stringify(args)), checkSecrets)) throw new Error('clear/save did not serialize clear before save');
    } finally {
      secondBackend.releaseClearDelete(); await Promise.allSettled([reverseSave, reverseClear].filter(Boolean)); rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  await pexelsTest('macOS Keychain lock recovers stale owners and protects newer owner tokens', async () => {
    const STALE_KEY = 'stale_key_12345678901234567890'; const secrets = [OLD_KEY, STALE_KEY];
    const staleRoot = mkdtempSync(path.join(fixtureDir(), 'clipdock-pexels-lock-stale-')); const stalePath = path.join(staleRoot, 'keychain.lock'); const staleWhen = new Date(Date.now() - 120_000);
    writeFileSync(stalePath, JSON.stringify({ pid: 99_999_999, token: 'stale-owner-token', createdAt: staleWhen.getTime() }), { encoding: 'utf8', mode: 0o600 }); utimesSync(stalePath, staleWhen, staleWhen);
    const staleBackend = saveClearBackend(null, STALE_KEY); const staleCalls = []; const staleStore = new MacKeychainPexelsCredentialStore(staleBackend.spawn('save', staleCalls), stalePath);
    try {
      if (!await staleStore.save(STALE_KEY) || existsSync(stalePath) || !noCredentialIn([stalePath, JSON.stringify({ pid: 99_999_999, token: 'stale-owner-token' })], secrets)) throw new Error('stale Keychain lock was not safely recovered');
    } finally { rmSync(staleRoot, { recursive: true, force: true }); }

    const ownerRoot = mkdtempSync(path.join(fixtureDir(), 'clipdock-pexels-lock-owner-')); const ownerPath = path.join(ownerRoot, 'keychain.lock');
    const ownerBackend = saveClearBackend(null, STALE_KEY, { gateSaveReadback: true }); const ownerCalls = []; const ownerStore = new MacKeychainPexelsCredentialStore(ownerBackend.spawn('save', ownerCalls), ownerPath);
    let ownerSave;
    try {
      ownerSave = ownerStore.save(STALE_KEY); await ownerBackend.saveReadbackBlocked;
      const newerOwner = JSON.stringify({ pid: process.pid, token: 'new-owner-token', createdAt: Date.now() });
      rmSync(ownerPath, { force: true }); writeFileSync(ownerPath, newerOwner, { encoding: 'utf8', mode: 0o600 });
      ownerBackend.releaseSaveReadback();
      if (await ownerSave !== true || !existsSync(ownerPath) || readFileSync(ownerPath, 'utf8') !== newerOwner || secrets.some((secret) => readFileSync(ownerPath, 'utf8').includes(secret)) || !noCredentialIn([ownerPath, newerOwner], secrets)) throw new Error('stale owner released a newer lock or exposed a credential');
    } finally {
      ownerBackend.releaseSaveReadback(); await Promise.allSettled([ownerSave].filter(Boolean)); rmSync(ownerRoot, { recursive: true, force: true });
    }
  });

  const credentialCheckRoot = mkdtempSync(path.join(tmpdir(), 'clipdock-verify-keychain-'));
  const credentialCheckLock = path.join(credentialCheckRoot, 'keychain.lock');
  const fakeCredentialStore = (spawn) => new MacKeychainPexelsCredentialStore(spawn, credentialCheckLock);
  try {
  await pexelsTest('macOS Keychain credential persistence keeps the key out of argv and uses bounded child commands', async () => {
    const calls = []; const store = fakeCredentialStore(keychainSpawn([keychainClose('', 44), keychainClose(''), keychainClose(`${TEST_KEY}\n`)], calls));
    if (!await store.save(TEST_KEY)) throw new Error('Keychain credential was not saved');
    const save = calls[1]; const args = save.args.join(' ');
    if (calls.length !== 3 || save.command !== '/usr/bin/security' || save.options.shell !== false || JSON.stringify(save.args) !== JSON.stringify(['-i']) || args.includes(TEST_KEY) || save.proc.stdin.chunks.join('') !== keychainAddInput(TEST_KEY)) throw new Error('Keychain save leaked the key or used unsafe security arguments');
    const loadCalls = []; const loaded = fakeCredentialStore(keychainSpawn([keychainClose(`${TEST_KEY}\n`)], loadCalls));
    const result = await loaded.load();
    if (result.key !== TEST_KEY || loadCalls[0].args[0] !== 'find-generic-password' || loadCalls[0].args.at(-1) !== '-w' || JSON.stringify(loadCalls[0].args).includes(TEST_KEY) || loadCalls[0].args.includes(PEXELS_KEYCHAIN_SERVICE) === false || loadCalls[0].args.includes(PEXELS_KEYCHAIN_ACCOUNT) === false) throw new Error('Keychain load did not use the fixed find command or returned the wrong credential');
  });
  await pexelsTest('macOS Keychain rejects exit-zero writes without exact read-back and compensates', async () => {
    for (const readback of ['', `${OLD_KEY}\n`]) {
      const calls = []; const store = fakeCredentialStore(keychainSpawn([keychainClose('', 44), keychainClose(''), keychainClose(readback), keychainClose('', 44)], calls));
      const message = await expectReject(store.save(TEST_KEY), /^Could not save the Pexels credential securely\.$/);
      const args = calls.map(({ args: commandArgs }) => commandArgs.join(' ')).join('\n');
      if (calls.length !== 4 || JSON.stringify(calls[1].args) !== JSON.stringify(['-i']) || calls[1].proc.stdin.chunks.join('') !== keychainAddInput(TEST_KEY) || calls[2].args[0] !== 'find-generic-password' || calls[3].args[0] !== 'delete-generic-password' || args.includes(TEST_KEY) || JSON.stringify({ message }).includes(TEST_KEY)) throw new Error('exit-zero Keychain write was accepted without an exact read-back or safe cleanup');
    }
  });
  await pexelsTest('macOS Keychain bounds multibyte string output by UTF-8 bytes', async () => {
    const calls = []; const oversized = '\u3000'.repeat(3000) + TEST_KEY; const store = fakeCredentialStore(keychainSpawn([keychainClose(oversized), keychainClose('')], calls));
    const result = await store.load();
    if (result.key !== null || result.message !== 'Disconnected. Saved credential was invalid and removed.' || calls.length !== 2) throw new Error('multibyte string output exceeded the Keychain byte cap');
  });
  await pexelsTest('macOS Keychain decodes split Buffer output only after applying the byte cap', async () => {
    const keyBytes = Buffer.from(TEST_KEY); const whitespace = Buffer.from('\u3000'.repeat((8 * 1024 - keyBytes.byteLength) / 3));
    const chunks = [Buffer.concat([keyBytes, whitespace.subarray(0, 1)]), Buffer.concat([whitespace.subarray(1), Buffer.from('\u3000')])];
    const calls = []; const store = fakeCredentialStore(keychainSpawn([keychainClose(chunks)], calls)); const result = await store.load();
    if (Buffer.concat(chunks).byteLength <= 8 * 1024 || result.key !== TEST_KEY || calls.length !== 1) throw new Error('split UTF-8 Buffer output was decoded or retained incorrectly');
  });
  await pexelsTest('macOS Keychain stdin EPIPE is sanitized, kills once, and attempts no-prior cleanup', async () => {
    const calls = []; const asyncEpipe = (proc) => {
      proc.stderr.emit('data', `${TEST_KEY} /private/client/login.keychain`);
      queueMicrotask(() => {
        proc.stdin.emit('error', new Error(`EPIPE ${TEST_KEY}`));
        if (proc.kills.length !== 1) throw new Error('stdin failure did not kill the child');
        proc.emit('close', 1);
        proc.stdin.emit('error', new Error(`late EPIPE ${TEST_KEY}`));
        proc.emit('close', 0);
      });
    };
    const store = fakeCredentialStore(keychainSpawn([keychainClose('', 44), asyncEpipe, keychainClose('', 44)], calls));
    const message = await expectReject(store.save(TEST_KEY), /^Could not save the Pexels credential securely\.$/);
    const args = calls.map(({ args: commandArgs }) => commandArgs.join(' ')).join('\n');
    if (message !== 'Could not save the Pexels credential securely.' || calls.length !== 3 || calls[1].proc.kills.length !== 1 || args.includes(TEST_KEY) || message.includes(TEST_KEY)) throw new Error('stdin EPIPE was exposed, settled twice, or skipped candidate cleanup');
  });
  await pexelsTest('macOS Keychain refuses replacement when the prior lookup fails', async () => {
    const calls = []; const secretError = `${TEST_KEY} /private/client/login.keychain`; const store = fakeCredentialStore(keychainSpawn([keychainClose('', 1, secretError)], calls));
    const message = await expectReject(store.save(TEST_KEY), /^Could not save the Pexels credential securely\.$/);
    const args = JSON.stringify(calls.map(({ args: commandArgs }) => commandArgs));
    if (calls.length !== 1 || args.includes(TEST_KEY) || message.includes(TEST_KEY) || message.includes('/private/')) throw new Error('prior Keychain lookup failure was not fail-closed');
  });
  await pexelsTest('macOS Keychain discards an invalid prior before replacement', async () => {
    const calls = []; const store = fakeCredentialStore(keychainSpawn([keychainClose('not-valid\n'), keychainClose(''), keychainClose(''), keychainClose(`${TEST_KEY}\n`)], calls));
    if (!await store.save(TEST_KEY)) throw new Error('replacement after invalid prior was not saved');
    const args = calls.map(({ args: commandArgs }) => commandArgs[0]).join(',');
    if (calls.length !== 4 || args !== 'find-generic-password,delete-generic-password,-i,find-generic-password' || calls[2].proc.stdin.chunks.join('') !== keychainAddInput(TEST_KEY) || JSON.stringify(calls.map(({ args: commandArgs }) => commandArgs)).includes(TEST_KEY)) throw new Error('invalid prior did not follow discard-before-replacement semantics');
  });
  await pexelsTest('macOS Keychain restores the prior value after an ambiguous replacement', async () => {
    const calls = []; const realSetTimeout = globalThis.setTimeout; let candidateClosed = false; let rollbackBeforeClose = false;
    const ambiguousCandidate = (proc) => {
      proc.mutated = true; const kill = proc.kill;
      proc.kill = (signal) => { const result = kill(signal); realSetTimeout(() => { candidateClosed = true; proc.emit('close', null); }, 5); return result; };
    };
    const restore = (proc) => { if (!candidateClosed) rollbackBeforeClose = true; keychainClose('')(proc); };
    const store = fakeCredentialStore(keychainSpawn([keychainClose(`${OLD_KEY}\n`), ambiguousCandidate, restore, keychainClose(`${OLD_KEY}\n`)], calls));
    globalThis.setTimeout = (callback, delay, ...args) => realSetTimeout(callback, delay === 5_000 ? 1 : delay, ...args);
    try {
      const message = await expectReject(store.save(TEST_KEY), /^Could not save the Pexels credential securely\.$/);
      const args = calls.map(({ args: commandArgs }) => commandArgs.join(' ')).join('\n'); const publicStatus = JSON.stringify({ message });
      if (message !== 'Could not save the Pexels credential securely.' || !candidateClosed || rollbackBeforeClose || calls.length !== 4 || !calls[1].proc.mutated || calls[1].proc.kills.length !== 1 || JSON.stringify(calls[2].args) !== JSON.stringify(['-i']) || calls[2].proc.stdin.chunks.join('') !== keychainAddInput(OLD_KEY) || calls[3].args[0] !== 'find-generic-password' || args.includes(TEST_KEY) || args.includes(OLD_KEY) || publicStatus.includes(TEST_KEY) || publicStatus.includes(OLD_KEY)) throw new Error('ambiguous replacement did not restore the prior Keychain value safely');
    } finally { globalThis.setTimeout = realSetTimeout; }
  });
  await pexelsTest('macOS Keychain invalid values are discarded with key-free status', async () => {
    const calls = []; const store = fakeCredentialStore(keychainSpawn([keychainClose('not-valid\n'), keychainClose('')], calls));
    const result = await store.load();
    if (result.key !== null || result.message !== 'Disconnected. Saved credential was invalid and removed.' || calls.length !== 2 || calls[1].args[0] !== 'delete-generic-password' || JSON.stringify(result).includes(TEST_KEY)) throw new Error('invalid Keychain value was not discarded safely');
  });
  await pexelsTest('macOS Keychain clear accepts not-found and sanitizes failures/timeouts', async () => {
    const notFound = fakeCredentialStore(keychainSpawn([keychainClose('', 44)])); await notFound.clear();
    const secretError = `${TEST_KEY} /private/client/login.keychain`; const failed = fakeCredentialStore(keychainSpawn([keychainClose('', 1, secretError)]));
    const message = await expectReject(failed.save(TEST_KEY), /^Could not save the Pexels credential securely\.$/);
    const failedClear = fakeCredentialStore(keychainSpawn([keychainClose('', 1, secretError)]));
    const clearMessage = await expectReject(failedClear.clear(), /^Could not remove the saved Pexels credential securely\.$/);
    if (message.includes(TEST_KEY) || message.includes('/private/') || clearMessage.includes(TEST_KEY) || clearMessage.includes('/private/') || JSON.stringify(failed).includes(TEST_KEY)) throw new Error('Keychain failure exposed a secret or path');
    const calls = []; const hanging = fakeCredentialStore(keychainSpawn([null], calls)); const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback) => realSetTimeout(callback, 1);
    try {
      const result = await hanging.load();
      if (result.key !== null || result.message !== 'Disconnected. Saved credential could not be read.' || calls[0].proc.kills.length === 0 || JSON.stringify(result).includes(TEST_KEY)) throw new Error('Keychain timeout was not bounded and sanitized');
    } finally { globalThis.setTimeout = realSetTimeout; }
  });
  } finally { rmSync(credentialCheckRoot, { recursive: true, force: true }); }
  await pexelsTest('credential persistence encrypts atomically, restores, clears, and rejects corrupt blobs', async () => {
    const temp = mkdtempSync(path.join(fixtureDir(), 'clipdock-credential-')); const file = path.join(temp, 'userData', 'pexels-credential.json');
    const cipher = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from([...Buffer.from(value)].map((byte) => byte ^ 0x5a)), decryptString: (value) => Buffer.from([...value].map((byte) => byte ^ 0x5a)).toString() };
    const store = new PexelsCredentialStore(file, cipher); if (!await store.save(TEST_KEY)) throw new Error('credential was not saved');
    const disk = readFileSync(file, 'utf8'); if (disk.includes(TEST_KEY) || statSync(file).mode & 0o077) throw new Error('credential was plaintext or not private');
    if ((await store.load()).key !== TEST_KEY) throw new Error('encrypted credential did not roundtrip');
    writeFileSync(file, '{bad'); const corrupt = await store.load(); if (corrupt.key !== null || existsSync(file)) throw new Error('corrupt credential was not removed');
    await store.save(TEST_KEY); await store.clear(); if (existsSync(file)) throw new Error('disconnect did not remove persisted credential');
    rmSync(temp, { recursive: true, force: true });
  });
  await pexelsTest('unavailable credential encryption never writes a plaintext file', async () => {
    const temp = mkdtempSync(path.join(fixtureDir(), 'clipdock-credential-unavailable-')); const file = path.join(temp, 'credential.json'); const store = new PexelsCredentialStore(file, { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unavailable'); }, decryptString: () => { throw new Error('unavailable'); } });
    const load = await store.load();
    if (await store.save(TEST_KEY) || existsSync(file) || load.key !== null || !load.message.includes('Secure saving is unavailable')) throw new Error('unavailable encryption wrote, restored, or hid credential status'); rmSync(temp, { recursive: true, force: true });
  });
  await pexelsTest('credential clear ignores only ENOENT and surfaces other removal failures', async () => {
    const temp = mkdtempSync(path.join(fixtureDir(), 'clipdock-credential-clear-')); const cipher = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() };
    await new PexelsCredentialStore(path.join(temp, 'missing.json'), cipher).clear();
    await expectReject(new PexelsCredentialStore(temp, cipher).clear(), /EISDIR|directory|operation not permitted/i);
    rmSync(temp, { recursive: true, force: true });
  });
  await pexelsTest('corrupt credential reports whether safe removal failed without exposing filesystem details', async () => {
    const temp = mkdtempSync(path.join(fixtureDir(), 'clipdock-credential-corrupt-')); const file = path.join(temp, 'credential.json'); writeFileSync(file, '{bad');
    const cipher = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() };
    const store = new PexelsCredentialStore(file, cipher); store.clear = async () => { throw new Error(`/private/path/${TEST_KEY}`); };
    const load = await store.load();
    if (load.key !== null || !load.message.includes('could not be removed') || load.message.includes('/private/') || load.message.includes(TEST_KEY) || !existsSync(file)) throw new Error('corrupt removal failure was not safely distinguished');
    rmSync(temp, { recursive: true, force: true });
  });
  await pexelsTest('invalid decrypted credential is rejected, removed, and never accepted by the client', async () => {
    const temp = mkdtempSync(path.join(fixtureDir(), 'clipdock-credential-invalid-')); const file = path.join(temp, 'credential.json'); const invalid = 'not-valid';
    const cipher = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() }; const store = new PexelsCredentialStore(file, cipher);
    await store.save(invalid); const load = await store.load(); const client = createPexelsClient(temp);
    if (load.key !== null || !load.message.includes('invalid') || existsSync(file) || client.restoreKey(invalid, true, 'Connected') !== false || client.status().connected) throw new Error('invalid decrypted credential survived startup validation');
    client.dispose(); rmSync(temp, { recursive: true, force: true });
  });
  await pexelsTest('key validation calls Pexels before replacement and preserves a prior key on auth failure', async () => {
    const rootDir = mkdtempSync(path.join(fixtureDir(), 'clipdock-pexels-validate-')); const candidate = 'candidate_key_123456789012345'; const calls = [];
    const client = createPexelsClient(rootDir, async (url, init) => { calls.push([String(url), init.headers.Authorization]); return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }); }); client.setKey(TEST_KEY, true);
    await expectReject(client.validateKey(candidate), /rejected/); if (!client.status().connected || !client.status().persisted) throw new Error('auth failure replaced the existing connection');
    const restored = createPexelsClient(rootDir, async (url, init) => { calls.push([String(url), init.headers.Authorization]); return new Response('{}', { headers: { 'content-type': 'application/json' } }); }); await restored.validateKey(candidate); const status = restored.setKey(candidate, false);
    if (!calls.some(([url, authorization]) => url.includes('/v1/curated?per_page=1') && authorization === candidate) || JSON.stringify(status) !== JSON.stringify({ connected: true, persisted: false, message: 'Connected for this session; secure saving unavailable' })) throw new Error('validation request or narrow status contract failed');
    client.clearKey(); restored.clearKey(); rmSync(rootDir, { recursive: true, force: true });
  });
});

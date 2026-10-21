// Main-process-only encrypted stock-provider (Pexels, Pixabay) credential persistence. The renderer never imports this module.
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { tryAcquireFileLock, type FileLock } from './file-lock';
import { AnchoredDir, ensureDirectory, prepareDirectory } from './safe-fs';

export type SafeStorage = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

export type CredentialLoad = { key: string | null; message: string };

export interface PexelsCredentialPersistence {
  load(): Promise<CredentialLoad>;
  save(key: string): Promise<boolean>;
  clear(): Promise<void>;
  dispose?(): void | Promise<void>;
}

export const PEXELS_KEYCHAIN_SERVICE = 'com.clipdock.pexels';
export const PIXABAY_KEYCHAIN_SERVICE = 'com.clipdock.pixabay';
export const PEXELS_KEYCHAIN_ACCOUNT = 'api-key';

/** Each provider owns its Keychain item and its own transaction lock. */
export type CredentialSource = { service: string; label: string; lockPath: string };
export const PEXELS_CREDENTIAL: CredentialSource = { service: PEXELS_KEYCHAIN_SERVICE, label: 'Pexels', lockPath: join(tmpdir(), 'ClipDock', 'pexels-keychain.lock') };
export const PIXABAY_CREDENTIAL: CredentialSource = { service: PIXABAY_KEYCHAIN_SERVICE, label: 'Pixabay', lockPath: join(tmpdir(), 'ClipDock', 'pixabay-keychain.lock') };

export const isValidPexelsKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{20,200}$/.test(value);

export class PexelsCredentialStore implements PexelsCredentialPersistence {
  constructor(private readonly file: string, private readonly safeStorage: SafeStorage) {}

  async load(): Promise<CredentialLoad> {
    if (!this.safeStorage.isEncryptionAvailable()) return { key: null, message: 'Disconnected. Secure saving is unavailable.' };
    let encoded: string;
    try { encoded = await readFile(this.file, 'utf8'); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { key: null, message: 'Disconnected.' }; return { key: null, message: 'Disconnected. Saved credential could not be read.' }; }
    let key: string;
    try {
      const blob = JSON.parse(encoded) as { version?: unknown; ciphertext?: unknown };
      if (blob.version !== 1 || typeof blob.ciphertext !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob.ciphertext)) throw new Error('invalid credential blob');
      key = this.safeStorage.decryptString(Buffer.from(blob.ciphertext, 'base64'));
    } catch {
      return this.#discard('unreadable');
    }
    if (!isValidPexelsKey(key)) return this.#discard('invalid');
    return { key, message: 'Connected · saved securely' };
  }

  async save(key: string): Promise<boolean> {
    if (!this.safeStorage.isEncryptionAvailable()) return false;
    const data = JSON.stringify({ version: 1, ciphertext: this.safeStorage.encryptString(key).toString('base64') });
    const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      await writeFile(temp, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temp, this.file);
      return true;
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  async clear(): Promise<void> {
    try { await rm(this.file); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  async #discard(reason: 'unreadable' | 'invalid'): Promise<CredentialLoad> {
    try {
      await this.clear();
      return { key: null, message: `Disconnected. Saved credential was ${reason} and removed.` };
    } catch {
      return { key: null, message: `Disconnected. Saved credential was ${reason} but could not be removed.` };
    }
  }
}

type KeychainSpawnOptions = { shell: false; stdio: ['pipe', 'pipe', 'pipe'] };
type KeychainSpawn = (command: string, args: string[], options: KeychainSpawnOptions) => ChildProcessWithoutNullStreams;
type KeychainResult = { code: number | null; stdout: string; stderr: string };
type BoundedOutput = { buffer: Buffer };

const KEYCHAIN_COMMAND = '/usr/bin/security';
const KEYCHAIN_TIMEOUT_MS = 5_000;
const KEYCHAIN_ROLLBACK_TIMEOUT_MS = 1_000;
const KEYCHAIN_TERMINATION_WAIT_MS = 250;
const KEYCHAIN_OUTPUT_LIMIT = 8 * 1024;
const KEYCHAIN_NOT_FOUND = 44;
const KEYCHAIN_COMMAND_ERROR = 'Secure credential storage is unavailable.';
const KEYCHAIN_LOAD_ERROR = 'Disconnected. Saved credential could not be read.';
// Command failures never surface: every caller maps them to its own message.
const KEYCHAIN_TIMEOUT_ERROR = 'Secure credential storage timed out.';
const KEYCHAIN_LOCK_ACQUIRE_TIMEOUT_MS = 90_000;
const KEYCHAIN_LOCK_RETRY_MS = 25;
const KEYCHAIN_LOCK_ERROR = 'Secure credential storage is unavailable.';

function isContainedPath(parent: string, child: string): boolean {
  const remainder = relative(parent, child);
  return remainder !== '' && remainder !== '..' && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder);
}

async function ensurePrivateKeychainLockParent(lockPath: string): Promise<AnchoredDir> {
  try {
    const parent = dirname(lockPath);
    const temp = resolve(tmpdir()), realTemp = await realpath(temp);
    // Validate before creating anything. Accept the OS temp alias at ingress,
    // then create only through the captured canonical temp directory.
    const base = isContainedPath(realTemp, parent) ? realTemp : temp;
    if (!isContainedPath(base, parent)) throw new Error(KEYCHAIN_LOCK_ERROR);
    let directory = prepareDirectory(realTemp);
    for (const name of relative(base, parent).split(sep)) directory = ensureDirectory(directory, name);
    const info = await lstat(directory.verify());
    directory.verify();
    // The default parent is ClipDock; injected lock paths must likewise have a
    // dedicated private parent. Never repair permissions on an existing folder.
    if ((info.mode & 0o777) !== 0o700 || (process.getuid && info.uid !== process.getuid())) throw new Error(KEYCHAIN_LOCK_ERROR);
    return directory;
  } catch {
    throw new Error(KEYCHAIN_LOCK_ERROR);
  }
}

async function acquireKeychainLock(lockPath: string, signal: AbortSignal): Promise<FileLock> {
  signal.throwIfAborted();
  const parent = await ensurePrivateKeychainLockParent(lockPath);
  const deadline = Date.now() + KEYCHAIN_LOCK_ACQUIRE_TIMEOUT_MS;
  while (true) {
    signal.throwIfAborted();
    const lock = tryAcquireFileLock(parent.child(basename(lockPath)));
    if (lock) return lock;
    if (Date.now() >= deadline) throw new Error(KEYCHAIN_LOCK_ERROR);
    await new Promise<void>((resolveDelay, reject) => {
      const cancel = () => { clearTimeout(timer); reject(new Error(KEYCHAIN_LOCK_ERROR)); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolveDelay(); }, KEYCHAIN_LOCK_RETRY_MS);
      signal.addEventListener('abort', cancel, {once: true});
    });
  }
}

const defaultKeychainSpawn: KeychainSpawn = (command, args, options) => spawn(command, args, options);

function appendBounded(output: BoundedOutput, chunk: Buffer | string): void {
  const encoded = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const remaining = KEYCHAIN_OUTPUT_LIMIT - output.buffer.byteLength;
  if (remaining <= 0) return;
  const length = Math.min(encoded.byteLength, remaining);
  output.buffer = Buffer.concat([output.buffer, encoded.subarray(0, length)], output.buffer.byteLength + length);
}

function runKeychainCommand(spawnCommand: KeychainSpawn, args: string[], input?: string, timeoutMs = KEYCHAIN_TIMEOUT_MS, signal?: AbortSignal): Promise<KeychainResult> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnCommand(KEYCHAIN_COMMAND, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      reject(new Error(KEYCHAIN_COMMAND_ERROR));
      return;
    }
    const stdout: BoundedOutput = { buffer: Buffer.alloc(0) };
    const stderr: BoundedOutput = { buffer: Buffer.alloc(0) };
    let settled = false;
    let failure: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    let terminationTimer: NodeJS.Timeout | undefined;
    const stop = (): void => { try { child.kill('SIGKILL'); } catch { /* best effort */ } };
    const finish = (result?: KeychainResult): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      if (timer !== undefined) clearTimeout(timer);
      if (terminationTimer !== undefined) clearTimeout(terminationTimer);
      if (failure !== undefined) reject(new Error(failure));
      else if (result !== undefined) resolve(result);
    };
    const fail = (message: string): void => {
      if (settled || failure !== undefined) return;
      failure = message;
      if (timer !== undefined) clearTimeout(timer);
      terminationTimer = setTimeout(() => finish(), KEYCHAIN_TERMINATION_WAIT_MS);
      stop();
    };
    const cancel = () => fail(KEYCHAIN_COMMAND_ERROR);
    signal?.addEventListener('abort', cancel, {once: true});
    child.stdout.on('data', (chunk: Buffer | string) => appendBounded(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer | string) => appendBounded(stderr, chunk));
    child.stdin.on('error', () => fail(KEYCHAIN_COMMAND_ERROR));
    child.on('error', () => fail(KEYCHAIN_COMMAND_ERROR));
    child.once('close', (code) => finish({ code, stdout: stdout.buffer.toString('utf8'), stderr: stderr.buffer.toString('utf8') }));
    timer = setTimeout(() => fail(KEYCHAIN_TIMEOUT_ERROR), timeoutMs);
    if (signal?.aborted) { cancel(); return; }
    try { if (input !== undefined) child.stdin.write(input); child.stdin.end(); } catch { fail(KEYCHAIN_COMMAND_ERROR); }
  });
}

export class MacKeychainPexelsCredentialStore implements PexelsCredentialPersistence {
  private readonly lockPath: string;
  private readonly saveError: string;
  private readonly clearError: string;
  private readonly cancellation = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();

  async dispose(): Promise<void> {
    this.cancellation.abort();
    await Promise.allSettled([...this.pending]);
  }

  constructor(private readonly spawnCommand: KeychainSpawn = defaultKeychainSpawn, lockPath?: string, private readonly source: CredentialSource = PEXELS_CREDENTIAL) {
    this.lockPath = resolve(lockPath ?? source.lockPath);
    this.saveError = `Could not save the ${source.label} credential securely.`;
    this.clearError = `Could not remove the saved ${source.label} credential securely.`;
  }

  async load(): Promise<CredentialLoad> {
    try {
      return await this.#withLock(async () => {
        let result: KeychainResult;
        try {
          result = await this.#findStored();
        } catch {
          return { key: null, message: KEYCHAIN_LOAD_ERROR };
        }
        if (result.code === KEYCHAIN_NOT_FOUND) return { key: null, message: 'Disconnected.' };
        if (result.code !== 0) return { key: null, message: KEYCHAIN_LOAD_ERROR };
        const key = result.stdout.trim();
        if (!isValidPexelsKey(key)) return this.#discardInvalid();
        return { key, message: 'Connected · saved securely' };
      });
    } catch {
      return { key: null, message: KEYCHAIN_LOAD_ERROR };
    }
  }

  async save(key: string): Promise<boolean> {
    if (!isValidPexelsKey(key)) return false;
    try {
      return await this.#withLock(async () => {
        let previous: string | null;
        try {
          previous = await this.#readPrior();
        } catch {
          throw new Error(this.saveError);
        }
        try {
          if (!await this.#writeAndVerify(key)) throw new Error(this.saveError);
          return true;
        } catch {
          await this.#rollback(previous);
          throw new Error(this.saveError);
        }
      });
    } catch {
      throw new Error(this.saveError);
    }
  }

  async clear(): Promise<void> {
    try {
      await this.#withLock(() => this.#clearUnlocked());
    } catch {
      throw new Error(this.clearError);
    }
  }

  async #discardInvalid(): Promise<CredentialLoad> {
    try {
      await this.#clearUnlocked();
      return { key: null, message: 'Disconnected. Saved credential was invalid and removed.' };
    } catch {
      return { key: null, message: 'Disconnected. Saved credential was invalid but could not be removed.' };
    }
  }

  async #clearUnlocked(): Promise<void> {
    let result: KeychainResult;
    try {
      result = await this.#deleteStored();
    } catch {
      throw new Error(this.clearError);
    }
    if (result.code !== 0 && result.code !== KEYCHAIN_NOT_FOUND) throw new Error(this.clearError);
  }

  async #readPrior(): Promise<string | null> {
    let result: KeychainResult;
    try {
      result = await this.#findStored();
    } catch {
      throw new Error(this.saveError);
    }
    if (result.code === KEYCHAIN_NOT_FOUND) return null;
    if (result.code !== 0) throw new Error(this.saveError);
    const prior = result.stdout.trim();
    if (isValidPexelsKey(prior)) return prior;
    try {
      await this.#clearUnlocked();
    } catch {
      throw new Error(this.saveError);
    }
    return null;
  }

  async #rollback(previous: string | null): Promise<void> {
    // Disposal cancels admission and the candidate command, but rollback owns
    // an independent deadline and keeps the transaction lock until it ends.
    const rollback = new AbortController();
    const deadline = setTimeout(() => rollback.abort(), KEYCHAIN_ROLLBACK_TIMEOUT_MS);
    try {
      if (previous === null) {
        const result = await this.#deleteStored(KEYCHAIN_ROLLBACK_TIMEOUT_MS, rollback.signal);
        if (result.code !== 0 && result.code !== KEYCHAIN_NOT_FOUND) return;
        return;
      }
      if (!await this.#writeAndVerify(previous, KEYCHAIN_ROLLBACK_TIMEOUT_MS, rollback.signal)) return;
    } catch { /* best effort */ }
    finally { clearTimeout(deadline); }
  }

  #withLock<T>(operation: () => Promise<T>): Promise<T> {
    const pending = (async () => {
      const lock = await acquireKeychainLock(this.lockPath, this.cancellation.signal);
      try { this.cancellation.signal.throwIfAborted(); return await operation(); }
      finally { lock.release(); }
    })();
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => {});
    return pending;
  }

  #findStored(timeoutMs = KEYCHAIN_TIMEOUT_MS, signal = this.cancellation.signal): Promise<KeychainResult> {
    return this.#run(['find-generic-password', '-s', this.source.service, '-a', PEXELS_KEYCHAIN_ACCOUNT, '-w'], undefined, timeoutMs, signal);
  }

  async #addStored(key: string, timeoutMs = KEYCHAIN_TIMEOUT_MS, signal = this.cancellation.signal): Promise<KeychainResult> {
    if (!isValidPexelsKey(key)) throw new Error(this.saveError);
    return this.#run(['-i'], `add-generic-password -U -s ${this.source.service} -a ${PEXELS_KEYCHAIN_ACCOUNT} -w ${key}\n`, timeoutMs, signal);
  }

  async #writeAndVerify(key: string, timeoutMs = KEYCHAIN_TIMEOUT_MS, signal = this.cancellation.signal): Promise<boolean> {
    const result = await this.#addStored(key, timeoutMs, signal);
    return result.code === 0 && await this.#verifyStored(key, timeoutMs, signal);
  }

  async #verifyStored(expected: string, timeoutMs = KEYCHAIN_TIMEOUT_MS, signal = this.cancellation.signal): Promise<boolean> {
    const result = await this.#findStored(timeoutMs, signal);
    return result.code === 0 && result.stdout.trim() === expected;
  }

  #deleteStored(timeoutMs = KEYCHAIN_TIMEOUT_MS, signal = this.cancellation.signal): Promise<KeychainResult> {
    return this.#run(['delete-generic-password', '-s', this.source.service, '-a', PEXELS_KEYCHAIN_ACCOUNT], undefined, timeoutMs, signal);
  }

  #run(args: string[], input?: string, timeoutMs = KEYCHAIN_TIMEOUT_MS, signal = this.cancellation.signal): Promise<KeychainResult> {
    return runKeychainCommand(this.spawnCommand, args, input, timeoutMs, signal);
  }
}

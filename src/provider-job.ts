import { closeSync, lstatSync } from 'node:fs';
import { ManagedRoot } from './managed-root';
import { AnchoredDir, captureFile, createDirectory, openExclusive, prepareDirectory, removeOwned, removePrivateDir, verifyFile, type OwnedFile } from './safe-fs';
import { basename, dirname, isAbsolute, relative, sep } from 'node:path';

export class ProviderJobCancelledError extends Error {
  // A containing download keeps its IPC rejection text while preserving the
  // cancelled phase's existing terminal notification (for example preparation).
  constructor(message: string, readonly terminalMessage = message) { super(message); this.name = 'ProviderJobCancelledError'; }
}

/** The runner preserves whether a provider failure historically sent an IPC event.
 * Unmarked errors (preflight, host completion, preparation) reject the invoke only.
 */
export class ProviderJobFailureError extends Error {
  constructor(message: string, readonly notify: boolean, options: ErrorOptions) { super(message, options); }
}

export class ProviderJobRejectedError extends Error {
  constructor(readonly kind: 'busy' | 'disposed', message: string) {
    // Preserve the invoke error's existing name; instanceof and kind supply typing.
    super(message);
  }
}

export type ProviderJobOutcome<T> =
  | {state: 'completed'; result: T}
  | {state: 'failed'; error: Error}
  | {state: 'cancelled'; error: ProviderJobCancelledError};
export type ProviderCancellation = Promise<void> | null;

/** The shared prerequisite message remains independent of provider error mapping. */
export function requireFfprobe(available: unknown, message = 'ffprobe was not found. Install ffprobe or set CLIPDOCK_FFPROBE_PATH to an absolute executable path.'): void {
  if (!available) throw new Error(message);
}

export type ProviderJobContext = {
  readonly signal: AbortSignal;
  check(): void;
  register(path: string | OwnedFile): OwnedFile;
  /** Retrieve the admission identity without recapturing a stored pathname. */
  owned(path: string): OwnedFile;
  /** Exclusively create and register a private temporary directory with its filesystem identity. */
  createDirectory(path: string): void;
  /** Commit publication with the result; an optional synchronous effect runs only on success. */
  publish(path: string, commit?: () => void): void;
  /** During commit, release cleanup ownership once a card or saved record references this path. */
  retain(path: string): void;
  /** Await a cancellable operation, including its termination on abort. */
  wait<T>(operation: Promise<T> & {cancel: () => Promise<void>}): Promise<T>;
  /** Start provider work, register any returned artifact before checking abort, and await cancellation. */
  perform<T>(operation: () => Promise<T>, cancel: () => ProviderCancellation | void, register?: (value: T) => void): Promise<T>;
};
export type RunOptions<T> = {
  cancelledMessage?: string;
  cancelledEventMessage?: string;
  notifyFailure?: boolean | ((error: Error) => boolean);
  timeoutMs?: number;
  timeoutMessage?: string;
  invalidMessage?: string;
  busyMessage?: string;
  prerequisites?: () => void;
  mapError?: (error: Error) => Error;
  terminal?: (outcome: ProviderJobOutcome<T>) => void;
};
type Job = { controller: AbortController; done: Promise<void>; cancelledMessage: string; cancelledEventMessage?: string };

/** Owns admission, cancellation, unpublished output and the single terminal promise. */
export class ProviderJobRunner {
  private readonly jobs = new Map<string, Job>();
  private readonly directoryObservers = new Set<(directory: AnchoredDir) => void>();
  private disposed = false;
  constructor(private readonly options: {
    cancelledMessage: string;
    busyMessage?: string;
    disposedMessage: string;
  }) {}

  isActive(jobId?: string): boolean { return jobId === undefined ? this.jobs.size > 0 : this.jobs.has(jobId); }

  /** Observe captured directory creation at admission, before provider awaits. */
  observeDirectories(observer: (directory: AnchoredDir) => void): () => void {
    this.directoryObservers.add(observer);
    return () => { this.directoryObservers.delete(observer); };
  }

  async run<T>(jobId: string, body: (context: ProviderJobContext) => Promise<T>, options: RunOptions<T> = {}): Promise<T> {
    if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(jobId)) throw new Error(options.invalidMessage ?? 'Invalid provider job ID.');
    if (this.disposed) throw new ProviderJobRejectedError('disposed', this.options.disposedMessage);
    if (this.jobs.has(jobId) || (this.options.busyMessage && this.jobs.size)) {
      throw new ProviderJobRejectedError('busy', options.busyMessage ?? this.options.busyMessage ?? `Provider job ${jobId} is already active.`);
    }
    options.prerequisites?.();
    let outcome: ProviderJobOutcome<T>;
    try {
      const result = await this.execute(jobId, body, options);
      outcome = {state: 'completed', result};
    } catch (thrown) {
      const original = thrown instanceof Error ? thrown : new Error(String(thrown));
      // The containing job owns its invoke rejection text even when a child
      // cancels itself; retain the child's distinct terminal notification text.
      let error = original instanceof ProviderJobCancelledError
        ? new ProviderJobCancelledError(options.cancelledMessage ?? this.options.cancelledMessage, original.terminalMessage)
        : original;
      if (!(original instanceof ProviderJobCancelledError) && !(original instanceof ProviderJobRejectedError)) {
        try { error = options.mapError?.(original) ?? original; }
        catch (mappingError) { error = mappingError instanceof Error ? mappingError : new Error(String(mappingError)); }
      }
      if (!(error instanceof ProviderJobCancelledError) && !(error instanceof ProviderJobRejectedError) && options.notifyFailure !== undefined) {
        const notify = typeof options.notifyFailure === 'function' ? options.notifyFailure(error) : options.notifyFailure;
        error = new ProviderJobFailureError(error.message, notify, {cause: error});
      }
      outcome = error instanceof ProviderJobCancelledError ? {state: 'cancelled', error} : {state: 'failed', error};
    }
    // Cleanup and publication have settled before the sole terminal notification.
    // A throwing observer cannot reclassify an already selected outcome.
    options.terminal?.(outcome);
    if (outcome.state === 'completed') return outcome.result;
    throw outcome.error;
  }

  private async execute<T>(jobId: string, body: (context: ProviderJobContext) => Promise<T>, options: RunOptions<T>): Promise<T> {
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const job = {controller, done, cancelledMessage: options.cancelledMessage ?? this.options.cancelledMessage, cancelledEventMessage: options.cancelledEventMessage};
    this.jobs.set(jobId, job);
    // One ownership/publication record per physical file, including case and
    // hard-link aliases. Keep each captured entry for identity-checked cleanup.
    const files = new Map<string, Map<string, OwnedFile>>();
    const registeredFiles = new Map<string, OwnedFile>();
    const fileIdentity = (file: OwnedFile): string => `file:${file.identity.dev}:${file.identity.ino}`;
    const directories = new Map<string, AnchoredDir>();
    const aliases = new Map<string, string>();
    const key = (path: string): string => aliases.get(path) ?? path;
    const publications = new Map<string, {commit?: () => void; file?: OwnedFile}>();
    const publishedFiles = new Set<string>();
    const publishedPaths = new Set<string>();
    const publishedDirectories = new Set<string>();
    const within = (directory: string, path: string): boolean => {
      const rel = relative(directory, path);
      return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    };
    const coveredByPublication = (path: string): boolean => [...publishedDirectories].some(directory => within(directory, path));
    const release = (key: string): void => {
      const entries = files.get(key);
      if (entries) {
        publishedFiles.add(key);
        for (const file of entries.values()) publishedPaths.add(file.path);
        files.delete(key);
        return;
      }
      if (publishedFiles.has(key)) return;
      publishedPaths.add(key);
      if (directories.has(key)) {
        publishedDirectories.add(key); directories.delete(key);
        // Publishing a subtree also retains every alias of its captured files.
        for (const [identity, members] of files) {
          if ([...members.values()].some(file => within(key, file.path))) release(identity);
        }
      }
    };
    let committing = false;
    const check = (): void => { if (controller.signal.aborted) throw controller.signal.reason; };
    const context: ProviderJobContext = {
      signal: controller.signal,
      check,
      register: value => {
        const path = typeof value === 'string' ? value : value.path;
        const existing = registeredFiles.get(path);
        if (existing) { verifyFile(existing); return existing; }
        let file: OwnedFile;
        if (typeof value !== 'string') { verifyFile(value); file = value; }
        else {
          const enclosing = [...directories.values()].filter(dir => within(dir.verify(), value)).sort((a, b) => b.verify().length - a.verify().length)[0];
          const boundary = enclosing?.root ?? ManagedRoot.capture(dirname(value));
          const parent = enclosing ?? AnchoredDir.capture(boundary.verify(), boundary);
          const target = enclosing ? value : parent.child(basename(value));
          try { file = captureFile(parent, target); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            // Legacy pre-creation registration reserves the name exclusively.
            const opened = openExclusive(AnchoredDir.capture(dirname(target), boundary), basename(target));
            closeSync(opened.fd); file = opened.file;
          }
        }
        const captured = registeredFiles.get(file.path);
        if (captured) { verifyFile(captured); file = captured; }
        const identity = fileIdentity(file);
        const members = files.get(identity) ?? new Map<string, OwnedFile>();
        members.set(file.path, file); files.set(identity, members);
        registeredFiles.set(path, file); registeredFiles.set(file.path, file);
        aliases.set(path, identity); aliases.set(file.path, identity);
        if (publishedFiles.has(identity)) publishedPaths.add(file.path);
        return file;
      },
      owned: path => {
        const file = registeredFiles.get(path);
        if (!file) throw new Error('Provider job does not own this file.');
        verifyFile(file); return file;
      },
      createDirectory: path => {
        check();
        const boundary = ManagedRoot.capture(dirname(path));
        const parent = AnchoredDir.capture(boundary.verify(), boundary);
        const dir = createDirectory(parent, basename(path));
        aliases.set(path, dir.verify()); aliases.set(dir.verify(), dir.verify()); directories.set(dir.verify(), dir);
        for (const observer of this.directoryObservers) observer(dir);
      },
      // Publication commits with the successful result, so cancellation in the
      // body's final microtask cannot leave a file without a completed job.
      publish: (path, commit) => {
        check();
        const file = registeredFiles.get(path);
        path = key(path);
        if (!files.has(path) && !directories.has(path)) throw new Error('Provider job cannot publish an unregistered path.');
        publications.set(path, {commit, file});
      },
      retain: path => {
        path = key(path);
        if (!committing) throw new Error('Provider job can retain a referenced path only during publication.');
        if (!files.has(path) && !directories.has(path) && !publications.has(path)) throw new Error('Provider job cannot retain an unregistered path.');
        release(path);
      },
      perform: (operation, cancel, register) => {
        check();
        return context.wait(Object.assign(operation().then(value => { register?.(value); return value; }), {
          cancel: async () => { await cancel(); },
        }));
      },
      wait: async operation => {
        let termination: Promise<void> | undefined;
        const abort = (): void => { termination ??= operation.cancel(); };
        controller.signal.addEventListener('abort', abort, {once: true});
        if (controller.signal.aborted) abort();
        try { const result = await operation; check(); return result; }
        finally { controller.signal.removeEventListener('abort', abort); await termination; }
      },
    };
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      controller.abort(new Error(options.timeoutMessage ?? 'Provider job timed out.'));
    }, options.timeoutMs);
    try {
      check();
      const result = await body(context);
      check();
      for (const [path, publication] of publications) {
        check();
        committing = true;
        try {
          if (publication.file) verifyFile(publication.file);
          directories.get(path)?.verify();
          publication.commit?.(); release(path);
        }
        finally { committing = false; }
      }
      check();
      return result;
    } catch (error) {
      const reason: unknown = controller.signal.reason;
      if (controller.signal.aborted && reason instanceof ProviderJobCancelledError && error instanceof ProviderJobCancelledError) {
        throw new ProviderJobCancelledError(reason.message, error.terminalMessage);
      }
      check();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      try {
        for (const [identity, members] of files) {
          if (publishedFiles.has(identity)) continue;
          for (const file of members.values()) {
            if (!coveredByPublication(file.path)) removeOwned(file);
          }
        }
        for (const [path, directory] of directories) {
          // An enclosing registration cannot revoke a published child.
          if (coveredByPublication(path) || [...publishedPaths].some(published => within(path, published))) continue;
          removePrivateDir(directory);
        }
      }
      finally { this.jobs.delete(jobId); finish(); }
    }
  }

  /** Abort synchronously; the returned promise waits for termination and cleanup.
   * null means no new cancellation was admitted.
   * A failure reason lets provider deadlines terminate work with their existing timeout error.
   */
  cancel(jobId?: string, failure?: Error): ProviderCancellation {
    const selected = jobId === undefined ? [...this.jobs.values()] : [this.jobs.get(jobId)].filter((job): job is Job => !!job);
    const pending = selected.filter(job => !job.controller.signal.aborted);
    if (!pending.length) return null;
    for (const job of pending) job.controller.abort(failure ?? new ProviderJobCancelledError(job.cancelledMessage, job.cancelledEventMessage));
    return Promise.all(selected.map(job => job.done)).then(() => undefined);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const pending = [...this.jobs.values()].map(job => job.done);
    this.cancel();
    await Promise.all(pending);
    this.directoryObservers.clear();
  }
}

/** A provider's session directory under its managed parent, and the private job
 * directories admitted into it. Workspace cleanup prunes only named provider
 * directories; admission recreates an absent one, only through the original parent.
 */
export class ProviderSession {
  path!: string;
  root!: ManagedRoot;
  parent!: AnchoredDir;
  directory!: AnchoredDir;
  readonly jobDirectories = new Map<string, AnchoredDir>();
  constructor(path: string, private readonly prunable: readonly string[], private readonly onRecreated?: () => void) { this.capture(path); }

  /** Move future jobs to a new session directory; active jobs keep their captured directories. */
  capture(path: string): void {
    const verified = prepareDirectory(path).verify();
    const root = ManagedRoot.capture(dirname(verified));
    const parent = AnchoredDir.capture(root.verify(), root);
    const directory = AnchoredDir.capture(verified, root);
    this.path = verified; this.root = root; this.parent = parent; this.directory = directory;
  }

  admit(): void {
    try { this.directory.verify(); }
    catch (error) {
      // An arbitrary caller-selected session directory remains an immutable boundary.
      const name = basename(this.path);
      if (!this.prunable.includes(name)) throw error;
      // Only absence permits recreation; an existing replacement stays rejected.
      try { lstatSync(this.parent.child(name)); }
      catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing;
        this.directory = createDirectory(this.parent, name);
        this.onRecreated?.();
        return;
      }
      throw error;
    }
  }

  /** Run a job whose non-empty jobDir is created privately inside the admitted session.
   * enter runs first in the job body; the callback it returns runs after the job settles.
   */
  async run<T>(
    jobs: ProviderJobRunner, jobId: string, jobDir: string, body: (context: ProviderJobContext) => Promise<T>,
    options: RunOptions<T>, enter?: (context: ProviderJobContext) => () => void,
  ): Promise<T> {
    let exit: (() => void) | undefined;
    try {
      return await jobs.run(jobId, context => {
        exit = enter?.(context);
        if (jobDir) {
          this.admit();
          context.createDirectory(jobDir);
          this.jobDirectories.set(jobDir, AnchoredDir.capture(jobDir, this.root));
        }
        return body(context);
      }, options);
    } finally { this.jobDirectories.delete(jobDir); exit?.(); }
  }
}

type CancellableBody = {body?: {cancel(reason?: unknown): Promise<void>} | null};

/** Cancellation must not wait for a hostile upstream body to acknowledge it. */
export function cancelBody(response: CancellableBody): void {
  void response.body?.cancel().catch(() => undefined);
}

/** Settle with `message` on abort without waiting for the work itself. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new Error(message));
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, {once: true});
  });
}

/** Fetch whose cancellation never waits for headers or a late body. A response
 * arriving after abort has its body cancelled in the background; after user
 * cancellation that termination joins `terminations`, so only disposal awaits it.
 */
export async function abortableFetch<U, I, R extends CancellableBody>(
  url: U, init: I,
  context: {fetch: (url: U, init: I) => Promise<R>; signal: AbortSignal; cancelledMessage: string; terminations?: Set<Promise<unknown>>},
): Promise<R> {
  const {signal, terminations} = context;
  const tracked = (): boolean => !!terminations && signal.reason instanceof ProviderJobCancelledError;
  const pending = context.fetch(url, init);
  void pending.then(response => { if (signal.aborted && !tracked()) cancelBody(response); }, () => undefined);
  try { return await abortable(pending, signal, context.cancelledMessage); }
  catch (error) {
    if (tracked()) {
      const termination = pending.then(response => response.body?.cancel(), () => undefined).catch(() => undefined);
      terminations!.add(termination);
      void termination.finally(() => terminations!.delete(termination));
    }
    throw error;
  }
}

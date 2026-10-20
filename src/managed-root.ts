// Electron-free captured filesystem identity. Stored paths are never recanonicalized.
import { closeSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalRoot, regularFile } from './path-boundary';
import { AnchoredDir, ensureDirectory, openExclusive, prepareDirectory, removeOwned, writeOwned } from './safe-fs';

export type RootIdentity = Readonly<{ path: string; directories: ReadonlyArray<Readonly<{ path: string; dev: number | string; ino: number | string }>> }>;
const serial = (value: bigint): number | string => Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
const validIdentity = (value: unknown): boolean => typeof value === 'number' ? Number.isSafeInteger(value) && value >= 0 : typeof value === 'string' && /^\d+$/.test(value);
const failure = () => new Error('Managed root failed the safety check.');

export class ManagedRoot {
  private constructor(private readonly identity: RootIdentity) { Object.freeze(this); }
  /** Capture an existing canonical directory, including ancestors on the same volume through its mount point. */
  static capture(folder: string): ManagedRoot {
    const path = canonicalRoot(folder);
    if (!path) throw failure();
    const directories: Array<RootIdentity['directories'][number]> = [];
    for (let current = path;; current = dirname(current)) {
      const info = lstatSync(current, {bigint: true});
      if (!info.isDirectory() || info.isSymbolicLink()) throw failure();
      directories.push(Object.freeze({ path: current, dev: serial(info.dev), ino: serial(info.ino) }));
      if (dirname(current) === current || lstatSync(dirname(current), {bigint: true}).dev !== info.dev) break;
    }
    const root = new ManagedRoot(Object.freeze({ path, directories: Object.freeze(directories) }));
    root.verify();
    return root;
  }
  /** Restore a worker-cloned in-session identity without capturing replacement directories. */
  static restore(identity: RootIdentity): ManagedRoot {
    if (!identity || typeof identity.path !== 'string' || !isAbsolute(identity.path) || !Array.isArray(identity.directories)) throw failure();
    if (identity.directories.length === 0) throw failure();
    let expected = identity.path;
    for (const entry of identity.directories) {
      if (!entry || entry.path !== expected || entry.dev !== identity.directories[0].dev || !validIdentity(entry.dev) || !validIdentity(entry.ino)) throw failure();
      expected = dirname(expected);
    }
    const copy = Object.freeze({ path: identity.path, directories: Object.freeze(identity.directories.map(({ path, dev, ino }) => Object.freeze({ path, dev, ino }))) });
    return new ManagedRoot(copy);
  }
  verify(): string {
    try {
      for (const entry of this.identity.directories) {
        const info = lstatSync(entry.path, {bigint: true});
        if (!info.isDirectory() || info.isSymbolicLink() || serial(info.dev) !== entry.dev || serial(info.ino) !== entry.ino) throw failure();
      }
      const mount = this.identity.directories[this.identity.directories.length - 1];
      const parent = dirname(mount.path);
      if (parent !== mount.path && serial(lstatSync(parent, {bigint: true}).dev) === mount.dev) throw failure();
      return this.identity.path;
    } catch { throw failure(); }
  }
  snapshot(): RootIdentity { this.verify(); return this.identity; }
  contains(file: string): boolean {
    const root = this.verify();
    const rel = relative(root, file);
    return isAbsolute(file) && rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  }
  resolve(file: unknown): string | null {
    try {
      this.verify();
      if (typeof file !== 'string' || !isAbsolute(file)) return null;
      const safe = regularFile(file);
      return safe && this.contains(safe) ? safe : null;
    } catch { return null; }
  }
  providerPath(name: 'youtube' | 'social' | 'pinterest' | 'pexels'): string {
    const provider = join(this.verify(), name);
    if (canonicalRoot(provider) !== provider) throw failure();
    return provider;
  }
  /** Recreate pruned provider directories without recapturing the managed root's identity. */
  ensureProviderDirectories(): void {
    for (const name of ['youtube', 'social', 'pinterest', 'pexels'] as const) {
      ensureDirectory(AnchoredDir.capture(this.verify(), this), name);
    }
    this.verify();
  }
  static prepare(folder: string, claim?: (root: ManagedRoot) => void): ManagedRoot {
    const root = ManagedRoot.capture(claim ? folder : prepareDirectory(folder).verify());
    claim?.(root);
    root.ensureProviderDirectories();
    for (const name of ['youtube', 'social', 'pinterest', 'pexels'] as const) {
      const directory = root.providerPath(name);
      // Write and re-check a byte: a volume whose file identity changes on write cannot be managed.
      const probe = openExclusive(AnchoredDir.capture(directory, root), `.clipdock-write-test-${randomUUID()}.tmp`);
      try { closeSync(probe.fd); writeOwned(probe.file, 'x'); }
      finally { if (removeOwned(probe.file) !== 'removed') throw failure(); }
    }
    root.verify();
    return root;
  }
}

/** One pointer shared by consumers; adapters and persistence finish before it changes. */
export class ManagedRootSelection {
  private active: ManagedRoot | null = null;
  private transitionFailed = false;
  current(): ManagedRoot { if (this.transitionFailed || !this.active) throw failure(); this.active.verify(); return this.active; }
  change(next: ManagedRoot, consumers: ReadonlyArray<(root: ManagedRoot) => void>, persist: (root: ManagedRoot) => void = () => {}): void {
    next.verify();
    for (const name of ['youtube', 'social', 'pinterest', 'pexels'] as const) next.providerPath(name);
    const previous = this.active;
    const attempted: Array<(root: ManagedRoot) => void> = [];
    try {
      for (const consumer of consumers) { attempted.push(consumer); consumer(next); }
      next.verify();
      persist(next);
      next.verify();
      this.active = next;
      this.transitionFailed = false;
    } catch (error) {
      if (previous) {
        try { previous.ensureProviderDirectories(); } catch { this.transitionFailed = true; }
        for (const consumer of attempted.reverse()) {
          try { consumer(previous); } catch { this.transitionFailed = true; }
        }
      }
      // If even rollback is unavailable, reject all consumers until a fully prepared change succeeds.
      throw error;
    }
  }
}

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { BoundedBuffer, shutdown } from './spawn.mjs';

/** Serialized RPC. A timed-out stream is poisoned: later mutations cannot run. */
export function createPythonBridge({ python, env, script, timeoutMs = 30000 }) {
  const child = spawn(python, ['-u', script], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const stderr = new BoundedBuffer(4096);
  child.stderr.on('data', chunk => stderr.push(chunk));
  const lines = createInterface({ input: child.stdout });
  const objects = new Map();
  const references = new WeakMap();
  let nextId = 1;
  let pending = null;
  let tail = Promise.resolve();
  let fatal = null;
  let closing = null;
  function fail(error) {
    fatal ??= error;
    pending?.reject(fatal);
  }
  child.on('error', error => { child.launchError = error; fail(error); });
  child.stdin.on('error', fail);
  child.on('exit', (code, signal) => fail(new Error(`Python bridge exited (${signal ?? code}): ${stderr.toString().trim()}`)));
  lines.on('line', line => {
    try {
      const response = JSON.parse(line);
      if (!pending || response.id !== pending.id) throw new Error('unexpected bridge response id');
      if ('error' in response) pending.reject(new Error(response.error));
      else pending.resolve(response.result);
    } catch (error) { fail(new Error(`Invalid Python bridge response: ${error.message}`)); }
  });
  function encode(value) {
    if (value && references.has(value)) return { $h: references.get(value) };
    if (Array.isArray(value)) return value.map(encode);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
    return value;
  }
  function decode(value) {
    if (Array.isArray(value)) return value.map(decode);
    if (!value || typeof value !== 'object') return value;
    if ('$h' in value) {
      if (!objects.has(value.$h)) {
        const object = {};
        references.set(object, value.$h);
        objects.set(value.$h, object);
        for (const method of value.methods) {
          // Never create a thenable, even for an API with a method named then.
          if (method === 'then') continue;
          Object.defineProperty(object, method, { enumerable: true, value: async (...args) => call(object, method, ...args) });
        }
      }
      return objects.get(value.$h);
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v)]));
  }
  function request(payload) {
    const result = tail.then(async () => {
      if (fatal) throw fatal;
      if (closing) throw new Error('Python bridge is closed');
      const id = nextId++;
      let timer;
      try {
        return decode(await new Promise((resolve, reject) => {
          pending = { id, resolve, reject };
          timer = setTimeout(() => fail(new Error(`Python bridge request ${payload.op}${payload.method ? ` ${payload.method}` : ''} timed out after ${timeoutMs} ms`)), timeoutMs);
          child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, error => { if (error) fail(error); });
        }));
      } finally { clearTimeout(timer); pending = null; }
    });
    tail = result.catch(() => {});
    return result;
  }
  function call(handle, method, ...args) {
    const number = typeof handle === 'number' ? handle : references.get(handle);
    if (!Number.isInteger(number)) return Promise.reject(new Error('Unknown Python bridge handle'));
    return request({ op: 'call', handle: number, method, args: encode(args) });
  }
  function close() {
    if (!closing) {
      fail(new Error('Python bridge is closed'));
      child.stdin.end();
      closing = shutdown(child, { graceMs: 300, termMs: 1000, killMs: 1000 }).then(result => {
        lines.close();
        objects.clear();
        if (!['graceful', 'terminated', 'killed'].includes(result.kind)) throw new Error(`Python bridge cleanup failed: ${result.kind}`);
      });
    }
    return closing;
  }
  return {
    workflowIntegration: {
      Initialize: async () => { await request({ op: 'root' }); return true; },
      GetResolve: () => request({ op: 'root' }),
    },
    call,
    close,
  };
}

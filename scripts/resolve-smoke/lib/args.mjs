/**
 * Pure CLI argument parsing for the ClipDock Resolve headless smoke harness.
 *
 * No Node runtime access on purpose: this is a fully deterministic unit-test
 * seam (test/resolve-headless-args.test.mjs) and must never launch Resolve.
 */

export class ArgError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArgError';
  }
}

export const USAGE = `ClipDock Resolve headless smoke harness (read-only, opt-in).

Starts the official Resolve Studio binary directly with -nogui (never via
"open -a"), connects through the official scripting API (DaVinciResolveScript +
fusionscript.so), performs READ-ONLY checks (version, project manager /
project-list readiness, current project presence/name, media pool and current
timeline presence when available), requests Quit(), and enforces bounded
SIGTERM -> SIGKILL cleanup. Emits one bounded machine-readable JSON report
with sanitized errors to stdout.

Refuses to run when Resolve or fuscript is already active. Never creates,
saves, closes, renames, or deletes projects, timelines, bins, or clips.

Usage:
  node scripts/resolve-smoke/run.mjs [options]

Options:
  --bundle <path>      Resolve .app bundle, Contents/MacOS folder, or the
                       "Resolve" binary itself
                       (default: /Applications/DaVinci Resolve/DaVinci Resolve.app)
  --script-api <path>  Developer/Scripting folder
                       (default: /Library/Application Support/Blackmagic Design/
                        DaVinci Resolve/Developer/Scripting)
  --python <path>      python3 executable (default: python3)
  --probe <path>       probe.py override (default: scripts/resolve-smoke/probe.py)
  --timeout-ms <n>     overall launch+connect deadline for the probe (default: 120000)
  --quit-grace-ms <n>  bounded wait for graceful exit after Quit() (default: 15000)
  --term-wait-ms <n>   bounded wait after SIGTERM before SIGKILL (default: 10000)
  --kill-wait-ms <n>   bounded wait after SIGKILL (default: 5000)
  --pretty             pretty-print the JSON report
  --help               show this help and exit

Exit codes:
  0  ok: read-only checks passed, cleanup completed, no process residue
  1  unexpected harness failure (internal error)
  2  usage error (bad or unknown option)
  3  environment unsupported (platform / bundle / scripting paths / python)
  4  refused: Resolve or fuscript is already active
  5  probe failed (connect timeout, import failure, or checks failed)
  6  cleanup incomplete (Resolve or fuscript process residue)`;

export const DEFAULTS = Object.freeze({
  bundle: '/Applications/DaVinci Resolve/DaVinci Resolve.app',
  scriptApi:
    '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting',
  python: 'python3',
  probe: null,
  timeoutMs: 120000,
  quitGraceMs: 15000,
  termWaitMs: 10000,
  killWaitMs: 5000,
  pretty: false,
  help: false,
});

const NUMERIC_OPTIONS = new Set(['timeout-ms', 'quit-grace-ms', 'term-wait-ms', 'kill-wait-ms']);
const STRING_OPTIONS = new Set(['bundle', 'script-api', 'python', 'probe']);
const FLAG_OPTIONS = new Set(['pretty']);

/** Maps CLI option names to config properties. */
const PROP = {
  bundle: 'bundle',
  'script-api': 'scriptApi',
  python: 'python',
  probe: 'probe',
  'timeout-ms': 'timeoutMs',
  'quit-grace-ms': 'quitGraceMs',
  'term-wait-ms': 'termWaitMs',
  'kill-wait-ms': 'killWaitMs',
  pretty: 'pretty',
};

export function parseArgs(argv) {
  if (argv.includes('--help')) {
    return { ...DEFAULTS, help: true };
  }
  const out = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      break;
    }
    if (!arg.startsWith('--') || arg.length === 2) {
      throw new ArgError(`unexpected argument: ${arg}`);
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inlineValue = eq === -1 ? null : arg.slice(eq + 1);
    if (FLAG_OPTIONS.has(name)) {
      out[PROP[name]] = true;
      continue;
    }
    let value = inlineValue;
    if (value === null) {
      i += 1;
      if (i >= argv.length) {
        throw new ArgError(`missing value for --${name}`);
      }
      value = argv[i];
    }
    if (NUMERIC_OPTIONS.has(name)) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        throw new ArgError(`--${name} expects a positive integer, got "${value}"`);
      }
      out[PROP[name]] = Math.floor(n);
    } else if (STRING_OPTIONS.has(name)) {
      out[PROP[name]] = value;
    } else {
      throw new ArgError(`unknown option --${name}`);
    }
  }
  return out;
}

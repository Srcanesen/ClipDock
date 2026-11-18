/**
 * Path resolution for the ClipDock Resolve headless smoke harness.
 *
 * Maps the user-supplied installation path onto the official layout and
 * composes the official scripting environment variables (RESOLVE_SCRIPT_API,
 * RESOLVE_SCRIPT_LIB, PYTHONPATH) exactly as documented in the Resolve
 * Scripting README. Deterministic unit-test seam
 * (test/resolve-headless-locate.test.mjs); never launches Resolve.
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const WINDOWS_INSTALL = ['Blackmagic Design', 'DaVinci Resolve'];

export function supportsResolveSmoke(platform) {
  return platform === 'darwin' || platform === 'win32';
}

export function resolveDefaults(platform, env) {
  if (platform === 'win32') {
    return {
      bundle: path.win32.join(env.ProgramFiles || 'C:\\Program Files', ...WINDOWS_INSTALL),
      scriptApi: path.win32.join(env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData', ...WINDOWS_INSTALL, 'Support', 'Developer', 'Scripting'),
      python: 'py',
    };
  }
  return {
    bundle: '/Applications/DaVinci Resolve/DaVinci Resolve.app',
    scriptApi: '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting',
    python: 'python3',
  };
}

/** fusionscript.so sits at Contents/Libraries/Fusion/ relative to Contents/MacOS/. */
const SCRIPT_LIB_REL = '../Libraries/Fusion/fusionscript.so';

/**
 * Accepts the .app bundle, its Contents/MacOS folder, or the Resolve binary on
 * macOS, and the install folder or Resolve.exe on Windows.
 */
export function resolveBinary(input, platform = process.platform) {
  if (platform === 'win32') {
    return path.win32.basename(input).toLowerCase() === 'resolve.exe' ? input : path.win32.join(input, 'Resolve.exe');
  }
  const base = path.posix.basename(input);
  if (base === 'Resolve' && !input.endsWith('.app')) {
    return input;
  }
  if (base === 'MacOS') {
    return path.posix.join(input, 'Resolve');
  }
  return path.posix.join(input, 'Contents', 'MacOS', 'Resolve');
}

/** Official scripting library location for a resolved Resolve binary. */
export function scriptLibForBinary(binary, platform = process.platform) {
  if (platform === 'win32') {
    return path.win32.resolve(path.win32.dirname(binary), 'fusionscript.dll');
  }
  return path.posix.resolve(path.posix.dirname(binary), SCRIPT_LIB_REL);
}

/**
 * Composes the official scripting environment: RESOLVE_SCRIPT_API,
 * RESOLVE_SCRIPT_LIB, and PYTHONPATH with $RESOLVE_SCRIPT_API/Modules appended
 * to any existing PYTHONPATH (README: PYTHONPATH="$PYTHONPATH:$RESOLVE_SCRIPT_API/Modules/").
 */
export function scriptEnv(binary, scriptApi, baseEnv = {}, platform = process.platform) {
  const systemPath = platform === 'win32' ? path.win32 : path.posix;
  const modulesDir = systemPath.join(scriptApi, 'Modules');
  const pythonPath = [baseEnv.PYTHONPATH, modulesDir].filter(Boolean).join(systemPath.delimiter);
  return {
    ...baseEnv,
    RESOLVE_SCRIPT_API: scriptApi,
    RESOLVE_SCRIPT_LIB: scriptLibForBinary(binary, platform),
    PYTHONPATH: pythonPath,
  };
}

export function pythonInvocation(python, args, platform = process.platform) {
  if (platform === 'win32') {
    const name = path.win32.basename(python).toLowerCase();
    // Old callers pass the POSIX default. Avoid the Windows Store alias.
    if (name === 'python3' || name === 'python3.exe') return ['py', ['-3', ...args]];
    if (name === 'py' || name === 'py.exe') return [python, ['-3', ...args]];
  }
  return [python, args];
}

function isFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Validates that every official path is present and a regular file/dir.
 * Returns {ok: true} or {ok: false, error: {code, message}}.
 */
export function validatePaths({ binary, scriptApi, scriptLib, platform = process.platform }, { existsFn = existsSync, isFileFn = isFile } = {}) {
  if (!existsFn(binary) || !isFileFn(binary)) {
    return {
      ok: false,
      error: {
        code: 'bundle-not-found',
        message: `Resolve binary not found: ${binary} (use --bundle to point at the installation or binary)`,
      },
    };
  }
  if (!existsFn(scriptApi)) {
    return {
      ok: false,
      error: {
        code: 'script-api-not-found',
        message: `Resolve scripting API folder not found: ${scriptApi} (use --script-api to override)`,
      },
    };
  }
  if (!existsFn(scriptLib) || !isFileFn(scriptLib)) {
    return {
      ok: false,
      error: {
        code: 'script-lib-not-found',
        message: `fusionscript library not found: ${scriptLib}`,
      },
    };
  }
  if (platform === 'win32') {
    const fuscript = path.win32.join(path.win32.dirname(binary), 'fuscript.exe');
    if (!existsFn(fuscript) || !isFileFn(fuscript)) {
      return { ok: false, error: { code: 'fuscript-not-found', message: `Resolve scripting helper not found: ${fuscript}` } };
    }
  }
  return { ok: true };
}

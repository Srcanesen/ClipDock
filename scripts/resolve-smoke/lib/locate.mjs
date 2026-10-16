/**
 * Path resolution for the ClipDock Resolve headless smoke harness.
 *
 * Maps the user-supplied bundle location onto the official macOS layout and
 * composes the official scripting environment variables (RESOLVE_SCRIPT_API,
 * RESOLVE_SCRIPT_LIB, PYTHONPATH) exactly as documented in the Resolve
 * Scripting README ("Mac OS X" block). Deterministic unit-test seam
 * (test/resolve-headless-locate.test.mjs); never launches Resolve.
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

/** fusionscript.so sits at Contents/Libraries/Fusion/ relative to Contents/MacOS/. */
const SCRIPT_LIB_REL = path.join('..', 'Libraries', 'Fusion', 'fusionscript.so');

/**
 * Accepts the .app bundle, its Contents/MacOS folder, or the "Resolve" binary
 * itself, and returns the binary path to spawn with -nogui.
 */
export function resolveBinary(input) {
  const base = path.basename(input);
  if (base === 'Resolve' && !input.endsWith('.app')) {
    return input;
  }
  if (base === 'MacOS') {
    return path.join(input, 'Resolve');
  }
  return path.join(input, 'Contents', 'MacOS', 'Resolve');
}

/** Official fusionscript.so location for a resolved Resolve binary. */
export function scriptLibForBinary(binary) {
  return path.resolve(path.join(path.dirname(binary), SCRIPT_LIB_REL));
}

/**
 * Composes the official scripting environment: RESOLVE_SCRIPT_API,
 * RESOLVE_SCRIPT_LIB, and PYTHONPATH with $RESOLVE_SCRIPT_API/Modules appended
 * to any existing PYTHONPATH (README: PYTHONPATH="$PYTHONPATH:$RESOLVE_SCRIPT_API/Modules/").
 */
export function scriptEnv(binary, scriptApi, baseEnv = {}) {
  const modulesDir = path.join(scriptApi, 'Modules');
  const pythonPath = [baseEnv.PYTHONPATH, modulesDir].filter(Boolean).join(path.delimiter);
  return {
    ...baseEnv,
    RESOLVE_SCRIPT_API: scriptApi,
    RESOLVE_SCRIPT_LIB: scriptLibForBinary(binary),
    PYTHONPATH: pythonPath,
  };
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
export function validatePaths({ binary, scriptApi, scriptLib }, { existsFn = existsSync, isFileFn = isFile } = {}) {
  if (!existsFn(binary) || !isFileFn(binary)) {
    return {
      ok: false,
      error: {
        code: 'bundle-not-found',
        message: `Resolve binary not found: ${binary} (use --bundle to point at the .app or binary)`,
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
  return { ok: true };
}

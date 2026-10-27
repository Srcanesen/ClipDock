# REVIEW.md

## What this repo is
ClipDock, a DaVinci Resolve Studio Workflow Integration panel (Electron) that finds media on YouTube, social sites, Pinterest, Pexels and Pixabay, downloads it with yt-dlp, gallery-dl or HTTP, prepares it with ffmpeg, and imports it into the open Resolve project, bin and timeline. `AGENTS.md` holds the verification ladder; `GLOSSARY.md` holds the domain words.

## Already enforced: do not re-flag
`npm test` (unit and integration suites, fake spawn and fake Resolve seams) and `npm run check` (build plus the shipped-surface rules that `npm run verify` prints: completed build, preload and IPC contract, path boundary, Electron and native-preview security, credential command, hygiene). `npm run test:resolve:headless` and `npm run test:resolve:e2e` cover the Resolve API surface and the download → prepare → import → timeline chain against real Resolve.

## Risk tiers
- high: `scripts/install-plugin.mjs`, `scripts/lib/install-files.mjs`, `scripts/resolve-smoke/**`, `src/safe-fs.ts`, `src/path-boundary.ts`, `src/managed-root.ts`, `src/workspace.ts`, `src/file-lock.ts`, `src/history.ts`, `src/download-ledger.ts`, `src/pexels-credential.ts`, `src/preload.ts`, the Electron and native-preview setup in `src/main.ts`, `package.json` dependency changes.
- low: docs only, with no code path changed.
- normal: everything else.

## What counts as a bug

### Long-running work: healthy work dies, or finished work is thrown away
- L1 Flag a fixed wall-clock timeout on work whose length grows with its input (download, conversion, merge, `+faststart` rewrite, copy). A timeout catches a hung process: it resets on real progress, and a phase that legitimately prints nothing gets a window sized by what it processes (bytes, duration). Flag a window computed from a quantity that does not bound that phase.
- L2 Flag a failure path whose cleanup deletes the output of an earlier step that already succeeded, unless the failure is real (not a timeout or cancel misfire).
- L3 Flag a child process, timer or listener that can outlive cancel, dispose or panel teardown, and output buffered without a bound or kept when nothing reads it.

### Engines and tools: the user gets the wrong outcome or message
- E1 Flag argv built from a URL, title, range label or metadata field without the existing validation (absolute `https://`, allow-lists, `literalPath`).
- E2 Flag a decision on yt-dlp, gallery-dl or ffmpeg output that ignores the real output order (`--print before_dl` lines, progress templates, stderr last line). Test fixtures must emit what the real tool emits, in its order.
- E3 Flag an error, 429 or network failure shown as "no results", a generic "failed" where a specific cause is known, or a provider key in a URL, log, error or IPC payload.

### Resolve: the wrong project, bin or timeline changes
- R1 Flag a Resolve API call whose null or false return is treated as success.
- R2 Flag a mutation (`AddItemListToMediaPool`, `AppendToTimeline`, `AddMarker`, `SetClipColor`, `AddSubFolder`) that can run after a project, timeline or bin switch without the `GetUniqueId` identity check that stops it. A cheaper check is fine; a changed abort decision is a bug.

### Files: data outside ClipDock's own folders is touched
- F1 Flag deletion, replacement or rename whose target is not proven inside the managed root by identity (device and inode), including symlinked components and swapped parents.
- F2 Flag a destructive install or reconcile on a destination that is not proven to be ClipDock's own (`com.clipdock.app` with its manifest `<Id>`).
- F3 Flag any consumer of `dist/` (runner, live check, installer) that loads it without `validateCompletedBuild` or `requireCompletedBuild`.
- F4 Flag a stored file (settings, history, ledger, credential) written non-atomically, or whose parse error blocks the app instead of being quarantined.

### Panel: the user sees a stale or false state
- U1 Flag a periodic or focus refresh that overwrites a transient action result before it can be read, and a transient result that never leaves.
- U2 Flag a refresh that resets list state the user built (shown batch, scroll, focus) when only the query or a filter should reset it.
- U3 Flag a keyboard shortcut or programmatic `click()` that acts on a control the user cannot see on the current page.
- U4 Flag remote or provider text reaching `innerHTML`, and a full list or grid rebuild on a per-item event (toggle, keystroke, pointer move).

### Tests: they cannot catch the bug they claim to cover
- T1 Flag a test with no literal expected value or observable effect, one that would pass if the code under test returned nothing.
- T2 Flag a bug fix with no regression test that fails on the old code, and an existing assertion edited to match new output with no reason in the diff.

### Docs: they lie
- D1 Flag a line in `AGENTS.md`, `GLOSSARY.md`, `README.md`, `scripts/resolve-smoke/README.md` or a code comment whose stated behaviour, command or rule the code contradicts.

## What to skip
- Paths: `dist/`, `output/`, `node_modules/`, `package-lock.json`, `static/fonts/`, `docs/*.gif`, `docs/*.jpg`.
- Duplication with no behaviour bug, capacity trade-offs inside a stated limit, and check-then-act windows of the same class `src/safe-fs.ts` already documents as accepted.
- Nits: at most 3 per review, each labelled `nit`, listed after every bug. Propose no refactor, abstraction or option the diff did not need.

## Evidence
- Every finding cites `path:line` and quotes the line. Read the code that runs; do not judge a function by its name.
- A claim about yt-dlp, gallery-dl or ffmpeg behaviour cites the tool's source or a measured run. A claim about Resolve behaviour cites the headless or e2e harness output. Mark anything else `unverified` with the reason.

## Output
- The first line is the count: `N findings (B bugs, K nits)`. When there are none, write `0 findings. No issues.` and stop.
- Then one line per finding, most severe first: `[rule] path:line: what breaks, for whom. Fix: one line.`

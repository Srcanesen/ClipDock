# ClipDock Resolve headless smoke harness (read-only, opt-in)

`scripts/resolve-smoke/` implements the official `-nogui` headless smoke for the
ClipDock Resolve scripting surface: a real Resolve Studio process, no window, no
Workflow Integration plugin.

## Exact scope

This harness verifies the **Resolve scripting API shape only** over the official
scripting path (`DaVinciResolveScript` module + `fusionscript.so`, env vars
`RESOLVE_SCRIPT_API` / `RESOLVE_SCRIPT_LIB` / `PYTHONPATH` exactly as the
Resolve Scripting README documents):

- `GetVersionString()`
- ProjectManager presence and project-list readiness
  (`GetProjectManager` + polled `GetProjectListInCurrentFolder()`)
- Current project presence/name (`GetCurrentProject` / `GetName`)
- Media Pool presence (`GetMediaPool`) and current timeline presence/name
  (`GetCurrentTimeline` / `GetName`) when a project is open
- **`transferApi`: the read-only Resolve API shape `src/transfer.ts`
  depends on**, as compact `required`/`optional` callable-presence maps:
  - required: `resolve.GetMediaStorage/GetProjectManager/OpenPage`,
    `projectManager.GetCurrentProject`, `project.GetCurrentTimeline/GetMediaPool/GetSetting`,
    `timeline.GetStartFrame/GetStartTimecode/GetCurrentTimecode`,
    `mediaPool.GetCurrentFolder/GetRootFolder/AddSubFolder/SetCurrentFolder/AppendToTimeline`,
    `folder.GetName/GetSubFolderList/GetClipList`,
    `mediaStorage.AddItemListToMediaPool`, `clip.GetClipProperty`
  - optional (feature-detected by `transfer.ts`, recorded but never red):
    `timeline.AddMarker/GetEndFrame`, `clip.SetClipColor`
  - mutating APIs are checked by **callable presence only and never invoked**
    (`OpenPage`, `AddItemListToMediaPool`, `AddSubFolder`, `SetCurrentFolder`,
    `AppendToTimeline`, `AddMarker`, `SetClipColor`); the bounded `mutating`
    list makes that explicit in the report
  - safe read-only calls verify getters actually answer: `GetMediaStorage`,
    `GetSetting('timelineFrameRate')`, `GetCurrentFolder`, `GetRootFolder`,
    `GetSubFolderList`, `GetClipList`, `GetName`, `GetStartFrame`,
    `GetStartTimecode`, `GetCurrentTimecode`, and `GetClipProperty('File Path')`
    on an existing clip from the current folder only
  - a required callable **missing on a reachable object fails the probe
    (exit 5)**; entries whose owning object is unreachable (no project / no
    timeline / no clip) are reported as `"unavailable"` and do **not** fail,
    so no-project/no-timeline runs stay valid while availability is explicit

It does **not** cover — and cannot cover — the `WorkflowIntegration.node`
bridge, panel loading inside the Resolve GUI (`Workspace → Workflow
Integrations`), or native drag (`webContents.startDrag`). Those boundaries
remain manual GUI smoke checks per the repo README. `-nogui` also never loads
the WI plugin (no menu, undocumented behavior).

## Safety invariants

- Refuses to run when **any Resolve process is already active** (pre-flight
  `pgrep -x Resolve` check).
- Launches the **bundle binary directly with `-nogui`** — never `open -a`
  (LaunchServices silently drops `-nogui`).
- Configures the **official scripting env paths** for both spawned processes.
- Waits **bounded** for `scriptapp` and ProjectManager readiness
  (`--timeout-ms`, default 120 s); the probe polls `GetProjectListInCurrentFolder()`
  as readiness evidence, not just `scriptapp`.
- **Read-only checks only.** The probe never calls any mutating API; the
  harness never creates, saves, closes, renames, or deletes projects,
  timelines, bins, or clips. Mutating APIs needed by `src/transfer.ts`
  (`OpenPage`, `AddItemListToMediaPool`, `AddSubFolder`, `SetCurrentFolder`,
  `AppendToTimeline`, `AddMarker`, `SetClipColor`) are verified by callable
  presence only, and the deterministic unit tests guard every one of them with
  methods that raise and write a sentinel if ever invoked.
- **Ownership-gated `Quit()`** (closes the preflight/connect TOCTOU): the probe
  may call `Quit()` only when the running `pgrep -x Resolve` PID set is exactly
  the child PID this harness spawned (passed via `RESOLVE_SMOKE_CHILD_PID`),
  for both the normal probe and the quit-only fallback. When ownership cannot
  be proven, Quit is skipped and a sanitized `quit-ownership-unproven` error is
  reported (exit 5). Parent cleanup signals **only its own child**.
- Requests `Quit()` from the probe and enforces a **bounded TERM → KILL**
  ladder (`--quit-grace-ms` / `--term-wait-ms` / `--kill-wait-ms`).
- Verifies **no `Resolve` or `fuscript` process remains** (residue evidence in
  the report) and fails the run otherwise; a failed residue check (pgrep
  failure) exits `cleanup-failed`, never 0.
- Emits **one bounded machine-readable JSON report** with sanitized, capped
  error messages; child stderr is captured through a bounded ring buffer.

## Requirements (first supported environment)

- macOS (Resolve Studio 21; anything else fails with `unsupported-platform`).
- Resolve Studio with external scripting enabled (System → "External scripting
  using": Local or Network) — Free Resolve does not support external scripts.
- Python >= 3.6 64-bit on `PATH` (or `--python`).

## Usage

```sh
node scripts/resolve-smoke/run.mjs              # defaults: official macOS layout
node scripts/resolve-smoke/run.mjs --help       # options + exit codes
node scripts/resolve-smoke/run.mjs --pretty     # pretty JSON report
npm run test:resolve:headless                   # equivalent npm entry (opt-in)
```

Options (all bounded):

| Option | Default |
|---|---|
| `--bundle <path>` | `/Applications/DaVinci Resolve/DaVinci Resolve.app` |
| `--script-api <path>` | `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting` |
| `--python <path>` | `python3` |
| `--probe <path>` | `scripts/resolve-smoke/probe.py` |
| `--timeout-ms <n>` | `120000` |
| `--quit-grace-ms <n>` | `15000` |
| `--term-wait-ms <n>` | `10000` |
| `--kill-wait-ms <n>` | `5000` |
| `--pretty` | off |

Exit codes: `0` ok · `1` unexpected harness failure (internal error) · `2` usage ·
`3` environment (platform/bundle/python/scripting paths) · `4` refused (Resolve
already running) · `5` probe failed (connect timeout/checks/Quit ownership not
provable) · `6` cleanup incomplete (process residue, or residue evidence
unavailable).

## Files

- `run.mjs` — orchestration: pre-flight → spawn → probe → Quit → TERM/KILL → residue → JSON.
- `probe.py` — the read-only Python probe (stdlib + official module only);
  reports the `transferApi` shape `src/transfer.ts` depends on (required
  callables fail exit 5 when missing on a reachable object; mutating APIs are
  presence-checked and never invoked); Quit is ownership-gated on
  `pgrep -x Resolve` == harness child PID.
- `lib/args.mjs` — pure CLI parsing seam.
- `lib/locate.mjs` — bundle/scripting path + official env composition seam.
- `lib/spawn.mjs` — bounded buffers, wait/TERM/KILL ladder, pgrep accounting seam.
- `lib/probe.mjs` — probe execution + marked-JSON parsing seam.
- `lib/report.mjs` — sanitized bounded JSON report seam.

Deterministic unit tests for these seams live in
`test/resolve-headless-*.test.mjs` and run inside `npm test`; they never launch
Resolve (fake probe scripts, plain `node -e`/`sleep` children, injected seams).

## Transfer end-to-end gate (mutating, opt-in)

```sh
npm run build
npm run test:resolve:e2e
node scripts/resolve-smoke/e2e.mjs --help
# Optional network leg (YouTube or a supported social URL):
npm run test:resolve:e2e -- --download-url=https://www.youtube.com/watch?v=VIDEO_ID
```

The separate e2e runner uses the real built `transfer.js`, `status-provider.js`,
and `media-prep.js` over a long-lived Python scripting bridge into Resolve
Studio `-nogui`. It generates local ffmpeg fixtures (including a Unicode path
and odd video dimensions), then reads back project status, duplicate-safe Media
Pool imports, the ClipDock bin, timeline appends, chapter markers, playhead
insertion, and a fast-profile preparation/import. Default runs need no network;
`--download-url` adds the real ClipDock yt-dlp worker and an import read-back.
ffmpeg and ffprobe must be discoverable by ClipDock. Build first; the runner
refuses a missing `dist/transfer.js`. Each JSON check includes expected/actual
values and `pass`, `fail`, or `unavailable` (absent AddMarker or unsupported
playhead insertion). Exit codes: 0 passed/unavailable, 2 usage, 3 setup failure,
4 Resolve already running, 5 failed check, 6 cleanup failure.

It refuses when Resolve is active and mutates only its own fresh
`ClipDock-E2E-<timestamp>-<pid>` project. Each transfer mutation checks the exact
current project name and spawned PID ownership. Project creation is the initial
bootstrap exception (a unique name is checked before creation); deletion runs
only after closing the verified test project, with a prefix check. Cleanup
always attempts project close/delete, bridge close, ownership-gated Quit and
bounded shutdown, residue verification, and fixture removal, in that order.
No existing project is deleted. Fake-Python tests in `test/resolve-e2e-*.test.mjs`
run without Resolve.

This gate still cannot verify `WorkflowIntegration.node`, panel loading in the
GUI, native drag, or rendered UI. Those require the installed/restarted GUI
verification flow; a headless pass is not visual or live panel evidence.

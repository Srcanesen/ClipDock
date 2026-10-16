# ClipDock glossary

Domain terms used in code, tests and reviews. Use these names for modules and in commit messages.

## Results and output

**Result**: one item returned by a provider search or a pasted URL (YouTube, social, Pinterest, Pexels).

**Staged selection**: a result the user has picked for download but not yet queued.

**Item output**: the effective settings a staged selection will download with: media mode, profile (intent), quality or Pexels rendition, trim range and target bin. It is resolved from the common defaults plus the card's own overrides.

**Common defaults**: the item output values that apply to every staged selection that has no override.

**Item output session**: the renderer module that owns staged selections, per-card overrides, the common defaults, the inspector draft and the identity of the selected result. Rendering reads it; only user input commits to it.

**Inspector draft**: the values shown in the detail inspector for the selected result before they are committed to its item output.

**Download queue**: the renderer module that turns a resolved item output into ordered queue items, from every entry path, and owns their execution, transfer outcomes and card invalidation. The host API reaches it through an injected adapter.

## Download jobs

**Provider**: a media source with its own engine: yt-dlp (YouTube and social), gallery-dl (Pinterest), the Pexels API.

**Provider job**: one admitted unit of provider work (metadata, search or download, plus media preparation). It has one cancellation scope, owns the files it creates until it publishes them, and ends with exactly one terminal outcome: completed, failed or cancelled.

**Provider job runner**: the module that admits provider work (job id and engine prerequisites), owns its cancellation and unpublished files, classifies errors, and selects and emits the job's single terminal outcome. Providers do provider work and throw; busy and disposed rejections are typed, never matched by message text.

**Engine host**: the Electron-free main-process module that owns discovered-engine readiness, the worker-per-role table, managed-root capture per operation, provider dispatch and cancellation, folder changes and shutdown order. `main.ts` only registers IPC channels from a provider descriptor table; tests supply fake workers through the worker-factory adapter.

**Media preparation**: the ffmpeg step that turns a downloaded file into the chosen output profile.

## Ownership

**Managed root**: the download folder ClipDock owns. It is captured once as a verified canonical identity; consumers receive that value and never re-canonicalize a stored string.

**Anchored directory**: a directory within a managed root whose identity and intervening directories remain bound to that root. A replacement at the same pathname is a different directory.

**Card**: the main process's record for one downloaded artifact that the renderer may drag, transfer or delete, addressed by an opaque card id.

**Download ownership ledger**: the main-process module that owns cards, their subtitle companions, their history binding, the set of paths protected from cleanup, and the delete decision.

**History**: the persisted, capped media library of past downloads.

## Tooling

**Shipped-surface rules**: named checks on the built and source tree that guard security and architecture invariants (for example: the preload exposes no Node API). Behaviour is tested in `test/`, not here.

**Completed build**: a `dist/` tree with a build record proving it came from the current sources.

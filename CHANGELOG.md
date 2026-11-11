# Changelog

All notable changes to ClipDock are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and ClipDock follows [Semantic Versioning](https://semver.org/).

## [0.3.2] - 2026-11-11

### Added

- **ClipDock icon in the macOS Dock.** The panel shows its own icon in the Dock instead of the default Electron icon.

### Fixed

- **Long downloads and conversions are no longer cut off.** A download or conversion that is still making progress runs until it finishes; ClipDock stops it only when progress stalls.
- **The download is kept when conversion fails.** The original file is recorded in History, and the error message says so, instead of being deleted. If it cannot be recorded in History, it is removed as before.
- **Media with a shifted start time prepares correctly.** A valid Matroska file whose timestamps do not start at zero no longer fails the duration check.
- **A damaged history file no longer blocks History.** ClipDock sets the damaged file aside and History and queue actions keep working without a restart.
- **Connection status recovers after a hung check.** A status check that never answers no longer blocks every later refresh.
- **Failed Pinterest lookups are reported as errors** instead of an empty "no results" page.
- **Subtitle trimming stays in step.** Reloading subtitles clears the old line selection, and lines from a previously selected language no longer replace the current one.
- **Next and Previous page use the search on screen**, not text typed into the box but not yet searched.
- **Selecting a chapter or subtitle line keeps keyboard focus** on the checkbox.
- **Engine detection no longer hangs** on a download tool that does not answer its version check.
- **The cleanup result stays visible** long enough to read.
- **Installation is more robust.** An interrupted install no longer blocks later builds and installs, and an administrator install leaves files that Resolve can read.

### Changed

- The Resolve manifest version now matches the package version, and the build check fails if they differ.
- Security fixes target the latest released series (see `SECURITY.md`).
- For contributors: `npm run preview` refuses a stale or incomplete build, and its sample states queue the downloads they advertise.

## [0.3.1] - 2026-10-30

### Fixed

- **Accurate warnings after deleting downloads.** If a file is deleted but download history cannot be updated, ClipDock reports that failure even when another warning is present.

### Changed

- **Internal cleanup.** Code comments were pruned and the rules they described are now enforced by automated tests; behaviour is unchanged.

## [0.3.0] - 2026-10-28

### Added

- **Orientation filter in search.** Icon buttons beside **Search** filter results by All, Vertical, Horizontal or Square. Pexels uses its own orientation filter; Pixabay and Pinterest filter on media dimensions. On YouTube, Vertical searches Shorts and Horizontal shows regular videos; Square is not offered there.
- **Bulk delete in History.** Select several records (Shift+click selects a range, **Select visible** selects the filtered rows) and delete their files in one step. The confirmation lists the selected titles and separates files that will be deleted from entries that will only leave History.
- **Clear finished in Downloads.** Removes finished, failed and cancelled items from the list without deleting files; they stay in History's **This session**.
- **History thumbnails** for local media, cached between sessions.

### Changed

- The paste-link source is now called **Social**.
- The first page of YouTube search results appears before the full search finishes.

### Fixed

- Slow but progressing downloads, conversions and stock downloads are no longer stopped by a fixed 30-minute limit; hung tools are stopped by silence instead.
- Pasting a YouTube or Pin URL and then changing orientation no longer reloads the item.
- Removing an item from the Downloads list no longer removes it from History's **This session**.
- Pinterest selections from opaque search results resolve correctly, and numeric Pin IDs keep their behaviour.
- The 2 GB download limit is reported when yt-dlp skips a file for size.
- Marker placement stops at the first destination switch.
- The installer refuses destinations that are not ClipDock's own folder, and scripts refuse a stale `dist/`.
- Action results in the footer expire after a bounded time, and the download folder error appears in Settings.

## [0.2.1] - 2026-10-21

### Fixed

- The search results toolbar no longer lets **Mark all** spill over the detail panel when a preview narrows the results column; the controls now wrap onto a second row.

### Changed

- Test fixtures no longer contain a personal username.
- `.env` files are ignored by Git.

## [0.2.0] - 2026-10-21

### Added

- **Pixabay stock videos.** Pexels and Pixabay now share one **Stock** tab; switch between them with the source toggle. Pixabay is video only.
- **Pixabay key in Settings.** Get a free key from the [Pixabay API docs](https://pixabay.com/api/docs/) while logged in (it appears under **Parameters → `key`**) and paste it in ClipDock **Settings**. On macOS it is stored in Keychain, separately from the Pexels key.
- **Pixabay attribution.** Results show "Results from Pixabay", and each video credits its creator ("Video by {user} on Pixabay").

### Fixed

- Pexels and Pixabay previews no longer close when you drag the player's seek bar.
- Previews now scroll with the detail panel instead of staying fixed over the settings, and the YouTube player stays inside the panel.

### Changed

- Renderer preview, status refresh and metadata state moved into their own session modules.
- yt-dlp, gallery-dl and the stock sources share session admission, discovery and abortable fetch plumbing.

## [0.1.0] - 2026-10-16

- Initial public release.

[0.2.1]: https://github.com/Srcanesen/ClipDock/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Srcanesen/ClipDock/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Srcanesen/ClipDock/releases/tag/v0.1.0

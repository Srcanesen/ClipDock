# Changelog

All notable changes to ClipDock are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and ClipDock follows [Semantic Versioning](https://semver.org/).

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

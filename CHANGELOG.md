# Changelog

All notable changes to ClipDock are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and ClipDock follows [Semantic Versioning](https://semver.org/).

## [0.4.0] - 2026-11-19

### Added

- **Windows support.** Installation, YouTube and Pinterest search, downloads, and dragging downloaded files into Resolve were tested on Windows 11 with DaVinci Resolve Studio 21.2.

### Changed

- **ClipDock finds download tools in more places on Windows.** It looks for yt-dlp, gallery-dl, ffmpeg and Deno in WinGet locations, and for gallery-dl installed with `pip --user`, including with Microsoft Store Python. When a tool is missing, ClipDock tells you how to install it.
- **The release zip can now be built on Windows too.** It includes the same plugin files and install instructions as the macOS zip.

### Fixed

- **YouTube downloads no longer fail with “Choose a usable download folder” on Windows when the folder is valid.**
- **The Windows installer can recover from an interrupted install even if Windows gives the previous installer's process number to another program.**

## [0.3.4] - 2026-11-17

### Added

- **Warning before deleting a file that was sent to DaVinci Resolve.** ClipDock now remembers, across restarts, that a file was imported, added to a timeline or dragged into Resolve. The delete confirmation in History and Downloads says that deleting the file takes the clip offline in Resolve. Deleting stays possible.
- **Release zip.** Releases now include `ClipDock-<version>.zip` with the built plugin and install steps, so installing no longer needs Node.js or a build.

### Changed

- **Delete old downloads keeps files that were sent to Resolve.** They are not counted or removed by the cleanup in Settings; delete them one by one from History instead.
- **A file dragged from History into Resolve is protected for the session**, like a file imported with ClipDock's own buttons.
- **Retrying the conversion of a file that was sent to Resolve keeps the original.** The converted file is added as a separate History entry.
- **A running transfer or conversion blocks deletion only of the files it uses.** Other History entries can be deleted meanwhile.
- **ClipDock deletes and converts files only in folders it owns:** the current download folder, the default folder, and folders it marked as its own. History entries from any other folder stay listed and can still be imported, but ClipDock leaves their files alone.

### Fixed

- **Files are no longer left without a History entry after a crash.** If ClipDock stops between finishing a download or conversion and saving it to History, the next start adds the entry and tidies up an interrupted retry. A crash in the short moment before ClipDock has noted the new file is not covered; **Delete old downloads** still removes such a file.
- **Row menus open on screen.** The three-dot menu of a History row opens downward when there is no room above.
- **A transfer or drag no longer fails because ClipDock could not save its note** that the file was sent to Resolve.

## [0.3.3] - 2026-11-11

### Added

- **Retry conversion in History.** A download that was kept after a failed conversion shows a **Not converted** label and a **Retry conversion** button. The retry uses the conversion you chose for the download, shows its progress in the row, and can be cancelled. On success the same History entry points to the converted file. If the retry fails or is cancelled, the original file stays as it was. If the original is still in use, it is kept and the converted file is added as a separate entry. Cards in **Downloads** follow the file they belong to, and a running conversion keeps its **Cancel** button after the panel reloads. The button appears for conversions that fail from this version on.

### Changed

- **Conversions wait their turn.** A retry and a download that reaches conversion at the same time now run one after the other instead of one of them failing.
- An entry cannot be deleted or relinked, and History cannot be cleared, while a conversion is running; cancel the conversion first.

### Fixed

- **A lock left by a crashed session is released** even when the system has given the crashed session's process number to another program, so History and saved credentials do not stay blocked. To stay safe, this applies only when that program started at least five minutes after the lock was taken.

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

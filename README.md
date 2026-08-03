# ImageExplorer

A modern, fast file manager for macOS — built with Rust and React.

[English](./README.md) | [中文](./README.zh-CN.md)

ImageExplorer brings the best of Windows Explorer to macOS: an editable address bar, a persistent folder tree, and blazing-fast Everything-style search — all wrapped in a native macOS design.

It is also built for a practical photography workflow: open a folder of camera files, compare a burst of similar frames in icon view, identify repeated viewpoints, check the estimated focus area, and send the selected RAW file to Camera Raw or another editor.

![ImageExplorer Screenshot](./docs/screenshot.png)

## Photo review workflow

The optional **View & Focus Analysis** mode turns icon view into a fast contact sheet for RAW review. It is off by default, so ordinary folders keep the lightweight Finder-like experience until you enable it from the icon-view toolbar.

![Icon view with focus analysis and view grouping](./docs/screenshots/icon-view-focus-analysis.png)

When the mode is enabled:

1. Similar frames are compared using a low-resolution visual fingerprint and grouped by viewpoint, even when they are not adjacent in filename order.
2. Each group receives a rotating background tint so a burst or repeated composition is easy to scan.
3. A small focus box is drawn over each thumbnail. The marker follows the image during Quick Look zoom, and the preview footer reports its normalized position, confidence, and estimation method.
4. Camera metadata is loaded lazily below the filename when macOS exposes it: dimensions, ISO, aperture, shutter speed, focal length, camera body, and lens.

### Camera AF metadata

When the source file contains Sony MakerNote focus coordinates, ImageExplorer
uses ExifTool to read `FocusLocation`/`FocusFrameSize` (and the documented
`FlexibleSpotPosition` fallback). Those rectangles are rendered as solid cyan
boxes and labelled **Camera AF**. A dashed amber box means the file did not
provide a drawable camera rectangle and the app is showing its separate
sharpness estimate instead; it is never presented as the camera's AF result.
Sony AF metadata may contain only the selected area's center point: in that
case the cyan box is explicitly marked as an approximate display frame and a
small dot marks the recorded center. Only `FocusLocation` together with
`FocusFrameSize` is treated as an exact camera rectangle.

Install ExifTool on macOS with `brew install exiftool`, or set
`IMAGEEXPLORER_EXIFTOOL`/`EXIFTOOL_PATH` to a bundled or standalone executable.
If a Sony file has no AF coordinates, the UI reports that explicitly. The
official tag definitions are maintained in the [ExifTool Sony MakerNote
reference](https://exiftool.org/TagNames/Sony.html).

![Repeated viewpoints highlighted in icon view](./docs/screenshots/icon-view-focus-groups.png)

![RAW/JPEG pairs in icon view](./docs/screenshots/icon-view-raw-pairs.png)

Press **Space** to open Quick Look, use the arrow buttons or Left/Right keys to move through the folder, and hold **⌘/Ctrl + scroll** to zoom around the pointer. Adjacent RAW previews are prefetched so moving through a sequence feels immediate.

![Quick Look zoom with focus marker](./docs/screenshots/quick-look-zoom-focus.png)

> Camera AF boxes are only drawn from coordinates actually present in the file's Sony MakerNote. When those tags are absent, the dashed estimate is a selection aid rather than a replacement for checking the full-resolution RAW.

## Features

- **Editable Address Bar** — Navigate by typing paths, copy/paste with Cmd+C/Cmd+V, breadcrumb clicking
- **Folder Tree Sidebar** — Windows-style collapsible tree with lazy loading
- **Mounted Volumes** — Shows mounted USB, external, and network volumes in the sidebar Locations section, refreshes after mount/unmount, and requests macOS folder access when a volume has not been authorized yet
- **Resizable Sidebar** — Drag the sidebar divider to adjust its width, drag it to the edge to hide it, and use the attached edge handle to click or drag it back open; the setting is remembered
- **Everything-Style Search** — Millisecond-level full-disk search powered by SQLite FTS5 + Rust, with an anchored result panel that stays above the file content and supports Finder-like selection, context-menu actions, and inline rename
- **Finder-Like Thumbnails** — Native thumbnail previews in icon/list views, including common camera RAW formats, generated through in-process Quick Look with progressive loading and caching for large folders
- **Optional Photo Analysis** — Group similar viewpoints globally, cycle distinct group colors, and mark an estimated focus region without changing the default lightweight browsing mode
- **Focus-Aware Quick Look** — Space-bar preview with Core Image RAW decoding, progressive loading, adjacent-image prefetching, pointer-centered zoom, and focus data beneath the image
- **EXIF-at-a-Glance** — Lazy, bounded-concurrency metadata loading for visible icon cards so camera settings appear without delaying folder layout
- **Finder-Like Selection & Rename** — Subtle native-style selection states; in icon/list views, click a selected filename to rename it inline (Enter confirms, Escape cancels)
- **Multi-Tab & Multi-Window** — Drag tabs between windows while preserving their navigation history; detached tabs open with their current folder and history; move files and folders into another window or its current folder, with source and destination views refreshed after completion
- **Cmd+X Cut** — Native cut support, no more Cmd+C → Cmd+Option+V
- **Queued File Operations** — Copy, move, and trash operations run through a sequential queue with cancellation, progress, errors, history, and a persistent operation center
- **One-Step Undo** — Completed copy and move operations keep a reversible history entry and can be undone from the operation center; delete operations remain recoverable through the system Trash
- **Name Conflict Resolution** — Before copy or move, choose to keep both, replace the existing item by moving it to Trash, skip conflicts, or cancel
- **Trash Management** — Open the system Trash from the sidebar to browse items, restore them to their original location, or empty the Trash
- **ZIP Workflows** — Compress selected files/folders to a ZIP or extract a ZIP from the context menu; archive work runs through the operation center
- **Item Info Inspector** — Use “Get Info” to inspect path, size, timestamps, permissions, ownership, package, alias, and symbolic-link details
- **Favorites & Recent Locations** — Keep frequently used folders in a persistent Favorites section and revisit the latest directories from the Recent section
- **QuickLook Preview** — Press Space to preview files (text, images, video, audio, PDF, HEIC, DNG, PSD), with native macOS thumbnail fallback for unsupported formats
- **Context Menus** — Windows-style right-click with 20+ actions, Finder-like sorting and arranging: "New File", "Open in New Tab" for folders, "Open in Terminal", "Copy Path", etc.
- **Dark Mode** — Light / Dark / System theme
- **i18n** — English and Simplified Chinese

## Development Roadmap

The current implementation status is tracked by milestones:

| Milestone | Status | Scope |
| --------- | ------ | ----- |
| M1 | Complete | Rich file metadata, hidden-item discovery, and a show-hidden-files setting |
| M2 | Complete | Copy/move/delete queue, progress center, cancellation, and cross-window refresh events |
| M3 | Complete | Same-name conflict dialog with keep-both, replace-to-Trash, skip, and cancel decisions |
| M4 | Complete | In-memory operation history and one-step undo for completed copy/move actions |
| M5 | Complete | Trash browsing/restore/empty controls and queued ZIP archive workflows |
| M6 | Complete | Package, alias, and symbolic-link identification, cross-platform item details, and metadata boundary tests |
| M7 | Complete | Persistent Favorites and Recent Locations with file-menu and sidebar management |
| M8 | Complete | Performance hardening, bounded thumbnail cache, watcher lifecycle management, resilient queued operations, disk-space preflight, persistent recovery state, SQLite migrations/integrity repair, updater integration, and release checks |

M3 conflict decisions are applied to the whole pending operation. The default keep-both behavior preserves the existing automatic unique-name fallback. M4 undo removes copied results or moves moved items back to their original directory; deleted items remain available through the operating system Trash.

M5 uses the platform Trash APIs where available and Finder automation on macOS. ZIP compression uses `ditto` on macOS and `zip`/`unzip` on other platforms.

M6 reloads filesystem metadata when “Get Info” opens so lightweight search-index entries do not hide the real attributes. Packages are identified by directory extension, `.alias` files are marked as aliases, and macOS Finder aliases are detected through Spotlight metadata and resolved through Finder automation. Symbolic links preserve both the link and its target path.

M7 stores Favorites and up to twelve Recent Locations in the application settings store. Favorites are limited to directories so sidebar navigation remains unambiguous; both sections support opening locations from the sidebar, while context menus can remove entries without changing the filesystem.

### Performance and release hardening

- Directory rendering remains virtualized; the backend indexer writes bounded batches instead of retaining a full million-file scan in memory.
- Copy/move jobs perform a best-effort destination free-space preflight, retry transient I/O/network errors, report recursive directory byte totals, and persist operation snapshots. Queued/running work is marked recoverable after an unexpected restart instead of disappearing.
- Thumbnail memory is bounded by an LRU cache (entry and byte limits). Directory watchers use reference counting so multiple windows share one watcher and release it when the last view leaves.
- SQLite uses a versioned migration table, WAL settings, integrity checks, and automatic backup/recreation when the index database is corrupt. A failed/incomplete index build is detected and rebuilt.
- `pnpm perf:smoke` provides repeatable host filesystem baselines. It intentionally does not claim a Tauri IPC or React P95; device-specific 100k/1M/100GB measurements remain part of release validation.
- The signed Tauri updater is wired through `tauri-plugin-updater`. Replace the placeholder public key in `src-tauri/tauri.conf.json` and configure `TAURI_SIGNING_PRIVATE_KEY` plus Apple signing/notarization secrets before distributing builds.
- `pnpm release:check` validates bundle, entitlements, updater metadata, and release prerequisites. The macOS workflow in `.github/workflows/release.yml` performs strict signing/notarization checks when the required Apple secrets are present.
- The full release gate is documented in [docs/performance-release-checklist.md](./docs/performance-release-checklist.md).
- Permission behavior and stored-data boundaries are documented in [docs/permissions.md](./docs/permissions.md).

## Tech Stack

| Layer | Technology |
| ----- | ---------- |
| Desktop Framework | [Tauri 2](https://tauri.app/) |
| Frontend | React 19 + TypeScript 5.8 |
| Backend | Rust (2021 edition) |
| Styling | Tailwind CSS 4 + shadcn/ui |
| Search Engine | SQLite FTS5 + parallel filesystem traversal |
| Build Tool | Vite 7 |
| Package Manager | pnpm |

## Build from Source

**Prerequisites:**

- [Node.js](https://nodejs.org/) (LTS)
- [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/tools/install)
- Xcode Command Line Tools (`xcode-select --install`)

```bash
# Clone the repository
git clone git@github.com:callback-io/ImageExplorer.git
cd ImageExplorer

# Install dependencies
pnpm install

# Run in development mode
pnpm tauri dev

# Build production app (.dmg)
pnpm tauri build
```

## Development

### Commands

| Command | Description |
| ------- | ----------- |
| `pnpm tauri dev` | Start app with hot reload |
| `pnpm tauri build` | Build production app bundle |
| `pnpm dev` | Frontend dev server only (port 1420) |
| `pnpm check` | ESLint + TypeScript check |
| `pnpm cargo:clippy` | Rust lint (warnings = errors) |
| `pnpm check:all` | All checks (frontend + Rust) |

### Project Structure

```text
src/                    # React frontend
├── components/         # UI components (FileList, Sidebar, TabBar, TopBar, etc.)
├── hooks/              # Custom hooks (useTabs, useSetting, useTheme, photo metadata)
├── stores/             # Zustand stores (viewMode, clipboard, photo analysis mode)
├── contexts/           # React contexts (tabs, theme)
├── lib/                # Utilities (i18n, settings, thumbnails, photo analysis, metadata)
└── locales/            # i18n translations (en, zh)

src-tauri/src/          # Rust backend
├── commands/           # Tauri commands (fs/EXIF, thumbnails, search, apps, watcher)
├── db/                 # SQLite layer (schema, indexer, search engine)
└── index/              # In-memory index (fallback)
```

### Git Hooks

Pre-commit hooks via [Husky](https://typicode.github.io/husky/) + [lint-staged](https://github.com/lint-staged/lint-staged):

- `*.{ts,tsx}` → ESLint fix + Prettier
- `*.{json,css,md}` → Prettier

## License

[BSL 1.1](./LICENSE) — Free for non-commercial use. See LICENSE for details.

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

![Repeated viewpoints highlighted in icon view](./docs/screenshots/icon-view-focus-groups.png)

![RAW/JPEG pairs in icon view](./docs/screenshots/icon-view-raw-pairs.png)

Press **Space** to open Quick Look, use the arrow buttons or Left/Right keys to move through the folder, and hold **⌘/Ctrl + scroll** to zoom around the pointer. Adjacent RAW previews are prefetched so moving through a sequence feels immediate.

![Quick Look zoom with focus marker](./docs/screenshots/quick-look-zoom-focus.png)

> Focus boxes are a visual sharpness estimate from the available preview, not a guaranteed camera MakerNote AF-area readout. A confidence value is shown so the result can be treated as a selection aid rather than a replacement for checking the full-resolution RAW.

## Features

- **Editable Address Bar** — Navigate by typing paths, copy/paste with Cmd+C/Cmd+V, breadcrumb clicking
- **Folder Tree Sidebar** — Windows-style collapsible tree with lazy loading
- **Mounted Volumes** — Shows mounted USB, external, and network volumes in the sidebar Locations section, refreshes after mount/unmount, and requests macOS folder access when a volume has not been authorized yet
- **Resizable Sidebar** — Drag the sidebar divider to adjust its width, drag it to the edge to hide it, and use the attached edge handle to click or drag it back open; the setting is remembered
- **Everything-Style Search** — Millisecond-level full-disk search powered by SQLite FTS5 + Rust, with an anchored result panel that stays above the file content and supports Finder-like selection, context-menu actions, and inline rename
- **Finder-Like Thumbnails** — Native thumbnail previews in icon/list views, including common camera RAW formats, generated through in-process Quick Look with progressive loading and caching for large folders
- **Optional Photo Analysis** — Group similar viewpoints globally, cycle distinct group colors, and mark an estimated focus region without changing the default lightweight browsing mode
- **Focus-Aware Quick Look** — Space-bar preview with keyboard navigation, progressive RAW loading, adjacent-image prefetching, pointer-centered zoom, and focus data beneath the image
- **EXIF-at-a-Glance** — Lazy, bounded-concurrency metadata loading for visible icon cards so camera settings appear without delaying folder layout
- **Finder-Like Selection & Rename** — Subtle native-style selection states; in icon/list views, click a selected filename to rename it inline (Enter confirms, Escape cancels)
- **Multi-Tab & Multi-Window** — Drag tabs between windows while preserving their navigation history; detached tabs open with their current folder and history; move files and folders into another window or its current folder, with source and destination views refreshed after completion
- **Cmd+X Cut** — Native cut support, no more Cmd+C → Cmd+Option+V
- **QuickLook Preview** — Press Space to preview files (text, images, video, audio, PDF, HEIC, DNG, PSD), with native macOS thumbnail fallback for unsupported formats
- **Context Menus** — Windows-style right-click with 20+ actions, Finder-like sorting and arranging: "New File", "Open in New Tab" for folders, "Open in Terminal", "Copy Path", etc.
- **Dark Mode** — Light / Dark / System theme
- **i18n** — English and Simplified Chinese

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

# ImageExplorer

A modern, fast file manager for macOS — built with Rust and React.

[English](./README.md) | [中文](./README.zh-CN.md)

ImageExplorer brings the best of Windows Explorer to macOS: an editable address bar, a persistent folder tree, and blazing-fast Everything-style search — all wrapped in a native macOS design.

![ImageExplorer Screenshot](./docs/screenshot.png)

## Features

- **Editable Address Bar** — Navigate by typing paths, copy/paste with Cmd+C/Cmd+V, breadcrumb clicking
- **Folder Tree Sidebar** — Windows-style collapsible tree with lazy loading
- **Mounted Volumes** — Shows mounted USB, external, and network volumes in the sidebar Locations section and refreshes after mount/unmount
- **Resizable Sidebar** — Drag the sidebar divider to adjust its width, drag it to the edge to hide it, and use the attached edge handle to click or drag it back open; the setting is remembered
- **Everything-Style Search** — Millisecond-level full-disk search powered by SQLite FTS5 + Rust, with an anchored result panel that stays above the file content and supports Finder-like selection, context-menu actions, and inline rename
- **Finder-Like Thumbnails** — Native thumbnail previews in icon/list views, with progressive loading and caching for large folders
- **Finder-Like Selection & Rename** — Subtle native-style selection states; in icon/list views, click a selected filename to rename it inline (Enter confirms, Escape cancels)
- **Multi-Tab & Multi-Window** — Drag tabs between windows while preserving their navigation history; detached tabs open with their current folder and history; move files and folders into another window or its current folder, with source and destination views refreshed after completion
- **Cmd+X Cut** — Native cut support, no more Cmd+C → Cmd+Option+V
- **QuickLook Preview** — Press Space to preview files (text, images, video, audio, PDF, HEIC, DNG, PSD), with native macOS thumbnail fallback for unsupported formats
- **Context Menus** — Windows-style right-click with 20+ actions: "New File", "Open in New Tab" for folders, "Open in Terminal", "Copy Path", etc.
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
├── hooks/              # Custom hooks (useTabs, useSetting, useTheme)
├── stores/             # Zustand stores (viewMode, clipboard)
├── contexts/           # React contexts (tabs, theme)
├── lib/                # Utilities (i18n, settings, window manager)
└── locales/            # i18n translations (en, zh)

src-tauri/src/          # Rust backend
├── commands/           # Tauri commands (fs, search, apps, watcher)
├── db/                 # SQLite layer (schema, indexer, search engine)
└── index/              # In-memory index (fallback)
```

### Git Hooks

Pre-commit hooks via [Husky](https://typicode.github.io/husky/) + [lint-staged](https://github.com/lint-staged/lint-staged):

- `*.{ts,tsx}` → ESLint fix + Prettier
- `*.{json,css,md}` → Prettier

## License

[BSL 1.1](./LICENSE) — Free for non-commercial use. See LICENSE for details.

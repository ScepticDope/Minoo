<p align="center">
  <img src="/src/images/logo_about.png" width="128" alt="App Icon">
</p>

# Minoo [![Latest Release](https://img.shields.io/github/v/release/ScepticDope/Minoo?style=flat-square)](https://github.com/ScepticDope/Minoo/releases) [![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](https://github.com/ScepticDope/Minoo/blob/main/LICENCE) [![Total Downloads](https://img.shields.io/github/downloads/ScepticDope/Minoo/total?label=total%20downloads&style=flat-square)](https://github.com/ScepticDope/Minoo/releases)

**Organised, Focused, Private.**

---

Minoo is a minimalist cross-platform Markdown note-taking app built with [Tauri V2](https://tauri.app), on a vanilla JS, HTML, CSS frontend and vanilla Rust backend. Fedora (Linux), macOS and iOS are officially supported.
Minoo can also be built for Windows and Android too.

## Features

- **Local Sync.** Paired devices automatically synchronise notes via your local network, no server or account is required. If a conflict occurs, both versions are kept and the older file is moved to the trash with a `[conflicted]` label.
- **Plain Markdown files.** Each note is saved as a standard Markdown `.md` file in regular folders. Your data belongs entirely to you, meaning you can back it up, use other editors, or track it with Git.
- **Raw Markdown styling.** Beautiful raw Markdown rendering of headings, bold text, italic text, lists, horizontal lines, quotes, code and code blocks, links, and tables.
- **Sidebar.** Easily organise your notes. You can drag and drop folders, select multiple files at once, and rename items instantly by double-clicking or pressing F2. Deleted notes can be recovered until the trash is manually emptied.
- **Command Palette & Search.** Navigate the app instantly using a central command palette. Run full-text searches across your open note or across all of them.
- **Customisation & Settings.** Choose from four beautiful themes and start customising your experience. All your configurations are saved in a `settings.toml` file, making them easy to back up and export.
- **Intuitive Touch Gestures.** Navigate fluidly on mobile devices. Swipe from the left to open the sidebar, from the right to access the command palette, press and hold to open context menus and tap with three fingers in the editor for a context-menu.

## Keyboard shortcuts

Shortcuts can be rebound in the settings or emptied to disable them.

---

| Shortcut         | Action                               |
| ---------------- | ------------------------------------ |
| `⌘/Ctrl+B`       | Toggle the sidebar                   |
| `⌘/Ctrl+N`       | New note                             |
| `⌘/Ctrl+Shift+N` | New folder                           |
| `⌘/Ctrl+F`       | Search the open note                 |
| `⌘/Ctrl+Shift+F` | Search all notes                     |
| `⌘/Ctrl+Shift+P` | Command palette                      |
| `⌘/Ctrl+,`       | Settings                             |
| `F11`            | Fullscreen                           |
| `⌥/Alt+⌘/Ctrl+C` | Center the window                    |
| `⌥/Alt+⌘/Ctrl+←` | Tile the window to the left half     |
| `⌥/Alt+⌘/Ctrl+→` | Tile the window to the right half    |
| `F2`             | Rename the selected entry            |
| `Delete`         | Move the selected entry to the trash |

---

_\*In the editor, `Tab` indents and `Shift+Tab` unindents, and `Enter` carries a list on to its next bullet or number._

## Project layout

```
update-codemirror.sh  Checks for and builds a new src/js/codemirror.js.
.github/workflows/    GitHub Actions.
  release.yml         Builds Fedora, Windows and Android packages.
src/                  Frontend (vanilla JS, HTML, CSS).
  index.html          The app's single page.
  style.css           All styling, including the themes.
  main.js             Entry point, wires the modules up.
  js/                 One module per domain (editor, sidebar, sync, ...).
  js/codemirror.js    The vendored CodeMirror 6 bundle, only editor.js imports it.
src-tauri/            Backend (vanilla Rust).
  src/lib.rs          App setup and the command registry.
  src/settings.rs     settings.toml handling.
  src/window.rs       Corrects the placement the state plugin restores and stores.
  src/notes.rs        Notes, folders, trash, and search.
  src/menu.rs         The macOS menu bar.
  src/sync/           Local-network sync: crypto, engine, network.
```

## Development

Run the desktop app:

```sh
cd src-tauri
cargo tauri dev
```

Run on an iOS simulator:

```sh
cd src-tauri
cargo tauri ios dev "iPhone 17"
```

Run on physical iOS device (make sure its connected in Xcode first).:

```sh
cd src-tauri
cargo tauri ios dev --force-ip-prompt
```

_\*To build and test on real iOS hardware you need your own Apple Developer account._

Run the backend tests (sync engine and crypto):

```sh
cd src-tauri
cargo test
```

### Updating CodeMirror

[CodeMirror 6](https://codemirror.net) is vendored as a single minified ES module. Running `update-codemirror.sh` keeps it current:

```sh
./update-codemirror.sh          # Checks for newer releases, then offers to rebuild.
./update-codemirror.sh --check  # Only reports what is new.
./update-codemirror.sh --force  # Rebuild, even when everything is up to date.
```

_\*Minoo had been using a custom-built, lightweight Markdown editor for two years. Was knee-deep in creating my own Codemirror-like web editor from scratch in order to implement all the QoL features I wanted, as well as addressing all the edge-case bugs and performance issues. Realised that it could have taken another X years to get just right, and I would essentially have ended up with Codemirror anyway, they arguably made the best possible design decisions given the constraints of a web editor. So, I finally gave in and adopted it. R.I.P. beautiful NIH code._

## Releases

On a new release bump the version in: `tauri.conf.json`, `Cargo.toml`, `gen/apple/project.yml` and `gen/apple/Minoo_iOS/Info.plist`. Publishing a GitHub release runs `.github/workflows/release.yml`, which builds the packages and attaches them.

---

| File   | Platform | Support                                                                |
| ------ | -------- | ---------------------------------------------------------------------- |
| `.rpm` | Fedora   | Officially supported.                                                  |
| `.exe` | Windows  | Unofficial and unsupported. Portable, no installer.                    |
| `.apk` | Android  | Unofficial and unsupported. Signed with new key, so needs a reinstall. |

---

_\*The macOS and iOS releases are published to the App Store._

## Contributing

Issues, feature requests and pull requests are welcome. Keep to the house style, vanilla JS and vanilla Rust, no new dependencies, and comments that read as chapter headings. In order to maintain Minoo's minimalist ethos and prevent feature creep, new additions and requests will be strictly evaluated and may be declined to keep the app lean.

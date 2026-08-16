// # Notes and the sidebar tree.
// Notes are plain Markdown files inside the app data directory and folders are real directories,
// addressed by the frontend through paths relative to the notes folder. Keeping the data
// as regular files makes import/export a matter of simply copying files.
//
// There is a hidden collapse status file inside every folder. This also serves
// as a way to allow for syncing of empty folders.
//
// Deleted entries move into a `.trash` folder at the notes root. The normal tree walk
// and search skip dot-entries, so `list_notes` surfaces it explicitly as a special
// "Trash" entry the sidebar shows at the bottom.

use crate::sync::{local_device_name, touch_last_edit};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
use tauri::Manager;

// ## The hidden collapse status file inside every folder.
// One line per device, e.g. "open Minoo-macos-13bb", "closed Minoo-ios-2e2c".
// The file syncs like a regular note. By existing it also keeps
// otherwise empty folders visible to the sync engine, so empty folders reach
// other devices too. The sync engine merges incoming status files per device line,
// see the engine's merge_collapse_status.
pub const COLLAPSE_STATUS_FILE: &str = ".collapseStatus";

// ## Parse collapse status content into device name to collapsed pairs.
// Malformed lines just drop out, which also migrates older formats away.
pub fn parse_collapse_status(content: &str) -> BTreeMap<String, bool> {
    content
        .lines()
        .filter_map(|line| {
            let (status, device) = line.trim().split_once(' ')?;
            match status {
                "closed" => Some((device.to_string(), true)),
                "open" => Some((device.to_string(), false)),
                _ => None,
            }
        })
        .collect()
}

// ## Serialize device states back into collapse status content.
// The BTreeMap keeps the lines sorted, so merged status files converge to
// byte-identical files (and so identical sync hashes) on every device.
pub fn serialize_collapse_status(states: &BTreeMap<String, bool>) -> String {
    states
        .iter()
        .map(|(device, collapsed)| {
            format!(
                "{} {}\n",
                if *collapsed { "closed" } else { "open" },
                device
            )
        })
        .collect()
}

// ## A note or folder entry in the sidebar tree.
// `collapsed` is whether a folder is folded shut in the sidebar, always true for notes.
#[derive(serde::Serialize)]
pub struct SidebarEntry {
    name: String,
    path: String,
    kind: &'static str,
    collapsed: bool,
    children: Vec<SidebarEntry>,
}

// ## A single search hit.
// `line` is 0 for a match on the note's name.
#[derive(serde::Serialize)]
pub struct SearchMatch {
    path: String,
    name: String,
    line: usize,
    preview: String,
}

const SEARCH_RESULT_LIMIT: usize = 100;

// ## The starter note new installs get.
const WELCOME_NOTE: &str = r#"# Welcome to Minoo. o/

_Minoo is a cross platform minimalist Markdown note-taking app._

# Tips
- Notes are plain Markdown files stored on this device. Nothing leaves it unless you turn on sync.
- Sync is optional and works directly between your own devices on the same network, with no cloud and no account. Pair your devices in the settings.
- Notes save themselves while you type.
- The sidebar holds your notes, folders, and the trash. Toggle it with Ctrl/Cmd+B or the close sidebar << button.
- Drag the sidebar's right edge to make it wider or narrower, and double click that edge to put it back to its default width.
- Right-click a note or folder for its actions: rename, delete, restore.
- Select a note or folder. Hit F2, or double click it, to rename it. Hit delete to move it to trash.
- Use shift click to select a range of notes/folders and drag or delete them in one go.
- Drag notes onto a folder to move them into it, or onto the trash to delete them.
- Ctrl/Cmd+F searches the open note, Ctrl/Cmd+Shift+F searches through all notes. Ctrl/Cmd+Shift+P opens the command palette, which can run every action by name.
- The ☰ button opens the settings: themes, fonts, shortcuts, and sync, each with a short explanation.
- Deleted and conflicted notes stay in the trash until you empty it manually.

# Touch device tips.
- Swipe right from the left edge of the screen to open the sidebar. Swipe the sidebar left to close it.
- Swipe left from the right edge of the screen to open the command palette.
- Drag the sidebar's right edge to resize it, and double tap that edge to put it back to its default width.
- Touch, hold and release on a note or folder to open a context menu.
- Touch and long hold a note or folder, to be able to drag it into a folder or onto the trash.
- Touch the editor with three fingers to open a context menu.

Hope you enjoy using Minoo. ♥️

# Styling Cheat Sheet
The editor will appply the following curated set of Markdown stylings.

# Heading 1
## Heading 2
### Heading 3
#### Heading 4-6

## Text
__Bold__ with two underscores, _italic_ with one, and ___both___ with three.

**Bold** with two asterisks, *italic* with one, and ***both*** with three.

~~Strikethrough~~ with two tildes.

Escape a character with a backslash, so \*this\* keeps its asterisks.

## Lists
- A bullet list starts a line with -, + or *.
  - Indent with two spaces to nest a level.

1. A numbered list starts a line with a number and a dot.
2. Press Enter and the next number is added for you.

## Quotes and rules
> A quote starts a line with a >.

A line of three or more dashes is a horizontal line:

---

## Code
Wrap `inline code` in single backticks.

```
A code block sits between two lines of three backticks.
```

A blank line followed by indented lines is a code block too, no backticks needed.

    Start every line with a tab, or with four spaces.
        Indent further inside it and that extra indentation is kept as typed.

## Links
A bare address like https://github.com/ScepticDope/Minoo is styled on its own.

## Tables
| Column | Column |
| ------ | ------ |
| Cell   | Cell   |
"#;

// ## Get the notes directory, creating it with a starter note on first run.
pub fn get_notes_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let notes_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get the app data directory: {}.", e))?
        .join("notes");

    if !notes_dir.exists() {
        fs::create_dir_all(&notes_dir)
            .map_err(|e| format!("Failed to create notes directory: {}.", e))?;

        fs::write(notes_dir.join("Welcome.md"), WELCOME_NOTE)
            .map_err(|e| format!("Failed to create starter note: {}.", e))?;
    }

    let trash_dir = notes_dir.join(".trash");

    if !trash_dir.exists() {
        fs::create_dir_all(&trash_dir)
            .map_err(|e| format!("Failed to create trash directory: {}.", e))?;
    }

    Ok(notes_dir)
}

// ## Check that a name is a single sane path segment.
pub fn is_valid_entry_name(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('.') && !name.contains('/') && !name.contains('\\')
}

// ## Resolve a relative path from the frontend into the notes directory.
// Rejects anything that could escape it. `.trash` is only accepted as the first
// segment, so trashed entries stay addressable.
fn resolve_note_path(app: &tauri::AppHandle, relative_path: &str) -> Result<PathBuf, String> {
    let valid = !relative_path.is_empty()
        && relative_path
            .split('/')
            .enumerate()
            .all(|(index, part)| is_valid_entry_name(part) || (index == 0 && part == ".trash"));

    if !valid {
        return Err(format!("Invalid note path: {}.", relative_path));
    }

    Ok(get_notes_dir(app)?.join(relative_path))
}

// ## Read one directory level into sidebar entries, sorted by name.
// The root lists notes above folders, while inside a folder the folders come first.
// `device` is this device's name, picking its own line from the collapse status files.
fn read_sidebar_dir(
    dir: &Path,
    relative_dir: &str,
    device: &str,
) -> Result<Vec<SidebarEntry>, String> {
    let mut folders = Vec::new();
    let mut notes = Vec::new();

    let dir_entries =
        fs::read_dir(dir).map_err(|e| format!("Failed to read notes directory: {}.", e))?;

    for entry in dir_entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();

        if file_name.starts_with('.') {
            continue;
        }

        let relative_path = if relative_dir.is_empty() {
            file_name.clone()
        } else {
            format!("{}/{}", relative_dir, file_name)
        };

        if entry.path().is_dir() {
            folders.push(SidebarEntry {
                name: file_name,
                path: relative_path.clone(),
                kind: "folder",
                collapsed: read_folder_collapse_status(&entry.path(), device),
                children: read_sidebar_dir(&entry.path(), &relative_path, device)?,
            });
        } else if file_name.to_lowercase().ends_with(".md") {
            notes.push(SidebarEntry {
                name: file_name[..file_name.len() - 3].to_string(),
                path: relative_path,
                kind: "note",
                collapsed: true,
                children: Vec::new(),
            });
        }
    }

    folders.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    notes.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    if relative_dir.is_empty() {
        notes.append(&mut folders);

        Ok(notes)
    } else {
        folders.append(&mut notes);

        Ok(folders)
    }
}

// ## Read this device's collapse status for a folder from its .collapseStatus file.
// A folder without one gets it written as closed, so empty folders created outside of Minoo
// also start syncing without needing a toggle first.
fn read_folder_collapse_status(folder_dir: &Path, device: &str) -> bool {
    let status_file = folder_dir.join(COLLAPSE_STATUS_FILE);

    match fs::read_to_string(&status_file) {
        Ok(content) => parse_collapse_status(&content)
            .get(device)
            .copied()
            .unwrap_or(true),
        Err(_) => {
            let _ = fs::write(&status_file, format!("closed {}\n", device));
            true
        }
    }
}

// ## Remember a folder's collapse status in its hidden .collapseStatus file.
// The file lives inside the folder itself, so it moves along with renames and moves,
// and it syncs across devices like a note. Only this device's own line changes here,
// the other devices' states stay untouched.
#[tauri::command]
pub fn set_folder_collapse_status(
    app: tauri::AppHandle,
    path: String,
    collapsed: bool,
) -> Result<(), String> {
    let folder_path = resolve_note_path(&app, &path)?;

    if !folder_path.is_dir() {
        return Err(format!("Not a folder: {}.", path));
    }

    let status_file = folder_path.join(COLLAPSE_STATUS_FILE);

    let mut states = parse_collapse_status(&fs::read_to_string(&status_file).unwrap_or_default());
    states.insert(local_device_name(&app), collapsed);

    fs::write(&status_file, serialize_collapse_status(&states))
        .map_err(|e| format!("Failed to write the folder state: {}.", e))?;
    touch_last_edit(&app);

    Ok(())
}

// ## List the whole sidebar tree, with the trash as a special entry at the end.
#[tauri::command]
pub fn list_notes(app: tauri::AppHandle) -> Result<Vec<SidebarEntry>, String> {
    let notes_dir = get_notes_dir(&app)?;
    let device = local_device_name(&app);
    let mut entries = read_sidebar_dir(&notes_dir, "", &device)?;

    entries.push(SidebarEntry {
        name: "Trash".to_string(),
        path: ".trash".to_string(),
        kind: "trash",
        collapsed: read_folder_collapse_status(&notes_dir.join(".trash"), &device),
        children: read_sidebar_dir(&notes_dir.join(".trash"), ".trash", &device)?,
    });

    Ok(entries)
}

// ## Read a note's Markdown content.
#[tauri::command]
pub fn load_note(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let note_path = resolve_note_path(&app, &path)?;

    fs::read_to_string(&note_path).map_err(|e| format!("Failed to read note: {}.", e))
}

// ## Write a note's Markdown content.
#[tauri::command]
pub fn save_note(app: tauri::AppHandle, path: String, content: String) -> Result<(), String> {
    let note_path = resolve_note_path(&app, &path)?;

    // The editor's paste fix pads lines with non-breaking spaces a.k.a. NBSP, any that slip past
    // the frontend cleanup must never reach the .md file and is replaced with a regular space.
    let content = if content.contains('\u{00A0}') {
        content.replace('\u{00A0}', " ")
    } else {
        content
    };

    fs::write(&note_path, content).map_err(|e| format!("Failed to write note: {}.", e))?;
    touch_last_edit(&app);

    Ok(())
}

// ## Create a new, empty note.
#[tauri::command]
pub fn create_note(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let note_path = resolve_note_path(&app, &path)?;

    if note_path.exists() {
        return Err(format!("Something named {} already exists.", path));
    }

    fs::write(&note_path, "").map_err(|e| format!("Failed to create note: {}.", e))?;
    touch_last_edit(&app);

    Ok(())
}

// ## Create a new, empty folder.
#[tauri::command]
pub fn create_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let folder_path = resolve_note_path(&app, &path)?;

    if folder_path.exists() {
        return Err(format!("Something named {} already exists.", path));
    }

    fs::create_dir(&folder_path).map_err(|e| format!("Failed to create folder: {}.", e))?;

    // The status file makes the empty folder syncable right away, see
    // COLLAPSE_STATUS_FILE.
    fs::write(
        folder_path.join(COLLAPSE_STATUS_FILE),
        format!("closed {}\n", local_device_name(&app)),
    )
    .map_err(|e| format!("Failed to write the folder state: {}.", e))?;
    touch_last_edit(&app);

    Ok(())
}

// ## Rename a note or folder in place, returning its new relative path.
#[tauri::command]
pub fn rename_entry(
    app: tauri::AppHandle,
    path: String,
    new_name: String,
) -> Result<String, String> {
    if path == ".trash" {
        return Err("The trash itself cannot be changed.".to_string());
    }

    let old_path = resolve_note_path(&app, &path)?;

    if !is_valid_entry_name(&new_name) {
        return Err(format!("Invalid name: {}.", new_name));
    }

    // A typed ".md" suffix would double up with the one added below.
    let file_name = if old_path.is_file() {
        let stem = if new_name.to_lowercase().ends_with(".md") {
            &new_name[..new_name.len() - 3]
        } else {
            new_name.as_str()
        };
        if stem.is_empty() {
            return Err(format!("Invalid name: {}.", new_name));
        }

        format!("{}.md", stem)
    } else {
        new_name
    };

    let new_relative = match path.rsplit_once('/') {
        Some((parent, _)) => format!("{}/{}", parent, file_name),
        None => file_name,
    };

    // A case-only rename ("note" to "Note") looks like a collision on the
    // case-insensitive filesystems of macOS, Windows, and iOS, but the "existing"
    // entry is just the one being renamed.
    let new_path = resolve_note_path(&app, &new_relative)?;

    let same_entry = match (fs::canonicalize(&old_path), fs::canonicalize(&new_path)) {
        (Ok(old), Ok(new)) => old == new,
        _ => false,
    };

    if new_path.exists() && !same_entry {
        return Err(format!("Something named {} already exists.", new_relative));
    }

    fs::rename(&old_path, &new_path).map_err(|e| format!("Failed to rename: {}.", e))?;
    touch_last_edit(&app);

    Ok(new_relative)
}

// ## Move a note or folder into another folder, returning its new relative path.
// The parent is "" for the root and ".trash" to delete. When something with the same
// name already exists there, the moved entry gets a counter appended to its name
// instead of failing.
#[tauri::command]
pub fn move_entry(
    app: tauri::AppHandle,
    path: String,
    new_parent: String,
) -> Result<String, String> {
    if path == ".trash" {
        return Err("The trash itself cannot be changed.".to_string());
    }

    let old_path = resolve_note_path(&app, &path)?;
    let file_name = path.rsplit('/').next().unwrap_or(&path).to_string();

    // Don't allow moving a folder into itself or one of its own descendants.
    if new_parent == path || new_parent.starts_with(&format!("{}/", path)) {
        return Err("Cannot move a folder into itself.".to_string());
    }

    let join_parent = |name: &str| {
        if new_parent.is_empty() {
            name.to_string()
        } else {
            format!("{}/{}", new_parent, name)
        }
    };

    let mut new_relative = join_parent(&file_name);

    if new_relative == path {
        return Ok(new_relative);
    }

    // Pick a free name by appending a counter when the plain one is taken.
    let notes_dir = get_notes_dir(&app)?;

    let (stem, extension) = match old_path.is_file() {
        true => match file_name.rsplit_once('.') {
            Some((stem, extension)) => (stem.to_string(), format!(".{}", extension)),
            None => (file_name.clone(), String::new()),
        },
        false => (file_name.clone(), String::new()),
    };

    let mut counter = 2;
    while notes_dir.join(&new_relative).exists() {
        new_relative = join_parent(&format!("{} {}{}", stem, counter, extension));
        counter += 1;
    }

    let new_path = resolve_note_path(&app, &new_relative)?;

    fs::rename(&old_path, &new_path).map_err(|e| format!("Failed to move: {}.", e))?;
    touch_last_edit(&app);

    Ok(new_relative)
}

// ## Permanently delete an entry from the trash.
// Only trash paths are accepted.
#[tauri::command]
pub fn delete_permanently(app: tauri::AppHandle, path: String) -> Result<(), String> {
    if !path.starts_with(".trash/") {
        return Err("Only entries in the trash can be deleted permanently.".to_string());
    }

    let entry_path = resolve_note_path(&app, &path)?;

    if entry_path.is_dir() {
        fs::remove_dir_all(&entry_path)
    } else {
        fs::remove_file(&entry_path)
    }
    .map_err(|e| format!("Failed to delete permanently: {}.", e))?;
    touch_last_edit(&app);

    Ok(())
}

// ## Permanently delete everything in the trash.
#[tauri::command]
pub fn empty_trash(app: tauri::AppHandle) -> Result<(), String> {
    let trash_dir = get_notes_dir(&app)?.join(".trash");

    fs::remove_dir_all(&trash_dir).map_err(|e| format!("Failed to empty the trash: {}.", e))?;

    fs::create_dir_all(&trash_dir)
        .map_err(|e| format!("Failed to recreate the trash directory: {}.", e))?;
    touch_last_edit(&app);

    Ok(())
}

// ## Search all notes by name and content.
// Case-insensitive, and capped so huge note collections keep the UI responsive.
#[tauri::command]
pub fn search_notes(app: tauri::AppHandle, query: String) -> Result<Vec<SearchMatch>, String> {
    let query = query.to_lowercase();
    let mut matches = Vec::new();

    if query.is_empty() {
        return Ok(matches);
    }

    let notes_dir = get_notes_dir(&app)?;
    search_notes_dir(&notes_dir, "", &query, &mut matches)?;

    Ok(matches)
}

// ## Recursively collect search matches from one directory level.
fn search_notes_dir(
    dir: &Path,
    relative_dir: &str,
    query: &str,
    matches: &mut Vec<SearchMatch>,
) -> Result<(), String> {
    let dir_entries =
        fs::read_dir(dir).map_err(|e| format!("Failed to read notes directory: {}.", e))?;

    for entry in dir_entries.flatten() {
        if matches.len() >= SEARCH_RESULT_LIMIT {
            return Ok(());
        }

        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with('.') {
            continue;
        }

        let relative_path = if relative_dir.is_empty() {
            file_name.clone()
        } else {
            format!("{}/{}", relative_dir, file_name)
        };

        if entry.path().is_dir() {
            search_notes_dir(&entry.path(), &relative_path, query, matches)?;
            continue;
        }

        if !file_name.to_lowercase().ends_with(".md") {
            continue;
        }

        let name = file_name[..file_name.len() - 3].to_string();

        // A hit on the note's name itself.
        if name.to_lowercase().contains(query) {
            matches.push(SearchMatch {
                path: relative_path.clone(),
                name: name.clone(),
                line: 0,
                preview: String::new(),
            });
        }

        let Ok(content) = fs::read_to_string(entry.path()) else {
            continue;
        };

        for (index, line_text) in content.lines().enumerate() {
            if matches.len() >= SEARCH_RESULT_LIMIT {
                break;
            }

            if line_text.to_lowercase().contains(query) {
                matches.push(SearchMatch {
                    path: relative_path.clone(),
                    name: name.clone(),
                    line: index + 1,
                    preview: line_text.trim().chars().take(120).collect(),
                });
            }
        }
    }

    Ok(())
}

// ## Open the notes folder in the system's file manager.
// Opens the folder itself with the notes inside, not its parent with the folder
// selected. On failure the path itself comes back as the error, so the frontend can
// still show it.
#[tauri::command]
pub fn open_notes_location(app: tauri::AppHandle) -> Result<(), String> {
    let notes_dir = get_notes_dir(&app)?;

    tauri_plugin_opener::open_path(&notes_dir, None::<&str>)
        .map_err(|_| notes_dir.display().to_string())
}

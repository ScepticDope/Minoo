// # User settings, stored as settings.toml.
// Uses Tauri's app config directory rather than the executable's directory, since on iOS
// macOS the executable lives in a read-only location.

use serde_json::Value;
use std::{fs, path::PathBuf};
use tauri::Manager;

// ## Default settings.
// New keys automatically reach existing installs through the merge in `load_settings`.
// The sidebar starts closed, since only the frontend can measure the screen. It opens
// the sidebar itself on a roomy one, see `openSidebarOnRoomyScreen` in settings.js.
const DEFAULT_SETTINGS: &str = r#"[settings]
line-numbers = true
open-note-focus = "none"
font-size = ""
font-family = ""
line-height = ""
word-spacing = ""
line-width = ""
ui-font-family = ""
sidebar-startup = false
sidebar-width = "250px"
window-controls = "auto"
theme = "GeniusGreen"
last-note = ""

[shortcuts]
sidebar = "CmdOrCtrl+B"
settings = "CmdOrCtrl+,"
command-palette = "CmdOrCtrl+Shift+P"
search = "CmdOrCtrl+F"
search-all = "CmdOrCtrl+Shift+F"
new-note = "CmdOrCtrl+N"
new-folder = "CmdOrCtrl+Shift+N"
fullscreen = "F11"
center-window = "Alt+CmdOrCtrl+C"
tile-left = "Alt+CmdOrCtrl+Left"
tile-right = "Alt+CmdOrCtrl+Right"
"#;

// ## Get the path to `settings.toml`.
pub fn get_settings_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .expect("Failed to get the app config directory.")
        .join("settings.toml")
}

// ## Initialize the settings file if it doesn't exist, reporting whether it did.
// The frontend acts on a fresh file, so it can finish the defaults that need a screen,
// see `openSidebarOnRoomyScreen` in settings.js.
#[tauri::command]
pub fn init_settings_file(app: tauri::AppHandle) -> bool {
    let settings_path = get_settings_path(&app);

    if settings_path.exists() {
        return false;
    }

    if let Some(settings_dir) = settings_path.parent() {
        if let Err(e) = fs::create_dir_all(settings_dir) {
            eprintln!("Failed to create settings directory: {}.", e);

            return false;
        }
    }

    if let Err(e) = fs::write(&settings_path, DEFAULT_SETTINGS) {
        eprintln!("Failed to create settings.toml: {}.", e);

        return false;
    }

    println!(
        "\nCreated settings.toml with default settings at:\n{:?}\n",
        settings_path
    );

    true
}

// ## Merge loaded settings over the defaults.
// Fills in any keys missing from the loaded settings, so settings added in newer
// versions also work with an older settings.toml on disk.
fn merge_settings(defaults: Value, loaded: Value) -> Value {
    match (defaults, loaded) {
        (Value::Object(mut defaults_map), Value::Object(loaded_map)) => {
            for (key, loaded_value) in loaded_map {
                let merged_value = match defaults_map.remove(&key) {
                    Some(default_value) => merge_settings(default_value, loaded_value),
                    None => loaded_value,
                };

                defaults_map.insert(key, merged_value);
            }
            Value::Object(defaults_map)
        }
        (_, loaded) => loaded,
    }
}

// ## Get settings as a JSON object.
// Reading never creates the file, so `init_settings_file` stays the only place that can
// report a fresh install. A missing file simply merges into the plain defaults.
#[tauri::command]
pub fn load_settings(app: tauri::AppHandle) -> Result<Value, String> {
    let settings = fs::read_to_string(get_settings_path(&app)).unwrap_or_default();

    let loaded: Value =
        toml::from_str(&settings).map_err(|e| format!("Failed to parse settings file: {}.", e))?;

    let defaults: Value = toml::from_str(DEFAULT_SETTINGS)
        .map_err(|e| format!("Failed to parse default settings: {}.", e))?;

    Ok(merge_settings(defaults, loaded))
}

// ## Reset the settings file to the defaults.
// Deletes settings.toml and recreates it, returning the fresh settings. The frontend
// finishes the screen dependent defaults afterwards, exactly like a first launch.
#[tauri::command]
pub fn reset_settings(app: tauri::AppHandle) -> Result<Value, String> {
    let settings_path = get_settings_path(&app);

    if settings_path.exists() {
        fs::remove_file(&settings_path)
            .map_err(|e| format!("Failed to remove settings file: {}.", e))?;
    }

    init_settings_file(app.clone());
    update_menu_shortcuts(&app);
    load_settings(app)
}

// ## Update settings from a JSON object.
#[tauri::command]
pub fn save_settings(app: tauri::AppHandle, new_settings: Value) -> Result<(), String> {
    let settings_path = get_settings_path(&app);

    let content = toml::to_string_pretty(&new_settings)
        .map_err(|e| format!("Failed to serialize settings: {}.", e))?;

    fs::write(&settings_path, content)
        .map_err(|e| format!("Failed to write to settings file: {}.", e))?;

    update_menu_shortcuts(&app);

    Ok(())
}

// ## Reflect possibly changed shortcuts in the macOS menu bar right away.
// Menus have to be touched from the main thread, commands run outside it.
fn update_menu_shortcuts(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();

        let _ = app.run_on_main_thread(move || {
            let _ = crate::menu::update_app_menu(&handle);
        });
    }

    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

// ## Reveal the settings file in the system's file manager.
// On failure the path itself comes back as the error, so the frontend can still show it.
#[tauri::command]
pub fn open_settings_location(app: tauri::AppHandle) -> Result<(), String> {
    let settings_path = get_settings_path(&app);

    tauri_plugin_opener::reveal_item_in_dir(&settings_path)
        .map_err(|_| settings_path.display().to_string())
}

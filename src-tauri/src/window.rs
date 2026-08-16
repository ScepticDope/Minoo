// # Two patches over the window state plugin, both about where the window lands.
// One runs on the way in, the other on the way out, and both work on the plugin's own
// state file rather than on a copy of it.

use serde_json::Value;
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager, PhysicalPosition, RunEvent};
use tauri_plugin_window_state::DEFAULT_FILENAME;

// ## The main window's label, which is also its key in the plugin's state file.
const MAIN_WINDOW: &str = "Minoo";

// ## The plugin's state file, and what it holds.
fn read_state(app: &AppHandle) -> Option<(PathBuf, Value)> {
    let path = app.path().app_config_dir().ok()?.join(DEFAULT_FILENAME);
    let state = serde_json::from_str(&fs::read_to_string(&path).ok()?).ok()?;

    Some((path, state))
}

// ## Put a restored window back on the corner it was saved on.
// The plugin restores the position before the size, and on macOS a resize keeps the
// window's bottom left corner, so the top edge slides down by whatever height the window
// just lost. A window smaller than the one in tauri.conf.json therefore comes back that
// much lower, and lower again on every launch, since the drifted corner is what gets
// saved next. Setting the position once more after the plugin is done fixes it: windows
// are built before this runs, and every frame change is queued on the main thread, so
// this one lands last.
pub fn restore_position(app: &AppHandle) {
    let Some((_, state)) = read_state(app) else {
        return;
    };

    let window_state = &state[MAIN_WINDOW];

    // A window filling the screen has no corner to correct, and already gets the size
    // from tauri.conf.json underneath it, see below.
    if window_state["fullscreen"] == true || window_state["maximized"] == true {
        return;
    }

    let (Some(x), Some(y)) = (window_state["x"].as_i64(), window_state["y"].as_i64()) else {
        return;
    };

    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.set_position(PhysicalPosition {
            x: x as i32,
            y: y as i32,
        });
    }
}

// ## Hand a window that quit filling the screen its first launch placement back.
// The plugin records every resize it sees, and on macOS it cannot tell that an
// undecorated window is filling the screen, since the check it has for that is forced off
// there to work around `https://github.com/tauri-apps/tauri/issues/5812`. So quitting from
// fullscreen leaves the whole screen stored as the window's size, and the window has
// nowhere sane to land when it leaves fullscreen on the next launch.
//
// Such a window gets the placement of a first launch written over the plugin's own, so it
// lands centered and at the size from tauri.conf.json. Plugins get the exit event before
// the app itself does, so the last change can be made here.
pub fn reset_saved_placement(app: &AppHandle, event: &RunEvent) {
    if !matches!(event, RunEvent::Exit) {
        return;
    }

    let Some((path, mut state)) = read_state(app) else {
        return;
    };

    let Some(window_state) = state.get_mut(MAIN_WINDOW) else {
        return;
    };

    // A window that quit at a size of its own keeps whatever the plugin stored for it.
    if window_state["fullscreen"] != true && window_state["maximized"] != true {
        return;
    }

    // The monitor the window sat on, so a second screen keeps it.
    let x = window_state["x"].as_f64().unwrap_or_default();
    let y = window_state["y"].as_f64().unwrap_or_default();

    let Some(monitor) = app
        .monitor_from_point(x, y)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())
    else {
        return;
    };

    let Some(window_config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW)
    else {
        return;
    };

    // The configured size is in logical pixels, the plugin stores physical ones.
    let width = (window_config.width * monitor.scale_factor()).round() as i32;
    let height = (window_config.height * monitor.scale_factor()).round() as i32;

    let left = monitor.position().x + (monitor.size().width as i32 - width) / 2;
    let top = monitor.position().y + (monitor.size().height as i32 - height) / 2;

    // A zoomed window is restored from `prev_x` and `prev_y`, a fullscreen one from `x`
    // and `y`, so both pairs get the same corner.
    for (key, value) in [
        ("x", left),
        ("prev_x", left),
        ("y", top),
        ("prev_y", top),
        ("width", width),
        ("height", height),
    ] {
        window_state[key] = value.into();
    }

    if let Ok(corrected) = serde_json::to_string(&state) {
        let _ = fs::write(&path, corrected);
    }
}

// # The macOS menu bar.
// Replaces Tauri's borked boilerplate menu and adds a proper About panel.
// The custom items reuse the user's configured shortcuts as their accelerators
// and reach the frontend as `menuAction` events, so they trigger exactly the same code
// as the keyboard shortcuts. Saving the settings rebuilds the menu, so shortcut
// changes show up right away.

use crate::settings;
use serde_json::Value;
use std::sync::atomic::{AtomicI32, Ordering};
use tauri::{
    image::Image,
    menu::{AboutMetadataBuilder, MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder},
    AppHandle, Emitter,
};

// ## The About panel icon.
fn about_icon() -> Option<Image<'static>> {
    Image::from_bytes(include_bytes!("../../src/images/logo_about.png")).ok()
}

// ## The About panel's copyright year.
// JS knows the local date without any complex date math, so the frontend sets this on startup.
static COPYRIGHT_YEAR: AtomicI32 = AtomicI32::new(2026);

#[tauri::command]
pub fn menu_set_year(app: AppHandle, year: i32) {
    if COPYRIGHT_YEAR.swap(year, Ordering::Relaxed) != year {
        let _ = update_app_menu(&app);
    }
}

// ## Build a custom menu item, with the user's shortcut as its accelerator.
// An unparsable shortcut string falls back to a plain item without an accelerator.
fn action_item(
    app: &AppHandle,
    shortcuts: &Value,
    id: &str,
    label: &str,
) -> tauri::Result<MenuItem<tauri::Wry>> {
    if let Some(shortcut) = shortcuts[id].as_str().filter(|s| !s.is_empty()) {
        if let Ok(item) = MenuItemBuilder::with_id(id, label)
            .accelerator(shortcut)
            .build(app)
        {
            return Ok(item);
        }
    }
    MenuItemBuilder::with_id(id, label).build(app)
}

// ## Install the menu bar at startup, and forward its custom items to the frontend.
pub fn setup_app_menu(app: &AppHandle) -> tauri::Result<()> {
    update_app_menu(app)?;

    // The predefined items handle themselves natively; the custom ones go to the
    // frontend, where ids unknown to it are simply ignored. Registered once here,
    // menu rebuilds keep using it.
    app.on_menu_event(|app, event| {
        let _ = app.emit("menuAction", event.id().0.clone());
    });

    Ok(())
}

// ## Build the menu bar from the current settings.
pub fn update_app_menu(app: &AppHandle) -> tauri::Result<()> {
    let loaded_settings = settings::load_settings(app.clone()).unwrap_or_default();
    let shortcuts = &loaded_settings["shortcuts"];

    // The About panel.
    let about = AboutMetadataBuilder::new()
        .name(Some("Minoo"))
        .version(Some(app.package_info().version.to_string()))
        .credits(Some("Organised, Focused, Private."))
        .copyright(Some(format!(
            "©{} - ScepticDope",
            COPYRIGHT_YEAR.load(Ordering::Relaxed)
        )))
        .icon(about_icon().or_else(|| app.default_window_icon().cloned()))
        .build();

    let app_menu = SubmenuBuilder::new(app, "Minoo")
        .about(Some(about))
        .separator()
        .item(&action_item(app, shortcuts, "settings", "Settings...")?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&action_item(app, shortcuts, "new-note", "New Note")?)
        .item(&action_item(app, shortcuts, "new-folder", "New Folder")?)
        .separator()
        .item(&action_item(app, shortcuts, "sync-now", "Sync Now")?)
        .separator()
        .close_window()
        .build()?;

    // The predefined edit items keep the standard ⌘X/C/V keys working inside the
    // webview. Undo and redo are custom, since the native ones drive the webview's own
    // undo stack, which the editor does not use. The frontend sends them to the editor
    // or to the focused text input.
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(
            &MenuItemBuilder::with_id("undo", "Undo")
                .accelerator("CmdOrCtrl+Z")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("redo", "Redo")
                .accelerator("CmdOrCtrl+Shift+Z")
                .build(app)?,
        )
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    // All custom items here. The predefined minimize and zoom target the native
    // titlebar buttons this undecorated window does not have, and the fullscreen
    // item must share the frontend's fullscreen state tracking (and show the
    // configured shortcut). The view toggles live here too, since macOS force-adds
    // its own "Enter Full Screen" item to any menu titled "View".
    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(
            &MenuItemBuilder::with_id("minimize", "Minimize")
                .accelerator("CmdOrCtrl+M")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("zoom", "Zoom").build(app)?)
        .separator()
        .item(&action_item(
            app,
            shortcuts,
            "center-window",
            "Center Window",
        )?)
        .item(&action_item(
            app,
            shortcuts,
            "tile-left",
            "Tile Window Left",
        )?)
        .item(&action_item(
            app,
            shortcuts,
            "tile-right",
            "Tile Window Right",
        )?)
        .separator()
        .item(&action_item(app, shortcuts, "sidebar", "Toggle Sidebar")?)
        .item(&action_item(app, shortcuts, "search", "Search Note")?)
        .item(&action_item(
            app,
            shortcuts,
            "search-all",
            "Search All Notes",
        )?)
        .item(&action_item(
            app,
            shortcuts,
            "command-palette",
            "Command Palette",
        )?)
        .separator()
        .item(&action_item(
            app,
            shortcuts,
            "fullscreen",
            "Toggle Fullscreen",
        )?)
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &window_menu])
        .build()?;
    app.set_menu(menu)?;

    Ok(())
}

// # Minoo's Rust backend.

#[cfg(target_os = "macos")]
mod menu;

mod notes;
mod settings;
mod sync;

#[cfg(desktop)]
mod window;

use tauri::Manager;

#[cfg(desktop)]
use tauri_plugin_window_state::StateFlags;

// # Originally a workaround for a Tauri issue with a white webview background on load.
// The window starts hidden and the frontend shows it once it has painted.
// While the white splash bug got fixed, a black splash persists.
// Just keeping this indefinitely for more control over initial window display.
// --Related issues--
// - https://github.com/tauri-apps/tauri/issues/1564
// - https://github.com/tauri-apps/tauri/issues/5170
#[cfg(desktop)]
#[tauri::command]
fn show_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("Minoo") {
        let _ = window.show();
    }
}

// # Keep the native webview background color in step with the frontend theme.
// The native color shows wherever the page does not paint, like the mobile overscroll
// areas, and would otherwise stay the startup `backgroundColor` from tauri.conf.json.
#[tauri::command]
fn set_background_color(window: tauri::WebviewWindow, red: u8, green: u8, blue: u8) {
    // Best effort, since not every platform supports changing it at runtime.
    let _ = window.set_background_color(Some(tauri::window::Color(red, green, blue, 255)));
}

// "Make it so." - Captain Jean-Luc Picard, Star Trek: The Next Generation (1987)
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    // ## Remember the window's placement and restore it on the next launch.
    // The plugin is desktop only, hence the dependency and the block below being gated
    // the same way. Its state file sits next to settings.toml, but stays out of it.
    // Visibility is left out of the flags, since the window is shown by the frontend once
    // it has painted, and decorations because this window never has any.
    #[cfg(desktop)]
    let builder = builder.plugin(
        tauri_plugin_window_state::Builder::default()
            .with_state_flags(
                StateFlags::POSITION
                    | StateFlags::SIZE
                    | StateFlags::MAXIMIZED
                    | StateFlags::FULLSCREEN,
            )
            .build(),
    );

    builder
        .invoke_handler(tauri::generate_handler![
            #[cfg(desktop)]
            show_window,
            #[cfg(target_os = "macos")]
            menu::menu_set_year,
            set_background_color,
            settings::init_settings_file,
            settings::load_settings,
            settings::save_settings,
            settings::reset_settings,
            settings::open_settings_location,
            notes::list_notes,
            notes::load_note,
            notes::save_note,
            notes::create_note,
            notes::create_folder,
            notes::set_folder_collapse_status,
            notes::rename_entry,
            notes::move_entry,
            notes::delete_permanently,
            notes::empty_trash,
            notes::search_notes,
            notes::open_notes_location,
            sync::sync_get_status,
            sync::sync_set_enabled,
            sync::sync_set_device_name,
            sync::sync_unpair,
            sync::sync_discover,
            sync::sync_pair_begin,
            sync::sync_pair_finish,
            sync::sync_pair_respond,
            sync::sync_now
        ])
        .setup(|app| {
            #[cfg(desktop)]
            window::restore_position(app.handle());

            #[cfg(target_os = "macos")]
            menu::setup_app_menu(app.handle())?;

            app.manage(sync::SyncState::new(app.handle()));

            sync::start_sync_server(app.handle().clone());
            sync::start_discovery_listener(app.handle().clone());
            sync::start_periodic_sync(app.handle().clone());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(desktop)]
            window::reset_saved_placement(app, &event);

            #[cfg(mobile)]
            let _ = (app, event);
        });
}

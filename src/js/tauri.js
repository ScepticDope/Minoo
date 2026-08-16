// # Exports Tauri API handles for communication between JS and the Rust backend.
// Available on window.__TAURI__ through the withGlobalTauri setting in `./src-tauri/tauri.conf.json`.
// If a future Tauri version drops this feature, switch to the npm exports commented out below.
export const { invoke } = window.__TAURI__.core;
export const { listen } = window.__TAURI__.event;
export const { currentMonitor, getCurrentWindow } = window.__TAURI__.window;
export const { PhysicalPosition, PhysicalSize } = window.__TAURI__.dpi;
export const { getVersion } = window.__TAURI__.app;

// ## Alternative exports directly from the @tauri-apps/api packages.
// export { invoke } from '@tauri-apps/api/core';
// export { listen } from '@tauri-apps/api/event';
// export { currentMonitor, getCurrentWindow } from '@tauri-apps/api/window';
// export { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi';
// export { getVersion } from '@tauri-apps/api/app';

// # Sync across devices.
// Minoo syncs notes directly between devices on the local network, without a server,
// cloud, or extra programs. Using a small Syncthing-style protocol over one UDP port for
// discovery and one TCP port for transfer, all on std::net.
//
// Devices must be paired once before they sync. Both users confirm the same short code,
// after which the pair shares a private key (stored in sync.toml next to settings.toml)
// that authenticates every later session with an HMAC-SHA256 challenge-response. That
// way several users on the same network never mix note collections. The pairing handshake
// itself travels in plain text on the local network, as do the note contents. The key
// protects against strangers syncing, not against someone capturing wifi packets.
//
// This module splits into `crypto` (the hash primitives), `engine` (manifests, the sync
// plan, and the session protocol), and `network` (discovery, the TCP server, and the
// periodic sync rounds). This file holds the shared state and the frontend commands.

mod crypto;
mod engine;
mod network;

use crypto::random_hex;
use engine::{pairing_code, pairing_key, read_msg, send_msg};
use network::{do_sync_with_all, parse_sync_addr, save_paired_device, DiscoveredDevice};
pub use network::{start_discovery_listener, start_periodic_sync, start_sync_server};
use serde_json::{json, Value};
use std::{
    fs,
    io::BufReader,
    net::{TcpStream, UdpSocket},
    path::PathBuf,
    sync::{mpsc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};

const SYNC_UDP_PORT: u16 = 41520;
const SYNC_TCP_PORT: u16 = 41521;

// ## The sync settings and paired devices, stored as sync.toml next to settings.toml.
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct SyncConfig {
    #[serde(rename = "device-id")]
    device_id: String,
    #[serde(rename = "device-name")]
    device_name: String,
    enabled: bool,
    #[serde(rename = "last-sync")]
    last_sync: u64,
    // When this device last changed a note. The newest last-edit wins conflicts.
    #[serde(rename = "last-edit")]
    last_edit: u64,
    peers: Vec<SyncPeer>,
}

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct SyncPeer {
    id: String,
    name: String,
    key: String,
    #[serde(rename = "last-addr")]
    last_addr: String,
    #[serde(rename = "last-port")]
    last_port: u16,
}

// ## Get the path to `sync.toml`.
fn sync_config_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .expect("Failed to get the app config directory.")
        .join("sync.toml")
}

// ## Write the sync config back to `sync.toml`.
fn save_sync_config(app: &tauri::AppHandle, config: &SyncConfig) -> Result<(), String> {
    let content = toml::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize sync settings: {}.", e))?;

    let path = sync_config_path(app);

    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }

    fs::write(&path, content).map_err(|e| format!("Failed to write sync settings: {}.", e))
}

// ## Load sync.toml, creating this device's identity on first run.
fn load_sync_config(app: &tauri::AppHandle) -> SyncConfig {
    let loaded = fs::read_to_string(sync_config_path(app))
        .ok()
        .and_then(|content| toml::from_str::<SyncConfig>(&content).ok());

    let mut config = loaded.unwrap_or_default();

    if config.device_id.is_empty() {
        config.device_id = random_hex(32);

        if config.device_name.is_empty() {
            config.device_name = format!("Minoo-{}-{}", std::env::consts::OS, random_hex(2));
        }

        let _ = save_sync_config(app, &config);
    }

    config
}

// ## Check that a device id is 64 hex characters.
fn is_valid_device_id(id: &str) -> bool {
    id.len() == 64 && id.chars().all(|c| c.is_ascii_hexdigit())
}

// ## An outgoing pairing held open between sync_pair_begin and sync_pair_finish.
struct OutgoingPairing {
    stream: TcpStream,
    reader: BufReader<TcpStream>,
    peer: SyncPeer,
}

// ## The shared sync state, managed by Tauri and used by the commands and threads.
pub struct SyncState {
    config: Mutex<SyncConfig>,

    // The port the TCP listener actually got, advertised in discovery replies.
    tcp_port: Mutex<u16>,

    // An incoming pairing waiting for the user's answer (sync_pair_respond).
    pending_pair: Mutex<Option<mpsc::Sender<bool>>>,

    // An outgoing pairing between sync_pair_begin and sync_pair_finish.
    outgoing_pair: Mutex<Option<OutgoingPairing>>,

    // Only one sync session may touch the notes folder at a time.
    session_lock: Mutex<()>,
}

impl SyncState {
    pub fn new(app: &tauri::AppHandle) -> Self {
        SyncState {
            config: Mutex::new(load_sync_config(app)),
            tcp_port: Mutex::new(SYNC_TCP_PORT),
            pending_pair: Mutex::new(None),
            outgoing_pair: Mutex::new(None),
            session_lock: Mutex::new(()),
        }
    }
}

// ## The current time in milliseconds since the Unix epoch.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ## This device's name, the key for per-device state like the collapse status files.
// A hand-edited empty name falls back to a fixed key instead of breaking the format.
pub fn local_device_name(app: &tauri::AppHandle) -> String {
    let state = app.state::<SyncState>();
    let name = state.config.lock().unwrap().device_name.clone();

    if name.is_empty() {
        "Unnamed".to_string()
    } else {
        name
    }
}

// ## Stamp that this device just changed a note.
// The notes commands call this, the sync engine's own writes don't, so receiving
// changes never makes a device look "newest".
pub fn touch_last_edit(app: &tauri::AppHandle) {
    let state = app.state::<SyncState>();
    let mut config = state.config.lock().unwrap();
    config.last_edit = now_ms();

    let _ = save_sync_config(app, &config);
}

// ## The per-peer index file.
// The file listing saved when that pair last finished syncing, which is what makes
// deletions distinguishable from new files.
fn sync_index_path(app: &tauri::AppHandle, peer_id: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get the app config directory: {}.", e))?
        .join("sync-index");

    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create index directory: {}.", e))?;

    Ok(dir.join(format!("{}.json", peer_id)))
}

// ## Bookkeeping after a successful session.
// Remember the time and where the peer can be reached, and tell the frontend, so the
// sidebar label and open note stay current.
fn finish_sync(
    app: &tauri::AppHandle,
    peer_id: &str,
    peer_ip: Option<String>,
    peer_port: u16,
    changed: bool,
) {
    let state = app.state::<SyncState>();
    let last_sync = now_ms();

    // ### Release the config lock before emitting.
    // The block ends the borrow, so the mutex guard drops here instead of staying held
    // for the rest of the function.
    {
        let mut config = state.config.lock().unwrap();
        config.last_sync = last_sync;

        if let Some(ip) = peer_ip {
            if let Some(peer) = config.peers.iter_mut().find(|p| p.id == peer_id) {
                peer.last_addr = ip;

                if peer_port != 0 {
                    peer.last_port = peer_port;
                }
            }
        }

        let _ = save_sync_config(app, &config);
    }

    let _ = app.emit("syncStatus", json!({"lastSync": last_sync}));

    if changed {
        let _ = app.emit("notesChanged", true);
    }
}

// ## This device's own local network address.
// Shown in the sync settings, so "pair by address" on another device is just a matter
// of copying it over. Connecting a UDP socket only picks the outgoing interface, no
// packet leaves the device.
fn local_ip() -> Option<String> {
    let socket = UdpSocket::bind(("0.0.0.0", 0)).ok()?;
    socket.connect(("8.8.8.8", 80)).ok()?;
    Some(socket.local_addr().ok()?.ip().to_string())
}

// ## The current sync state, for the settings screen.
#[tauri::command]
pub fn sync_get_status(app: tauri::AppHandle) -> Result<Value, String> {
    let state = app.state::<SyncState>();
    let port = *state.tcp_port.lock().unwrap();
    let config = state.config.lock().unwrap();

    Ok(json!({
        "deviceId": config.device_id,
        "deviceName": config.device_name,
        "enabled": config.enabled,
        "lastSync": config.last_sync,
        "address": local_ip().map(|ip| format!("{}:{}", ip, port)),
        "peers": config.peers.iter().map(|p| json!({"id": p.id, "name": p.name})).collect::<Vec<_>>(),
    }))
}

// ## Turn syncing on or off.
#[tauri::command]
pub fn sync_set_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let state = app.state::<SyncState>();
    let mut config = state.config.lock().unwrap();
    config.enabled = enabled;

    save_sync_config(&app, &config)
}

// ## Name this device, as seen by peers.
#[tauri::command]
pub fn sync_set_device_name(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let name: String = name.trim().chars().take(64).collect();

    if name.is_empty() {
        return Err("The device name cannot be empty.".to_string());
    }

    let state = app.state::<SyncState>();
    let mut config = state.config.lock().unwrap();
    config.device_name = name;

    save_sync_config(&app, &config)
}

// ## Forget a paired device and its sync index.
#[tauri::command]
pub fn sync_unpair(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if !is_valid_device_id(&id) {
        return Err("Invalid device id.".to_string());
    }

    let state = app.state::<SyncState>();
    let mut config = state.config.lock().unwrap();
    config.peers.retain(|p| p.id != id);

    save_sync_config(&app, &config)?;

    if let Ok(index_path) = sync_index_path(&app, &id) {
        let _ = fs::remove_file(index_path);
    }

    Ok(())
}

// ## List the paired devices that answer right now.
#[tauri::command]
pub async fn sync_discover(app: tauri::AppHandle) -> Result<Vec<DiscoveredDevice>, String> {
    Ok(network::discover_devices(&app))
}

// ## Start pairing with a device.
// Exchange secrets, hold the connection, and hand the verification code to the
// frontend. sync_pair_finish sends the user's answer.
#[tauri::command]
pub async fn sync_pair_begin(app: tauri::AppHandle, addr: String) -> Result<Value, String> {
    let state = app.state::<SyncState>();

    let (enabled, our_id, our_name) = {
        let config = state.config.lock().unwrap();
        (
            config.enabled,
            config.device_id.clone(),
            config.device_name.clone(),
        )
    };

    if !enabled {
        return Err("Sync is disabled; enable it in the settings first.".to_string());
    }

    let socket_addr = parse_sync_addr(&addr)?;
    let mut stream = TcpStream::connect_timeout(&socket_addr, Duration::from_secs(5))
        .map_err(|e| format!("Could not connect: {}.", e))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(15)));
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);

    let secret_a = random_hex(32);
    let our_port = *state.tcp_port.lock().unwrap();

    send_msg(
        &mut stream,
        &json!({
            "t": "pair-request",
            "id": our_id,
            "name": our_name,
            "secret": secret_a,
            "port": our_port,
        }),
    )?;

    let challenge = read_msg(&mut reader)?;

    if challenge["t"] == "error" {
        return Err(challenge["message"]
            .as_str()
            .unwrap_or("Pairing failed.")
            .to_string());
    }

    let peer_id = challenge["id"].as_str().unwrap_or("").to_string();
    let peer_name: String = challenge["name"]
        .as_str()
        .unwrap_or("Unknown device")
        .chars()
        .take(64)
        .collect();
    let secret_b = challenge["secret"].as_str().unwrap_or("").to_string();

    if challenge["t"] != "pair-challenge" || !is_valid_device_id(&peer_id) || secret_b.is_empty() {
        return Err("The other device sent an invalid pairing reply.".to_string());
    }

    let code = pairing_code(&secret_a, &secret_b);
    let peer = SyncPeer {
        id: peer_id,
        name: peer_name.clone(),
        key: pairing_key(&secret_a, &secret_b),
        last_addr: socket_addr.ip().to_string(),
        last_port: socket_addr.port(),
    };

    *state.outgoing_pair.lock().unwrap() = Some(OutgoingPairing {
        stream,
        reader,
        peer,
    });

    Ok(json!({"name": peer_name, "code": code}))
}

#[tauri::command]
pub async fn sync_pair_finish(app: tauri::AppHandle, confirm: bool) -> Result<(), String> {
    let state = app.state::<SyncState>();

    let Some(mut pairing) = state.outgoing_pair.lock().unwrap().take() else {
        return Err("No pairing is in progress.".to_string());
    };

    if !confirm {
        let _ = send_msg(&mut pairing.stream, &json!({"t": "pair-reject"}));
        return Ok(());
    }

    send_msg(&mut pairing.stream, &json!({"t": "pair-confirm"}))?;

    // The other device's user still has to accept, hence the timeout here.
    let _ = pairing
        .stream
        .set_read_timeout(Some(Duration::from_secs(95)));

    let reply = read_msg(&mut pairing.reader)?;

    match reply["t"].as_str() {
        Some("pair-accept") => {
            let name = pairing.peer.name.clone();
            save_paired_device(&app, pairing.peer)?;
            let _ = app.emit("syncPairComplete", json!({"name": name}));

            Ok(())
        }

        Some("pair-reject") => Err("The other device declined the pairing.".to_string()),
        _ => Err(reply["message"]
            .as_str()
            .unwrap_or("Pairing failed.")
            .to_string()),
    }
}

// ## The user's answer to an incoming pairing request.
#[tauri::command]
pub fn sync_pair_respond(app: tauri::AppHandle, accept: bool) -> Result<(), String> {
    let state = app.state::<SyncState>();
    let pending = state.pending_pair.lock().unwrap();

    match pending.as_ref() {
        Some(sender) => {
            let _ = sender.send(accept);

            Ok(())
        }

        None => Err("No pairing is waiting for an answer.".to_string()),
    }
}

// ## Trigger an immediate sync with every paired device that answers.
#[tauri::command]
pub async fn sync_now(app: tauri::AppHandle) -> Result<String, String> {
    do_sync_with_all(&app)
}

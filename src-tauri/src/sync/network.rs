// # The sync network, the TCP server, UDP discovery, and the sync rounds.
// Devices come and go from the wifi, so besides answering discovery probes every device
// announces itself once a minute, and paired devices that hear an announce sync right
// away. The periodic sync also retries the last known address of every paired device,
// which keeps syncing two-way even on networks that swallow UDP broadcasts (like iOS
// without the multicast entitlement).

use super::engine::{read_msg, run_client_session, run_server_session, send_msg, SessionCtx};
use super::{
    finish_sync, is_valid_device_id, pairing_code, pairing_key, random_hex, save_sync_config,
    sync_index_path, SyncPeer, SyncState, SYNC_TCP_PORT, SYNC_UDP_PORT,
};
use crate::notes::get_notes_dir;
use serde_json::{json, Value};
use std::{
    io::BufReader,
    net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs, UdpSocket},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

// ## The TCP listener.
// Every incoming connection is either a pairing request or a sync.
pub fn start_sync_server(app: tauri::AppHandle) {
    thread::spawn(move || {
        let listener = TcpListener::bind(("0.0.0.0", SYNC_TCP_PORT))
            .or_else(|_| TcpListener::bind(("0.0.0.0", 0)));

        let listener = match listener {
            Ok(listener) => listener,
            Err(e) => {
                eprintln!("Sync is unavailable, could not open a TCP port: {}.", e);
                return;
            }
        };

        if let Ok(addr) = listener.local_addr() {
            *app.state::<SyncState>().tcp_port.lock().unwrap() = addr.port();
        }

        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let app = app.clone();

            thread::spawn(move || handle_sync_connection(app, stream));
        }
    });
}

// ## Route one incoming connection to pairing or syncing.
fn handle_sync_connection(app: tauri::AppHandle, mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(60)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(60)));

    let Ok(read_half) = stream.try_clone() else {
        return;
    };

    let mut reader = BufReader::new(read_half);
    let Ok(first) = read_msg(&mut reader) else {
        return;
    };

    let enabled = { app.state::<SyncState>().config.lock().unwrap().enabled };
    if !enabled {
        let _ = send_msg(
            &mut stream,
            &json!({"t": "error", "message": "Sync is disabled on the other device."}),
        );
        return;
    }

    let result = match first["t"].as_str() {
        Some("pair-request") => handle_incoming_pairing(&app, &mut stream, &mut reader, &first),
        Some("hello") => handle_incoming_sync(&app, &mut stream, &mut reader, &first),
        _ => Err("Unknown request.".to_string()),
    };

    if let Err(e) = result {
        eprintln!("Sync connection failed: {}", e);
    }
}

// ## An incoming sync, running the server side of the session.
fn handle_incoming_sync(
    app: &tauri::AppHandle,
    stream: &mut TcpStream,
    reader: &mut BufReader<TcpStream>,
    hello: &Value,
) -> Result<(), String> {
    let state = app.state::<SyncState>();
    let peer_id = hello["id"].as_str().unwrap_or("");

    let (peer, local_id, local_name, local_edited) = {
        let config = state.config.lock().unwrap();
        (
            config.peers.iter().find(|p| p.id == peer_id).cloned(),
            config.device_id.clone(),
            config.device_name.clone(),
            config.last_edit,
        )
    };

    let Some(peer) = peer else {
        let _ = send_msg(
            stream,
            &json!({"t": "error", "message": "The devices are not paired; pair them in the sync settings first."}),
        );

        return Err("Rejected a sync from an unpaired device.".to_string());
    };

    let ctx = SessionCtx {
        notes_dir: get_notes_dir(app)?,
        index_path: sync_index_path(app, &peer.id)?,
        local_id,
        local_name,
        local_edited,
        local_port: *state.tcp_port.lock().unwrap(),
        peer_id: peer.id.clone(),
        key: peer.key.clone(),
    };

    let changed = {
        let _session = state.session_lock.lock().unwrap();
        run_server_session(stream, reader, hello, &ctx)?
    };

    finish_sync(
        app,
        &peer.id,
        stream.peer_addr().ok().map(|a| a.ip().to_string()),
        hello["port"].as_u64().unwrap_or(0) as u16,
        changed,
    );

    Ok(())
}

// ## An incoming pairing request.
// Shows the code to the user and waits for both sides to say yes.
fn handle_incoming_pairing(
    app: &tauri::AppHandle,
    stream: &mut TcpStream,
    reader: &mut BufReader<TcpStream>,
    request: &Value,
) -> Result<(), String> {
    let peer_id = request["id"].as_str().unwrap_or("").to_string();

    let peer_name: String = request["name"]
        .as_str()
        .unwrap_or("Unknown device")
        .chars()
        .take(64)
        .collect();

    let secret_a = request["secret"].as_str().unwrap_or("").to_string();

    let state = app.state::<SyncState>();

    let (our_id, our_name) = {
        let config = state.config.lock().unwrap();
        (config.device_id.clone(), config.device_name.clone())
    };

    if !is_valid_device_id(&peer_id) || peer_id == our_id || secret_a.is_empty() {
        let _ = send_msg(
            stream,
            &json!({"t": "error", "message": "Invalid pairing request."}),
        );

        return Err("Invalid pairing request.".to_string());
    }

    // Only one pairing can be waiting for the user at a time.
    let receiver = {
        let mut pending = state.pending_pair.lock().unwrap();

        if pending.is_some() {
            let _ = send_msg(
                stream,
                &json!({"t": "error", "message": "Another pairing is already in progress."}),
            );

            return Err("Another pairing is already in progress.".to_string());
        }

        let (sender, receiver) = mpsc::channel();

        *pending = Some(sender);

        receiver
    };

    let secret_b = random_hex(32);
    let result = (|| {
        send_msg(
            stream,
            &json!({"t": "pair-challenge", "id": our_id, "name": our_name, "secret": secret_b}),
        )?;

        // Both users get 90 seconds to compare the codes and answer.
        let _ = stream.set_read_timeout(Some(Duration::from_secs(95)));

        app.emit(
            "syncPairRequest",
            json!({"name": peer_name, "code": pairing_code(&secret_a, &secret_b)}),
        )
        .map_err(|e| e.to_string())?;

        let accepted = receiver
            .recv_timeout(Duration::from_secs(90))
            .unwrap_or(false);
        if !accepted {
            let _ = send_msg(stream, &json!({"t": "pair-reject"}));

            return Err("Pairing was declined on this device.".to_string());
        }

        let confirm = read_msg(reader)?;
        if confirm["t"] != "pair-confirm" {
            return Err("The other device cancelled the pairing.".to_string());
        }

        let peer = SyncPeer {
            id: peer_id.clone(),
            name: peer_name.clone(),
            key: pairing_key(&secret_a, &secret_b),
            last_addr: stream
                .peer_addr()
                .map(|a| a.ip().to_string())
                .unwrap_or_default(),
            last_port: request["port"].as_u64().unwrap_or(SYNC_TCP_PORT as u64) as u16,
        };

        save_paired_device(app, peer)?;
        send_msg(stream, &json!({"t": "pair-accept"}))?;

        let _ = app.emit("syncPairComplete", json!({"name": peer_name}));

        Ok(())
    })();

    *state.pending_pair.lock().unwrap() = None;

    result
}

// ## Remember a paired device in the sync config.
pub fn save_paired_device(app: &tauri::AppHandle, peer: SyncPeer) -> Result<(), String> {
    let state = app.state::<SyncState>();
    let mut config = state.config.lock().unwrap();

    // Pairing again replaces the old key for that device.
    config.peers.retain(|p| p.id != peer.id);
    config.peers.push(peer);

    save_sync_config(app, &config)
}

// ## Discovery over UDP.
// The listener answers "who runs Minoo?" probes with this device's name and TCP port,
// and probing broadcasts plus unicasts to remembered addresses (broadcast is restricted
// on iOS, remembered addresses are not). The listener also hears the once-a-minute
// announces and syncs right away when a paired device shows up, which is what keeps
// syncing two-way. Each side finds the other, not just the side that happens to
// discover first.
pub fn start_discovery_listener(app: tauri::AppHandle) {
    thread::spawn(move || {
        let socket = match UdpSocket::bind(("0.0.0.0", SYNC_UDP_PORT)) {
            Ok(socket) => socket,
            Err(e) => {
                eprintln!(
                    "Sync discovery is unavailable, could not open the UDP port: {}.",
                    e
                );

                return;
            }
        };

        let mut buffer = [0u8; 1024];
        loop {
            let Ok((length, source)) = socket.recv_from(&mut buffer) else {
                continue;
            };

            let message = String::from_utf8_lossy(&buffer[..length]).to_string();

            let state = app.state::<SyncState>();

            let (enabled, device_id, device_name, peers) = {
                let config = state.config.lock().unwrap();
                (
                    config.enabled,
                    config.device_id.clone(),
                    config.device_name.clone(),
                    config.peers.clone(),
                )
            };
            if !enabled {
                continue;
            }

            if let Some(probe_id) = message.strip_prefix("MINOO-SYNC-1 PROBE ") {
                if probe_id.trim() == device_id {
                    continue;
                }

                let port = *state.tcp_port.lock().unwrap();

                let reply = json!({"minoo": 1, "id": device_id, "name": device_name, "port": port});

                let _ = socket.send_to(reply.to_string().as_bytes(), source);
            } else if let Some(announce) = message.strip_prefix("MINOO-SYNC-1 ANNOUNCE ") {
                let mut parts = announce.split_whitespace();

                let announced_id = parts.next().unwrap_or("");
                let port: u16 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
                if announced_id == device_id || port == 0 {
                    continue;
                }

                // A paired device just came online (or is still around), sync with it.
                let Some(peer) = peers.iter().find(|p| p.id == announced_id).cloned() else {
                    continue;
                };

                let app = app.clone();
                let addr = SocketAddr::new(source.ip(), port).to_string();

                thread::spawn(move || {
                    let _ = sync_with_peer(&app, &peer, &addr);
                });
            }
        }
    });
}

// ## Shout this device's presence, so paired devices sync with it right away.
fn send_announce(app: &tauri::AppHandle) {
    let state = app.state::<SyncState>();

    let (enabled, device_id, peers) = {
        let config = state.config.lock().unwrap();
        (
            config.enabled,
            config.device_id.clone(),
            config.peers.clone(),
        )
    };

    if !enabled {
        return;
    }

    let Ok(socket) = UdpSocket::bind(("0.0.0.0", 0)) else {
        return;
    };

    let _ = socket.set_broadcast(true);

    let port = *state.tcp_port.lock().unwrap();

    let announce = format!("MINOO-SYNC-1 ANNOUNCE {} {}", device_id, port);

    let _ = socket.send_to(announce.as_bytes(), ("255.255.255.255", SYNC_UDP_PORT));

    for peer in &peers {
        if !peer.last_addr.is_empty() {
            let _ = socket.send_to(
                announce.as_bytes(),
                (peer.last_addr.as_str(), SYNC_UDP_PORT),
            );
        }
    }
}

// ## A device found by discovery.
#[derive(Clone, serde::Serialize)]
pub struct DiscoveredDevice {
    pub id: String,
    pub name: String,
    pub addr: String,
    pub paired: bool,
}

// ## Probe the network and collect the devices that answer.
pub fn discover_devices(app: &tauri::AppHandle) -> Vec<DiscoveredDevice> {
    let state = app.state::<SyncState>();

    let (device_id, peers) = {
        let config = state.config.lock().unwrap();

        (config.device_id.clone(), config.peers.clone())
    };

    let Ok(socket) = UdpSocket::bind(("0.0.0.0", 0)) else {
        return Vec::new();
    };

    let _ = socket.set_broadcast(true);

    let probe = format!("MINOO-SYNC-1 PROBE {}", device_id);

    let _ = socket.send_to(probe.as_bytes(), ("255.255.255.255", SYNC_UDP_PORT));

    for peer in &peers {
        if !peer.last_addr.is_empty() {
            let _ = socket.send_to(probe.as_bytes(), (peer.last_addr.as_str(), SYNC_UDP_PORT));
        }
    }

    let _ = socket.set_read_timeout(Some(Duration::from_millis(250)));
    let deadline = Instant::now() + Duration::from_millis(1000);
    let mut found: Vec<DiscoveredDevice> = Vec::new();
    let mut buffer = [0u8; 2048];

    while Instant::now() < deadline {
        let Ok((length, source)) = socket.recv_from(&mut buffer) else {
            continue;
        };

        let Ok(reply) = serde_json::from_slice::<Value>(&buffer[..length]) else {
            continue;
        };

        if reply["minoo"] != 1 {
            continue;
        }

        let id = reply["id"].as_str().unwrap_or("").to_string();
        if id == device_id || id.is_empty() || found.iter().any(|d| d.id == id) {
            continue;
        }

        let port = reply["port"].as_u64().unwrap_or(SYNC_TCP_PORT as u64) as u16;

        found.push(DiscoveredDevice {
            paired: peers.iter().any(|p| p.id == id),
            id,
            name: reply["name"]
                .as_str()
                .unwrap_or("Unknown device")
                .chars()
                .take(64)
                .collect(),
            addr: SocketAddr::new(source.ip(), port).to_string(),
        });
    }

    found
}

// ## Parse an address string, defaulting to the sync port.
pub fn parse_sync_addr(addr: &str) -> Result<SocketAddr, String> {
    let addr = addr.trim();

    if let Ok(parsed) = addr.parse::<SocketAddr>() {
        return Ok(parsed);
    }

    format!("{}:{}", addr, SYNC_TCP_PORT)
        .to_socket_addrs()
        .ok()
        .and_then(|mut addrs| addrs.next())
        .ok_or_else(|| format!("Invalid address: {}.", addr))
}

// ## Sync with one paired device as the client side.
fn sync_with_peer(app: &tauri::AppHandle, peer: &SyncPeer, addr: &str) -> Result<bool, String> {
    let state = app.state::<SyncState>();
    let socket_addr = parse_sync_addr(addr)?;

    let mut stream = TcpStream::connect_timeout(&socket_addr, Duration::from_secs(5))
        .map_err(|e| format!("could not connect: {}", e))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(60)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(60)));
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);

    let (local_id, local_name, local_edited) = {
        let config = state.config.lock().unwrap();
        (
            config.device_id.clone(),
            config.device_name.clone(),
            config.last_edit,
        )
    };
    let ctx = SessionCtx {
        notes_dir: get_notes_dir(app)?,
        index_path: sync_index_path(app, &peer.id)?,
        local_id,
        local_name,
        local_edited,
        local_port: *state.tcp_port.lock().unwrap(),
        peer_id: peer.id.clone(),
        key: peer.key.clone(),
    };

    let changed = {
        let _session = state.session_lock.lock().unwrap();
        run_client_session(&mut stream, &mut reader, &ctx)?
    };

    finish_sync(
        app,
        &peer.id,
        Some(socket_addr.ip().to_string()),
        socket_addr.port(),
        changed,
    );

    Ok(changed)
}

// ## Sync with every paired device that answers on the network.
pub fn do_sync_with_all(app: &tauri::AppHandle) -> Result<String, String> {
    let state = app.state::<SyncState>();

    let (enabled, peers) = {
        let config = state.config.lock().unwrap();
        (config.enabled, config.peers.clone())
    };

    if !enabled {
        return Err("Sync is disabled; enable it in the settings first.".to_string());
    }

    if peers.is_empty() {
        return Err("No devices are paired yet.".to_string());
    }

    // Prefer the freshly discovered address, but fall back to where each device was
    // last seen. Portable devices come and go, and some networks swallow broadcasts.
    let discovered = discover_devices(app);
    let mut synced = Vec::new();
    let mut failed = Vec::new();

    for peer in &peers {
        let addr = match discovered.iter().find(|d| d.id == peer.id) {
            Some(device) => device.addr.clone(),
            None if !peer.last_addr.is_empty() && peer.last_port != 0 => {
                match peer.last_addr.parse() {
                    Ok(ip) => SocketAddr::new(ip, peer.last_port).to_string(),
                    Err(_) => continue,
                }
            }

            None => continue,
        };

        match sync_with_peer(app, peer, &addr) {
            Ok(_) => synced.push(peer.name.clone()),
            Err(e) => failed.push(format!("{} ({})", peer.name, e)),
        }
    }

    if synced.is_empty() && failed.is_empty() {
        return Err("No paired devices were found on the network.".to_string());
    }

    if synced.is_empty() {
        return Err(format!("Sync failed: {}.", failed.join(", ")));
    }

    let mut summary = format!("Synced with {}.", synced.join(", "));
    if !failed.is_empty() {
        summary.push_str(&format!(" Failed: {}.", failed.join(", ")));
    }

    Ok(summary)
}

// ## The periodic background sync.
// A quiet sync shortly after startup, then a retry every minute, since portable
// devices come and go from the wifi. Each round also announces this device, so the
// paired devices that hear it sync back right away.
pub fn start_periodic_sync(app: tauri::AppHandle) {
    thread::spawn(move || {
        let mut wait = Duration::from_secs(5);

        loop {
            thread::sleep(wait);
            wait = Duration::from_secs(60);

            let ready = {
                let state = app.state::<SyncState>();
                let config = state.config.lock().unwrap();

                config.enabled && !config.peers.is_empty()
            };

            if ready {
                send_announce(&app);

                // Peers being away is normal, so background failures stay quiet.
                let _ = do_sync_with_all(&app);
            }
        }
    });
}

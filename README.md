# Host-Ship Rust direct benchmark

Public allocation: `45.131.65.244:30376`.

## Test topology

```text
45.131.65.244:30376
└─ rust-reality 1.6.1
   └─ VLESS + REALITY + Vision (direct public listener; no Node.js MUX)

Cloudflare fallback (enabled only after edge health verification)
host-ship-01.pp1.de5.net:443
└─ Cloudflare Edge TLS
   -> remotely-managed Tunnel
   -> http://127.0.0.1:18080
   -> Node.js VLESS/WS + health/subscription origin
```

This branch is a controlled performance comparison. Rust REALITY binds directly to the single public allocation. The Node.js MUX and direct TLS/WS fallback are bypassed. Cloudflare Tunnel remains an outbound connection to the local WS/HTTP origin, so no second public port is required.

The branch defaults to direct Rust mode. Setting `HOSTSHIP_REALITY_DIRECT=0` restores the previous MUX + direct TLS/WS path for comparison. Returning to the `main` branch also restores the previous production topology.

## Identity preservation

REALITY state remains under `/home/container/.hostship-node/reality/v1.6.1/`. The existing UUID, Public Key, Short ID and SNI are reused. Do not set `RR_REGENERATE=1` for this comparison.

## Cloudflare configuration

Hostname: `host-ship-01.pp1.de5.net`

Published application route in the Cloudflare Zero Trust dashboard:

```text
Public hostname: host-ship-01.pp1.de5.net
Service type:   HTTP
Service URL:    http://127.0.0.1:18080
Path:            (empty)
```

The Host-Ship egg does not expose custom startup variables. The runtime reads the tunnel token from `/home/container/.hostship-node/cloudflare.json`.

That file is written by the private `dulangd/hostship-renew` installer workflow through the verified Host-Ship Client API. Do not create it manually and never commit the real token to this repository.

In the private `dulangd/hostship-renew` repository, the existing `CF_TUNNEL_TOKEN` secret supplies the token. Existing `HS_API_KEY` and `HS_SERVER_ID` secrets are reused to write the private file and restart the server. The token is not printed in workflow logs.

The installer flow writes and verifies `cloudflare.json`, restarts Host-Ship, starts cloudflared inside the Node.js process, and waits for `https://host-ship-01.pp1.de5.net/health` to return the origin health response. Only then is the CF TLS/WS node published.

The CF-specific backend advertises `PUBLIC_HOST=host-ship-01.pp1.de5.net`, `PUBLIC_PORT=443`, `PUBLIC_TLS=1` and `PUBLIC_WS_HOST=host-ship-01.pp1.de5.net`, so the subscription and health endpoint use the tunnel hostname.

## Expected runtime markers

```text
REALITY_CORE rust-reality/1.6.1
REALITY_LISTEN 0.0.0.0:30376
HOSTSHIP_RUST_DIRECT_READY node_count=2
CF_TUNNEL_NODE_ACTIVE hostname=host-ship-01.pp1.de5.net subscription_nodes=2
```

The expected public nodes are:

- Direct VLESS + REALITY + Vision at `45.131.65.244:30376`.
- VLESS + WS + TLS through `host-ship-01.pp1.de5.net:443`.

If the CF edge route is unhealthy, the runtime keeps the direct Rust REALITY node only and does not publish a broken CF node.

## Registry

The node runtime does not use a Railway Registry Token or `HOSTSHIP_REGISTER_TOKEN`.

- After CF edge health is confirmed, Public-Proof registers the CF TLS/WS route as `hostship-01-native`.
- The same verified CF health URL is used as the proof endpoint for the direct REALITY/TCP route `hostship-01-reality`; the VLESS URI itself still targets `45.131.65.244:30376`.
- Both registrations refresh on the lease-based schedule. The 900-second lease is refreshed at two-thirds of its lifetime.
- A permanent `403 uri rejected` is logged once and is not retried continuously. Transient failures use capped backoff.

## Runtime verification

The cloudflared binary is pinned to version `2026.11.2`. Its SHA-256 is checked against the official release digest:

`56f13335143ec0e22772963290683a84a04114a35ec64cbc794a4d39ff9bb8cf`.

The tunnel token is passed to cloudflared through the `TUNNEL_TOKEN` environment variable, not on the command line.

## Host-Ship startup

Keep `MAIN_FILE=index.js` (or `index.ts`) and `AUTO_UPDATE=1`. After selecting this branch in the Host-Ship Git deployment settings, use **Restart**, not Reinstall.

After restart, test the direct REALITY link separately from the CF Tunnel link. Compare download, upload, latency, stability and CPU under the same client/network/test target. The branch is a benchmark candidate; it must not be treated as a speed improvement until those measurements confirm it.

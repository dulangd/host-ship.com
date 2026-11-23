# Host-Ship multi-node runtime

Public allocation: `45.131.65.244:30376`.

The runtime currently supports two direct nodes and a prepared Cloudflare Tunnel fallback:

```text
45.131.65.244:30376
├─ REALITY/TCP              -> rust-reality v1.6.1
├─ pinned TLS/WSS           -> local TLS terminator -> VLESS/WS backend
└─ clear HTTP management    -> /health + subscriptions + Public-Proof

Cloudflare Tunnel (optional)
CF hostname:443
└─ Cloudflare Edge TLS
   -> remotely-managed Tunnel
   -> http://127.0.0.1:18080
   -> same VLESS/WS backend
```

## Direct nodes

1. `VLESS + REALITY + TCP + xtls-rprx-vision`.
2. `VLESS + WebSocket + self-signed TLS` with Xray certificate pinning (`pcs`).

The direct self-signed TLS node is retained for diagnosis/fallback. Standard Xray clients use certificate pinning; Shadowrocket receives its legacy compatibility form.

## Cloudflare Tunnel node

The third node is **prepared but disabled until both variables exist**:

- `CF_TUNNEL_TOKEN`
- `CF_TUNNEL_HOSTNAME`

The local origin is fixed at:

```text
http://127.0.0.1:18080
```

The current Host-Ship egg does not expose arbitrary `CF_TUNNEL_TOKEN` or `CF_TUNNEL_HOSTNAME` startup variables. The bootstrap therefore also supports a private runtime config file:

`/home/container/.hostship-node/cloudflare.json`

Create that file in the Host-Ship File Manager with this structure (replace the token locally; never commit the real token to GitHub):

```json
{
  "hostname": "host-ship-01.pp1.de5.net",
  "token": "PASTE_THE_NEW_TUNNEL_TOKEN_HERE"
}
```

The bootstrap reads this file at startup and applies mode `0600`. Environment variables, if the provider exposes them later, take precedence over the file. With neither source configured, CF remains in standby and does not add a third subscription node.

For a remotely-managed Cloudflare Tunnel, configure its published application route so the public hostname points to the exact Service URL above. Then restart Host-Ship once.

The runtime pins `cloudflared 2026.10.7` and verifies the official SHA-256 before execution. The tunnel token is passed through `TUNNEL_TOKEN` in the child environment, not as a command-line argument.

When enabled, the subscription gains:

```text
DE-HostShip-01-CF-Tunnel
VLESS + WebSocket + TLS
hostname:443
```

Cloudflare Tunnel is only used for HTTP/WebSocket transport. REALITY remains direct raw TCP; Cloudflare published hostnames do not transparently proxy arbitrary raw TCP to normal VLESS clients.

## Stable state

Persistent runtime state is under `/home/container/.hostship-node/`.

Both `index.js` and `index.ts` enter the same bootstrap. With `AUTO_UPDATE=1`, use **Restart**, not Reinstall.

Registry remains tokenless Public-Proof and continues to publish the direct REALITY node as primary.

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

For a remotely-managed Cloudflare Tunnel, configure its published application route so the supplied public hostname points to that exact Service URL. Then set the two variables above and restart Host-Ship once.

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

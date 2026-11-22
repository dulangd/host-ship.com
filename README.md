# Host-Ship multi-node runtime

Public allocation: `45.131.65.244:30376`.

Host-Ship currently exposes one allocation only, so the runtime multiplexes three ingress types on the same public TCP port:

```text
45.131.65.244:30376
├─ REALITY TLS ClientHello -> rust-reality v1.6.1
├─ pinned TLS/WSS          -> local TLS terminator -> VLESS/WS backend
└─ clear HTTP/WS           -> management + compatibility backend
```

## Advertised nodes

The subscription advertises exactly two nodes:

1. `VLESS + REALITY + TCP + xtls-rprx-vision` — primary.
2. `VLESS + WebSocket + TLS` — fallback.

The TLS fallback uses a persistent self-signed leaf certificate plus Xray certificate pinning:

- URI field `pcs` = SHA-256 of the leaf certificate.
- URI field `vcn` = pinned certificate name.
- No `allowInsecure`.
- No public `security=none` VLESS node is advertised.

The same TLS certificate/key is stored under `/home/container/.hostship-node/tls/` and survives normal restarts.

## Panel startup

Both `index.js` and `index.ts` are launchers that enter the same `hostship-bootstrap.js`. This removes the dependency on Host-Ship's unusual `MAIN_FILE == "*.js"` startup check.

With `AUTO_UPDATE=1`, use **Restart**, not Reinstall.

## Expected startup markers

```text
REALITY_BINARY_READY ...
REALITY_TARGET_READY ...
REALITY_BACKEND_READY ...
TLS_CERT_READY ...
TLS_BACKEND_READY ...
SERVICE_READY HTTP/WS_BACKEND ...
MUX_READY ...
HOSTSHIP_MULTI_NODE_READY node_count=2
REALITY_LINK_FINAL vless://...
TLS_WS_LINK_FINAL vless://...
SUB_URL http://45.131.65.244:30376/<token>/sub
SUB64_URL http://45.131.65.244:30376/<token>/sub64
REGISTRY_READY ... mode=public-proof
```

Registry continues to publish the REALITY node as the primary endpoint and uses tokenless Public-Proof. Do not add a shared Registry token unless Public-Proof becomes impossible.

Persistent runtime state is under `/home/container/.hostship-node/`.

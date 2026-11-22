# host-ship.com

Host-Ship native node runtime for the Container Test project.

## Current panel target

- Docker image: Nodejs 24
- Public allocation: `45.131.65.244:30376`
- Repository: `https://github.com/dulangd/host-ship.com.git`
- Branch: `main`
- Main file: `index.ts`
- No npm packages are required.

Host-Ship's NodeJS egg falls through to `ts-node --esm` for `index.ts`. The entry wrapper replaces itself with Node and launches `hostship-bootstrap.js`.

## Current architecture

The public allocation now uses one TCP port for both REALITY and management HTTP:

```text
45.131.65.244:30376
├─ raw TCP        -> rust-reality v1.6.1
└─ HTTP / WS      -> local Node backend
                    ├─ /health
                    ├─ subscription endpoints
                    └─ Public-Proof Registry endpoint
```

REALITY is the primary advertised node. The old WebSocket backend remains behind the mux for HTTP/WS compatibility and management, but subscriptions and Registry publish the REALITY URI.

Persistent state lives under `/home/container/.hostship-node/`, including the REALITY identity and Public-Proof identity. Normal restarts keep the same credentials.

## Runtime output

A successful start should include:

- `REALITY_BINARY_READY`
- `REALITY_BACKEND_READY`
- `MUX_READY`
- `SERVICE_READY HTTP/WS_BACKEND`
- `HOSTSHIP_REALITY_READY`
- `REALITY_LINK_FINAL`
- `GEO_READY`
- `REGISTRY_READY ... mode=public-proof` when Registry accepts the lease

The generated REALITY link uses:

- protocol: VLESS
- transport: TCP
- security: REALITY
- flow: `xtls-rprx-vision`
- fingerprint: `chrome`
- public endpoint: `45.131.65.244:30376`

## Public HTTP endpoints

The same public port still accepts clear HTTP requests through the protocol mux:

- `GET /health`
- `GET /<generated-token>/node`
- `GET /<generated-token>/sub`
- `GET /<generated-token>/sub64`

The subscription endpoints return the REALITY URI while REALITY mode is active.

## Registry

Host-Ship continues to prefer **tokenless Public-Proof registration**. Do not add `REGISTRY_TOKEN` or `HOSTSHIP_REGISTER_TOKEN` unless Public-Proof becomes impossible and a fallback is explicitly required.

The public `/health` endpoint stays available on port 30376 specifically so Registry proof verification can coexist with raw REALITY traffic.

HTTP 429 from Registry is handled with backoff instead of rapid re-registration.

## Panel operation

With `AUTO_UPDATE=1`, a normal **Restart** is enough for the existing server to pull the latest repository changes. Do not Reinstall just for this REALITY migration; reinstalling risks unnecessary state loss.

Optional environment variables:

- `RR_SNI`: force a specific REALITY cover SNI.
- `RR_REGENERATE=1`: regenerate the REALITY identity once. Leave unset during normal operation.
- `PUBLIC_HOST`: override the public address; default is `45.131.65.244`.

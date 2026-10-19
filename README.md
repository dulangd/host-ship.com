# host-ship.com test

Container Test runtime for the first Host-Ship.com server.

## Current panel target

- Docker image: Nodejs 24
- Allocation shown by Host-Ship: `45.131.65.244:30376`
- Repository: `https://github.com/dulangd/host-ship.com.git`
- Branch: `main`
- Main file: `index.js`
- No npm packages are required.

The server binds `0.0.0.0` and prefers `SERVER_PORT`, then `PORT`, then the current allocation `30376`.

## Test endpoints

- `GET /health`
- `GET /<generated-token>/node`
- `GET /<generated-token>/sub`
- `GET /<generated-token>/sub64`
- VLESS over WebSocket on a generated persistent path

Identity is stored in `/home/container/.hostship-node/identity.json` so normal restarts preserve UUID, WebSocket path, subscription token and node ID.

## First validation

Start with the native Host-Ship allocation only. The runtime prints:

- `SERVICE_READY`
- `NATIVE_READY`
- `DIAG_LOCAL_HTTP_OK`
- `DIAG_DNS_OK` or a DNS note
- `DIAG_PUBLIC_HAIRPIN_*`
- `GEO_READY`
- the native VLESS and subscription links

A failed hairpin probe does not by itself prove the external allocation is closed; the client-side test is authoritative.

## Railway registry

Registry code is present but remains disabled until a token is supplied.

Preferred secret file:

`/home/container/registry_token.txt`

The runtime uses stable ID `hostship-01-native`, provider `host-ship`, and the existing Railway registry API. Do not commit the token.

Registry activation comes only after the native endpoint works in a real client.

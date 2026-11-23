# Host-Ship multi-node runtime

Public allocation: `45.131.65.244:30376`.

## Runtime layout

```text
45.131.65.244:30376
├─ VLESS + REALITY + TCP
├─ VLESS + pinned TLS + WS (self-signed diagnostic fallback)
└─ HTTP health + subscription + local VLESS/WS origin

Cloudflare fallback (enabled only after edge health verification)
host-ship-01.pp1.de5.net:443
└─ Cloudflare Edge TLS
   -> remotely-managed Tunnel
   -> http://127.0.0.1:18080
   -> local VLESS/WS origin
```

The Cloudflare node is standard VLESS + WebSocket + TLS on port 443. It does not carry raw REALITY TCP.

## Cloudflare configuration

Hostname: `host-ship-01.pp1.de5.net`

Published application route in the Cloudflare Zero Trust dashboard:

```text
Public hostname: host-ship-01.pp1.de5.net
Service type:   HTTP
Service URL:    http://127.0.0.1:18080
Path:            (empty)
```

The Host-Ship egg does not expose custom startup variables. The runtime reads the token from:

`/home/container/.hostship-node/cloudflare.json`

That file is written automatically by the private `dulangd/hostship-renew` installer workflow through the already verified Host-Ship Client API. Do not create it manually and never commit the real token to this repository.

In the private `dulangd/hostship-renew` repository, add a repository secret:

- Name: `CF_TUNNEL_TOKEN`
- Value: the token portion from the Cloudflare connector command (not the `sudo cloudflared service install` text).

Existing secrets `HS_API_KEY` and `HS_SERVER_ID` are reused to write the private file and restart the server. The token is never printed in workflow logs.

After the secret is added, the installer workflow is triggered by a one-time commit to `.github/cf-install-trigger.txt` (or manually through Actions). It performs:

1. Write `cloudflare.json` through the Host-Ship Client API.
2. Read the file back and compare the token without printing it.
3. Restart Host-Ship.
4. Start cloudflared inside the Node.js process (no systemd and no sudo).
5. Wait for `https://host-ship-01.pp1.de5.net/health` to return the Host-Ship origin health response.
6. Only then restart the backend with the third CF node enabled. In that CF-specific backend, `PUBLIC_HOST`, `PUBLIC_PORT=443`, `PUBLIC_TLS=1`, and `PUBLIC_WS_HOST` are aligned to the CF hostname so its health endpoint, advertised VLESS URI, and Railway's canonical `HOSTSHIP_PUBLIC_ENDPOINT` agree.
7. Verify the three-node subscription and tokenless Public-Proof registration.
8. Run an end-to-end Xray client test against the third VLESS TLS/WS node and fetch `https://www.cloudflare.com/cdn-cgi/trace` through its SOCKS inbound. The workflow verifies the official Xray release SHA-256 and reports success only after an HTTP 200 response through the proxy.

Railway's registry service is configured with `HOSTSHIP_NODE_ID=hostship-01-native` and `HOSTSHIP_PUBLIC_ENDPOINT=https://host-ship-01.pp1.de5.net`. These are server-side enrollment values, not Host-Ship startup variables.

If the Cloudflare Edge route is not healthy, the runtime rolls back to the two direct nodes. It does not publish a non-working CF node.

## Runtime verification

The cloudflared binary is pinned to version `2026.10.7`. Its SHA-256 is checked against the digest published in the official GitHub release metadata:

`1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872`

The process uses the remotely managed tunnel token through the `TUNNEL_TOKEN` environment variable. The token is not passed on the command line.

## Registry

The node runtime does not use Railway Registry Token or `HOSTSHIP_REGISTER_TOKEN`.

- Before Cloudflare Edge health is confirmed: registry is disabled; no invalid direct REALITY/self-signed TLS URI is submitted.
- After Cloudflare Edge health is confirmed: Public-Proof registers the standard CF TLS/WS URI, with the public endpoint `https://host-ship-01.pp1.de5.net`.
- A permanent `403 uri rejected` is logged once and not retried continuously.
- Transient network failures retry from 15 seconds with capped backoff.

## Stable state

Persistent state is under `/home/container/.hostship-node/`.

Both `index.js` and `index.ts` enter the same bootstrap. With `AUTO_UPDATE=1`, use **Restart**, not Reinstall.

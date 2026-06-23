# LAN Chat Service V2

LAN Chat Service V2 is a local Fastify/WebSocket browser chat for Mac mini LAN use. It supports room codes, host-approved clients, text messages, file upload/download, and JSON persistence under `data/` by default.

## Run on the Mac mini

Durable launchd service:

```bash
cd /Users/garbagod/.hermes/.workspace/lan-chat-service
./scripts/install-launchd.sh
curl http://127.0.0.1:4301/api/health
```

Manual foreground run:

```bash
cd /Users/garbagod/.hermes/.workspace/lan-chat-service
PORT=4301 HOST=0.0.0.0 npm run start
```

Runtime settings:

- `PORT`: defaults to `4301`.
- `HOST`: defaults to `0.0.0.0` so other LAN/Tailscale devices can connect when the network allows it.
- `DATA_DIR`: optional persistence directory override. Defaults to `./data`.

## PetLink Jenkins artifact mirror

This service is now a delivery artifact mirror for Jenkins `petlink-delivery`.

Bootstrap or repair the artifact room:

```bash
cd /Users/garbagod/.hermes/.workspace/lan-chat-service
npm run bootstrap:artifacts
```

Current room purpose:

```text
Room: PetLink Delivery Artifacts
Use: Jenkins uploads APK, APK SHA256, and delivery-summary.json after successful packaging.
```

Capability values are local-only and gitignored:

```text
lan-chat-service/data/artifact-room.json      # chmod 600
local-ci-jenkins/.env LAN_CHAT_*              # chmod 600
```

Public internet exposure is intentionally not enabled. Use `http://127.0.0.1:4301` locally or `http://100.88.199.90:4301` over Tailscale until authenticated download hardening is added.

Health check:

```bash
curl http://127.0.0.1:4301/api/health
```

Expected shape:

```json
{"ok":true,"rooms":0}
```

## Open and join from another device

1. Start the service on the Mac mini with `PORT=4301 HOST=0.0.0.0 npm run start`.
2. On the Mac mini host, open `http://127.0.0.1:4301` and create a room.
3. Copy the six-character room code from the chat header.
4. From another LAN or Tailscale device, open `http://100.88.199.90:4301` or the LAN URL printed in the server log, enter the room code, and request to join.
5. The host approves the pending client before that client can send messages or upload files.

If the second device cannot connect, verify the Mac mini and client are on the same LAN/Tailscale network and that no local firewall blocks inbound traffic to port `4301`.

## Validation

Run the baseline smoke test:

```bash
npm run smoke
```

Run the stronger LAN service verification:

```bash
npm run verify:lan
```

`verify:lan` starts the server on a temporary local port with an isolated `DATA_DIR`, then checks:

- `/api/health`
- multi-room message isolation
- persistence after server restart
- file upload and download
- rejected-client denial

Manual production-port health smoke:

```bash
PORT=4301 HOST=0.0.0.0 npm run start
curl http://127.0.0.1:4301/api/health
```

Stop the manual server with `Ctrl-C` after the health check. This repo does not install launchd or mutate global machine state.

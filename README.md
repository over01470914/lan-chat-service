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

Runtime settings for a small Tencent Cloud 2C/8G/80GB host:

- `PORT`: defaults to `4301`.
- `HOST`: defaults to `0.0.0.0` so other LAN/Tailscale devices can connect when the network allows it.
- `DATA_DIR`: optional persistence directory override. Defaults to `./data`.
- `MAX_FILE_SIZE`: per-upload limit, default `200mb`. Set `500mb` if you want the old MVP limit.
- `MAX_TOTAL_UPLOAD_BYTES`: total local upload store quota, default `20gb`.
- `MAX_ROOM_MESSAGES`: per-room retained message cap, default `1000`; older file messages are pruned with their stored files.
- `MAX_ROOMS`: room cap, default `200`.
- `MAX_TEXT_LENGTH`: text message cap, default `4000`.

Files are still uploaded/downloaded with streams, so a 200MB upload is not buffered into 200MB RAM. The main low-end VPS protection is quota + retention to avoid unbounded disk/db growth.


## Linux / headless CLI

The CLI works without a browser window and is intended for headless Linux hosts or clients:

```bash
# Create a room and print the room token + host token
node bin/lan-chat.js host --server http://127.0.0.1:4301 --room "Ops Room" --name "Tencent Host" --json

# Join from another terminal/machine; host must approve the returned clientId
node bin/lan-chat.js join --server http://SERVER_IP:4301 --room ABC123 --name "Linux Worker" --json

# Host approves a pending client
node bin/lan-chat.js approve --server http://SERVER_IP:4301 --room ABC123 --host-id <hostToken> --client-id <clientId>

# Send a message without opening the Web UI
node bin/lan-chat.js send --server http://SERVER_IP:4301 --room ABC123 --client-id <clientId> --text "hello"

# Interactive terminal chat mode
node bin/lan-chat.js join --server http://SERVER_IP:4301 --room ABC123 --name "Linux Worker" --interactive
```

Terminology:

- `roomToken` = six-character room code that other devices use to join.
- `hostToken` = host client id; keep it private because it can approve/reject clients.
- CLI sessions are cached under `~/.lan-chat-service/sessions.json` for convenience.

## Web recent rooms

The browser home page now stores recently hosted/joined rooms in `localStorage` and shows a quick-access section. Each entry stores room code, room name, role, client id, origin, and last opened time; it does not store server secrets.

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
npm run cli:smoke
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

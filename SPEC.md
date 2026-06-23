# LAN Chat Service MVP Spec

## Goal
Build a browser-based LAN chat service where one machine acts as the host and other devices join rooms as clients using room codes. The host carries message history and uploaded files.

## Locked MVP Decisions
- Runtime: Web app first; Electron packaging later.
- Host: runs a local Node.js server on the host machine.
- Join: clients use a room code; URL exposure alone is not enough.
- Approval: new clients wait for host approval before entering a room.
- Rooms: one host can create and manage multiple rooms.
- Persistence: chat metadata and uploaded files persist across restarts.
- File limit: configurable; default is 200MB per upload for 2C/8G/80GB VPS safety, can be raised to 500MB.
- Storage guardrails: configurable total upload quota, room count cap, and per-room message retention.
- Devices: desktop and mobile browsers on the same LAN, plus headless Linux CLI host/join/send/approve flows.
- UI: minimal, modern, youthful, polished enough for daily use.

## Acceptance Criteria
- AC-1: Given the server is running, when a host opens the app, then they can create a named room and see its room code.
- AC-2: Given a room exists, when a client enters the room code and display name, then the host sees a pending approval request.
- AC-3: Given the host approves a pending client, when the client sends text, then all approved participants in that room receive it in real time.
- AC-4: Given an approved participant uploads a file under 500MB, then room participants receive a file message with a downloadable link.
- AC-5: Given the server restarts, when the host/client reopens a room, then retained messages and file links are still available.
- AC-6: Given multiple rooms exist, when users join different rooms, then messages/files do not cross room boundaries.
- AC-7: Given a Linux machine has no browser UI, when it runs the CLI host/join/send/approve commands, then it can create or participate in a room and receive room/client tokens.
- AC-8: Given a browser has hosted or joined rooms before, when it opens the landing page, then recent rooms are available for quick re-entry. Pending rooms must re-enter as pending instead of showing a missing-room error.
- AC-9: Given a client is pending or rejected, when they enter chat, then the composer and upload controls are disabled with a conspicuous chat-section notice.
- AC-10: Given the Host creates or manages a room, when they enable Auto approve in Web or CLI, then pending clients are approved and new clients can join without manual approval; non-host clients cannot toggle it.
- AC-11: Given test/QA or stale rooms have accumulated, when an operator runs the prune script, then it previews matching rooms by default, protects the PetLink artifact room, and only deletes rooms/files after explicit `--apply`.

## Non-goals
- End-to-end encryption.
- Internet relay/NAT traversal.
- Electron packaging.
- Chunked/resumable multi-GB transfer.
- User accounts beyond per-room display names and browser-local client identity.
- Automatic background deletion of production rooms without an operator-triggered dry-run/apply cycle.

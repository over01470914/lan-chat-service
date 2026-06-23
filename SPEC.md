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
- File limit: 500MB per upload.
- Devices: desktop and mobile browsers on the same LAN.
- UI: minimal, modern, youthful, polished enough for daily use.

## Acceptance Criteria
- AC-1: Given the server is running, when a host opens the app, then they can create a named room and see its room code.
- AC-2: Given a room exists, when a client enters the room code and display name, then the host sees a pending approval request.
- AC-3: Given the host approves a pending client, when the client sends text, then all approved participants in that room receive it in real time.
- AC-4: Given an approved participant uploads a file under 500MB, then room participants receive a file message with a downloadable link.
- AC-5: Given the server restarts, when the host/client reopens a room, then prior messages and file links are still available.
- AC-6: Given multiple rooms exist, when users join different rooms, then messages/files do not cross room boundaries.

## Non-goals
- End-to-end encryption.
- Internet relay/NAT traversal.
- Electron packaging.
- Chunked/resumable multi-GB transfer.
- User accounts beyond per-room display names and browser-local client identity.

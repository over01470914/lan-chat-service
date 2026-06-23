#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import readline from 'node:readline';
import { WebSocket } from 'ws';

const args = process.argv.slice(2);
const command = args[0] || 'help';
const flags = parseFlags(args.slice(1));
const server = normalizeServer(flags.server || process.env.LAN_CHAT_SERVER || 'http://127.0.0.1:4301');

try {
  if (command === 'help' || flags.help) showHelp();
  else if (command === 'host') await hostRoom();
  else if (command === 'join') await joinRoom();
  else if (command === 'room') await showRoom();
  else if (command === 'approve') await approveClient();
  else if (command === 'reject') await rejectClient();
  else if (command === 'settings') await updateSettings();
  else if (command === 'send') await sendMessage();
  else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  console.error(`lan-chat: ${error.message}`);
  process.exit(1);
}

function parseFlags(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith('--')) result[key] = true;
    else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function normalizeServer(value) {
  return String(value).replace(/\/$/, '');
}

async function hostRoom() {
  const created = await post('/api/rooms', { name: flags.room || 'LAN Room', hostName: flags.name || 'Host CLI', autoApprove: Boolean(flags['auto-approve']) });
  rememberSession({ server, roomCode: created.room.code, roomName: created.room.name, clientId: created.clientId, role: 'host' });
  const payload = { server, roomCode: created.room.code, roomToken: created.room.code, hostId: created.clientId, hostToken: created.clientId, autoApprove: created.room.autoApprove, room: created.room };
  print(payload, [`Room ${created.room.code} created`, `server=${server}`, `roomToken=${created.room.code}`, `hostToken=${created.clientId}`, `autoApprove=${created.room.autoApprove ? 'on' : 'off'}`]);
  if (flags.interactive) await interactive(created.room.code, created.clientId, 'host');
}

async function joinRoom() {
  const roomCode = requireFlag('room').toUpperCase();
  const joined = await post(`/api/rooms/${roomCode}/join`, { name: flags.name || 'CLI Client', clientId: flags['client-id'] });
  rememberSession({ server, roomCode, roomName: joined.room.name, clientId: joined.clientId, role: 'client', status: joined.status });
  const payload = { server, roomCode, roomToken: roomCode, clientId: joined.clientId, status: joined.status, room: joined.room };
  print(payload, [`Join ${roomCode}: ${joined.status}`, `server=${server}`, `clientId=${joined.clientId}`]);
  if (flags.interactive) await interactive(roomCode, joined.clientId, 'client');
}

async function showRoom() {
  const roomCode = requireFlag('room').toUpperCase();
  const room = await get(`/api/rooms/${roomCode}`);
  print(room, [`Room ${room.room.code} / ${room.room.name}`, `pending=${room.room.pending.length}`, `approved=${room.room.approved.length}`, `messages=${room.room.messages.length}`]);
}

async function approveClient() {
  const roomCode = requireFlag('room').toUpperCase();
  const approved = await post(`/api/rooms/${roomCode}/approve`, { hostId: requireFlag('host-id'), clientId: requireFlag('client-id') });
  print(approved, [`Approved ${flags['client-id']} in ${roomCode}`]);
}

async function rejectClient() {
  const roomCode = requireFlag('room').toUpperCase();
  const rejected = await post(`/api/rooms/${roomCode}/reject`, { hostId: requireFlag('host-id'), clientId: requireFlag('client-id') });
  print(rejected, [`Rejected ${flags['client-id']} in ${roomCode}`]);
}

async function updateSettings() {
  const roomCode = requireFlag('room').toUpperCase();
  if (!flags['auto-approve'] && !flags['manual-approve']) throw new Error('--auto-approve or --manual-approve is required');
  const updated = await post(`/api/rooms/${roomCode}/settings`, { hostId: requireFlag('host-id'), autoApprove: Boolean(flags['auto-approve']) });
  print(updated, [`Room ${roomCode} autoApprove=${updated.room.autoApprove ? 'on' : 'off'}`, `pending=${updated.room.pending.length}`, `approved=${updated.room.approved.length}`]);
}

async function sendMessage() {
  const roomCode = requireFlag('room').toUpperCase();
  const text = flags.text || flags.message;
  if (!text) throw new Error('--text is required');
  const sent = await post(`/api/rooms/${roomCode}/messages`, { clientId: requireFlag('client-id'), text });
  print(sent, [`Sent to ${roomCode}: ${sent.message.text}`]);
}

async function interactive(roomCode, clientId, role) {
  console.log(`Interactive ${role} mode. Type text to send. Commands: /room, /approve <clientId>, /reject <clientId>, /quit`);
  const wsUrl = `${server.replace(/^http/, 'ws')}/ws?roomCode=${encodeURIComponent(roomCode)}&clientId=${encodeURIComponent(clientId)}`;
  const socket = new WebSocket(wsUrl);
  socket.on('message', (raw) => {
    const event = JSON.parse(raw.toString());
    if (event.type === 'message') printMessage(event.message);
    if (event.type === 'pending-updated') console.log(`[pending] ${event.room.pending.map((client) => `${client.name}:${client.id}`).join(', ') || 'none'}`);
    if (event.type === 'room-updated') console.log(`[room] pending=${event.room.pending.length} approved=${event.room.approved.length}`);
    if (event.type === 'rejected') console.log('[access] rejected by host');
  });
  await new Promise((resolve) => socket.once('open', resolve));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  rl.prompt();
  rl.on('line', async (line) => {
    const text = line.trim();
    try {
      if (!text) return rl.prompt();
      if (text === '/quit') {
        rl.close();
        socket.close();
        return;
      }
      if (text === '/room') console.log(JSON.stringify(await get(`/api/rooms/${roomCode}`), null, 2));
      else if (text.startsWith('/approve ')) await post(`/api/rooms/${roomCode}/approve`, { hostId: clientId, clientId: text.split(/\s+/)[1] });
      else if (text.startsWith('/reject ')) await post(`/api/rooms/${roomCode}/reject`, { hostId: clientId, clientId: text.split(/\s+/)[1] });
      else await post(`/api/rooms/${roomCode}/messages`, { clientId, text });
    } catch (error) {
      console.error(error.message);
    }
    rl.prompt();
  });
  await new Promise((resolve) => rl.once('close', resolve));
}

function printMessage(message) {
  if (message.type === 'file') console.log(`[${message.authorName}] file: ${message.file.name} ${message.file.url}`);
  else console.log(`[${message.authorName}] ${message.text}`);
}

function requireFlag(name) {
  if (!flags[name]) throw new Error(`--${name} is required`);
  return flags[name];
}

async function get(path) {
  const response = await fetch(`${server}${path}`);
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function post(path, body) {
  const response = await fetch(`${server}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

function print(payload, lines) {
  if (flags.json) console.log(JSON.stringify(payload, null, 2));
  else console.log(lines.join('\n'));
}

function rememberSession(session) {
  const path = join(homedir(), '.lan-chat-service', 'sessions.json');
  mkdirSync(dirname(path), { recursive: true });
  const sessions = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  const filtered = sessions.filter((item) => !(item.server === session.server && item.roomCode === session.roomCode && item.clientId === session.clientId));
  filtered.unshift({ ...session, lastOpenedAt: new Date().toISOString() });
  writeFileSync(path, JSON.stringify(filtered.slice(0, 30), null, 2));
}

function showHelp() {
  console.log(`LAN Chat CLI

Usage:
  lan-chat host --server http://host:4301 --room "Ops Room" --name Host [--auto-approve] [--json] [--interactive]
  lan-chat join --server http://host:4301 --room ABC123 --name Worker [--json] [--interactive]
  lan-chat room --server http://host:4301 --room ABC123 [--json]
  lan-chat approve --room ABC123 --host-id <hostToken> --client-id <clientId>
  lan-chat reject --room ABC123 --host-id <hostToken> --client-id <clientId>
  lan-chat settings --room ABC123 --host-id <hostToken> --auto-approve
  lan-chat settings --room ABC123 --host-id <hostToken> --manual-approve
  lan-chat send --room ABC123 --client-id <clientId> --text "hello"

Notes:
  roomToken is the six-character room code.
  hostToken is the host client id; keep it private because it can approve/reject clients.
  --auto-approve lets CLI/Linux clients join and send without a browser approval step.
  LAN_CHAT_SERVER can provide a default server URL.
`);
}

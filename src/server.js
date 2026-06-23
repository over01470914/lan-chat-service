import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import fastifyMultipart from '@fastify/multipart';
import Fastify from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 4301);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT_DIR = resolve(process.cwd());
const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(ROOT_DIR, 'data');
const UPLOAD_DIR = join(DATA_DIR, 'uploads');
const DB_PATH = join(DATA_DIR, 'db.json');
const DEFAULT_MAX_FILE_SIZE = 200 * 1024 * 1024;
const DEFAULT_TOTAL_UPLOAD_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_FILE_SIZE = parseBytes(process.env.MAX_FILE_SIZE || process.env.MAX_UPLOAD_BYTES, DEFAULT_MAX_FILE_SIZE);
const MAX_TOTAL_UPLOAD_BYTES = parseBytes(process.env.MAX_TOTAL_UPLOAD_BYTES || process.env.UPLOAD_QUOTA_BYTES, DEFAULT_TOTAL_UPLOAD_BYTES);
const MAX_ROOM_MESSAGES = parsePositiveInt(process.env.MAX_ROOM_MESSAGES, 1000);
const MAX_ROOMS = parsePositiveInt(process.env.MAX_ROOMS, 200);
const MAX_TEXT_LENGTH = parsePositiveInt(process.env.MAX_TEXT_LENGTH, 4000);
const UPLOAD_ROOT = resolve(UPLOAD_DIR);

mkdirSync(UPLOAD_DIR, { recursive: true });

const app = Fastify({ logger: true, bodyLimit: MAX_FILE_SIZE + 1024 * 1024 });
await app.register(fastifyMultipart, { limits: { fileSize: MAX_FILE_SIZE } });

let db = await loadDb();
const sockets = new Map();

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBytes(value, fallback) {
  if (!value) return fallback;
  const text = String(value).trim().toLowerCase();
  const match = text.match(/^(\d+(?:\.\d+)?)(b|kb|mb|gb)?$/);
  if (!match) return fallback;
  const amount = Number(match[1]);
  const unit = match[2] || 'b';
  const multiplier = unit === 'gb' ? 1024 ** 3 : unit === 'mb' ? 1024 ** 2 : unit === 'kb' ? 1024 : 1;
  return Math.floor(amount * multiplier);
}

function createEmptyDb() {
  return { rooms: {}, clients: {} };
}

async function loadDb() {
  if (!existsSync(DB_PATH)) return createEmptyDb();
  const raw = await readFile(DB_PATH, 'utf8');
  return JSON.parse(raw);
}

async function saveDb() {
  const tmpPath = `${DB_PATH}.tmp`;
  await writeFile(tmpPath, JSON.stringify(db, null, 2));
  await rename(tmpPath, DB_PATH);
}

function roomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let index = 0; index < 6; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  if (db.rooms[code]) return roomCode();
  return code;
}

function publicRoom(room) {
  return {
    code: room.code,
    name: room.name,
    autoApprove: Boolean(room.autoApprove),
    createdAt: room.createdAt,
    pending: room.pending.map((id) => db.clients[id]).filter(Boolean),
    approved: room.approved.map((id) => db.clients[id]).filter(Boolean),
    messages: room.messages,
  };
}

function ensureRoomLists(room) {
  room.pending ||= [];
  room.approved ||= [];
  room.rejected ||= [];
  if (typeof room.autoApprove !== 'boolean') room.autoApprove = false;
}

function requireRoom(code) {
  const room = db.rooms[String(code || '').toUpperCase()];
  if (!room) {
    const error = new Error('Room not found');
    error.statusCode = 404;
    throw error;
  }
  ensureRoomLists(room);
  return room;
}

function requireHost(room, hostId) {
  if (hostId !== room.hostId) {
    const error = new Error('Only host can update room settings');
    error.statusCode = 403;
    throw error;
  }
}

function requireApproved(room, clientId) {
  if (room.rejected.includes(clientId)) {
    const error = new Error('Client was rejected');
    error.statusCode = 403;
    throw error;
  }
  if (room.hostId !== clientId && !room.approved.includes(clientId)) {
    const error = new Error('Client is not approved');
    error.statusCode = 403;
    throw error;
  }
}

function broadcast(roomCodeValue, event) {
  for (const [clientId, socket] of sockets.entries()) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    if (socket.roomCode !== roomCodeValue) continue;
    socket.send(JSON.stringify(event));
  }
}

function pushMessage(room, message) {
  room.messages.push(message);
  broadcast(room.code, { type: 'message', message });
}

async function enforceRoomRetention(room) {
  const removed = [];
  while (room.messages.length > MAX_ROOM_MESSAGES) {
    removed.push(room.messages.shift());
  }
  for (const message of removed) {
    if (message?.type === 'file' && message.file?.url) await deleteStoredFileByUrl(message.file.url);
  }
  if (removed.length) broadcast(room.code, { type: 'room-updated', room: publicRoom(room) });
}

async function deleteStoredFileByUrl(url) {
  const storedName = storedNameFromFileUrl(url);
  const filePath = resolveUploadPath(storedName);
  if (!filePath) return;
  await unlink(filePath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function getUploadBytes() {
  const names = await readdir(UPLOAD_DIR).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  let total = 0;
  for (const name of names) {
    const filePath = resolveUploadPath(name);
    if (!filePath) continue;
    const info = await stat(filePath).catch(() => null);
    if (info?.isFile()) total += info.size;
  }
  return total;
}

function configSummary() {
  return {
    maxFileSize: MAX_FILE_SIZE,
    maxTotalUploadBytes: MAX_TOTAL_UPLOAD_BYTES,
    maxRoomMessages: MAX_ROOM_MESSAGES,
    maxRooms: MAX_ROOMS,
    maxTextLength: MAX_TEXT_LENGTH,
    dataDir: DATA_DIR,
    uploadDir: UPLOAD_DIR,
  };
}

function canDeleteMessage(room, message, clientId) {
  return room.hostId === clientId || message.clientId === clientId;
}

function safeStoredFilename(filename) {
  const cleaned = String(filename || 'file')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.+/g, '.')
    .replace(/^\.+/, '')
    .slice(0, 180)
    .trim();
  return cleaned || 'file';
}

function storedNameFromFileUrl(url) {
  const value = String(url || '');
  const segment = value.split('/').pop() || '';
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function resolveUploadPath(storedName) {
  const name = String(storedName || '');
  if (!name || name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
  const filePath = resolve(UPLOAD_DIR, name);
  if (filePath !== UPLOAD_ROOT && !filePath.startsWith(`${UPLOAD_ROOT}${sep}`)) return null;
  return filePath;
}

app.get('/api/health', async () => ({
  ok: true,
  rooms: Object.keys(db.rooms).length,
  messages: Object.values(db.rooms).reduce((count, room) => count + (room.messages?.length || 0), 0),
  uploadBytes: await getUploadBytes(),
  config: configSummary(),
}));

app.post('/api/rooms', async (request) => {
  if (Object.keys(db.rooms).length >= MAX_ROOMS) {
    const error = new Error('Room limit reached');
    error.statusCode = 507;
    throw error;
  }
  const name = String(request.body?.name || 'LAN Room').slice(0, 80);
  const hostName = String(request.body?.hostName || 'Host').slice(0, 40);
  const autoApprove = request.body?.autoApprove === true;
  const hostId = randomUUID();
  const code = roomCode();
  db.clients[hostId] = { id: hostId, name: hostName, role: 'host', createdAt: new Date().toISOString() };
  db.rooms[code] = {
    code,
    name,
    hostId,
    autoApprove,
    createdAt: new Date().toISOString(),
    pending: [],
    approved: [hostId],
    rejected: [],
    messages: [],
  };
  await saveDb();
  return { room: publicRoom(db.rooms[code]), clientId: hostId };
});

app.get('/api/rooms/:code', async (request) => ({ room: publicRoom(requireRoom(request.params.code)) }));

app.post('/api/rooms/:code/join', async (request) => {
  const room = requireRoom(request.params.code);
  const name = String(request.body?.name || 'Guest').slice(0, 40);
  const existingClientId = request.body?.clientId;
  if (existingClientId && db.clients[existingClientId] && room.rejected.includes(existingClientId)) {
    return { status: 'rejected', clientId: existingClientId, room: publicRoom(room) };
  }
  if (existingClientId && db.clients[existingClientId] && room.approved.includes(existingClientId)) {
    return { status: 'approved', clientId: existingClientId, room: publicRoom(room) };
  }
  if (existingClientId && db.clients[existingClientId] && room.pending.includes(existingClientId)) {
    if (room.autoApprove) {
      room.pending = room.pending.filter((id) => id !== existingClientId);
      if (!room.approved.includes(existingClientId)) room.approved.push(existingClientId);
      await saveDb();
      const publicState = publicRoom(room);
      broadcast(room.code, { type: 'room-updated', room: publicState });
      return { status: 'approved', clientId: existingClientId, room: publicState };
    }
    return { status: 'pending', clientId: existingClientId, room: publicRoom(room) };
  }
  const clientId = randomUUID();
  db.clients[clientId] = { id: clientId, name, role: 'client', createdAt: new Date().toISOString() };
  const status = room.autoApprove ? 'approved' : 'pending';
  if (room.autoApprove) room.approved.push(clientId);
  else room.pending.push(clientId);
  await saveDb();
  broadcast(room.code, { type: room.autoApprove ? 'room-updated' : 'pending-updated', room: publicRoom(room) });
  return { status, clientId, room: publicRoom(room) };
});

app.post('/api/rooms/:code/settings', async (request) => {
  const room = requireRoom(request.params.code);
  requireHost(room, request.body?.hostId);
  if (typeof request.body?.autoApprove === 'boolean') {
    room.autoApprove = request.body.autoApprove;
    if (room.autoApprove && room.pending.length) {
      for (const clientId of room.pending) {
        if (!room.approved.includes(clientId)) room.approved.push(clientId);
      }
      room.pending = [];
    }
  }
  await saveDb();
  const publicState = publicRoom(room);
  broadcast(room.code, { type: 'room-updated', room: publicState });
  return { room: publicState };
});

app.post('/api/rooms/:code/approve', async (request) => {
  const room = requireRoom(request.params.code);
  requireHost(room, request.body?.hostId);
  const clientId = request.body?.clientId;
  room.pending = room.pending.filter((id) => id !== clientId);
  room.rejected = room.rejected.filter((id) => id !== clientId);
  if (!room.approved.includes(clientId)) room.approved.push(clientId);
  await saveDb();
  broadcast(room.code, { type: 'room-updated', room: publicRoom(room) });
  return { room: publicRoom(room) };
});

app.post('/api/rooms/:code/reject', async (request) => {
  const room = requireRoom(request.params.code);
  requireHost(room, request.body?.hostId);
  const clientId = request.body?.clientId;
  room.pending = room.pending.filter((id) => id !== clientId);
  room.approved = room.approved.filter((id) => id !== clientId);
  if (clientId && !room.rejected.includes(clientId)) room.rejected.push(clientId);
  await saveDb();
  const publicState = publicRoom(room);
  broadcast(room.code, { type: 'room-updated', room: publicState });
  const socket = sockets.get(clientId);
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'rejected', room: publicState }));
  return { room: publicState };
});

app.post('/api/rooms/:code/messages', async (request) => {
  const room = requireRoom(request.params.code);
  const clientId = request.body?.clientId;
  requireApproved(room, clientId);
  const text = String(request.body?.text || '').trim().slice(0, MAX_TEXT_LENGTH);
  if (!text) {
    const error = new Error('Message text is required');
    error.statusCode = 400;
    throw error;
  }
  const message = {
    id: randomUUID(),
    type: 'text',
    text: text.slice(0, 8000),
    clientId,
    authorName: db.clients[clientId]?.name || 'Unknown',
    createdAt: new Date().toISOString(),
  };
  pushMessage(room, message);
  await enforceRoomRetention(room);
  await saveDb();
  return { message };
});

app.post('/api/rooms/:code/files', async (request, reply) => {
  const room = requireRoom(request.params.code);
  const parts = request.parts();
  let clientId = '';
  let savedFile = null;

  for await (const part of parts) {
    if (part.type === 'field' && part.fieldname === 'clientId') {
      clientId = String(part.value);
      continue;
    }
    if (part.type === 'file' && part.fieldname === 'file') {
      if (!clientId) {
        reply.code(400);
        return { error: 'clientId must be provided before file' };
      }
      requireApproved(room, clientId);
      const safeName = safeStoredFilename(part.filename);
      const id = randomUUID();
      const storedName = `${id}-${safeName}`;
      const targetPath = join(UPLOAD_DIR, storedName);
      const uploadBytesBefore = await getUploadBytes();
      await pipeline(part.file, createWriteStream(targetPath));
      const size = (await stat(targetPath)).size;
      if (uploadBytesBefore + size > MAX_TOTAL_UPLOAD_BYTES) {
        await unlink(targetPath).catch(() => {});
        const error = new Error('Upload storage quota exceeded');
        error.statusCode = 507;
        throw error;
      }
      savedFile = { id, originalName: safeName, storedName, mimeType: part.mimetype, size };
    }
  }

  requireApproved(room, clientId);
  if (!savedFile) {
    reply.code(400);
    return { error: 'file is required' };
  }

  const message = {
    id: randomUUID(),
    type: 'file',
    clientId,
    authorName: db.clients[clientId]?.name || 'Unknown',
    createdAt: new Date().toISOString(),
    file: {
      id: savedFile.id,
      name: savedFile.originalName,
      mimeType: savedFile.mimeType,
      size: savedFile.size,
      url: `/api/files/${savedFile.storedName}`,
    },
  };
  pushMessage(room, message);
  await enforceRoomRetention(room);
  await saveDb();
  return { message };
});


app.delete('/api/rooms/:code/messages/:messageId', async (request) => {
  const room = requireRoom(request.params.code);
  const clientId = request.body?.clientId;
  requireApproved(room, clientId);
  const message = room.messages.find((item) => item.id === request.params.messageId);
  if (!message) {
    const error = new Error('Message not found');
    error.statusCode = 404;
    throw error;
  }
  if (!canDeleteMessage(room, message, clientId)) {
    const error = new Error('Only host or sender can delete this message');
    error.statusCode = 403;
    throw error;
  }

  room.messages = room.messages.filter((item) => item.id !== message.id);
  if (message.type === 'file' && message.file?.url) await deleteStoredFileByUrl(message.file.url);
  await saveDb();
  const publicState = publicRoom(room);
  broadcast(room.code, { type: 'room-updated', room: publicState });
  return { room: publicState, deleted: message.id };
});

app.get('/api/files/:storedName', async (request, reply) => {
  const storedName = String(request.params.storedName || '');
  const filePath = resolveUploadPath(storedName);
  if (!filePath) {
    reply.code(400);
    return { error: 'bad filename' };
  }
  if (!existsSync(filePath)) {
    reply.code(404);
    return { error: 'not found' };
  }
  return reply.send(createReadStream(filePath));
});

app.get('/', async (_request, reply) => reply.sendFile?.('index.html'));
await app.register(import('@fastify/static').then((module) => module.default), { root: join(ROOT_DIR, 'public'), prefix: '/' });

const server = await app.listen({ port: PORT, host: HOST });
app.log.info(`Local URL: http://127.0.0.1:${PORT}`);
for (const url of getLanUrls(PORT)) app.log.info(`LAN URL: ${url}`);
const wss = new WebSocketServer({ server: app.server, path: '/ws' });
wss.on('connection', (socket, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const clientId = url.searchParams.get('clientId');
  const code = url.searchParams.get('roomCode')?.toUpperCase();
  socket.roomCode = code;
  if (clientId) sockets.set(clientId, socket);
  socket.send(JSON.stringify({ type: 'hello', server }));
  socket.on('close', () => {
    if (clientId) sockets.delete(clientId);
  });
});

function getLanUrls(port) {
  return Object.values(networkInterfaces())
    .flat()
    .filter((item) => item && item.family === 'IPv4' && !item.internal)
    .map((item) => `http://${item.address}:${port}`);
}

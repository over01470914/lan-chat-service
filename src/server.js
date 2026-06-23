import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
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
const MAX_FILE_SIZE = 500 * 1024 * 1024;
const UPLOAD_ROOT = resolve(UPLOAD_DIR);

mkdirSync(UPLOAD_DIR, { recursive: true });

const app = Fastify({ logger: true, bodyLimit: MAX_FILE_SIZE + 1024 * 1024 });
await app.register(fastifyMultipart, { limits: { fileSize: MAX_FILE_SIZE } });

let db = await loadDb();
const sockets = new Map();

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

app.get('/api/health', async () => ({ ok: true, rooms: Object.keys(db.rooms).length }));

app.post('/api/rooms', async (request) => {
  const name = String(request.body?.name || 'LAN Room').slice(0, 80);
  const hostName = String(request.body?.hostName || 'Host').slice(0, 40);
  const hostId = randomUUID();
  const code = roomCode();
  db.clients[hostId] = { id: hostId, name: hostName, role: 'host', createdAt: new Date().toISOString() };
  db.rooms[code] = {
    code,
    name,
    hostId,
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
  const clientId = randomUUID();
  db.clients[clientId] = { id: clientId, name, role: 'client', createdAt: new Date().toISOString() };
  room.pending.push(clientId);
  await saveDb();
  broadcast(room.code, { type: 'pending-updated', room: publicRoom(room) });
  return { status: 'pending', clientId, room: publicRoom(room) };
});

app.post('/api/rooms/:code/approve', async (request) => {
  const room = requireRoom(request.params.code);
  if (request.body?.hostId !== room.hostId) {
    const error = new Error('Only host can approve clients');
    error.statusCode = 403;
    throw error;
  }
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
  if (request.body?.hostId !== room.hostId) {
    const error = new Error('Only host can reject clients');
    error.statusCode = 403;
    throw error;
  }
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
  const text = String(request.body?.text || '').trim();
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
      await pipeline(part.file, createWriteStream(targetPath));
      savedFile = { id, originalName: safeName, storedName, mimeType: part.mimetype };
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
      url: `/api/files/${savedFile.storedName}`,
    },
  };
  pushMessage(room, message);
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
  if (message.type === 'file' && message.file?.url) {
    const storedName = storedNameFromFileUrl(message.file.url);
    const filePath = resolveUploadPath(storedName);
    if (filePath) {
      await unlink(filePath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
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

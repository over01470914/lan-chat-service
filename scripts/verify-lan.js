import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

const port = Number(process.env.VERIFY_PORT || 4501);
const host = '127.0.0.1';
const baseUrl = `http://${host}:${port}`;
const dataDir = await mkdtemp(joinPath(tmpdir(), 'lan-chat-verify-data-'));
let server;
let output = '';

try {
  server = await startServer();
  const health = await get('/api/health');
  assert(health.ok === true, 'health endpoint returns ok');

  const alpha = await createRoom('Alpha Room', 'Alpha Host');
  const beta = await createRoom('Beta Room', 'Beta Host');
  assert(alpha.room.code !== beta.room.code, 'rooms have distinct codes');

  const alphaClient = await joinAndApprove(alpha, 'Alpha Client');
  const betaClient = await joinAndApprove(beta, 'Beta Client');

  await post(`/api/rooms/${alpha.room.code}/messages`, { clientId: alphaClient.clientId, text: 'alpha-only-message' });
  await post(`/api/rooms/${beta.room.code}/messages`, { clientId: betaClient.clientId, text: 'beta-only-message' });

  const alphaRoom = await get(`/api/rooms/${alpha.room.code}`);
  const betaRoom = await get(`/api/rooms/${beta.room.code}`);
  assert(alphaRoom.room.messages.some((message) => message.text === 'alpha-only-message'), 'alpha room has alpha message');
  assert(!alphaRoom.room.messages.some((message) => message.text === 'beta-only-message'), 'alpha room excludes beta message');
  assert(betaRoom.room.messages.some((message) => message.text === 'beta-only-message'), 'beta room has beta message');
  assert(!betaRoom.room.messages.some((message) => message.text === 'alpha-only-message'), 'beta room excludes alpha message');

  const rejectedJoin = await post(`/api/rooms/${alpha.room.code}/join`, { name: 'Denied Client' });
  await post(`/api/rooms/${alpha.room.code}/reject`, { hostId: alpha.clientId, clientId: rejectedJoin.clientId });
  await expectPostStatus(`/api/rooms/${alpha.room.code}/messages`, { clientId: rejectedJoin.clientId, text: 'denied' }, 403, 'rejected client cannot send message');

  const uploadForm = new FormData();
  uploadForm.append('clientId', alphaClient.clientId);
  uploadForm.append('file', new Blob(['download payload v2'], { type: 'text/plain' }), 'payload-v2.txt');
  const uploadResponse = await fetch(`${baseUrl}/api/rooms/${alpha.room.code}/files`, { method: 'POST', body: uploadForm });
  assert(uploadResponse.ok, `file upload ok (${uploadResponse.status})`);
  const upload = await uploadResponse.json();
  const downloadResponse = await fetch(`${baseUrl}${upload.message.file.url}`);
  assert(downloadResponse.ok, `file download ok (${downloadResponse.status})`);
  assert(await downloadResponse.text() === 'download payload v2', 'file download content matches');

  await stopServer();
  server = await startServer();
  const restored = await get(`/api/rooms/${alpha.room.code}`);
  assert(restored.room.messages.some((message) => message.text === 'alpha-only-message'), 'text message persists after restart');
  assert(restored.room.messages.some((message) => message.type === 'file' && message.file.name === 'payload-v2.txt'), 'file message persists after restart');
  const restoredFile = restored.room.messages.find((message) => message.type === 'file' && message.file.name === 'payload-v2.txt');
  const restoredDownload = await fetch(`${baseUrl}${restoredFile.file.url}`);
  assert(await restoredDownload.text() === 'download payload v2', 'file remains downloadable after restart');

  const deleted = await del(`/api/rooms/${alpha.room.code}/messages/${restoredFile.id}`, { clientId: alpha.clientId });
  assert(deleted.deleted === restoredFile.id, 'host can delete file message');
  const deletedDownload = await fetch(`${baseUrl}${restoredFile.file.url}`);
  assert(deletedDownload.status === 404, 'deleted attachment is gone from upload store');

  await stopServer();
  await injectTraversalMessage(alpha);
  server = await startServer();
  const traversalFetch = await fetch(`${baseUrl}/api/files/%2e%2e%2fsentinel-outside-upload.txt`);
  assert(traversalFetch.status !== 200, 'path traversal download is not served');
  const traversalDelete = await del(`/api/rooms/${alpha.room.code}/messages/traversal-delete-probe`, { clientId: alpha.clientId });
  assert(traversalDelete.deleted === 'traversal-delete-probe', 'malicious stored path message can be removed safely');
  await access(joinPath(dataDir, 'sentinel-outside-upload.txt'));

  console.log(JSON.stringify({
    ok: true,
    port,
    dataDir,
    rooms: [alpha.room.code, beta.room.code],
    checks: [
      'api health',
      'multi-room isolation',
      'persistence after restart',
      'file download',
      'file delete persistence cleanup',
      'upload path traversal safety',
      'rejected-client denial',
    ],
  }, null, 2));
} finally {
  if (server) await stopServer();
  await rm(dataDir, { recursive: true, force: true });
}

async function startServer() {
  output = '';
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), HOST: host, DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  await waitForHealth();
  return child;
}

async function stopServer() {
  const child = server;
  server = null;
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1500);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`server did not become healthy:\n${output}`);
}

async function createRoom(name, hostName) {
  const created = await post('/api/rooms', { name, hostName });
  assert(created.room.code, `${name} has room code`);
  assert(created.clientId, `${name} has host client id`);
  return created;
}

async function joinAndApprove(roomContext, name) {
  const join = await post(`/api/rooms/${roomContext.room.code}/join`, { name });
  assert(join.status === 'pending', `${name} starts pending`);
  await post(`/api/rooms/${roomContext.room.code}/approve`, { hostId: roomContext.clientId, clientId: join.clientId });
  return join;
}

async function injectTraversalMessage(roomContext) {
  const sentinelPath = joinPath(dataDir, 'sentinel-outside-upload.txt');
  await writeFile(sentinelPath, 'do not delete');
  const dbPath = joinPath(dataDir, 'db.json');
  const db = JSON.parse(await readFile(dbPath, 'utf8'));
  db.rooms[roomContext.room.code].messages.push({
    id: 'traversal-delete-probe',
    type: 'file',
    clientId: roomContext.clientId,
    authorName: 'Safety Probe',
    createdAt: new Date().toISOString(),
    file: {
      id: 'traversal-delete-probe-file',
      name: 'sentinel-outside-upload.txt',
      mimeType: 'text/plain',
      url: '/api/files/%2e%2e%2fsentinel-outside-upload.txt',
    },
  });
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function del(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function expectPostStatus(path, body, status, message) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert(response.status === status, `${message}; expected ${status}, got ${response.status}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

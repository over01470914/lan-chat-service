import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const baseUrl = process.env.LAN_CHAT_URL || 'http://127.0.0.1:4301';
const dataDir = resolve(process.env.DATA_DIR || join(process.cwd(), 'data'));
const statePath = resolve(process.env.ARTIFACT_ROOM_STATE || join(dataDir, 'artifact-room.json'));

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function readState() {
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    return null;
  }
}

async function existingStateWorks(state) {
  if (!state?.roomCode || !state?.jenkinsClientId) return false;
  try {
    const room = await request(`/api/rooms/${state.roomCode}`);
    return room.room?.approved?.some((client) => client.id === state.jenkinsClientId);
  } catch {
    return false;
  }
}

await request('/api/health');
let state = await readState();
if (!(await existingStateWorks(state))) {
  const created = await request('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name: 'PetLink Delivery Artifacts', hostName: 'Naya Artifact Host' }),
  });
  const joined = await request(`/api/rooms/${created.room.code}/join`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Jenkins Delivery Bot' }),
  });
  await request(`/api/rooms/${created.room.code}/approve`, {
    method: 'POST',
    body: JSON.stringify({ hostId: created.clientId, clientId: joined.clientId }),
  });
  state = {
    roomName: 'PetLink Delivery Artifacts',
    roomCode: created.room.code,
    hostClientId: created.clientId,
    jenkinsClientId: joined.clientId,
    createdAt: new Date().toISOString(),
    baseUrl,
  };
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2));
  await chmod(statePath, 0o600);
}
console.log(JSON.stringify({
  ok: true,
  baseUrl,
  roomName: state.roomName,
  roomCode: state.roomCode,
  statePath,
  jenkinsClientConfigured: Boolean(state.jenkinsClientId),
}, null, 2));

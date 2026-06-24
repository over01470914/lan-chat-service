import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

const port = Number(process.env.CLI_SMOKE_PORT || 4498);
const baseUrl = `http://127.0.0.1:${port}`;
const dataDir = await mkdtemp(joinPath(tmpdir(), 'lan-chat-cli-smoke-data-'));
const server = spawn(process.execPath, ['src/server.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, MAX_ROOM_MESSAGES: '3', MAX_TOTAL_UPLOAD_BYTES: '2mb' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
server.stdout.on('data', (chunk) => { output += chunk.toString(); });
server.stderr.on('data', (chunk) => { output += chunk.toString(); });

try {
  await waitForHealth();
  const hosted = runCli(['host', '--server', baseUrl, '--room', 'CLI Room', '--name', 'CLI Host', '--json']);
  assert(hosted.roomCode, 'host command returns roomCode');
  assert(hosted.hostToken === hosted.hostId, 'host command returns host token');
  assert(hosted.inviteToken, 'host command returns invite token');
  assert(hosted.inviteUrl.includes('token='), 'host command returns invite URL');

  const tokenJoined = runCli(['join', '--server', baseUrl, '--room', hosted.roomCode, '--name', 'CLI Mobile', '--token', hosted.inviteToken, '--json']);
  assert(tokenJoined.status === 'approved', 'cli join with invite token is approved');

  const joined = runCli(['join', '--server', baseUrl, '--room', hosted.roomCode, '--name', 'CLI Client', '--json']);
  assert(joined.status === 'pending', 'join command starts pending');
  assert(joined.clientId, 'join command returns client id');

  const approved = runCli(['approve', '--server', baseUrl, '--room', hosted.roomCode, '--host-id', hosted.hostId, '--client-id', joined.clientId, '--json']);
  assert(approved.room.approved.some((client) => client.id === joined.clientId), 'approve command approves client');

  const sent = runCli(['send', '--server', baseUrl, '--room', hosted.roomCode, '--client-id', joined.clientId, '--text', 'hello from cli', '--json']);
  assert(sent.message.text === 'hello from cli', 'send command posts message');

  const room = runCli(['room', '--server', baseUrl, '--room', hosted.roomCode, '--json']);
  assert(room.room.messages.some((message) => message.text === 'hello from cli'), 'room command reads messages');

  await post(`/api/rooms/${hosted.roomCode}/messages`, { clientId: joined.clientId, text: 'm2' });
  await post(`/api/rooms/${hosted.roomCode}/messages`, { clientId: joined.clientId, text: 'm3' });
  await post(`/api/rooms/${hosted.roomCode}/messages`, { clientId: joined.clientId, text: 'm4' });
  const retained = await get(`/api/rooms/${hosted.roomCode}`);
  assert(retained.room.messages.length === 3, 'MAX_ROOM_MESSAGES retention trims old messages');
  assert(!retained.room.messages.some((message) => message.text === 'hello from cli'), 'oldest message was pruned');

  const autoHosted = runCli(['host', '--server', baseUrl, '--room', 'CLI Auto Room', '--name', 'CLI Auto Host', '--auto-approve', '--json']);
  assert(autoHosted.autoApprove === true, 'cli host --auto-approve creates auto approve room');
  const autoJoined = runCli(['join', '--server', baseUrl, '--room', autoHosted.roomCode, '--name', 'CLI Auto Client', '--json']);
  assert(autoJoined.status === 'approved', 'cli join is auto approved when room allows it');
  const settingsOff = runCli(['settings', '--server', baseUrl, '--room', autoHosted.roomCode, '--host-id', autoHosted.hostId, '--manual-approve', '--json']);
  assert(settingsOff.room.autoApprove === false, 'cli settings can disable auto approve');
  const settingsOn = runCli(['settings', '--server', baseUrl, '--room', hosted.roomCode, '--host-id', hosted.hostId, '--auto-approve', '--json']);
  assert(settingsOn.room.autoApprove === true, 'cli settings can enable auto approve');

  const health = await get('/api/health');
  assert(health.config.maxRoomMessages === 3, 'health exposes max room messages config');
  assert(health.config.maxTotalUploadBytes === 2 * 1024 * 1024, 'health exposes upload quota config');

  console.log(JSON.stringify({ ok: true, roomCode: hosted.roomCode, checks: ['cli host', 'cli token join', 'cli join', 'cli approve', 'cli send', 'cli room', 'retention config', 'cli auto approve', 'cli settings'] }, null, 2));
} finally {
  server.kill('SIGTERM');
  await new Promise((resolve) => server.once('exit', resolve));
  await rm(dataDir, { recursive: true, force: true });
}

function runCli(args) {
  const result = spawnSync(process.execPath, ['bin/lan-chat.js', ...args], { cwd: process.cwd(), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`cli ${args.join(' ')} failed\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  return JSON.parse(result.stdout);
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

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

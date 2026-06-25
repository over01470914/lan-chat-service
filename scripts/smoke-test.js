import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

const port = 4497;
const baseUrl = `http://127.0.0.1:${port}`;
const dataDir = await mkdtemp(joinPath(tmpdir(), 'lan-chat-smoke-data-'));
const server = spawn(process.execPath, ['src/server.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
server.stdout.on('data', (chunk) => { output += chunk.toString(); });
server.stderr.on('data', (chunk) => { output += chunk.toString(); });

try {
  await waitForHealth();
  const create = await post('/api/rooms', { name: 'Smoke Room', hostName: 'Boss Host' });
  assert(create.room.code, 'room code exists');
  assert(create.clientId, 'host client id exists');
  assert(create.room.autoApprove === false, 'manual approval is default');

  const rejectedJoin = await post(`/api/rooms/${create.room.code}/join`, { name: 'Client Reject' });
  assert(rejectedJoin.status === 'pending', 'rejected client starts pending');
  const rejected = await post(`/api/rooms/${create.room.code}/reject`, { hostId: create.clientId, clientId: rejectedJoin.clientId });
  assert(!rejected.room.pending.some((client) => client.id === rejectedJoin.clientId), 'rejected client removed from pending');
  assert(!rejected.room.approved.some((client) => client.id === rejectedJoin.clientId), 'rejected client not approved');
  await expectPostStatus(`/api/rooms/${create.room.code}/messages`, { clientId: rejectedJoin.clientId, text: 'should fail' }, 403, 'rejected client cannot send text');

  const rejectedForm = new FormData();
  rejectedForm.append('clientId', rejectedJoin.clientId);
  rejectedForm.append('file', new Blob(['blocked payload'], { type: 'text/plain' }), 'blocked.txt');
  const rejectedUpload = await fetch(`${baseUrl}/api/rooms/${create.room.code}/files`, { method: 'POST', body: rejectedForm });
  assert(rejectedUpload.status === 403, 'rejected client cannot upload file');

  assert(create.invite?.inviteToken, 'host create returns invite token');
  assert(create.invite.inviteUrl.includes(`room=${create.room.code}`), 'invite URL includes room code');
  assert(create.invite.inviteUrl.includes('token='), 'invite URL includes token');
  await expectPostStatus(`/api/rooms/${create.room.code}/invite`, {}, 404, 'GET-only invite endpoint rejects POST');
  const invalidTokenJoin = await post(`/api/rooms/${create.room.code}/join`, { name: 'Wrong Token', inviteToken: 'bad-token' });
  assert(invalidTokenJoin.status === 'pending', 'invalid invite token does not auto approve');
  const tokenJoin = await post(`/api/rooms/${create.room.code}/join`, { name: 'Mobile Client', inviteToken: create.invite.inviteToken });
  assert(tokenJoin.status === 'approved', 'valid invite token auto approves mobile client');
  assert(tokenJoin.room.approved.some((client) => client.id === tokenJoin.clientId), 'token joined client is approved');
  const inviteInfo = await get(`/api/rooms/${create.room.code}/invite?hostId=${create.clientId}`);
  assert(inviteInfo.invite.cliCommand.includes('--token'), 'invite endpoint includes CLI token command');
  const rotated = await post(`/api/rooms/${create.room.code}/invite/rotate`, { hostId: create.clientId });
  assert(rotated.invite.inviteToken !== create.invite.inviteToken, 'host can rotate invite token');
  const oldTokenJoin = await post(`/api/rooms/${create.room.code}/join`, { name: 'Old Token Client', inviteToken: create.invite.inviteToken });
  assert(oldTokenJoin.status === 'pending', 'rotated old token no longer auto approves');

  const join = await post(`/api/rooms/${create.room.code}/join`, { name: 'Client A' });
  assert(join.status === 'pending', 'client starts pending');
  assert(join.room.pending.some((client) => client.id === join.clientId), 'pending client visible');
  const pendingRejoin = await post(`/api/rooms/${create.room.code}/join`, { name: 'Client A', clientId: join.clientId });
  assert(pendingRejoin.status === 'pending', 'recent-room rejoin keeps pending clients pending');
  assert(pendingRejoin.room.pending.filter((client) => client.id === join.clientId).length === 1, 'pending rejoin does not duplicate client');

  const approved = await post(`/api/rooms/${create.room.code}/approve`, { hostId: create.clientId, clientId: join.clientId });
  assert(approved.room.approved.some((client) => client.id === join.clientId), 'client approved');

  const text = await post(`/api/rooms/${create.room.code}/messages`, { clientId: join.clientId, text: 'hello from smoke' });
  assert(text.message.text === 'hello from smoke', 'text message sent');

  const autoRoom = await post('/api/rooms', { name: 'Auto Room', hostName: 'Auto Host', autoApprove: true });
  assert(autoRoom.room.autoApprove === true, 'auto approve can be enabled at creation');
  const autoJoin = await post(`/api/rooms/${autoRoom.room.code}/join`, { name: 'Auto Client' });
  assert(autoJoin.status === 'approved', 'auto approve client starts approved');
  assert(autoJoin.room.approved.some((client) => client.id === autoJoin.clientId), 'auto approved client is in approved list');
  const manualRoom = await post('/api/rooms', { name: 'Manual Toggle Room', hostName: 'Toggle Host' });
  const pendingToggleJoin = await post(`/api/rooms/${manualRoom.room.code}/join`, { name: 'Toggle Client' });
  assert(pendingToggleJoin.status === 'pending', 'client is pending before settings toggle');
  await expectPostStatus(`/api/rooms/${manualRoom.room.code}/settings`, { hostId: pendingToggleJoin.clientId, autoApprove: true }, 403, 'non-host cannot toggle auto approve');
  const toggled = await post(`/api/rooms/${manualRoom.room.code}/settings`, { hostId: manualRoom.clientId, autoApprove: true });
  assert(toggled.room.autoApprove === true, 'host can enable auto approve in room');
  assert(toggled.room.pending.length === 0, 'enabling auto approve clears pending clients');
  assert(toggled.room.approved.some((client) => client.id === pendingToggleJoin.clientId), 'enabling auto approve approves pending clients');

  const appJs = await readFile('public/app.js', 'utf8');
  const indexHtml = await readFile('public/index.html', 'utf8');
  assert(appJs.includes('pendingAttachments'), 'composer stores pending attachments');
  assert(appJs.includes('addAttachments(event.target.files)'), 'file input attaches before send');
  assert(appJs.includes('event.dataTransfer.files'), 'drop attaches files before send');
  assert(appJs.includes('renderFilePreview'), 'file drawer renders previews');
  assert(appJs.includes('touchstart'), 'mobile long press menu is wired');
  assert(appJs.includes('inviteTokenFromUrl'), 'mobile invite token route is wired');
  assert(appJs.includes('rotateInviteToken'), 'host can rotate invite token from UI');
  assert(appJs.includes('/settings'), 'room settings toggle is wired');
  assert(appJs.includes('deriveAccessStatus'), 'pending/rejected status derives from room state');
  assert(appJs.includes('Object.prototype.hasOwnProperty.call(options, \'body\')'), 'GET requests do not send JSON bodies');
  assert(indexHtml.includes('type="module"'), 'browser loads module utilities');
  assert(indexHtml.includes('accessNotice'), 'pending access notice is rendered');
  assert(indexHtml.includes('autoApproveToggle'), 'host auto approve toggle is rendered');
  assert(indexHtml.includes('mobileShareButton'), 'mobile share button is rendered');
  assert(indexHtml.includes('recentRoomsMobile'), 'mobile recent rooms section is rendered');
  assert(indexHtml.includes('mobileRoomMenuButton'), 'mobile room drawer button is rendered');
  assert(indexHtml.includes('mobileRoomFab'), 'persistent mobile drawer entry is rendered');
  assert(appJs.includes('openMobileRoomDrawer'), 'mobile room drawer is wired');
  assert(appJs.includes('syncMobileViewportHeight'), 'mobile visual viewport resize handling is wired');
  assert(appJs.includes('recentRoomsMobileList'), 'mobile recent rooms list is wired');

  const tempDir = await mkdtemp(joinPath(tmpdir(), 'lan-chat-smoke-'));
  const uploadPath = joinPath(tempDir, 'hello.txt');
  await writeFile(uploadPath, 'file payload');
  const form = new FormData();
  form.append('clientId', join.clientId);
  form.append('file', new Blob(['file payload'], { type: 'text/plain' }), 'hello.txt');
  const uploadResponse = await fetch(`${baseUrl}/api/rooms/${create.room.code}/files`, { method: 'POST', body: form });
  assert(uploadResponse.ok, 'file upload ok');
  const upload = await uploadResponse.json();
  assert(upload.message.file.name === 'hello.txt', 'file message created');
  const download = await fetch(`${baseUrl}${upload.message.file.url}`);
  assert(await download.text() === 'file payload', 'file download matches');

  const deleted = await del(`/api/rooms/${create.room.code}/messages/${upload.message.id}`, { clientId: join.clientId });
  assert(deleted.deleted === upload.message.id, 'sender can delete own file message');
  const deletedDownload = await fetch(`${baseUrl}${upload.message.file.url}`);
  assert(deletedDownload.status === 404, 'deleted file is removed from upload store');
  await rm(tempDir, { recursive: true, force: true });

  const room = await get(`/api/rooms/${create.room.code}`);
  assert(room.room.messages.length >= 1, 'messages persisted in room state');
  assert(!room.room.messages.some((message) => message.id === upload.message.id), 'deleted message removed from room state');

  console.log(JSON.stringify({ ok: true, roomCode: create.room.code, messages: room.room.messages.length, rejectCovered: true, attachmentsCovered: true, deleteCovered: true }, null, 2));
} finally {
  server.kill('SIGTERM');
  await new Promise((resolve) => server.once('exit', resolve));
  await rm(dataDir, { recursive: true, force: true });
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
  assert(response.status === status, message);
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

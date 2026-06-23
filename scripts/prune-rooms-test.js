import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const dataDir = await mkdtemp(joinPath(tmpdir(), 'lan-chat-prune-test-'));
const uploadDir = joinPath(dataDir, 'uploads');
const oldDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
const freshDate = new Date().toISOString();

try {
  await mkdir(uploadDir, { recursive: true });
  await writeFile(joinPath(uploadDir, 'old-file.txt'), 'old payload');
  await writeFile(joinPath(uploadDir, 'fresh-file.txt'), 'fresh payload');
  await writeFile(joinPath(dataDir, 'db.json'), JSON.stringify({
    rooms: {
      TEST01: {
        code: 'TEST01',
        name: 'QA Test Room',
        hostId: 'host-test',
        createdAt: oldDate,
        pending: ['pending-test'],
        approved: ['host-test', 'client-test'],
        rejected: ['reject-test'],
        messages: [{ id: 'file-old', type: 'file', clientId: 'client-test', createdAt: oldDate, file: { url: '/api/files/old-file.txt', name: 'old-file.txt' } }],
      },
      KEEP01: {
        code: 'KEEP01',
        name: 'PetLink Delivery Artifacts',
        hostId: 'host-keep',
        createdAt: oldDate,
        pending: [],
        approved: ['host-keep'],
        rejected: [],
        messages: [],
      },
      FRESH1: {
        code: 'FRESH1',
        name: 'Fresh Test Room',
        hostId: 'host-fresh',
        createdAt: freshDate,
        pending: [],
        approved: ['host-fresh'],
        rejected: [],
        messages: [{ id: 'file-fresh', type: 'file', clientId: 'host-fresh', createdAt: freshDate, file: { url: '/api/files/fresh-file.txt', name: 'fresh-file.txt' } }],
      },
    },
    clients: {
      'host-test': { id: 'host-test', name: 'Host Test' },
      'client-test': { id: 'client-test', name: 'Client Test' },
      'pending-test': { id: 'pending-test', name: 'Pending Test' },
      'reject-test': { id: 'reject-test', name: 'Reject Test' },
      'host-keep': { id: 'host-keep', name: 'Host Keep' },
      'host-fresh': { id: 'host-fresh', name: 'Host Fresh' },
    },
  }, null, 2));

  const dry = runPrune(['--data-dir', dataDir, '--name-regex', 'test|qa', '--older-than', '7d']);
  assert(dry.dryRun === true, 'dry-run is default');
  assert(dry.candidates.length === 1 && dry.candidates[0].code === 'TEST01', 'dry-run selects only old test room');
  await assertExists(joinPath(uploadDir, 'old-file.txt'), 'dry-run keeps uploaded file');
  let db = JSON.parse(await readFile(joinPath(dataDir, 'db.json'), 'utf8'));
  assert(db.rooms.TEST01, 'dry-run keeps room in db');

  const protectedDry = runPrune(['--data-dir', dataDir, '--name-regex', 'petlink|test|qa', '--older-than', '7d']);
  assert(protectedDry.candidates.some((room) => room.code === 'KEEP01' && room.protected.includes('protected-name')), 'PetLink artifact room is protected by default');
  assert(protectedDry.deletePlan.protectedSkipped === 1, 'protected rooms are counted as skipped');

  const applied = runPrune(['--data-dir', dataDir, '--name-regex', 'test|qa', '--older-than', '7d', '--apply']);
  assert(applied.dryRun === false, 'apply disables dry-run');
  assert(applied.deletedRooms.length === 1 && applied.deletedRooms[0].code === 'TEST01', 'apply deletes selected room');
  assert(applied.deletedFiles === 1, 'apply deletes referenced file');
  db = JSON.parse(await readFile(joinPath(dataDir, 'db.json'), 'utf8'));
  assert(!db.rooms.TEST01, 'deleted room removed from db');
  assert(db.rooms.KEEP01 && db.rooms.FRESH1, 'non-matching and fresh rooms retained');
  assert(!db.clients['host-test'] && !db.clients['client-test'] && !db.clients['pending-test'] && !db.clients['reject-test'], 'exclusive deleted-room clients removed');
  assert(db.clients['host-keep'] && db.clients['host-fresh'], 'retained room clients kept');
  await assertMissing(joinPath(uploadDir, 'old-file.txt'), 'apply removes referenced uploaded file');
  await assertExists(joinPath(uploadDir, 'fresh-file.txt'), 'apply keeps retained room file');

  const noSelector = spawnSync(process.execPath, ['scripts/prune-rooms.js', '--data-dir', dataDir], { cwd: root, encoding: 'utf8' });
  assert(noSelector.status !== 0, 'no selector is rejected');

  console.log(JSON.stringify({ ok: true, checks: ['dry-run default', 'selector safety', 'protected artifact room skip', 'apply deletes selected room', 'file cleanup', 'client cleanup'] }, null, 2));
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

function runPrune(args) {
  const result = spawnSync(process.execPath, ['scripts/prune-rooms.js', ...args], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`prune failed (${result.status})\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function assertExists(path, message) {
  await stat(path).catch((error) => { throw new Error(`${message}: ${error.message}`); });
}

async function assertMissing(path, message) {
  const exists = await stat(path).then(() => true, () => false);
  assert(!exists, message);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

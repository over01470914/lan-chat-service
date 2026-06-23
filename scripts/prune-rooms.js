#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { copyFile, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const dataDir = resolve(args['data-dir'] || process.env.DATA_DIR || join(process.cwd(), 'data'));
const dbPath = resolve(args['db-path'] || join(dataDir, 'db.json'));
const uploadDir = resolve(args['upload-dir'] || join(dataDir, 'uploads'));
const dryRun = !args.apply;
const selectors = ['code', 'name-regex', 'older-than', 'empty', 'max-rooms'].filter((key) => args[key] !== undefined);

if (args.help || args.h) showHelpAndExit(0);
if (!selectors.length) fail('Refusing to run without a selector. Use --code, --name-regex, --older-than, --empty, or --max-rooms.');
if (!existsSync(dbPath)) fail(`DB not found: ${dbPath}`);

const db = JSON.parse(await readFile(dbPath, 'utf8'));
db.rooms ||= {};
db.clients ||= {};

const allRooms = Object.values(db.rooms).map(normalizeRoom).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
const codeSet = parseList(args.code).map((code) => code.toUpperCase());
const nameRegex = args['name-regex'] ? new RegExp(String(args['name-regex']), 'i') : null;
const protectNameRegex = args['protect-name-regex'] ? new RegExp(String(args['protect-name-regex']), 'i') : /PetLink Delivery Artifacts/i;
const protectCodeSet = new Set(parseList(args['protect-code']).map((code) => code.toUpperCase()));
const olderThanMs = args['older-than'] ? parseDurationMs(args['older-than']) : null;
const cutoff = olderThanMs ? Date.now() - olderThanMs : null;
const maxRooms = args['max-rooms'] !== undefined ? parsePositiveInt(args['max-rooms'], '--max-rooms') : null;
const keepNewestCodes = maxRooms !== null
  ? new Set([...allRooms].sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt)).slice(0, maxRooms).map((room) => room.code))
  : null;

const candidates = [];
for (const room of allRooms) {
  const reasons = candidateReasons(room);
  if (!reasons.length) continue;
  const protectedReasons = protectionReasons(room);
  candidates.push(roomSummary(room, reasons, protectedReasons));
}

const deletable = candidates.filter((room) => !room.protected.length);
const deleteCodeSet = new Set(deletable.map((room) => room.code));
const filesToDelete = collectFilesToDelete(db, deleteCodeSet, uploadDir);

const output = {
  ok: true,
  dryRun,
  dbPath,
  uploadDir,
  selectors: Object.fromEntries(selectors.map((key) => [key, args[key] === true ? true : String(args[key])])),
  protectedDefault: 'name matches /PetLink Delivery Artifacts/i unless --protect-name-regex overrides it',
  candidates,
  deletePlan: {
    rooms: deletable.length,
    protectedSkipped: candidates.length - deletable.length,
    files: filesToDelete.length,
  },
  warning: dryRun ? 'Dry-run only. Re-run with --apply to delete selected rooms/files.' : 'Applied. DB backup was written before mutation.',
};

if (dryRun) {
  console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}

const backupPath = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
await copyFile(dbPath, backupPath);
for (const filePath of filesToDelete) {
  await unlink(filePath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}
for (const code of deleteCodeSet) delete db.rooms[code];
removeUnreferencedClients(db);
const tmpPath = `${dbPath}.tmp`;
await writeFile(tmpPath, JSON.stringify(db, null, 2));
await rename(tmpPath, dbPath);

output.backupPath = backupPath;
output.deletedRooms = deletable.map((room) => ({ code: room.code, name: room.name, reasons: room.reasons }));
output.deletedFiles = filesToDelete.length;
output.remainingRooms = Object.keys(db.rooms).length;
console.log(JSON.stringify(output, null, 2));

function candidateReasons(room) {
  const reasons = [];
  if (codeSet.length && codeSet.includes(room.code)) reasons.push('code');
  if (nameRegex && nameRegex.test(room.name)) reasons.push('name-regex');
  if (olderThanMs !== null) {
    const created = timestampMs(room.createdAt);
    if (created && created < cutoff) reasons.push('older-than');
  }
  if (args.empty && room.messages.length === 0) reasons.push('empty');
  if (keepNewestCodes && !keepNewestCodes.has(room.code)) reasons.push('max-rooms');
  return matchMode() === 'any' ? reasons : selectors.every((selector) => selectorMatched(selector, reasons)) ? reasons : [];
}

function selectorMatched(selector, reasons) {
  if (selector === 'code') return reasons.includes('code');
  if (selector === 'name-regex') return reasons.includes('name-regex');
  if (selector === 'older-than') return reasons.includes('older-than');
  if (selector === 'empty') return reasons.includes('empty');
  if (selector === 'max-rooms') return reasons.includes('max-rooms');
  return false;
}

function matchMode() {
  return args['match-any'] ? 'any' : 'all';
}

function protectionReasons(room) {
  const reasons = [];
  if (protectNameRegex && protectNameRegex.test(room.name)) reasons.push('protected-name');
  if (protectCodeSet.has(room.code)) reasons.push('protected-code');
  return reasons;
}

function normalizeRoom(room) {
  return {
    ...room,
    code: String(room.code || '').toUpperCase(),
    name: String(room.name || ''),
    pending: Array.isArray(room.pending) ? room.pending : [],
    approved: Array.isArray(room.approved) ? room.approved : [],
    rejected: Array.isArray(room.rejected) ? room.rejected : [],
    messages: Array.isArray(room.messages) ? room.messages : [],
  };
}

function roomSummary(room, reasons, protectedReasons) {
  const fileMessages = room.messages.filter((message) => message?.type === 'file' && message.file?.url);
  return {
    code: room.code,
    name: room.name,
    createdAt: room.createdAt || null,
    messages: room.messages.length,
    files: fileMessages.length,
    members: new Set([room.hostId, ...room.pending, ...room.approved, ...room.rejected].filter(Boolean)).size,
    reasons,
    protected: protectedReasons,
  };
}

function collectFilesToDelete(database, deleteCodes, uploadsRoot) {
  const files = [];
  for (const [code, room] of Object.entries(database.rooms || {})) {
    if (!deleteCodes.has(String(code).toUpperCase())) continue;
    for (const message of room.messages || []) {
      if (message?.type !== 'file' || !message.file?.url) continue;
      const filePath = resolveUploadPath(uploadsRoot, storedNameFromFileUrl(message.file.url));
      if (filePath) files.push(filePath);
    }
  }
  return [...new Set(files)];
}

function removeUnreferencedClients(database) {
  const referenced = new Set();
  for (const room of Object.values(database.rooms || {})) {
    for (const id of [room.hostId, ...(room.pending || []), ...(room.approved || []), ...(room.rejected || [])]) {
      if (id) referenced.add(id);
    }
    for (const message of room.messages || []) {
      if (message.clientId) referenced.add(message.clientId);
    }
  }
  for (const clientId of Object.keys(database.clients || {})) {
    if (!referenced.has(clientId)) delete database.clients[clientId];
  }
}

function storedNameFromFileUrl(url) {
  const segment = String(url || '').split('/').pop() || '';
  try { return decodeURIComponent(segment); } catch { return segment; }
}

function resolveUploadPath(root, storedName) {
  const name = String(storedName || '');
  if (!name || name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
  const filePath = resolve(root, name);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) return null;
  return filePath;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) fail(`Unknown positional arg: ${arg}`);
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    const key = rawKey;
    if (['apply', 'empty', 'match-any', 'help', 'h'].includes(key)) {
      parsed[key] = true;
      continue;
    }
    const value = inlineValue ?? argv[++index];
    if (value === undefined || value.startsWith('--')) fail(`Missing value for --${key}`);
    if (parsed[key] !== undefined) parsed[key] = `${parsed[key]},${value}`;
    else parsed[key] = value;
  }
  return parsed;
}

function parseList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function parseDurationMs(value) {
  const match = String(value || '').trim().toLowerCase().match(/^(\d+)(m|h|d|w)$/);
  if (!match) fail(`Invalid duration for --older-than: ${value}. Use e.g. 30m, 24h, 7d, 2w.`);
  const amount = Number(match[1]);
  const unit = match[2];
  return amount * (unit === 'w' ? 7 * 24 * 60 * 60 * 1000 : unit === 'd' ? 24 * 60 * 60 * 1000 : unit === 'h' ? 60 * 60 * 1000 : 60 * 1000);
}

function parsePositiveInt(value, label) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) fail(`${label} must be a non-negative integer.`);
  return parsed;
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function showHelpAndExit(code) {
  console.log(`Usage:
  node scripts/prune-rooms.js --name-regex 'test|qa' --older-than 7d [--apply]
  node scripts/prune-rooms.js --empty --older-than 24h [--apply]
  node scripts/prune-rooms.js --max-rooms 50 [--apply]
  node scripts/prune-rooms.js --code ABC123,DEF456 [--apply]

Defaults:
  Dry-run only unless --apply is provided.
  Multiple selectors are ANDed; add --match-any for OR semantics.
  Rooms named "PetLink Delivery Artifacts" are protected by default.
  DATA_DIR defaults to env DATA_DIR or ./data.
`);
  process.exit(code);
}

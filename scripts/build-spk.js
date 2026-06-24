#!/usr/bin/env node
import { chmod, cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(process.cwd());
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = process.env.SPK_VERSION || pkg.version || '0.1.0';
const packageName = 'lan-chat-service';
const displayName = 'LAN Chatroom Service';
const distDir = join(root, 'dist');
const workDir = join(distDir, 'spk-work');
const payloadDir = join(workDir, 'payload');
const scriptsDir = join(workDir, 'scripts');
const spkPath = join(distDir, `${packageName}-${version}.spk`);

await rm(workDir, { recursive: true, force: true });
await mkdir(payloadDir, { recursive: true });
await mkdir(scriptsDir, { recursive: true });
await mkdir(distDir, { recursive: true });

const includePaths = ['bin', 'public', 'scripts', 'src', 'package.json', 'package-lock.json', 'README.md', 'SPEC.md'];
for (const item of includePaths) {
  const source = join(root, item);
  if (!existsSync(source)) continue;
  await cp(source, join(payloadDir, basename(item)), { recursive: true, dereference: false });
}

await writeFile(join(workDir, 'INFO'), infoFile({ packageName, displayName, version }));
await writeFile(join(workDir, 'PACKAGE_ICON.PNG'), Buffer.alloc(0));
await writeFile(join(workDir, 'PACKAGE_ICON_256.PNG'), Buffer.alloc(0));
await writeFile(join(scriptsDir, 'postinst'), postinstScript());
await writeFile(join(scriptsDir, 'start-stop-status'), startStopStatusScript());
await writeFile(join(scriptsDir, 'preuninst'), preuninstScript());
for (const name of ['postinst', 'start-stop-status', 'preuninst']) await chmod(join(scriptsDir, name), 0o755);

run('tar', ['-czf', join(workDir, 'package.tgz'), '-C', payloadDir, '.']);
await rm(payloadDir, { recursive: true, force: true });
await rm(spkPath, { force: true });
run('tar', ['-cf', spkPath, '-C', workDir, 'INFO', 'package.tgz', 'scripts', 'PACKAGE_ICON.PNG', 'PACKAGE_ICON_256.PNG']);
const stat = spawnSync('sh', ['-lc', `du -h ${shellQuote(spkPath)} | awk '{print $1}'`], { encoding: 'utf8' });
console.log(JSON.stringify({ ok: true, spkPath, version, size: stat.stdout.trim() }, null, 2));

function infoFile({ packageName, displayName, version }) {
  return [
    `package="${packageName}"`,
    `version="${version}"`,
    `displayname="${displayName}"`,
    'description="LAN room chat service with mobile invite URL, token join, host approval, WebSocket chat, and file sharing."',
    'maintainer="Naya"',
    'arch="noarch"',
    'os_min_ver="7.0-40000"',
    'install_dep_packages="Node.js_v20"',
    'startable="yes"',
    'ctl_stop="yes"',
    'thirdparty="yes"',
    'support_url="https://github.com/over01470914/lan-chat-service"',
    '',
  ].join('\n');
}

function postinstScript() {
  return [
    '#!/bin/sh',
    'set -eu',
    'PKG_DIR="${SYNOPKG_PKGDEST:-/var/packages/lan-chat-service/target}"',
    'DATA_DIR="${SYNOPKG_PKGVAR:-/var/packages/lan-chat-service/var}"',
    'mkdir -p "$DATA_DIR/uploads" "$PKG_DIR"',
    'cd "$PKG_DIR"',
    'if command -v npm >/dev/null 2>&1; then',
    '  npm ci --omit=dev --no-audit --no-fund',
    'else',
    '  echo "npm not found. Install Synology Node.js v20 package before starting LAN Chatroom Service." >&2',
    'fi',
    'exit 0',
    '',
  ].join('\n');
}

function startStopStatusScript() {
  return [
    '#!/bin/sh',
    'set -eu',
    'PKG_DIR="${SYNOPKG_PKGDEST:-/var/packages/lan-chat-service/target}"',
    'DATA_DIR="${SYNOPKG_PKGVAR:-/var/packages/lan-chat-service/var}"',
    'PID_FILE="$DATA_DIR/lan-chat-service.pid"',
    'LOG_FILE="$DATA_DIR/lan-chat-service.log"',
    'PORT="${PORT:-4301}"',
    'HOST="${HOST:-0.0.0.0}"',
    'start_service() {',
    '  mkdir -p "$DATA_DIR/uploads"',
    '  cd "$PKG_DIR"',
    '  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then',
    '    exit 0',
    '  fi',
    '  DATA_DIR="$DATA_DIR" PORT="$PORT" HOST="$HOST" NODE_ENV=production nohup node src/server.js >> "$LOG_FILE" 2>&1 &',
    '  echo $! > "$PID_FILE"',
    '}',
    'stop_service() {',
    '  if [ -f "$PID_FILE" ]; then',
    '    PID="$(cat "$PID_FILE")"',
    '    if kill -0 "$PID" 2>/dev/null; then',
    '      kill "$PID" || true',
    '      sleep 2',
    '      kill -0 "$PID" 2>/dev/null && kill -9 "$PID" || true',
    '    fi',
    '    rm -f "$PID_FILE"',
    '  fi',
    '}',
    'status_service() {',
    '  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then',
    '    exit 0',
    '  fi',
    '  exit 1',
    '}',
    'case "${1:-status}" in',
    '  start) start_service ;;',
    '  stop) stop_service ;;',
    '  restart) stop_service; start_service ;;',
    '  status) status_service ;;',
    '  log) tail -n 100 "$LOG_FILE" ;;',
    '  *) echo "Usage: $0 {start|stop|restart|status|log}"; exit 1 ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n');
}

function preuninstScript() {
  return [
    '#!/bin/sh',
    'set -eu',
    'if [ -n "${SYNOPKG_PKGDEST:-}" ] && [ -x "$SYNOPKG_PKGDEST/scripts/start-stop-status" ]; then',
    '  "$SYNOPKG_PKGDEST/scripts/start-stop-status" stop || true',
    'fi',
    'exit 0',
    '',
  ].join('\n');
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

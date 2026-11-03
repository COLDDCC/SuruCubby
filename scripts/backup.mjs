/**
 * 在线备份数据库（服务不用停）：用 SQLite 的 VACUUM INTO 写出一份一致的快照，校验后 gzip。
 *
 *   node scripts/backup.mjs [数据目录]      默认读环境变量 DATA_DIR，再默认 ./data
 *
 * 备份放在 <数据目录>/backups/surucubby-YYYYMMDD-HHMMSS.db.gz，超过 30 天的自动删掉。
 * deploy/backup.sh 每天调用它，并可选地用 rclone 传一份到异地。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dataDir = path.resolve(process.argv[2] ?? process.env.DATA_DIR ?? 'data');
const source = path.join(dataDir, 'surucubby.db');
if (!fs.existsSync(source)) {
  console.error(`找不到数据库：${source}`);
  process.exit(1);
}
const dest = path.join(dataDir, 'backups');
fs.mkdirSync(dest, { recursive: true });

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const snapshot = path.join(dest, `surucubby-${stamp}.db`);

const db = new DatabaseSync(source);
db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
db.close();

const check = new DatabaseSync(snapshot, { readOnly: true });
const result = check.prepare('PRAGMA integrity_check').get();
check.close();
if (Object.values(result ?? {})[0] !== 'ok') {
  console.error(`备份校验失败：${snapshot}`);
  process.exit(1);
}

fs.writeFileSync(`${snapshot}.gz`, zlib.gzipSync(fs.readFileSync(snapshot), { level: 9 }));
fs.rmSync(snapshot);

const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
for (const name of fs.readdirSync(dest)) {
  const full = path.join(dest, name);
  if (/^surucubby-.*\.db\.gz$/.test(name) && fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full);
}
console.log(`${snapshot}.gz`);

#!/usr/bin/env bash
# 从备份恢复：sudo bash deploy/restore.sh /var/lib/surucubby/backups/surucubby-XXXX.db.gz
# 会先把当前库另存一份，再停服务、替换、启动。
set -euo pipefail
SRC="${1:?用法：restore.sh <备份文件.db.gz>}"
DATA_DIR="${DATA_DIR:-/var/lib/surucubby}"
systemctl stop surucubby
cp "$DATA_DIR/surucubby.db" "$DATA_DIR/surucubby.before-restore-$(date +%Y%m%d-%H%M%S).db" 2>/dev/null || true
rm -f "$DATA_DIR/surucubby.db-wal" "$DATA_DIR/surucubby.db-shm"
gunzip -c "$SRC" > "$DATA_DIR/surucubby.db"
chown surucubby:surucubby "$DATA_DIR/surucubby.db"
systemctl start surucubby
echo "已从 $SRC 恢复并重启"

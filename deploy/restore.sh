#!/usr/bin/env bash
# 从备份恢复：sudo bash deploy/restore.sh /var/lib/surucubby/backups/surucubby-XXXX.db.gz
# 会先把当前库另存一份，再停服务、替换、启动。
# 封面图丢了（换了服务器）：按日期顺序把 backups/images-*.tar 依次解到 /var/lib/surucubby/images，
#   for f in $(ls /var/lib/surucubby/backups/images-*.tar); do tar -xf "$f" -C /var/lib/surucubby/images; done
#   chown -R surucubby:surucubby /var/lib/surucubby/images
# 或者从异地：rclone copy "$BACKUP_REMOTE/images" /var/lib/surucubby/images
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

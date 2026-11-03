#!/usr/bin/env bash
# 每天备份一次数据库（由 setup.sh 装进 /etc/cron.d/surucubby）。
#   - scripts/backup.mjs 做在线快照 + 校验 + gzip，本机留 30 天（/var/lib/surucubby/backups）；
#   - 配置了 rclone 远端（/etc/surucubby.env 里的 BACKUP_REMOTE，例如 r2:surucubby-backup）就再传一份到异地。
set -euo pipefail
DATA_DIR="${DATA_DIR:-/var/lib/surucubby}"
cd "$(dirname "$0")/.."
FILE="$(sudo -u surucubby node --disable-warning=ExperimentalWarning scripts/backup.mjs "$DATA_DIR")"
if [[ -n "${BACKUP_REMOTE:-}" ]] && command -v rclone >/dev/null; then
  rclone copy "$FILE" "$BACKUP_REMOTE" --quiet
fi
echo "备份完成：$FILE"

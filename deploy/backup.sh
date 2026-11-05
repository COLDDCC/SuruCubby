#!/usr/bin/env bash
# 每天备份一次（由 setup.sh 装进 /etc/cron.d/surucubby）。
#   - scripts/backup.mjs 做数据库在线快照 + 校验 + gzip，本机留 30 天（/var/lib/surucubby/backups）；
#   - 封面图（/var/lib/surucubby/images）每天打一个增量包：只装上次以后新增的图，本机留 30 天，
#     数据库备份 + 这一串图片包就能完整恢复；
#   - 配置了 rclone 远端（/etc/surucubby.env 里的 BACKUP_REMOTE，例如 r2:surucubby-backup）就再传一份到异地，
#     图片目录直接增量同步到远端的 images/ 下（只传新的，不删远端的）。
set -euo pipefail
DATA_DIR="${DATA_DIR:-/var/lib/surucubby}"
cd "$(dirname "$0")/.."
FILE="$(sudo -u surucubby node --disable-warning=ExperimentalWarning scripts/backup.mjs "$DATA_DIR")"
IMAGES="$DATA_DIR/images"
STAMP_FILE="$DATA_DIR/backups/.images-last"
if [[ -d "$IMAGES" ]]; then
  TAR="$DATA_DIR/backups/images-$(date +%Y%m%d-%H%M%S).tar"
  if [[ -f "$STAMP_FILE" ]]; then
    (cd "$IMAGES" && find . -type f -newer "$STAMP_FILE" -print0 | tar --null -cf "$TAR" --files-from=-)
  else
    tar -cf "$TAR" -C "$IMAGES" .
  fi
  touch "$STAMP_FILE"
  # 空包（这一天没有新图）就不留
  if [[ $(tar -tf "$TAR" | wc -l) -eq 0 ]]; then rm -f "$TAR"; fi
  find "$DATA_DIR/backups" -name 'images-*.tar' -mtime +30 -delete
fi
if [[ -n "${BACKUP_REMOTE:-}" ]] && command -v rclone >/dev/null; then
  rclone copy "$FILE" "$BACKUP_REMOTE" --quiet
  [[ -d "$IMAGES" ]] && rclone copy "$IMAGES" "$BACKUP_REMOTE/images" --quiet
fi
echo "备份完成：$FILE"

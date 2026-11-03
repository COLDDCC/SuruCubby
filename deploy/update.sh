#!/usr/bin/env bash
# 更新到 GitHub 上的最新代码：sudo bash /opt/surucubby/deploy/update.sh
set -euo pipefail
cd /opt/surucubby
sudo -u surucubby git pull --ff-only
sudo -u surucubby npm install --omit=dev --no-audit --no-fund
sudo -u surucubby node scripts/fetch-vendor.mjs || echo "SheetJS 下载失败，导入页会退回官方 CDN"
bash deploy/backup.sh >/dev/null   # 更新前先备份一份，迁移出问题可以回退
systemctl restart surucubby
sleep 2
systemctl --no-pager --lines=5 status surucubby

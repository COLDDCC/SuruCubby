#!/usr/bin/env bash
# 在一台全新的 Ubuntu 22.04 / 24.04（或 Debian 12）VPS 上一键安装 SuruCubby。
#
#   curl -fsSL https://raw.githubusercontent.com/COLDDCC/SuruCubby/HEAD/deploy/setup.sh -o setup.sh
#   sudo DOMAIN=cang.example.com bash setup.sh
#
# 做的事：装 Node 24、Caddy → 建系统用户 → 拉代码 → 生成密钥 → 装 systemd 服务 → 配 HTTPS → 每日备份。
# 可重复执行：已经装过的部分会跳过，不会覆盖已有的数据和密码。
set -euo pipefail

DOMAIN="${DOMAIN:?请用 DOMAIN=你的域名 sudo bash setup.sh}"
REPO="${REPO:-https://github.com/COLDDCC/SuruCubby.git}"
BRANCH="${BRANCH:-}"   # 不填就用仓库的默认分支
APP=/opt/surucubby
DATA=/var/lib/surucubby

[[ $EUID -eq 0 ]] || { echo "请用 sudo 运行"; exit 1; }

echo "==> 安装系统依赖"
apt-get update -qq
apt-get install -y -qq curl git gzip ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null

if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  echo "==> 安装 Node.js 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

if ! command -v caddy >/dev/null; then
  echo "==> 安装 Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

echo "==> 建用户和目录"
id surucubby >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin surucubby
mkdir -p "$DATA"
chown surucubby:surucubby "$DATA"
chmod 750 "$DATA"

echo "==> 拉代码"
if [[ ! -d "$APP/.git" ]]; then
  git clone ${BRANCH:+--branch "$BRANCH"} "$REPO" "$APP"
fi
chown -R surucubby:surucubby "$APP"
cd "$APP"
sudo -u surucubby git pull --ff-only || true
sudo -u surucubby npm install --omit=dev --no-audit --no-fund
sudo -u surucubby node scripts/fetch-vendor.mjs || echo "（SheetJS 下载失败，稍后可手动 npm run vendor）"

if [[ ! -f /etc/surucubby.env ]]; then
  echo "==> 生成配置"
  read -r -s -p "设置后台引导密码（账号 admin）：" ADMIN_PW; echo
  [[ ${#ADMIN_PW} -ge 8 ]] || { echo "密码至少 8 位"; exit 1; }
  cat > /etc/surucubby.env <<CONF
PORT=8787
HOST=127.0.0.1
DATA_DIR=$DATA
TRUST_PROXY=1
ADMIN_PASSWORD=$ADMIN_PW
SESSION_SECRET=$(head -c 48 /dev/urandom | base64 | tr -d '\n/+=')
IMAGE_CACHE_MB=2048
# BACKUP_REMOTE=r2:surucubby-backup
CONF
  chmod 600 /etc/surucubby.env
fi

echo "==> 安装服务"
install -m 644 deploy/surucubby.service /etc/systemd/system/surucubby.service
systemctl daemon-reload
systemctl enable --now surucubby
systemctl restart surucubby

echo "==> 配置 HTTPS（Caddy）"
sed "s/cang.example.com/$DOMAIN/" deploy/Caddyfile.example > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

echo "==> 每日备份（凌晨 4 点）"
cat > /etc/cron.d/surucubby <<CRON
SHELL=/bin/bash
0 4 * * * root set -a; . /etc/surucubby.env; set +a; bash $APP/deploy/backup.sh >> /var/log/surucubby-backup.log 2>&1
CRON

echo
echo "完成。确认 Cloudflare DNS 里 $DOMAIN 的 A 记录指向本机 IP、代理状态为 DNS only，然后打开："
echo "  后台   https://$DOMAIN/admin/   （账号 admin，密码是刚才设的）"
echo "  客户   https://$DOMAIN/login"

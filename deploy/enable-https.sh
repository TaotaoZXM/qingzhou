#!/bin/bash
# Enable HTTPS for myqingzhou.com and www.myqingzhou.com on the Aliyun ECS.
# Safe to re-run. Does not reload nginx with the TLS config until the
# certificate files exist and nginx -t succeeds.
#
# Requires the current port-80 site config (ACME webroot at /var/www/certbot)
# and this repo's deploy/nginx-qingzhou.conf. DNS A records for both names
# must already point at 121.41.63.67.
#
# Optional: CERTBOT_EMAIL=you@example.com
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -E bash "$0" "$@"
fi

if [ -f /opt/qingzhou/deploy/nginx-qingzhou.conf ]; then
  CONF_SRC="/opt/qingzhou/deploy/nginx-qingzhou.conf"
else
  CONF_SRC="$(cd "$(dirname "$0")" && pwd)/nginx-qingzhou.conf"
fi
CONF_DST="/etc/nginx/conf.d/qingzhou.conf"
WEBROOT="/var/www/certbot"
LIVE="/etc/letsencrypt/live/myqingzhou.com"
EXPECTED_IP="121.41.63.67"

if [ ! -f "$CONF_SRC" ]; then
  echo "缺少 $CONF_SRC。先把这个版本同步到 /opt/qingzhou。" >&2
  exit 1
fi
if ! grep -q '/etc/letsencrypt/live/myqingzhou.com/fullchain.pem' "$CONF_SRC"; then
  echo "$CONF_SRC 不是带真实证书路径的 HTTPS 配置。" >&2
  exit 1
fi
if [ ! -f "$CONF_DST" ]; then
  echo "缺少 $CONF_DST。现网应已有只监听 80 的配置。" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "需要 python3 做 DNS 和 webroot 检查。" >&2
  exit 1
fi

install_certbot() {
  if command -v certbot >/dev/null 2>&1; then
    echo "certbot 已安装: $(command -v certbot)"
    return
  fi
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y certbot
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y certbot || {
      dnf install -y epel-release
      dnf install -y certbot
    }
  else
    echo "无法安装 certbot：没有 apt-get 或 dnf。" >&2
    exit 1
  fi
  command -v certbot >/dev/null 2>&1
}

probe_webroot() {
  local host="$1"
  local token="qingzhou-probe-${host}"
  mkdir -p "$WEBROOT/.well-known/acme-challenge"
  printf 'ok' > "$WEBROOT/.well-known/acme-challenge/$token"
  set +e
  python3 - "$host" "$token" <<'PY'
import http.client
import sys

host, token = sys.argv[1], sys.argv[2]
connection = http.client.HTTPConnection("127.0.0.1", 80, timeout=5)
connection.request(
    "GET",
    f"/.well-known/acme-challenge/{token}",
    headers={"Host": host},
)
response = connection.getresponse()
body = response.read().decode()
if response.status != 200 or body != "ok":
    raise SystemExit(f"{host} 的 ACME 响应是 {response.status} {body!r}")
print(f"webroot ok: {host}")
PY
  local status=$?
  set -e
  rm -f "$WEBROOT/.well-known/acme-challenge/$token"
  if [ "$status" -ne 0 ]; then
    echo "现网 80 端口没有把 /.well-known/acme-challenge/ 指到 $WEBROOT（Host: $host）。没有申请证书。" >&2
    exit "$status"
  fi
}

check_dns() {
  python3 - "$EXPECTED_IP" <<'PY'
import socket
import sys

expect = sys.argv[1]
failed = False
for host in ("myqingzhou.com", "www.myqingzhou.com"):
    try:
        infos = socket.getaddrinfo(host, 80, socket.AF_INET, socket.SOCK_STREAM)
    except socket.gaierror as error:
        print(f"{host} 还没有 A 记录 ({error})。指到 {expect} 后再执行。", file=sys.stderr)
        failed = True
        continue
    ips = sorted({item[4][0] for item in infos})
    if expect not in ips:
        print(f"{host} 的 A 记录是 {ips}，需要包含 {expect}。", file=sys.stderr)
        failed = True
    else:
        print(f"{host} A {expect}")
if failed:
    raise SystemExit(1)
PY
}

install_certbot
mkdir -p "$WEBROOT"
probe_webroot myqingzhou.com
probe_webroot www.myqingzhou.com
check_dns

email_args=(--register-unsafely-without-email)
if [ -n "${CERTBOT_EMAIL:-}" ]; then
  email_args=(-m "$CERTBOT_EMAIL")
fi

certbot certonly \
  --webroot -w "$WEBROOT" \
  --cert-name myqingzhou.com \
  -d myqingzhou.com -d www.myqingzhou.com \
  --agree-tos --non-interactive --keep-until-expiring --expand \
  "${email_args[@]}"

if [ ! -f "$LIVE/fullchain.pem" ] || [ ! -f "$LIVE/privkey.pem" ]; then
  echo "证书没有写到 $LIVE。没有修改 Nginx。" >&2
  exit 1
fi

backup="${CONF_DST}.bak.$(date +%Y%m%d%H%M%S)"
cp -a "$CONF_DST" "$backup"
cp "$CONF_SRC" "$CONF_DST"
if ! nginx -t; then
  cp -a "$backup" "$CONF_DST"
  echo "nginx -t 失败，已还原 $backup。443 没有启用。" >&2
  exit 1
fi
systemctl reload nginx
echo "Nginx 已加载 HTTPS 配置。备份: $backup"

mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'EOF'
#!/bin/sh
systemctl reload nginx
EOF
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

if systemctl cat certbot.timer >/dev/null 2>&1; then
  systemctl enable --now certbot.timer
  systemctl list-timers certbot.timer --no-pager || true
else
  cat > /etc/cron.d/qingzhou-certbot <<'EOF'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
0 3,15 * * * root certbot renew --quiet --deploy-hook "systemctl reload nginx"
EOF
  chmod 644 /etc/cron.d/qingzhou-certbot
  echo "没有 certbot.timer，已写入 /etc/cron.d/qingzhou-certbot"
fi

if ! certbot renew --dry-run; then
  echo "证书已安装，Nginx 已重载。certbot renew --dry-run 失败，续期还不可用。" >&2
  exit 1
fi

echo "HTTPS 已启用: https://myqingzhou.com/taskmanager/ 和 https://www.myqingzhou.com/taskmanager/"
echo "域名的 / 会跳到 /taskmanager/。IP 仍走 HTTP，页面仍在 http://121.41.63.67/ ，也可以打开 http://121.41.63.67/taskmanager/"

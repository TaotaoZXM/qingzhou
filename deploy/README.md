# 把轻舟部署到阿里云 ECS

轻舟分成两部分：仓库根目录的静态页面，以及 `server/` 里的 Node.js API。Nginx 对外提供页面，并把 `/api` 转到本机 API。任务数据放在阿里云 RDS MySQL。

下面按一台新的 ECS 来写。系统用 Alibaba Cloud Linux 3 或 Ubuntu 22.04 / 24.04 都可以。命令里需要管理员权限的地方使用 `sudo`。

## 1. 安全组

在 ECS 安全组的入方向放行：

| 端口 | 用途 |
| --- | --- |
| 22 | SSH。来源收窄到自己的 IP |
| 80 | HTTP，以及证书申请 |
| 443 | HTTPS |

不要把 `3000` 和 `3306` 对公网开放。API 只监听 `127.0.0.1`，数据库只走内网。

如果系统里开着 firewalld，再执行：

```bash
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

Ubuntu 上如果启用了 ufw：

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

## 2. 准备 RDS MySQL

1. 创建 RDS MySQL（5.7 或 8.0）。使用专有网络，和 ECS 放在同一个 VPC。
2. 记下内网地址，后面填到 `DB_HOST`。不要用公网地址。
3. 创建数据库 `qingzhou`，字符集 `utf8mb4`，排序规则 `utf8mb4_unicode_ci`。
4. 创建账号，只授予 `qingzhou` 库的权限。密码填到 `DB_PASSWORD`。
5. 把 ECS 的主私网 IP 加进 RDS 白名单。IP 在 ECS 控制台实例详情里，名称一般是「主私网 IP」。白名单不要写成 `0.0.0.0/0`。

RDS 白名单改的是数据库允许哪些内网地址连接。安全组放行的是 ECS 自己的 80 和 443。两处都要设，缺一不可。

可以在 ECS 上确认内网能连上：

```bash
mysql -h rm-xxxxxxxx.mysql.rds.aliyuncs.com -P 3306 -u qingzhou -p qingzhou -e "SELECT 1"
```

表不用手工建。API 启动时会执行 `server/schema.sql`。

## 3. 安装 Node.js、Nginx 和 Git

Node.js 需要 18 或更高。`node -v` 满足的话可以跳过 Node 安装。

### Ubuntu 22.04 / 24.04

```bash
sudo apt-get update
sudo apt-get install -y git nginx certbot
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### Alibaba Cloud Linux 3

```bash
sudo dnf install -y git nginx
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs
sudo dnf install -y certbot || {
  sudo dnf install -y epel-release
  sudo dnf install -y certbot
}
```

证书用 certbot 的 webroot，不用 nginx 插件，避免它改写站点配置。不在默认源里时，第 8 节的脚本会再试一次。

确认：

```bash
node -v
nginx -v
```

## 4. 放置代码

```bash
sudo useradd --system --home /opt/qingzhou --shell /usr/sbin/nologin qingzhou || true
sudo mkdir -p /opt/qingzhou
sudo chown "$USER":"$USER" /opt/qingzhou
git clone <你的仓库地址> /opt/qingzhou
cd /opt/qingzhou/server
npm ci
sudo chown -R qingzhou:qingzhou /opt/qingzhou
```

`ExecStart` 使用 `/usr/bin/node`。如果 `command -v node` 不是这个路径，改 `deploy/qingzhou.service` 里的 `ExecStart`。

## 5. 环境变量

```bash
sudo cp /opt/qingzhou/deploy/.env.example /etc/qingzhou.env
sudo chmod 600 /etc/qingzhou.env
sudoedit /etc/qingzhou.env
```

至少改这几项：

- `DB_HOST`：RDS 内网地址
- `DB_USER`、`DB_PASSWORD`、`DB_NAME`
- `JWT_SECRET`：`openssl rand -hex 32` 的结果，至少 16 个字符

生产环境保持：

```text
HOST=127.0.0.1
NODE_ENV=production
SERVE_STATIC=0
```

页面由 Nginx 提供，Node 只处理 `/api`。

### 管理员账号

需要一个不经过邮箱注册和验证、也能登录的账号时，在 `/etc/qingzhou.env` 同时加上：

```text
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=
```

`ADMIN_USERNAME` 是登录名，不是邮箱。启动时把它写进 `users.email`，`role` 设为 `admin`，并写上验证时间。两项都留空时，启动不会创建或修改管理员。只填一项时，进程会退出，避免半套配置。

密码哈希和普通账号使用同一套 bcrypt。在服务器上生成，只把输出贴进环境文件：

```bash
cd /opt/qingzhou/server
node scripts/hash-password.js
```

脚本会提示输入密码，标准输出只有哈希。不要把密码或哈希写进仓库，也不要放进 shell 历史；如果必须传参数，进程列表里看得到。

登录仍用原来的登录框和 `POST /api/auth/login`。邮箱一栏填写 `admin`（与 `ADMIN_USERNAME` 完全一致），密码用生成哈希时的那一个。管理员不检查邮箱验证，但走同一套登录限流、7 天会话，以及 `token_version`：更换 `ADMIN_PASSWORD_HASH` 并重启后，这个账号已经发出的会话会失效。

注册接口仍然只接受邮箱，并拒绝注册 `admin`。没有单独的管理员接口，也没有额外的管理功能。

改 `ADMIN_USERNAME` 会按新名字再写一行，不会删除原来的管理员行。确认新账号能登录后，再自行处理旧行。

## 6. 启动 API

```bash
sudo cp /opt/qingzhou/deploy/qingzhou.service /etc/systemd/system/qingzhou.service
sudo systemctl daemon-reload
sudo systemctl enable --now qingzhou
sudo systemctl status qingzhou --no-pager
curl -fsS http://127.0.0.1:3000/api/health
```

`/api/health` 返回 `{"ok":true}` 说明进程和数据库都通了。失败时看：

```bash
sudo journalctl -u qingzhou -n 80 --no-pager
```

Alibaba Cloud Linux 上如果 Nginx 反代出现 502，而本机 `curl` 是通的，多半是 SELinux 拦住了 Nginx：

```bash
sudo setsebool -P httpd_can_network_connect 1
```

## 7. 配置 Nginx

现网 `/etc/nginx/conf.d/qingzhou.conf` 只监听 80，`server_name` 同时有 `121.41.63.67`、`myqingzhou.com`、`www.myqingzhou.com`，`/.well-known/acme-challenge/` 指向 `/var/www/certbot`。443 那段还注释着，证书目录 `/etc/letsencrypt` 还不存在。安全组已经放行 80 和 443。

仓库里的 `deploy/nginx-qingzhou.conf` 是证书签发之后的配置。证书文件还不在时不要把它拷进 `conf.d`，`nginx -t` 会因为找不到 PEM 失败。启用步骤在第 8 节。

启用之后 Nginx 会做这些事：

- `http://121.41.63.67/` 继续走 HTTP，不跳转，页面仍在 `/`。同一个地址也可以打开 `http://121.41.63.67/taskmanager/`（没有末尾斜杠时会补上）
- `myqingzhou.com` 和 `www.myqingzhou.com` 的 80 端口只留下 ACME 校验，其余 301 到同一主机的 HTTPS，路径和查询字符串保留
- 443 终止 TLS，证书路径是 `/etc/letsencrypt/live/myqingzhou.com/fullchain.pem` 和 `privkey.pem`（这本证书同时覆盖 www）
- 正式页面在 `/taskmanager/`。`/taskmanager` 会 301 到 `/taskmanager/`，查询字符串保留。这个前缀下的文件来自网站根目录 `/opt/qingzhou`；找不到的路径回退到 `index.html`，所以深链刷新仍是这一份页面
- 443 上，`/` 和 `/index.html` 301 到 `/taskmanager/`，查询字符串保留。例如 `/?login=1` 会到 `/taskmanager/?login=1`。旧书签因此还能进应用
- `/api/` 仍在网站根上，转发到 `127.0.0.1:3000`，并设置 `X-Forwarded-Proto $scheme`。页面请求的是绝对路径 `/api`，不会变成 `/taskmanager/api`
- 拒绝直接访问 `server/`、`deploy/`、`.git/` 等目录，也包括 `/taskmanager/` 下面的同名路径

新机器还没有这份只监听 80 的配置时，先让 80 端口能打开页面，并且 `/.well-known/acme-challenge/` 的 `root` 是 `/var/www/certbot`，再做第 8 节。

## 8. 开启 HTTPS

PWA 需要 HTTPS。`myqingzhou.com` 和 `www.myqingzhou.com` 的 A 记录都要指到 `121.41.63.67`。如果有指到别处的 AAAA，先删掉，否则证书校验可能走到别的机器。记录还没生效时，下面的脚本会在申请证书之前退出，不会改 Nginx。

先把包含 `deploy/enable-https.sh` 和 `deploy/nginx-qingzhou.conf` 的版本放到 `/opt/qingzhou`。然后在阿里云 ECS「发送命令」（云助手 RunCommand）里用 root 执行，或者登录后执行同一条：

```bash
sudo bash /opt/qingzhou/deploy/enable-https.sh
```

需要到期邮件时加上邮箱，脚本会把它传给 certbot。不设则使用 `--register-unsafely-without-email`：

```bash
sudo CERTBOT_EMAIL=you@example.com bash /opt/qingzhou/deploy/enable-https.sh
```

脚本按这个顺序执行。任一步失败，都不会把还没有证书的 443 配置留下来：

1. 没有 certbot 就安装。Ubuntu：`apt-get install -y certbot`。Alibaba Cloud Linux：`dnf install -y certbot`，源里没有则先 `epel-release` 再装。
2. 建立 `/var/www/certbot`，并向本机 80 发带 `Host: myqingzhou.com` 和 `Host: www.myqingzhou.com` 的校验请求，确认现网 webroot 还在。
3. 确认两个域名的 A 记录包含 `121.41.63.67`。
4. 用 webroot 申请证书，不使用 nginx 插件，所以 certbot 不会改站点文件：

```bash
sudo certbot certonly \
  --webroot -w /var/www/certbot \
  --cert-name myqingzhou.com \
  -d myqingzhou.com -d www.myqingzhou.com \
  --agree-tos --non-interactive --keep-until-expiring --expand \
  --register-unsafely-without-email
```

5. 确认这两个文件存在：

```text
/etc/letsencrypt/live/myqingzhou.com/fullchain.pem
/etc/letsencrypt/live/myqingzhou.com/privkey.pem
```

6. 备份 `/etc/nginx/conf.d/qingzhou.conf`，用仓库里的配置覆盖它。`nginx -t` 失败则还原备份并退出。通过后 `systemctl reload nginx`。
7. 写入 `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh`（内容是 `systemctl reload nginx`）。有 `certbot.timer` 就 `systemctl enable --now certbot.timer`；没有则写 `/etc/cron.d/qingzhou-certbot`，每天 03:00 和 15:00 执行 `certbot renew --quiet --deploy-hook "systemctl reload nginx"`。
8. `certbot renew --dry-run`。演练失败时，HTTPS 配置已经加载，脚本以非 0 退出，方便在云助手里看到续期还没通。

Cookie 不要改环境变量。保持 `COOKIE_SECURE` 不设置。Nginx 在 443 上把 `X-Forwarded-Proto` 设为 `https`，API 的 `trust proxy` 为 1，登录和退出的 `Set-Cookie` 会带 `Secure`，并保留原来的 `HttpOnly` 和 `SameSite=Lax`。`http://121.41.63.67/` 的 `X-Forwarded-Proto` 是 `http`，Cookie 不带 `Secure`，过渡期还能登录。不要写 `COOKIE_SECURE=1`，否则 IP 上的登录态存不住。改完不需要为 Cookie 重启 API；已在跑的进程本来就会看这个头。

用浏览器确认：

- `https://myqingzhou.com/taskmanager/` 和 `https://www.myqingzhou.com/taskmanager/` 能打开，图标和接口正常
- `https://myqingzhou.com/` 和 `https://www.myqingzhou.com/` 跳到同一主机的 `/taskmanager/`
- `https://myqingzhou.com/?login=1` 跳到 `/taskmanager/?login=1`
- `http://myqingzhou.com/` 和 `http://www.myqingzhou.com/` 先到 HTTPS，再进入 `/taskmanager/`
- `http://121.41.63.67/` 仍然是 HTTP，地址留在 `/`，可以登录

## 9. 更新

```bash
sudo -u qingzhou git -C /opt/qingzhou pull
sudo -u qingzhou npm ci --prefix /opt/qingzhou/server
sudo systemctl restart qingzhou
```

`git pull` 只更新 `/opt/qingzhou` 里的文件，不会改 `/etc/nginx/conf.d/qingzhou.conf`。证书已经在、只是页面路径变了时，不必重跑 certbot。先备份现网配置，再把仓库里的文件换上去并重载：

```bash
sudo cp -a /etc/nginx/conf.d/qingzhou.conf "/etc/nginx/conf.d/qingzhou.conf.bak.$(date +%Y%m%d%H%M%S)"
sudo cp /opt/qingzhou/deploy/nginx-qingzhou.conf /etc/nginx/conf.d/qingzhou.conf
sudo nginx -t && sudo systemctl reload nginx
```

`nginx -t` 失败就不要 reload，把刚才的 `.bak` 文件拷回 `/etc/nginx/conf.d/qingzhou.conf`。`deploy/enable-https.sh` 也会用这份文件覆盖站点配置，可以重跑；它会再做一次证书和 webroot 检查。还没有证书时仍按第 8 节，不要提前把这份文件拷进 `conf.d`。

页面里有一段很短的脚本，只在主机名是 `myqingzhou.com` 或 `www.myqingzhou.com`、并且路径是 `/` 或 `/index.html` 时，才改到 `/taskmanager/`。已经安装的 Service Worker 如果把 Nginx 的 301 吞掉、地址栏仍停在 `/`，这段脚本会把浏览器带过去。IP 和本机预览不跳转。在 `/taskmanager` 下打开时，脚本会写上 `<base href="/taskmanager/">`，深链里的图标、manifest 和 `sw.js` 仍指向这个目录。Service Worker 的脚本在 `/taskmanager/sw.js`，作用范围是 `/taskmanager/`，并且继续放过 `/api/`。

如果 `git pull` 报 `safe.directory`，执行一次：

```bash
sudo git config --system --add safe.directory /opt/qingzhou
```

启动时会再次执行 `server/schema.sql`，并为已有的 `users` 表补上 `role` 列（默认 `user`）。重复执行不会清数据。若配置了管理员环境变量，启动还会按上面的规则写入该账号。

## 10. GitHub Pages

`.github/workflows/deploy-pages.yml` 不再在推送 `main` 时运行。Pages 上没有 API，登录和同步不能用。

需要一个不能登录的静态演示时，到 GitHub Actions 里手动运行 “Deploy to GitHub Pages”。那个产物只有页面文件。日常使用以这台 ECS 上的域名为准。

## 登录会话

登录后的 Cookie 固定保留 7 天。旧环境文件里的 `JWT_EXPIRES_IN=30d` 不会再生效。重置密码会让该账号已经发出的会话全部失效。

## 邮箱验证和密码重置

接口响应不会带 `verifyUrl`、`resetUrl` 或令牌。`EMAIL_DELIVERY=directmail` 时也不会带，哪怕同时开了 `EXPOSE_DEV_LINKS`。生产环境即使设置 `EXPOSE_DEV_LINKS=1` 也不会返回。本机调试要同时满足 `EXPOSE_DEV_LINKS=1`、`NODE_ENV` 不是 `production`，并且没有把发信设成 `directmail`。

`EMAIL_DELIVERY` 不是 `directmail` 时，找回密码返回「找回密码暂不可用，请联系管理员」，不会生成重置令牌。这个阶段注册的账号会标成已验证，可以直接登录；以前没验证的账号，在邮件未接入时登录也会补上验证时间，避免接上邮件后被锁在外面。邮箱所有权要等真正发信之后才算数。

发信走阿里云邮件推送的 SingleSendMail 接口（杭州公网默认是 `https://dm.aliyuncs.com/`），不用 SMTP。把下面这些写进 `/etc/qingzhou.env`。不要加引号，不要把 AccessKey 或这份文件提交到 git：

```bash
EMAIL_DELIVERY=directmail
DIRECTMAIL_ACCESS_KEY_ID=你的AccessKeyId
DIRECTMAIL_ACCESS_KEY_SECRET=你的AccessKeySecret
DIRECTMAIL_ACCOUNT_NAME=noreply@mail.myqingzhou.com
APP_PUBLIC_URL=https://www.myqingzhou.com
```

`DIRECTMAIL_ACCOUNT_NAME` 是控制台里已验证的发信地址。也可以用 `EMAIL_FROM` 代替这一项。控制台区域是杭州时不用写 `DIRECTMAIL_REGION`，默认 `cn-hangzhou`。区域必须和控制台一致，否则改成对应的值（`ap-southeast-1`、`ap-southeast-2`、`us-east-1`、`eu-central-1`）。同一地域的 ECS 可以改走内网，例如 `DIRECTMAIL_ENDPOINT=https://dm-vpc.cn-hangzhou.aliyuncs.com/`。

`APP_PUBLIC_URL` 是站点源。写成 `https://www.myqingzhou.com/taskmanager/` 也可以：验证和重置链接仍在源上的 `/api/auth/verify?token=` 和 `/api/auth/reset?token=`，信里另外带一条 `https://www.myqingzhou.com/taskmanager/`。不设置时用请求里的协议和主机名。

可选：`DIRECTMAIL_REPLY_TO` 是回信地址。不设置则不启用控制台里的回信地址。RAM 用户只需要 `dm:SingleSendMail`。发信地址用触发类型，不要用批量地址。控制台如果开了 IP 保护，把这台 ECS 的出口 IP 加进白名单。

改完重启，再用一个真实邮箱走一遍注册和找回密码，确认信到了、链接能打开，并且接口 JSON 里没有验证或重置地址：

```bash
sudo systemctl restart qingzhou
```

发信失败时，注册返回「验证邮件发送失败，请稍后再试」，找回密码和再次发送验证信返回「邮件发送失败，请稍后再试」。日志里只有错误码和 RequestId，没有 AccessKey，也没有带令牌的链接。注册如果没把信发出去，这次创建的未验证账号会删掉，可以重新注册。

不要在服务器上设置 `EXPOSE_DEV_LINKS`。

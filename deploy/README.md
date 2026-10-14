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
sudo apt-get install -y git nginx certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### Alibaba Cloud Linux 3

```bash
sudo dnf install -y git nginx
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs
sudo dnf install -y certbot python3-certbot-nginx || true
```

如果 certbot 不在默认源里，可以改用阿里云数字证书管理服务签发的 Nginx 证书，见第 8 节。

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

把域名解析到 ECS 公网 IP 之后：

```bash
sudo mkdir -p /var/www/certbot
sudo cp /opt/qingzhou/deploy/nginx-qingzhou.conf /etc/nginx/conf.d/qingzhou.conf
sudoedit /etc/nginx/conf.d/qingzhou.conf
```

把两处 `example.com` 换成真实域名。然后：

```bash
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

配置会做这几件事：

- 网站根目录是 `/opt/qingzhou`
- `/api/` 转发到 `127.0.0.1:3000`
- 拒绝直接访问 `server/`、`deploy/`、`.git/` 等目录
- `/.well-known/acme-challenge/` 留给证书校验

先用浏览器打开 `http://你的域名/`，能看到轻舟，并且可以注册登录。

## 8. 开启 HTTPS

PWA 安装和正式使用都需要 HTTPS。Cookie 在 HTTPS 请求上会带 `Secure`。

### 用 certbot

域名已经解析到这台 ECS，并且安全组放行了 80：

```bash
sudo certbot --nginx -d example.com
```

把 `example.com` 换成真实域名。certbot 会改写 Nginx 配置并加上跳转到 HTTPS。

续期：

```bash
sudo systemctl enable --now certbot.timer || sudo certbot renew --dry-run
```

### 用阿里云证书

在数字证书管理服务下载 Nginx 证书，放到例如：

```text
/etc/nginx/ssl/example.com.pem
/etc/nginx/ssl/example.com.key
```

打开 `/etc/nginx/conf.d/qingzhou.conf`，取消文件底部 443 那段的注释，把 `ssl_certificate` 指到这两个文件。确认 HTTPS 可以打开后，在 80 端口的 `server` 里加上：

```nginx
return 301 https://$host$request_uri;
```

保留 `/.well-known/acme-challenge/` 的话，把跳转放在该 location 之后，避免以后换证书时校验失败。

改完执行 `sudo nginx -t && sudo systemctl reload nginx`。

如果希望 Cookie 在任何情况下都只走 HTTPS，在 `/etc/qingzhou.env` 加上 `COOKIE_SECURE=1`，然后 `sudo systemctl restart qingzhou`。证书还没配好之前不要加这一行，否则 HTTP 登录态存不住。

## 9. 更新

```bash
sudo -u qingzhou git -C /opt/qingzhou pull
sudo -u qingzhou npm ci --prefix /opt/qingzhou/server
sudo systemctl restart qingzhou
```

如果 `git pull` 报 `safe.directory`，执行一次：

```bash
sudo git config --system --add safe.directory /opt/qingzhou
```

启动时会再次执行 `server/schema.sql`。里面的语句都是 `CREATE TABLE IF NOT EXISTS`，重复执行不会清数据。

## 10. GitHub Pages

`.github/workflows/deploy-pages.yml` 不再在推送 `main` 时运行。Pages 上没有 API，登录和同步不能用。

需要一个不能登录的静态演示时，到 GitHub Actions 里手动运行 “Deploy to GitHub Pages”。那个产物只有页面文件。日常使用以这台 ECS 上的域名为准。

## 密码重置

登录框里的「发送密码重置邮件」会调用 `POST /api/auth/forgot-password`。账号存在时，服务会在 `password_reset_tokens` 里记下一次性 token，并调用 `sendPasswordResetEmail`。这个函数现在不会发信。

接上阿里云邮件推送或自己的 SMTP 时，只改 `server/src/index.js` 里的 `sendPasswordResetEmail`。函数参数里已经有收件邮箱、原始 token 和重置链接。用户设置新密码的接口是 `POST /api/auth/reset-password`，请求体为 `{ "token": "...", "password": "..." }`。

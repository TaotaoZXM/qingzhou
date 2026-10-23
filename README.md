# 轻舟

轻舟是一款面向手机端的 PWA 任务管理工具：先选择此刻的能量状态，再从适合当前状态的任务开始。

## 在线使用

应用部署在自己的服务器上，页面和接口使用同一个域名。手机浏览器打开后，可以通过“添加到主屏幕”安装为 PWA。

未登录时只能浏览 Start 页。登录并完成邮箱验证后会自动同步。第一次登录时，如果这台设备已有本地数据、而云端账号还没有数据，应用会把本地数据迁移到云端；云端已有数据时，以云端为准并覆盖本机。之后可以在其他浏览器用同一个邮箱和密码恢复。

部署步骤见 [`deploy/README.md`](deploy/README.md)。

## 本地预览

需要一套 MySQL，并在 `server/.env` 中写好连接信息。变量说明见 [`deploy/.env.example`](deploy/.env.example)。本地可以让 API 同时提供页面，把 `SERVE_STATIC` 留空或设为 `1`，`HOST` 使用 `127.0.0.1`。

```bash
cd server
npm install
npm start
```

然后访问 <http://127.0.0.1:3000/>。

只看静态页面、不连接数据库时，仍可以：

```bash
python3 -m http.server 8765
```

此时 `/api` 不存在，账户登录不可用，数据只留在本机。

## 账号与同步

- 未登录时只能看 Start。点能量状态、To-do、Done、Cal 或添加，都会打开登录框。
- 邮件还没接上时，注册后可以直接登录，再设置用户名。接上邮件后，新账号要先完成邮箱验证。用户名显示在右上角，点开可以退出登录。
- 可选管理员不是邮箱账号。同时设置 `ADMIN_USERNAME`（例如 `admin`）和 `ADMIN_PASSWORD_HASH` 后，进程启动会写入或更新这一行：`role` 为 `admin`，并标成已验证。两项都没设置时不会创建。管理员用现有登录框，在邮箱一栏填写这个用户名和密码，不需要邮箱验证。注册仍然只接受邮箱，并且不能注册 `admin`。限流、7 天会话，以及改密码后旧会话失效，都和普通账号一样。哈希用 `server/scripts/hash-password.js` 生成，不要把密码或哈希写进仓库。
- 会话是 HttpOnly Cookie，`SameSite=Lax`，有效期 7 天。Nginx 把 `X-Forwarded-Proto` 设为 `https` 时，Cookie 同时带 `Secure`。用 HTTP 打开 IP 时不带 `Secure`。重置密码后，这个账号已经发出的会话都会失效。
- 每个账号一份应用状态：待办、完成记录、灵感、项目。修改后大约 250 毫秒自动同步。本机缓存记着账号 id；换账号登录时，不会把上一个账号或来源不明的本地数据上传到新账号。保存如果和云端版本不一致，会合并后再提交。
- 接口不会返回重置链接或验证链接。只有本机调试同时设置 `EXPOSE_DEV_LINKS=1` 且 `NODE_ENV` 不是 `production` 时才会返回。找回密码在接上邮件前不可用。接上之后设置 `EMAIL_DELIVERY=directmail`，并让 `sendVerificationEmail` 和 `sendPasswordResetEmail` 真正把信发出去。验证页是 `/api/auth/verify?token=`，重置页是 `/api/auth/reset?token=`。

## GitHub Pages

推送到 `main` 不再自动发布到 GitHub Pages。登录和同步需要同域的 `/api`，Pages 跑不了这个后端。

工作流文件还在 [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml)，只能手动运行，而且只上传页面静态文件，用作离线演示。正式使用请部署到 ECS。

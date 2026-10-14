# 轻舟

轻舟是一款面向手机端的 PWA 任务管理工具：先选择此刻的能量状态，再从适合当前状态的任务开始。

## 在线使用

应用部署在自己的服务器上，页面和接口使用同一个域名。手机浏览器打开后，可以通过“添加到主屏幕”安装为 PWA。

未登录时，任务、灵感、完成记录和复盘保存在当前设备的 `localStorage` 中。登录后会自动同步。第一次登录时，如果这台设备已有本地数据、而云端账号还没有数据，应用会把本地数据迁移到云端；云端已有数据时，以云端为准并覆盖本机。之后可以在其他浏览器用同一个邮箱和密码恢复。

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

- 注册和登录使用邮箱加密码，密码至少 8 位。
- 会话放在 HttpOnly Cookie 里，浏览器请求同源的 `/api`。
- 每个账号一份应用状态，内容和以前的云端文档一致：待办、完成记录、灵感、项目。
- 修改后大约 250 毫秒自动同步；离线时继续写 `localStorage`。
- 忘记密码会记下重置请求。邮件发送还没有接入，接口留在 `POST /api/auth/forgot-password` 和 `POST /api/auth/reset-password`。真正发信时，改 `server/src/index.js` 里的 `sendPasswordResetEmail`。

## GitHub Pages

推送到 `main` 不再自动发布到 GitHub Pages。登录和同步需要同域的 `/api`，Pages 跑不了这个后端。

工作流文件还在 [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml)，只能手动运行，而且只上传页面静态文件，用作离线演示。正式使用请部署到 ECS。

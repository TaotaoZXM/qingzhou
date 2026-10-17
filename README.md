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
- 注册后需要打开验证邮件。验证成功会显示「注册账号成功」，然后在弹窗里填写用户名。用户名显示在右上角，点开可以退出登录。
- 会话是 HttpOnly Cookie，有效期 15 天。
- 每个账号一份应用状态：待办、完成记录、灵感、项目。修改后大约 250 毫秒自动同步。新安装和新建账号都没有示例任务、灵感或复盘。
- 发信由 `EMAIL_DELIVERY` 控制。默认不发信，链接只写在服务日志里。非生产环境的接口响应里也会带上链接，方便本地打开验证页 `/api/auth/verify?token=` 和重置页 `/api/auth/reset?token=`。生产环境无论是否发信，响应里都不会带 token。接上阿里云邮件推送时设置 `EMAIL_DELIVERY=directmail`，并配好 `DIRECTMAIL_*`（见 `deploy/.env.example`）。

## GitHub Pages

推送到 `main` 不再自动发布到 GitHub Pages。登录和同步需要同域的 `/api`，Pages 跑不了这个后端。

工作流文件还在 [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml)，只能手动运行，而且只上传页面静态文件，用作离线演示。正式使用请部署到 ECS。

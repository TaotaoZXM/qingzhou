# 轻舟

轻舟是一款面向手机端的 PWA 任务管理工具：先选择此刻的能量状态，再从适合当前状态的任务开始。

## 在线使用

GitHub Pages 发布后，可通过以下地址打开：

<https://taotaozxm.github.io/qingzhou/>

在手机浏览器中打开后，可以通过浏览器的“添加到主屏幕”安装为 PWA。未配置云端账号时，任务、灵感、完成记录和复盘会保存在当前设备的 `localStorage` 中；配置 Supabase 后，登录账号即可在不同浏览器和设备间恢复。

## 云端同步配置

正式使用跨浏览器同步前，需要创建一个 Supabase 项目：

1. 在 Supabase 控制台创建项目，并保持 Email 登录方式开启；本应用不使用手机号或第三方登录。
2. 在 SQL Editor 中执行 [`supabase-schema.sql`](./supabase-schema.sql)，创建用户数据表和行级安全策略。
3. 将项目的 URL 和公开 anon key 填入 [`supabase-config.js`](./supabase-config.js)。anon key 可以放在前端，绝对不要放入 service role key。
4. 提交并推送 `supabase-config.js`，等待 GitHub Pages 自动部署。

用户第一次登录时，如果当前设备已有本地数据而云端账号还没有数据，应用会把本地数据迁移到云端；之后每次新增或修改都会自动同步。用户可以在其他浏览器用同一个邮箱和密码登录恢复数据。

如果启用了邮箱确认，注册后需要先点击邮箱中的确认链接，再回到应用登录。忘记密码可以通过登录窗口发送重置邮件。

## 本地预览

```bash
python3 -m http.server 8765
```

然后访问 <http://127.0.0.1:8765/>。

## 发布

推送到 `main` 分支后，GitHub Actions 会自动部署到 GitHub Pages。部署配置位于 `.github/workflows/deploy-pages.yml`。

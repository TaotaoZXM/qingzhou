# 轻舟

轻舟是一款面向手机端的 PWA 任务管理工具：先选择此刻的能量状态，再从适合当前状态的任务开始。

## 在线使用

GitHub Pages 发布后，可通过以下地址打开：

<https://taotaozxm.github.io/qingzhou/>

在手机浏览器中打开后，可以通过浏览器的“添加到主屏幕”安装为 PWA。任务、灵感和当天的推荐记录保存在当前设备的 `localStorage` 中，不需要账号。

## 本地预览

```bash
python3 -m http.server 8765
```

然后访问 <http://127.0.0.1:8765/>。

## 发布

推送到 `main` 分支后，GitHub Actions 会自动部署到 GitHub Pages。部署配置位于 `.github/workflows/deploy-pages.yml`。


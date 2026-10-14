function page(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · 轻舟</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#eef0ed;color:#252a26;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}
  main{width:min(100%,390px);margin:24px;padding:24px 20px;background:#fff;border-radius:12px;box-shadow:0 16px 40px rgba(37,42,38,.12)}
  h1{margin:0;font-size:22px;letter-spacing:-.04em}
  p{margin:10px 0 0;color:#7e887f;font-size:14px;line-height:1.5}
  form{display:grid;gap:12px;margin-top:18px}
  label{display:grid;gap:6px;color:#7e887f;font-size:13px}
  input{width:100%;padding:10px 0;color:#252a26;background:transparent;border:0;border-bottom:1px solid #e5e8e3;outline:0;font:inherit}
  button,a.button{display:inline-block;margin-top:8px;padding:11px 14px;color:#fff;background:#367769;border:0;border-radius:6px;font:inherit;text-align:center;text-decoration:none}
  .status{min-height:18px;color:#9a5f5d}
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function verifySuccessPage() {
  return page('邮箱验证成功', `
    <h1>邮箱验证成功</h1>
    <p>起一个名字，它会显示在右上角。</p>
    <form id="nameForm">
      <label>用户名<input id="username" maxlength="20" required placeholder="怎么称呼你" autocomplete="nickname"></label>
      <button type="submit">完成</button>
      <p id="status" class="status"></p>
    </form>
    <script>
      document.getElementById('nameForm').onsubmit = async (event) => {
        event.preventDefault();
        const status = document.getElementById('status');
        const username = document.getElementById('username').value.trim();
        const response = await fetch('/api/auth/username', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) { status.textContent = data.error || '保存失败'; return; }
        location.href = '/';
      };
    </script>
  `);
}

export function verifyErrorPage(message) {
  return page('验证失败', `<h1>验证失败</h1><p>${message}</p><p><a class="button" href="/?login=1">返回登录</a></p>`);
}

export function resetPasswordPage() {
  return page('重置密码', `
    <h1>重置密码</h1>
    <p>设置一个新密码，至少 8 位。完成后会回到登录。</p>
    <form id="resetForm">
      <label>新密码<input id="password" type="password" minlength="8" required autocomplete="new-password"></label>
      <label>再输入一次<input id="confirm" type="password" minlength="8" required autocomplete="new-password"></label>
      <button type="submit">更新密码</button>
      <p id="status" class="status"></p>
    </form>
    <script>
      const params = new URLSearchParams(location.search);
      document.getElementById('resetForm').onsubmit = async (event) => {
        event.preventDefault();
        const status = document.getElementById('status');
        const password = document.getElementById('password').value;
        const confirm = document.getElementById('confirm').value;
        if (password !== confirm) { status.textContent = '两次密码不一致'; return; }
        const response = await fetch('/api/auth/reset-password', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: params.get('token') || '', password })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) { status.textContent = data.error || '重置失败'; return; }
        location.href = '/?login=1';
      };
    </script>
  `);
}

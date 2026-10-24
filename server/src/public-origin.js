// Email links use the public site origin. The SPA is served under /taskmanager/,
// while /api stays on the origin root. APP_PUBLIC_URL may be either form.

export function resolvePublicOrigin(configured) {
  const raw = String(configured || '').trim();
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  if (url.username || url.password) return '';
  return url.origin;
}

export function appHomeUrl(origin) {
  return `${String(origin || '').replace(/\/+$/, '')}/taskmanager/`;
}

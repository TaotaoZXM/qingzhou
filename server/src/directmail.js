import { createHmac, randomUUID } from 'node:crypto';
import { appHomeUrl } from './public-origin.js';

const API_VERSION = '2015-11-23';
const DEFAULT_REGION = 'cn-hangzhou';
const FROM_ALIAS = '轻舟';
const REQUEST_TIMEOUT_MS = 10_000;

// Public endpoints. The region must match the DirectMail console.
// Same-region ECS can override DIRECTMAIL_ENDPOINT with the VPC host.
const PUBLIC_ENDPOINTS = {
  'cn-hangzhou': 'https://dm.aliyuncs.com/',
  'ap-southeast-1': 'https://dm.ap-southeast-1.aliyuncs.com/',
  'ap-southeast-2': 'https://dm.ap-southeast-2.aliyuncs.com/',
  'us-east-1': 'https://dm.us-east-1.aliyuncs.com/',
  'eu-central-1': 'https://dm.eu-central-1.aliyuncs.com/'
};

export class DirectMailError extends Error {
  constructor(message, { code = 'DirectMailError', requestId = '', status = 0 } = {}) {
    super(message);
    this.name = 'DirectMailError';
    this.code = code;
    this.requestId = requestId;
    this.status = status;
  }
}

function envValue(name) {
  return String(process.env[name] || '').trim();
}

export function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

export function canonicalQuery(params) {
  return Object.keys(params)
    .filter((key) => key !== 'Signature' && params[key] !== undefined && params[key] !== null)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&');
}

export function signRpc(method, params, accessKeySecret) {
  const stringToSign = `${method}&${percentEncode('/')}&${percentEncode(canonicalQuery(params))}`;
  return createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64');
}

export function redactMailLog(value) {
  return String(value || '')
    .replace(/token=[^&\s"']+/gi, 'token=[redacted]')
    .replace(/(AccessKeySecret|Signature|Password)(=|":\s*")[^&\s"']+/gi, '$1$2[redacted]')
    .slice(0, 300);
}

export function resolveDirectMailEndpoint() {
  const region = envValue('DIRECTMAIL_REGION') || DEFAULT_REGION;
  const override = envValue('DIRECTMAIL_ENDPOINT');
  if (override) {
    let url;
    try {
      url = new URL(override);
    } catch {
      throw new DirectMailError('DIRECTMAIL_ENDPOINT is not a URL', { code: 'ConfigError' });
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new DirectMailError('DIRECTMAIL_ENDPOINT must use http or https', { code: 'ConfigError' });
    }
    if (url.username || url.password) {
      throw new DirectMailError('DIRECTMAIL_ENDPOINT must not include credentials', { code: 'ConfigError' });
    }
    const endpoint = override.endsWith('/') ? override : `${override}/`;
    return { region, endpoint };
  }
  const endpoint = PUBLIC_ENDPOINTS[region];
  if (!endpoint) {
    throw new DirectMailError(`Unknown DIRECTMAIL_REGION ${region}`, { code: 'ConfigError' });
  }
  return { region, endpoint };
}

export function readDirectMailSettings() {
  const missing = [];
  const accessKeyId = envValue('DIRECTMAIL_ACCESS_KEY_ID');
  const accessKeySecret = envValue('DIRECTMAIL_ACCESS_KEY_SECRET');
  const accountName = envValue('DIRECTMAIL_ACCOUNT_NAME') || envValue('EMAIL_FROM');
  if (!accessKeyId) missing.push('DIRECTMAIL_ACCESS_KEY_ID');
  if (!accessKeySecret) missing.push('DIRECTMAIL_ACCESS_KEY_SECRET');
  if (!accountName) missing.push('DIRECTMAIL_ACCOUNT_NAME');
  return {
    missing,
    accessKeyId,
    accessKeySecret,
    accountName,
    replyTo: envValue('DIRECTMAIL_REPLY_TO')
  };
}

export function assertDirectMailEnv() {
  if (envValue('EMAIL_DELIVERY') !== 'directmail') return;
  const { missing } = readDirectMailSettings();
  if (missing.length) {
    throw new Error(`EMAIL_DELIVERY=directmail is missing ${missing.join(', ')}`);
  }
  resolveDirectMailEndpoint();
}

function rpcTimestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mailDocument({ title, intro, actionLabel, actionUrl, note, appUrl }) {
  const href = escapeHtml(actionUrl);
  const home = escapeHtml(appUrl);
  const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:#f4f5f2;color:#252a26;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f2;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;">
        <tr><td style="padding:28px 24px;">
          <p style="margin:0;font-size:13px;letter-spacing:.08em;color:#367769;">轻舟</p>
          <h1 style="margin:12px 0 0;font-size:22px;font-weight:600;">${escapeHtml(title)}</h1>
          <p style="margin:12px 0 0;font-size:15px;line-height:1.6;color:#3c4440;">${escapeHtml(intro)}</p>
          <p style="margin:20px 0;"><a href="${href}" style="display:inline-block;padding:12px 18px;background:#367769;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(actionLabel)}</a></p>
          <p style="margin:0;font-size:13px;line-height:1.6;color:#7e887f;">如果按钮打不开，把下面的地址复制到浏览器：</p>
          <p style="margin:8px 0 0;font-size:13px;line-height:1.6;word-break:break-all;"><a href="${href}" style="color:#367769;">${href}</a></p>
          <p style="margin:20px 0 0;font-size:13px;line-height:1.6;color:#7e887f;">${escapeHtml(note)}</p>
          <p style="margin:8px 0 0;font-size:13px;line-height:1.6;"><a href="${home}" style="color:#367769;">${home}</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  const text = `${title}\n\n${intro}\n\n${actionUrl}\n\n${note}\n${appUrl}\n`;
  return { html, text };
}

export function verificationMessage({ verifyUrl, appUrl }) {
  const home = appUrl || appHomeUrl(new URL(verifyUrl).origin);
  const { html, text } = mailDocument({
    title: '验证你的邮箱',
    intro: '请点击下面的按钮完成轻舟注册。链接 24 小时内有效，只能使用一次。',
    actionLabel: '完成验证',
    actionUrl: verifyUrl,
    note: '如果不是你本人操作，忽略这封邮件即可。验证完成后会进入轻舟：',
    appUrl: home
  });
  return { subject: '轻舟邮箱验证', htmlBody: html, textBody: text };
}

export function passwordResetMessage({ resetUrl, appUrl }) {
  const home = appUrl || appHomeUrl(new URL(resetUrl).origin);
  const { html, text } = mailDocument({
    title: '重置轻舟密码',
    intro: '请点击下面的按钮设置新密码。链接 1 小时内有效，只能使用一次。',
    actionLabel: '重置密码',
    actionUrl: resetUrl,
    note: '如果不是你本人操作，忽略这封邮件即可，密码不会改变。完成后从这里回到轻舟：',
    appUrl: home
  });
  return { subject: '轻舟密码重置', htmlBody: html, textBody: text };
}

export async function singleSendMail({ toAddress, subject, htmlBody, textBody }, options = {}) {
  const settings = readDirectMailSettings();
  if (settings.missing.length) {
    throw new DirectMailError(`DirectMail is not configured: ${settings.missing.join(', ')}`, { code: 'ConfigError' });
  }
  const { region, endpoint } = resolveDirectMailEndpoint();
  const params = {
    Format: 'JSON',
    Version: API_VERSION,
    AccessKeyId: settings.accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: options.nonce || randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: rpcTimestamp(options.now || new Date()),
    Action: 'SingleSendMail',
    RegionId: region,
    AccountName: settings.accountName,
    AddressType: '1',
    ReplyToAddress: 'false',
    ToAddress: toAddress,
    Subject: subject,
    HtmlBody: htmlBody,
    TextBody: textBody,
    FromAlias: FROM_ALIAS,
    ClickTrace: '0',
    UnSubscribeLinkType: 'disabled'
  };
  if (settings.replyTo) {
    params.ReplyAddress = settings.replyTo;
  }
  const signature = signRpc('POST', params, settings.accessKeySecret);
  const body = `${canonicalQuery(params)}&Signature=${percentEncode(signature)}`;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/json'
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new DirectMailError(timedOut ? 'DirectMail request timed out' : 'DirectMail request failed', {
      code: timedOut ? 'Timeout' : 'NetworkError'
    });
  }
  const raw = await response.text();
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }
  const code = payload?.Code ? String(payload.Code) : '';
  if (!response.ok || (code && code.toUpperCase() !== 'OK')) {
    throw new DirectMailError(redactMailLog(payload?.Message || 'DirectMail rejected the message'), {
      code: code || 'HttpError',
      requestId: payload?.RequestId ? String(payload.RequestId) : '',
      status: response.status
    });
  }
  return {
    requestId: payload?.RequestId ? String(payload.RequestId) : '',
    envId: payload?.EnvId ? String(payload.EnvId) : ''
  };
}

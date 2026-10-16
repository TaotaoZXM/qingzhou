import { createHmac, randomUUID } from 'node:crypto';

// Aliyun RPC percent-encoding: same as Java URLEncoder, then + → %20, * → %2A, %7E → ~.
export function popEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

export function canonicalQuery(params) {
  return Object.keys(params)
    .sort()
    .map((key) => `${popEncode(key)}=${popEncode(params[key])}`)
    .join('&');
}

export function signRpcParams(params, accessKeySecret, method = 'POST') {
  const canonical = canonicalQuery(params);
  const stringToSign = `${method}&${popEncode('/')}&${popEncode(canonical)}`;
  const signature = createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64');
  return { signature, stringToSign, canonical };
}

function directMailConfig() {
  const accessKeyId = process.env.DIRECTMAIL_ACCESS_KEY_ID || '';
  const accessKeySecret = process.env.DIRECTMAIL_ACCESS_KEY_SECRET || '';
  const accountName = process.env.DIRECTMAIL_ACCOUNT_NAME || '';
  if (!accessKeyId || !accessKeySecret || !accountName) {
    throw new Error('DirectMail is not configured (DIRECTMAIL_ACCESS_KEY_ID, DIRECTMAIL_ACCESS_KEY_SECRET, DIRECTMAIL_ACCOUNT_NAME)');
  }
  return {
    accessKeyId,
    accessKeySecret,
    accountName,
    endpoint: process.env.DIRECTMAIL_ENDPOINT || 'https://dm.aliyuncs.com/',
    regionId: process.env.DIRECTMAIL_REGION || 'cn-hangzhou',
    fromAlias: process.env.DIRECTMAIL_FROM_ALIAS || '轻舟',
    addressType: process.env.DIRECTMAIL_ADDRESS_TYPE || '1'
  };
}

export function buildSingleSendMailRequest({ to, subject, html, text }, now = new Date()) {
  const config = directMailConfig();
  const version = config.regionId === 'cn-hangzhou' ? '2015-11-23' : '2017-06-22';
  const params = {
    Action: 'SingleSendMail',
    Format: 'JSON',
    Version: version,
    AccessKeyId: config.accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: randomUUID(),
    Timestamp: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    RegionId: config.regionId,
    AccountName: config.accountName,
    AddressType: config.addressType,
    ReplyToAddress: 'false',
    ToAddress: to,
    Subject: subject,
    HtmlBody: html,
    TextBody: text || ''
  };
  if (config.fromAlias) params.FromAlias = config.fromAlias;
  const { signature } = signRpcParams(params, config.accessKeySecret, 'POST');
  params.Signature = signature;
  return {
    endpoint: config.endpoint,
    body: canonicalQuery(params)
  };
}

export async function sendDirectMail({ to, subject, html, text }) {
  const request = buildSingleSendMailRequest({ to, subject, html, text });
  const response = await fetch(request.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: request.body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.Code) {
    const message = data.Message || data.Code || `DirectMail failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function deliver({ email, url, subject, intro }) {
  const safeUrl = escapeHtml(url);
  if (process.env.EMAIL_DELIVERY === 'directmail') {
    try {
      await sendDirectMail({
        to: email,
        subject,
        html: `<p>${intro}</p><p><a href="${safeUrl}">${safeUrl}</a></p>`,
        text: `${intro}\n${url}\n`
      });
      return { delivered: true };
    } catch (error) {
      console.error(`[directmail] ${email} ${error.message}`);
      console.info(`[directmail] fallback link for ${email} ${url}`);
      return { delivered: false };
    }
  }
  console.info(`[email] ${email} ${url}`);
  return { delivered: false };
}

export function sendVerificationEmail({ email, verifyUrl }) {
  return deliver({
    email,
    url: verifyUrl,
    subject: '请验证你的轻舟账号',
    intro: '请在 24 小时内打开下面的链接，完成轻舟账号验证。'
  });
}

export function sendPasswordResetEmail({ email, resetUrl }) {
  return deliver({
    email,
    url: resetUrl,
    subject: '重置你的轻舟密码',
    intro: '请在 1 小时内打开下面的链接，重置轻舟密码。如果这不是你本人的操作，可以忽略这封邮件。'
  });
}

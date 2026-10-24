import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertDirectMailEnv,
  canonicalQuery,
  passwordResetMessage,
  percentEncode,
  redactMailLog,
  resolveDirectMailEndpoint,
  signRpc,
  singleSendMail,
  verificationMessage
} from '../src/directmail.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../src/index.js';
import { appHomeUrl, resolvePublicOrigin } from '../src/public-origin.js';

const SECRET = 'super-secret-value';

function clearMailEnv() {
  delete process.env.EMAIL_DELIVERY;
  delete process.env.PASSWORD_RESET_DELIVERY;
  delete process.env.DIRECTMAIL_ACCESS_KEY_ID;
  delete process.env.DIRECTMAIL_ACCESS_KEY_SECRET;
  delete process.env.DIRECTMAIL_ACCOUNT_NAME;
  delete process.env.DIRECTMAIL_REGION;
  delete process.env.DIRECTMAIL_ENDPOINT;
  delete process.env.DIRECTMAIL_REPLY_TO;
  delete process.env.EMAIL_FROM;
  delete process.env.APP_PUBLIC_URL;
}

function configuredEnv() {
  clearMailEnv();
  process.env.EMAIL_DELIVERY = 'directmail';
  process.env.DIRECTMAIL_ACCESS_KEY_ID = 'testid';
  process.env.DIRECTMAIL_ACCESS_KEY_SECRET = SECRET;
  process.env.DIRECTMAIL_ACCOUNT_NAME = 'noreply@mail.myqingzhou.com';
}

test('RPC signature matches the Aliyun fixed example', () => {
  const params = {
    Format: 'JSON',
    Version: '2014-05-26',
    AccessKeyId: 'testid',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: 'edb2b34af0af9a6d14deaf7c1a5315eb',
    SignatureVersion: '1.0',
    Timestamp: '2023-03-13T08:34:30Z',
    Action: 'DescribeDedicatedHosts',
    RegionId: 'cn-beijing'
  };
  assert.equal(
    canonicalQuery(params),
    'AccessKeyId=testid&Action=DescribeDedicatedHosts&Format=JSON&RegionId=cn-beijing&SignatureMethod=HMAC-SHA1&SignatureNonce=edb2b34af0af9a6d14deaf7c1a5315eb&SignatureVersion=1.0&Timestamp=2023-03-13T08%3A34%3A30Z&Version=2014-05-26'
  );
  assert.equal(signRpc('GET', params, 'testsecret'), '9NaGiOspFP5UPcwX8Iwt2YJXXuk=');
  assert.equal(percentEncode('a b*~'), 'a%20b%2A~');
});

test('public origin keeps /api on the host and the app under /taskmanager/', () => {
  assert.equal(resolvePublicOrigin('https://www.myqingzhou.com/taskmanager/'), 'https://www.myqingzhou.com');
  assert.equal(resolvePublicOrigin('https://www.myqingzhou.com/taskmanager'), 'https://www.myqingzhou.com');
  assert.equal(resolvePublicOrigin('https://user:pass@www.myqingzhou.com/taskmanager/'), '');
  assert.equal(resolvePublicOrigin('not a url'), '');
  assert.equal(appHomeUrl('https://www.myqingzhou.com'), 'https://www.myqingzhou.com/taskmanager/');
});

test('Hangzhou is the default endpoint and regions or overrides replace it', () => {
  clearMailEnv();
  assert.deepEqual(resolveDirectMailEndpoint(), {
    region: 'cn-hangzhou',
    endpoint: 'https://dm.aliyuncs.com/'
  });
  process.env.DIRECTMAIL_REGION = 'ap-southeast-1';
  assert.equal(resolveDirectMailEndpoint().endpoint, 'https://dm.ap-southeast-1.aliyuncs.com/');
  process.env.DIRECTMAIL_ENDPOINT = 'https://dm-vpc.cn-hangzhou.aliyuncs.com';
  assert.equal(resolveDirectMailEndpoint().endpoint, 'https://dm-vpc.cn-hangzhou.aliyuncs.com/');
  process.env.DIRECTMAIL_REGION = 'mars';
  delete process.env.DIRECTMAIL_ENDPOINT;
  assert.throws(() => resolveDirectMailEndpoint(), /DIRECTMAIL_REGION/);
  process.env.DIRECTMAIL_ENDPOINT = 'https://user:pass@dm.aliyuncs.com/';
  assert.throws(() => resolveDirectMailEndpoint(), /credentials/);
  clearMailEnv();
});

test('messages are Chinese and point at /api plus the taskmanager home', () => {
  const verifyUrl = 'https://www.myqingzhou.com/api/auth/verify?token=abc123';
  const home = 'https://www.myqingzhou.com/taskmanager/';
  const verify = verificationMessage({ verifyUrl, appUrl: home });
  assert.equal(verify.subject, '轻舟邮箱验证');
  assert.match(verify.textBody, /24 小时/);
  assert.match(verify.htmlBody, /完成验证/);
  assert.match(verify.htmlBody, /https:\/\/www\.myqingzhou\.com\/api\/auth\/verify\?token=abc123/);
  assert.match(verify.htmlBody, /https:\/\/www\.myqingzhou\.com\/taskmanager\//);
  assert.doesNotMatch(verify.htmlBody, /\/taskmanager\/api/);

  const reset = passwordResetMessage({
    resetUrl: 'https://www.myqingzhou.com/api/auth/reset?token=def456',
    appUrl: home
  });
  assert.equal(reset.subject, '轻舟密码重置');
  assert.match(reset.textBody, /1 小时/);
  assert.match(reset.htmlBody, /重置密码/);
  assert.match(reset.textBody, /token=def456/);
});

test('SingleSendMail posts a signed form and keeps the secret out of the body', async () => {
  configuredEnv();
  process.env.DIRECTMAIL_REPLY_TO = 'reply@mail.myqingzhou.com';
  const calls = [];
  const result = await singleSendMail({
    toAddress: 'person@example.com',
    subject: '轻舟邮箱验证',
    htmlBody: '<p>https://www.myqingzhou.com/api/auth/verify?token=abc</p>',
    textBody: 'token=abc'
  }, {
    now: new Date('2024-01-02T03:04:05.678Z'),
    nonce: 'nonce-1',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), method: options.method, body: String(options.body), headers: options.headers });
      return new Response(JSON.stringify({ RequestId: 'RID', EnvId: 'EID' }), { status: 200 });
    }
  });
  assert.equal(result.requestId, 'RID');
  assert.equal(result.envId, 'EID');
  assert.equal(calls[0].url, 'https://dm.aliyuncs.com/');
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].headers['Content-Type'], /application\/x-www-form-urlencoded/);
  const params = Object.fromEntries(new URLSearchParams(calls[0].body));
  const signature = params.Signature;
  delete params.Signature;
  assert.equal(signRpc('POST', params, SECRET), signature);
  assert.equal(params.Action, 'SingleSendMail');
  assert.equal(params.Version, '2015-11-23');
  assert.equal(params.RegionId, 'cn-hangzhou');
  assert.equal(params.AccountName, 'noreply@mail.myqingzhou.com');
  assert.equal(params.AddressType, '1');
  assert.equal(params.ReplyToAddress, 'false');
  assert.equal(params.ReplyAddress, 'reply@mail.myqingzhou.com');
  assert.equal(params.ToAddress, 'person@example.com');
  assert.equal(params.FromAlias, '轻舟');
  assert.equal(params.ClickTrace, '0');
  assert.equal(params.UnSubscribeLinkType, 'disabled');
  assert.equal(params.Timestamp, '2024-01-02T03:04:05Z');
  assert.equal(Object.hasOwn(params, 'AccessKeySecret'), false);
  assert.equal(calls[0].body.includes(SECRET), false);
  clearMailEnv();
});

test('missing settings and provider errors do not call out or leak secrets', async () => {
  clearMailEnv();
  process.env.DIRECTMAIL_ACCESS_KEY_ID = 'testid';
  process.env.DIRECTMAIL_ACCESS_KEY_SECRET = SECRET;
  let called = false;
  await assert.rejects(
    () => singleSendMail({ toAddress: 'a@b.co', subject: 's', htmlBody: 'h', textBody: 't' }, {
      fetchImpl: async () => { called = true; return new Response('{}'); }
    }),
    (error) => {
      assert.equal(error.code, 'ConfigError');
      assert.equal(String(error.message).includes(SECRET), false);
      assert.match(error.message, /DIRECTMAIL_ACCOUNT_NAME/);
      return true;
    }
  );
  assert.equal(called, false);

  process.env.EMAIL_FROM = 'noreply@mail.myqingzhou.com';
  const sent = await singleSendMail({ toAddress: 'a@b.co', subject: 's', htmlBody: 'h', textBody: 't' }, {
    fetchImpl: async () => new Response(JSON.stringify({ RequestId: 'from-alias' }), { status: 200 })
  });
  assert.equal(sent.requestId, 'from-alias');

  await assert.rejects(
    () => singleSendMail({ toAddress: 'a@b.co', subject: 's', htmlBody: '<a href="https://www.myqingzhou.com/api/auth/verify?token=abc">x</a>', textBody: 't' }, {
      fetchImpl: async () => new Response(JSON.stringify({
        Code: 'InvalidSendMail',
        Message: 'rejected token=abc AccessKeySecret=super-secret-value',
        RequestId: 'rid-fail'
      }), { status: 400 })
    }),
    (error) => {
      assert.equal(error.code, 'InvalidSendMail');
      assert.equal(error.requestId, 'rid-fail');
      assert.equal(error.status, 400);
      assert.equal(error.message.includes('token=abc'), false);
      assert.equal(error.message.includes(SECRET), false);
      assert.match(error.message, /token=\[redacted\]/);
      return true;
    }
  );

  await assert.rejects(
    () => singleSendMail({ toAddress: 'a@b.co', subject: 's', htmlBody: 'h', textBody: 't' }, {
      fetchImpl: async () => {
        const error = new Error(`timeout token=abc ${SECRET}`);
        error.name = 'TimeoutError';
        throw error;
      }
    }),
    (error) => {
      assert.equal(error.code, 'Timeout');
      assert.equal(error.message.includes(SECRET), false);
      assert.equal(error.message.includes('token='), false);
      return true;
    }
  );
  assert.equal(redactMailLog('token=abc AccessKeySecret=super-secret-value').includes(SECRET), false);
  clearMailEnv();
  assert.doesNotThrow(() => assertDirectMailEnv());
  process.env.EMAIL_DELIVERY = 'directmail';
  assert.throws(() => assertDirectMailEnv(), /DIRECTMAIL_ACCESS_KEY_ID/);
  clearMailEnv();
});

test('hooks send only in directmail mode and do not log the token', async () => {
  const realFetch = globalThis.fetch;
  const info = console.info;
  const lines = [];
  const calls = [];
  console.info = (...args) => { lines.push(args.join(' ')); };
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: String(options?.body || '') });
    return new Response(JSON.stringify({ RequestId: 'rid-hook', EnvId: 'env-hook' }), { status: 200 });
  };
  try {
    clearMailEnv();
    const idle = await sendVerificationEmail({
      email: 'person@example.com',
      verifyUrl: 'https://www.myqingzhou.com/api/auth/verify?token=abc123'
    });
    assert.equal(idle.delivered, false);
    assert.equal(calls.length, 0);

    configuredEnv();
    process.env.PASSWORD_RESET_DELIVERY = 'log';
    const sent = await sendVerificationEmail({
      email: 'person@example.com',
      verifyUrl: 'https://www.myqingzhou.com/api/auth/verify?token=abc123'
    });
    assert.equal(sent.delivered, true);
    assert.equal(sent.token, undefined);
    assert.equal(sent.verifyUrl, undefined);
    const reset = await sendPasswordResetEmail({
      email: 'person@example.com',
      resetUrl: 'https://www.myqingzhou.com/api/auth/reset?token=def456'
    });
    assert.equal(reset.delivered, true);
    const verifyParams = new URLSearchParams(calls[0].body);
    const resetParams = new URLSearchParams(calls[1].body);
    assert.match(verifyParams.get('HtmlBody'), /轻舟/);
    assert.match(verifyParams.get('HtmlBody'), /\/api\/auth\/verify\?token=abc123/);
    assert.match(verifyParams.get('HtmlBody'), /\/taskmanager\//);
    assert.equal(verifyParams.get('Subject'), '轻舟邮箱验证');
    assert.equal(resetParams.get('Subject'), '轻舟密码重置');
    assert.match(resetParams.get('TextBody'), /\/api\/auth\/reset\?token=def456/);
    const logged = lines.join('\n');
    assert.match(logged, /verification sent to person@example.com requestId=rid-hook/);
    assert.match(logged, /password reset sent to person@example.com requestId=rid-hook/);
    assert.equal(logged.includes('abc123'), false);
    assert.equal(logged.includes('def456'), false);
    assert.equal(logged.includes(SECRET), false);
  } finally {
    console.info = info;
    globalThis.fetch = realFetch;
    clearMailEnv();
  }
});

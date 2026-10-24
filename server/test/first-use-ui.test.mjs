import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifySuccessPage } from '../src/auth-pages.js';

const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(root, '..', '..', 'index.html'), 'utf8');

test('verify success card stays content-sized inside the viewport', () => {
  const page = verifySuccessPage();
  assert.match(page, /邮箱验证成功/);
  assert.match(page, /min-height:100vh;min-height:100dvh/);
  assert.match(page, /align-items:center;justify-content:center;align-items:safe center;justify-content:safe center/);
  assert.match(page, /width:min\(100%,400px\);height:auto/);
  assert.match(page, /align-self:center/);
  assert.doesNotMatch(page, /margin:24px/);
  assert.doesNotMatch(page, /min-height:100vh;display:grid/);
});

test('first-use copy and controls are in the app', () => {
  assert.match(html, /signup\?'注册':'登录'/);
  assert.match(html, /id="startEmptyAdd"/);
  assert.match(html, /id="todoEmptyAdd"/);
  assert.match(html, /id="newTodo">＋ 新任务/);
  assert.equal((html.match(/当前没有要完成的任务/g) || []).length, 2);
  assert.doesNotMatch(html, /今天的任务都完成了/);
  assert.doesNotMatch(html, /给下一件想做的事留一个位置/);
  assert.match(html, /不填写截止日期/);
  assert.match(html, /showTaskDeadline\('',' '\)|showTaskDeadline\('',''\)/);
  assert.match(html, /pendingDeleteType==='done'\)deleteDoneRow/);
  assert.match(html, /saved\.length===0&&openIds\.size>0/);
  assert.match(html, /env\(safe-area-inset-top,0px\)/);
  assert.match(html, /backdrop-filter:none/);
});

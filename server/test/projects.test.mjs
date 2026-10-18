import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.html'), 'utf8');

function projectLists() {
  return [...html.matchAll(/<div class="project-list">([\s\S]*?)<\/div>/g)].map((match) => match[1]);
}

function loadProjectHelpers() {
  const start = html.indexOf('function isLegacyPlaceholderProject');
  const end = html.indexOf('const projectNames=[]');
  assert.ok(start > 0 && end > start, 'project helpers were not found');
  const context = {};
  createContext(context);
  runInContext(`${html.slice(start, end)}
    globalThis.projectsFromState = projectsFromState;
    globalThis.isLegacyPlaceholderProject = isLegacyPlaceholderProject;
  `, context);
  return context;
}

test('new-task pickers do not ship built-in projects', () => {
  const lists = projectLists();
  assert.equal(lists.length, 2);
  for (const list of lists) {
    assert.match(list, /新增项目/);
    assert.equal(list.includes('class="project active"'), false);
    assert.equal(list.includes('工作'), false);
    assert.equal(list.includes('产品'), false);
    assert.equal(list.includes('个人成长'), false);
    assert.equal(list.includes('生活'), false);
    assert.equal((list.match(/class="project/g) || []).length, 1);
  }
  assert.match(html, /const projectNames=\[\]/);
  for (const id of ['todoProjectFilter', 'doneProjectFilter', 'reviewProjectFilter']) {
    const start = html.indexOf(`id="${id}"`);
    const end = html.indexOf('id="', start + 8);
    const chunk = html.slice(start, end);
    assert.equal(chunk.includes('filter-option'), false, id);
    assert.equal(chunk.includes('工作'), false, id);
  }
});

test('saved placeholder projects stay only when a task uses them', () => {
  const { projectsFromState } = loadProjectHelpers();
  const names = (state) => [...projectsFromState(state)];
  const legacy = ['工作', '产品', '个人成长', '生活'];
  assert.deepEqual(names({ version: 1, projects: legacy, todo: [], done: [] }), []);

  const custom = names({
    version: 1,
    projects: [...legacy, '舟'],
    todo: [],
    done: []
  });
  assert.deepEqual(custom, ['舟']);

  const task = { id: 't1', title: '写方案', project: '工作', priority: 'urgent-important' };
  const done = { id: 'd1', title: '买菜', project: '生活' };
  const kept = names({
    version: 1,
    projects: [...legacy, '舟', '日常'],
    todo: [task],
    done: [done]
  });
  assert.deepEqual(kept, ['舟', '工作', '生活']);
  assert.equal(task.project, '工作');
  assert.equal(done.project, '生活');

  const unlabeled = { id: 't2', title: '无项目', project: '未分类' };
  assert.deepEqual(names({ version: 1, projects: [], todo: [unlabeled], done: [] }), []);
  assert.equal(unlabeled.project, '未分类');
});

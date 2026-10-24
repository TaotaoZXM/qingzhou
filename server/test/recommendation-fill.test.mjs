import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.html'), 'utf8');

function between(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start + startMarker.length);
  assert.ok(start > 0 && end > start, `${startMarker} … ${endMarker}`);
  return html.slice(start, end);
}

function loadPushHelpers() {
  const source = between('function chooseRecommendationIdsFrom', 'function refreshRecommendationIds');
  const context = {
    priorityRank: { 'urgent-important': 4, important: 3, urgent: 2, other: 1 },
    recommendationRules: {
      low: { target: 'easy', order: ['easy', 'medium', 'hard'] },
      some: { target: 'medium', order: ['medium', 'easy', 'hard'] },
      ready: { target: 'hard', order: ['hard', 'medium', 'easy'] }
    },
    Math
  };
  createContext(context);
  runInContext(`${source}
    globalThis.chooseRecommendationIdsFrom = chooseRecommendationIdsFrom;
    globalThis.fillSavedPushIds = fillSavedPushIds;
  `, context);
  return context;
}

const keepOrder = () => 0.999;
const task = (id, difficulty, priority) => ({ id, difficulty, priority });
const ids = (value) => (value == null ? value : [...value]);

const catalog = [
  task('m-urgent', 'medium', 'urgent-important'),
  task('m-other', 'medium', 'other'),
  task('e-urgent', 'easy', 'urgent-important'),
  task('h-urgent', 'hard', 'urgent-important'),
  task('m-important', 'medium', 'important')
];

test('ranking still picks the energy target, then priority, without a new shuffle order', () => {
  const { chooseRecommendationIdsFrom } = loadPushHelpers();
  assert.deepEqual(
    ids(chooseRecommendationIdsFrom(catalog, 'some', { random: keepOrder })),
    ['m-urgent', 'm-important', 'm-other']
  );
  assert.deepEqual(
    ids(chooseRecommendationIdsFrom(catalog, 'low', { random: keepOrder })),
    ['e-urgent', 'm-urgent', 'm-important']
  );
  assert.deepEqual(
    ids(chooseRecommendationIdsFrom(catalog, 'ready', { random: keepOrder })),
    ['h-urgent', 'm-urgent', 'm-important']
  );
});

test('a new open task fills a free slot and leaves valid pushed tasks in place', () => {
  const { fillSavedPushIds } = loadPushHelpers();
  const saved = ['e-urgent', 'e-other-old'];
  const items = [
    task('e-urgent', 'easy', 'urgent-important'),
    task('e-other-old', 'easy', 'other'),
    task('m-urgent', 'medium', 'urgent-important'),
    task('new-easy', 'easy', 'other')
  ];
  assert.deepEqual(
    ids(fillSavedPushIds(saved, items, 'some', keepOrder)),
    ['e-urgent', 'e-other-old', 'm-urgent']
  );
  assert.deepEqual(
    ids(fillSavedPushIds(saved, items, 'low', keepOrder)),
    ['e-urgent', 'e-other-old', 'new-easy']
  );
  assert.deepEqual(saved, ['e-urgent', 'e-other-old']);
});

test('one free slot takes the new task when it is the only task not already pushed', () => {
  const { fillSavedPushIds } = loadPushHelpers();
  const items = [
    task('kept-a', 'easy', 'other'),
    task('kept-b', 'medium', 'important'),
    task('new-task', 'hard', 'other')
  ];
  assert.deepEqual(
    ids(fillSavedPushIds(['kept-a', 'kept-b'], items, 'some', keepOrder)),
    ['kept-a', 'kept-b', 'new-task']
  );
  assert.deepEqual(
    ids(fillSavedPushIds(['kept-a'], items, 'ready', keepOrder)),
    ['kept-a', 'new-task', 'kept-b']
  );
});

test('a full valid push does not reshuffle when another task appears', () => {
  const { fillSavedPushIds } = loadPushHelpers();
  const saved = ['e-urgent', 'm-other', 'h-urgent'];
  const items = catalog.concat([task('new-top', 'medium', 'urgent-important')]);
  assert.equal(fillSavedPushIds(saved, items, 'some', keepOrder), null);
  assert.equal(fillSavedPushIds(['gone', 'e-urgent', 'm-other', 'h-urgent'], items, 'low', keepOrder), null);
});

test('stale ids stay out of the kept prefix and do not block a free slot', () => {
  const { fillSavedPushIds } = loadPushHelpers();
  const items = [
    task('keep-low', 'easy', 'other'),
    task('keep-high', 'medium', 'urgent-important'),
    task('newcomer', 'easy', 'important')
  ];
  assert.deepEqual(
    ids(fillSavedPushIds(['keep-low', 'gone', 'keep-high'], items, 'some', keepOrder)),
    ['keep-low', 'keep-high', 'newcomer']
  );
});

test('an empty saved list is left for the existing rebuild', () => {
  const { fillSavedPushIds } = loadPushHelpers();
  assert.equal(fillSavedPushIds([], catalog, 'some', keepOrder), null);
  assert.equal(fillSavedPushIds(undefined, catalog, 'some', keepOrder), null);
  assert.equal(fillSavedPushIds(['only-open'], [task('only-open', 'easy', 'other')], 'low', keepOrder), null);
});

test('filling slots updates only the current energy and leaves the other list alone', () => {
  const source = between('function chooseRecommendationIdsFrom', 'function renderRecommendations');
  const low = ['x', 'y', 'z'];
  const some = ['kept-a', 'kept-b'];
  const context = {
    priorityRank: { 'urgent-important': 4, important: 3, urgent: 2, other: 1 },
    recommendationRules: {
      low: { target: 'easy', order: ['easy', 'medium', 'hard'] },
      some: { target: 'medium', order: ['medium', 'easy', 'hard'] },
      ready: { target: 'hard', order: ['hard', 'medium', 'easy'] }
    },
    Math,
    activeEnergy: 'some',
    recommendationState: 'low',
    recommendedTaskIds: ['x'],
    recommendedTaskIdsByState: { some, low },
    recommendationsGenerated: false,
    saveCount: 0,
    allTodoItems: () => [
      task('kept-a', 'easy', 'other'),
      task('kept-b', 'medium', 'important'),
      task('new-task', 'hard', 'other'),
      task('x', 'easy', 'other'),
      task('y', 'easy', 'other'),
      task('z', 'easy', 'other')
    ],
    document: { querySelector: () => null }
  };
  context.saveDailyRecommendations = () => { context.saveCount += 1; };
  createContext(context);
  runInContext(source, context);
  context.fillCurrentPushSlots();
  const someIds = ids(context.recommendedTaskIdsByState.some);
  assert.deepEqual(someIds.slice(0, 2), ['kept-a', 'kept-b']);
  assert.ok(['x', 'y', 'z'].includes(someIds[2]));
  assert.equal(context.recommendedTaskIdsByState.low, low);
  assert.equal(context.recommendationState, 'some');
  assert.equal(context.saveCount, 1);

  context.activeEnergy = 'low';
  context.fillCurrentPushSlots();
  assert.equal(context.recommendedTaskIdsByState.low, low);
  assert.equal(context.saveCount, 1);
});

test('creating a task fills only the current energy and does not refill when a task is completed or deleted', () => {
  const ensure = between('function ensureRecommendationIds', 'function currentPushEnergy');
  const complete = between('function completeTask', 'document.addEventListener');
  const remove = between('function deleteTodoRow', 'function deleteIdeaRow');
  const add = between('function addTaskToList', "document.querySelector('#todoSheet form')");
  const refresh = between("document.getElementById('refreshRecommendations').onclick", 'function showTodoTab');

  assert.match(ensure, /saved\.length===0&&openIds\.size>0/);
  assert.doesNotMatch(ensure, /fillSavedPushIds|fillCurrentPushSlots/);
  assert.doesNotMatch(complete, /fillSavedPushIds|fillCurrentPushSlots/);
  assert.doesNotMatch(remove, /fillSavedPushIds|fillCurrentPushSlots/);
  assert.match(add, /fillCurrentPushSlots\(\)/);
  assert.match(refresh, /refreshRecommendationIds\(activeEnergy\|\|'some'\)/);
  assert.doesNotMatch(refresh, /fillCurrentPushSlots/);
  assert.match(html, /\.phone \.screen\.start \.recommendation-head\{display:none\}/);
  assert.doesNotMatch(between('<section id="startScreen"', '<section id="todoScreen"'), /卡皮|capybara|v\d+/i);
});

function loadFooterHelpers() {
  const source = between('function greyFooterIds', 'function settledPushItems');
  const context = { Math, Date, String };
  createContext(context);
  runInContext(`${source}
    globalThis.greyFooterIds = greyFooterIds;
    globalThis.pushColumnPlan = pushColumnPlan;
  `, context);
  return context;
}

test('the grey footer keeps only tasks completed on the given local day', () => {
  const { greyFooterIds } = loadFooterHelpers();
  const today = new Date(2026, 9, 24, 15, 30);
  const yesterday = new Date(2026, 9, 23, 23, 59);
  const tomorrow = new Date(2026, 9, 25, 0, 1);
  assert.deepEqual(
    ids(greyFooterIds([
      { id: 'old', completedAt: yesterday },
      { id: 'first', completedAt: new Date(2026, 9, 24, 9, 0) },
      { id: 'blank', completedAt: 'not-a-date' },
      { id: 'later', completedAt: new Date(2026, 9, 24, 18, 0) },
      { id: 'next', completedAt: tomorrow }
    ], '2026-10-24')),
    ['first', 'later']
  );
  assert.deepEqual(ids(greyFooterIds([{ id: 'today', completedAt: today }], '2026-10-23')), []);
});

test('settled tasks sit after unfinished ones and do not use an unfinished slot', () => {
  const { pushColumnPlan } = loadFooterHelpers();
  const plan = pushColumnPlan(['a', 'b', 'c', 'd'], ['b', 'done-1', 'done-2']);
  assert.deepEqual(ids(plan.unfinished), ['a', 'b', 'c']);
  assert.deepEqual(ids(plan.settled), ['done-1', 'done-2']);
  assert.equal(plan.unfinished.length, 3);
});

test('Cal has the same grey eyebrow style, checkboxes stay in front, and the push list is not pinned', () => {
  const cal = between('<section id="calScreen"', '<nav class="bottom-nav">');
  const todo = between('<section id="todoScreen"', '<section id="doneScreen"');
  const done = between('<section id="doneScreen"', '<section id="calScreen"');
  assert.match(cal, /<div class="eyebrow">LOOKING BACK<\/div>\s*<h1>Cal<\/h1>/);
  assert.match(todo, /<div class="eyebrow">WORKSPACE<\/div>\s*<h1>To-do<\/h1>/);
  assert.match(done, /<div class="eyebrow">CLOSED LOOP<\/div>\s*<h1>Done<\/h1>/);
  assert.match(html, /\.phone #calScreen \.eyebrow\{font-size:14px\}/);
  assert.match(html, /row\.append\(check,copy,chevron\)/);
  assert.match(between('function settledTaskRow', 'function renderTodoSettled'), /row\.append\(check,main\)/);
  assert.match(between('function addTaskToList', "document.querySelector('#todoSheet form')"), /row\.append\(check,main\)/);
  assert.match(between('function completeTask', 'document.addEventListener'), /noteSettledTask\(item\.id\)/);
  assert.match(html, /function rollRecommendationDay\(\)/);
  assert.match(html, /recommendationStorageKey\(\)\{return 'lightboat-recommendations-'\+dateKey\(new Date\(\)\)\}/);
  assert.doesNotMatch(html, /todoPinned|position:\s*sticky/);
});

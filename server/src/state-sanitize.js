// Shipped sample records. Ids use seed_ / done_seed_. The sample completions also
// used tiny `completed` values (1, 2, 3) so they never appeared under "today"
// and only the review-required one ("完成周报发送") stayed visible in 待复盘.

const DEMO_IDEAS = new Set([
  '把每周复盘变成一张很短的卡片',
  '给常见任务准备可复用的下一步'
]);

const DEMO_DONE_TITLES = new Set([
  '完成周报发送',
  '整理了一次房间',
  '确认了本周会议时间'
]);

function isSeedId(id) {
  const value = String(id || '');
  return value.startsWith('seed_') || value.startsWith('done_seed_');
}

function ideaText(idea) {
  if (typeof idea === 'string') return idea.trim();
  return String(idea?.text || '').trim();
}

export function isDemoDoneItem(item) {
  if (!item || typeof item !== 'object') return false;
  if (isSeedId(item.id)) return true;
  const completed = Number(item.completed || 0);
  return DEMO_DONE_TITLES.has(String(item.title || '')) && completed > 0 && completed < 1e11;
}

export function sanitizeAppState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.version !== 1) {
    return { state, changed: false };
  }
  const todo = (Array.isArray(state.todo) ? state.todo : []).filter((item) => !isSeedId(item?.id));
  const done = (Array.isArray(state.done) ? state.done : []).filter((item) => !isDemoDoneItem(item));
  const ideas = (Array.isArray(state.ideas) ? state.ideas : []).filter((idea) => !DEMO_IDEAS.has(ideaText(idea)));
  const changed = todo.length !== (Array.isArray(state.todo) ? state.todo.length : 0)
    || done.length !== (Array.isArray(state.done) ? state.done.length : 0)
    || ideas.length !== (Array.isArray(state.ideas) ? state.ideas.length : 0);
  return { state: { ...state, todo, done, ideas }, changed };
}

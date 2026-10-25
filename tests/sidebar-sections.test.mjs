import test from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_WINDOW, readOpen, sidebarSections } from '../src/sidebar-sections.ts';

const now = 10 * REVIEW_WINDOW;
const task = (id, extra = {}) => ({ id, projectId: 'p', createdAt: 1, updatedAt: 1, lastResponseAt: null, taskStage: 'pending', ...extra });
const ids = list => list.map(t => t.id);
const split = (tasks, options = {}) => sidebarSections({
  tasks, now, active: t => Boolean(t.running), stage: t => t.taskStage, ...options,
});

test('puts every task in exactly one section', () => {
  const tasks = [
    task('run', { running: true, taskStage: 'in_progress' }),
    task('fresh', { taskStage: 'review', lastResponseAt: now - 60_000 }),
    task('stale', { taskStage: 'review', lastResponseAt: now - REVIEW_WINDOW - 1 }),
    task('idea'),
    task('done', { taskStage: 'completed', completedAt: now - 5 }),
  ];
  const sections = split(tasks);
  assert.deepEqual(ids(sections.active), ['run']);
  assert.deepEqual(ids(sections.review), ['fresh']);
  assert.deepEqual(ids(sections.rest), ['stale', 'idea']);
  assert.deepEqual(ids(sections.completed), ['done']);
  assert.equal(Object.values(sections).flat().length, tasks.length);
});

test('keeps sidebar order within Active and Needs review', () => {
  const tasks = [task('b', { running: true }), task('a', { running: true }), task('d', { taskStage: 'review', lastResponseAt: now - 2 }), task('c', { taskStage: 'review', lastResponseAt: now - 1 })];
  const sections = split(tasks);
  assert.deepEqual(ids(sections.active), ['b', 'a']);
  assert.deepEqual(ids(sections.review), ['d', 'c']);
});

test('lists completed tasks newest first, and a running completed task stays active', () => {
  const tasks = [
    task('old', { taskStage: 'completed', completedAt: 10 }),
    task('new', { taskStage: 'completed', completedAt: 30 }),
    task('mid', { taskStage: 'completed', completedAt: null, updatedAt: 20 }),
    task('again', { taskStage: 'completed', running: true }),
  ];
  const sections = split(tasks);
  assert.deepEqual(ids(sections.completed), ['new', 'mid', 'old']);
  assert.deepEqual(ids(sections.active), ['again']);
});

test('running threads are Active even when pinned or open; pinned review work stays pinned', () => {
  const tasks = [
    task('pin', { pinned: true, running: true }), task('open', { running: true }),
    task('pinDone', { pinned: true, taskStage: 'completed' }), task('pinReview', { pinned: true, taskStage: 'review', lastResponseAt: now - 1 }),
  ];
  const placed = split(tasks, { selectedId: 'open' });
  assert.deepEqual(ids(placed.active), ['pin', 'open']);
  assert.deepEqual(ids(placed.rest), ['pinReview']);
  assert.deepEqual(ids(placed.completed), ['pinDone']);
});

test('Needs review lists only unseen turns, and a held open thread stays there', () => {
  const tasks = [task('seen', { taskStage: 'review', lastResponseAt: now - 1 }), task('new', { taskStage: 'review', lastResponseAt: now - 1 })];
  const unseen = t => t.id === 'new';
  assert.deepEqual(ids(split(tasks, { unseen }).review), ['new']);
  assert.deepEqual(ids(split(tasks, { unseen, selectedId: 'seen', held: true }).review), ['seen', 'new']);
  assert.deepEqual(ids(split(tasks, { unseen, selectedId: 'new' }).review), []);
});

test('the Completed section reads its open state safely', () => {
  assert.equal(readOpen({ getItem: () => 'true' }, 'k'), true);
  assert.equal(readOpen({ getItem: () => null }, 'k'), false);
  assert.equal(readOpen({ getItem: () => { throw new Error('denied'); } }, 'k'), false);
});

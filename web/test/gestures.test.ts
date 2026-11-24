import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backMode, edgeAxis, isEdgeStart, settingsLeave, settingsOrigin, settingsPageState, swipeBackDecision, swipeDismiss, opensOnPress } from '../client/src/gestures.js';

test('isEdgeStart: only touches within 20 px of the left edge start a swipe back', () => {
  assert.equal(isEdgeStart(0), true);
  assert.equal(isEdgeStart(19.5), true);
  assert.equal(isEdgeStart(20), false);
  assert.equal(isEdgeStart(120), false);
  assert.equal(isEdgeStart(-1), false);
});

test('edgeAxis: right and mostly horizontal swipes back; vertical or leftward moves scroll', () => {
  assert.equal(edgeAxis(5, 2), 'x');
  assert.equal(edgeAxis(3, 3), 'x');
  assert.equal(edgeAxis(2, 5), 'y');
  assert.equal(edgeAxis(-4, 0), 'y');
  assert.equal(edgeAxis(0, 0), 'y');
});

test('swipeBackDecision: past 35 % of the width, or a quick flick', () => {
  const w = 390;
  assert.equal(swipeBackDecision(140, w, 0), true); // 36 %
  assert.equal(swipeBackDecision(130, w, 0), false); // 33 %, slow
  assert.equal(swipeBackDecision(60, w, 0.8), true); // flick
  assert.equal(swipeBackDecision(20, w, 2), false); // too short even if fast
  assert.equal(swipeBackDecision(60, w, 0.45), true);
  assert.equal(swipeBackDecision(60, w, 0.3), false);
  assert.equal(swipeBackDecision(0, w, 1), false);
  assert.equal(swipeBackDecision(200, 0, 0), false);
});

test('backMode: pop entries opened from the list, replace anything else', () => {
  assert.equal(backMode({ fromList: true }), 'pop');
  assert.equal(backMode({ fromList: true, klatchlyLightbox: true }), 'pop');
  assert.equal(backMode(null), 'replace');
  assert.equal(backMode(undefined), 'replace');
  assert.equal(backMode({}), 'replace');
  assert.equal(backMode({ fromList: 'yes' }), 'replace');
  assert.equal(backMode('fromList'), 'replace');
});

test('settingsOrigin: the app path Settings was opened from, else the chat list', () => {
  assert.equal(settingsOrigin({ fromList: true, from: '/demo' }), '/demo');
  assert.equal(settingsOrigin({ fromList: true, from: '/example/0123456789ab' }), '/example/0123456789ab');
  assert.equal(settingsOrigin({ fromList: true, from: '/chat/%21a%3Ab' }), '/chat/%21a%3Ab');
  assert.equal(settingsOrigin({ from: '/' }), '/');
  // No state (link, notification), or nothing usable: the chat list.
  for (const st of [null, undefined, {}, 'x', { from: 42 }, { from: '' }, { from: 'demo' }, { from: '//evil.example/x' }, { from: '/\\evil' }, { from: '/settings' }, { from: '/settings/x' }, { from: `/${'a'.repeat(600)}` }]) {
    assert.equal(settingsOrigin(st), '/', JSON.stringify(st));
  }
  // Settings opened from the list is a list entry: Back pops it.
  assert.equal(backMode({ fromList: true, from: '/demo' }), 'pop');
});

test('Settings pages: Back pops to the menu; leaving goes back past both, or replaces with the origin', () => {
  // Menu opened by the gear from a chat, then a page from the menu.
  const menu = { fromList: true, from: '/chat/x' };
  const page = settingsPageState(menu);
  assert.deepEqual(page, { fromList: true, from: '/chat/x', settingsMenu: 'pop' });
  assert.equal(backMode(page), 'pop');
  assert.deepEqual(settingsLeave(page, false), { go: -2 });
  assert.deepEqual(settingsLeave(menu, true), { go: -1 });
  // The menu came from a link (no state): leaving a page from it replaces it with the chat list.
  const linked = settingsPageState(null);
  assert.deepEqual(linked, { fromList: true, from: '/', settingsMenu: 'replace' });
  assert.deepEqual(settingsLeave(linked, false), { replace: '/' });
  assert.deepEqual(settingsLeave(null, true), { replace: '/' });
  // The page shown beside the menu, chosen in it (wide screen): it took the gear's entry, one step back.
  assert.deepEqual(settingsLeave(menu, false), { go: -1 });
  // A page opened by a link, or a reload that kept only the origin.
  assert.deepEqual(settingsLeave(null, false), { replace: '/' });
  assert.deepEqual(settingsLeave({ from: '/example' }, false), { replace: '/example' });
});

test('swipeDismiss: far enough or quick (lightbox and sheets)', () => {
  assert.equal(swipeDismiss(120, 1000), true);
  assert.equal(swipeDismiss(60, 200), true);
  assert.equal(swipeDismiss(60, 400), false);
  assert.equal(swipeDismiss(40, 100), false);
  assert.equal(swipeDismiss(-200, 100), false);
});

test('opensOnPress: the main mouse button opens a chat row as it goes down; fingers, pens, modifiers and the open row wait for the click', () => {
  const press = { pointerType: 'mouse', button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
  assert.equal(opensOnPress(press, false), true);
  assert.equal(opensOnPress(press, true), false);
  assert.equal(opensOnPress({ ...press, pointerType: 'touch' }, false), false);
  assert.equal(opensOnPress({ ...press, pointerType: 'pen' }, false), false);
  assert.equal(opensOnPress({ ...press, button: 1 }, false), false);
  assert.equal(opensOnPress({ ...press, button: 2 }, false), false);
  for (const k of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey'] as const) assert.equal(opensOnPress({ ...press, [k]: true }, false), false, k);
});

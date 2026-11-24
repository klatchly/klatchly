import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anyRule, hhmm, isHeld, minutesOf, quietSince, ruleFor, validRule, wallClock, windowStart, type QuietRule, type QuietRules } from '../server/quiethours.js';

// Quiet hours, the pure part (server/quiethours.ts): windows, days, time zones, which rule applies, what is held.

const at = (iso: string) => Date.parse(iso);
const rule = (from: string, to: string, days = [0, 1, 2, 3, 4, 5, 6], tz = 'UTC'): QuietRule => ({ from: minutesOf(from)!, to: minutesOf(to)!, days, tz });

test('wall clock in a zone', () => {
  // 2026-11-11 is a Wednesday. 23:30 UTC is 06:30 the next day in Ho Chi Minh City (UTC+7).
  assert.deepEqual(wallClock('UTC', at('2026-11-11T23:30:00Z')), { day: 3, seconds: 23 * 3600 + 30 * 60 });
  assert.deepEqual(wallClock('Asia/Ho_Chi_Minh', at('2026-11-11T23:30:00Z')), { day: 4, seconds: 6 * 3600 + 30 * 60 });
});

test('a window within the day', () => {
  const r = rule('09:00', '17:00');
  assert.equal(windowStart(r, at('2026-11-11T08:59:59Z')), null);
  assert.equal(windowStart(r, at('2026-11-11T09:00:00Z')), at('2026-11-11T09:00:00Z'));
  assert.equal(windowStart(r, at('2026-11-11T12:34:56Z')), at('2026-11-11T09:00:00Z'));
  assert.equal(windowStart(r, at('2026-11-11T17:00:00Z')), null, 'the end is out');
});

test('an overnight window: the evening part, then the morning part from the day before', () => {
  const r = rule('22:00', '07:00');
  assert.equal(windowStart(r, at('2026-11-11T21:59:00Z')), null);
  assert.equal(windowStart(r, at('2026-11-11T23:15:00Z')), at('2026-11-11T22:00:00Z'));
  assert.equal(windowStart(r, at('2026-11-12T06:59:00Z')), at('2026-11-11T22:00:00Z'));
  assert.equal(windowStart(r, at('2026-11-12T07:00:00Z')), null);
});

test('days: a window starts only on its days; the morning part belongs to the day it started', () => {
  // Weekdays only (Mon–Fri). Friday 2026-11-13 22:00 starts one that ends Saturday 07:00; none starts on Saturday.
  const r = rule('22:00', '07:00', [1, 2, 3, 4, 5]);
  assert.equal(windowStart(r, at('2026-11-14T03:00:00Z')), at('2026-11-13T22:00:00Z'), 'Saturday morning: Friday’s window');
  assert.equal(windowStart(r, at('2026-11-14T23:00:00Z')), null, 'Saturday night: none');
  assert.equal(windowStart(r, at('2026-11-15T03:00:00Z')), null, 'Sunday morning: none');
  assert.equal(windowStart(r, at('2026-11-16T03:00:00Z')), null, 'Monday morning: Sunday started none');
  assert.equal(windowStart(r, at('2026-11-16T22:30:00Z')), at('2026-11-16T22:00:00Z'));
});

test('times are the rule’s zone, not the server’s', () => {
  // 22:00–07:00 in Ho Chi Minh City is 15:00–00:00 UTC.
  const r = rule('22:00', '07:00', undefined, 'Asia/Ho_Chi_Minh');
  assert.equal(windowStart(r, at('2026-11-11T14:59:00Z')), null);
  assert.equal(windowStart(r, at('2026-11-11T15:30:00Z')), at('2026-11-11T15:00:00Z'));
  assert.equal(windowStart(r, at('2026-11-11T23:59:00Z')), at('2026-11-11T15:00:00Z'));
  assert.equal(windowStart(r, at('2026-11-12T00:00:00Z')), null);
});

test('which rule applies: the chat’s own, never quiet, else its account’s', () => {
  const rules: QuietRules = { accounts: { wa: rule('22:00', '07:00') }, chats: { own: rule('12:00', '13:00'), never: false } };
  assert.deepEqual(ruleFor(rules, 'x', 'wa'), rules.accounts.wa);
  assert.deepEqual(ruleFor(rules, 'own', 'wa'), rules.chats.own);
  assert.equal(ruleFor(rules, 'never', 'wa'), undefined);
  assert.equal(ruleFor(rules, 'x', 'tg'), undefined);
  assert.equal(ruleFor(rules, 'x', undefined), undefined);
  assert.equal(ruleFor(rules, 'constructor', 'toString'), undefined, 'no prototype keys');
  assert.ok(anyRule(rules));
  assert.ok(!anyRule({ accounts: {}, chats: { a: false } }), 'only "never": no Quiet tab');
});

test('held: quiet, unread, its activity since the window opened (or the last "show them now")', () => {
  const rules: QuietRules = { accounts: { wa: rule('22:00', '07:00') }, chats: {} };
  const now = at('2026-11-12T01:00:00Z');
  const chat = (o: Record<string, unknown>) => ({ id: 'c', accountID: 'wa', unreadCount: 2, lastActivity: '2026-11-12T00:30:00Z', ...o });
  assert.ok(isHeld(rules, chat({}), now));
  assert.ok(!isHeld(rules, chat({ unreadCount: 0 }), now), 'read: back');
  assert.ok(!isHeld(rules, chat({ lastActivity: '2026-11-11T21:00:00Z' }), now), 'unread from before the window: stays in the inbox');
  assert.ok(!isHeld(rules, chat({ accountID: 'tg' }), now), 'another network');
  assert.ok(!isHeld(rules, chat({}), at('2026-11-12T07:00:00Z')), 'window closed: back');
  // "Show them now" at 00:45: what came before is back, what comes after is held again.
  const released = { ...rules, releasedAt: at('2026-11-12T00:45:00Z') };
  assert.ok(!isHeld(released, chat({}), now));
  assert.ok(isHeld(released, chat({ lastActivity: '2026-11-12T00:50:00Z' }), now));
  assert.equal(quietSince(released, 'c', 'wa', now), at('2026-11-12T00:45:00Z'));
});

test('validRule: exact shape, real zone, days normalised', () => {
  assert.deepEqual(validRule({ from: 1320, to: 420, days: [5, 1, 1], tz: 'Europe/Paris' }), { from: 1320, to: 420, days: [1, 5], tz: 'Europe/Paris' });
  for (const bad of [
    null,
    [],
    { from: 1320, to: 1320, days: [1], tz: 'UTC' },
    { from: 1440, to: 0, days: [1], tz: 'UTC' },
    { from: 1.5, to: 0, days: [1], tz: 'UTC' },
    { from: 0, to: 60, days: [], tz: 'UTC' },
    { from: 0, to: 60, days: [7], tz: 'UTC' },
    { from: 0, to: 60, days: [1], tz: 'Mars/Olympus' },
    { from: 0, to: 60, days: [1], tz: '../etc' },
    { from: 0, to: 60, days: [1], tz: 'UTC', extra: 1 },
  ]) assert.equal(validRule(bad), undefined, JSON.stringify(bad));
});

test('hh:mm both ways', () => {
  assert.equal(hhmm(0), '00:00');
  assert.equal(hhmm(22 * 60 + 5), '22:05');
  assert.equal(minutesOf('07:30'), 450);
  for (const bad of ['24:00', '7:30', '07:60', '', 'x']) assert.equal(minutesOf(bad), undefined, bad);
});

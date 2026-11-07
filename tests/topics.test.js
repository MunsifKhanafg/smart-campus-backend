import test from 'node:test';
import assert from 'node:assert/strict';
import { topicState } from '../src/controllers/topicController.js';

// The rule from the project brief: a topic's materials stay locked until its scheduled date.
const NOW = new Date('2026-11-03T10:00:00Z');
const day = (n) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

test('a topic scheduled for the future is "upcoming" (students only see its title and date)', () => {
  assert.equal(topicState({ scheduledDate: day(1) }, NOW), 'upcoming');
});

test('a topic becomes "available" exactly when its scheduled date arrives', () => {
  assert.equal(topicState({ scheduledDate: NOW }, NOW), 'available');
  assert.equal(topicState({ scheduledDate: day(-5) }, NOW), 'available');
});

test('past topics stay available for revision unless the teacher set an end date', () => {
  assert.equal(topicState({ scheduledDate: day(-30) }, NOW), 'available');
  assert.equal(topicState({ scheduledDate: day(-30), availableUntil: day(10) }, NOW), 'available');
  assert.equal(topicState({ scheduledDate: day(-30), availableUntil: day(-1) }, NOW), 'closed');
});

test('an upcoming topic stays upcoming even if it has an end date', () => {
  assert.equal(topicState({ scheduledDate: day(2), availableUntil: day(9) }, NOW), 'upcoming');
});

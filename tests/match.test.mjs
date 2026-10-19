import test from 'node:test';
import assert from 'node:assert/strict';
import { newMatch, recordGame, pointsFor, TARGETS } from '../www/js/engine/match.js';

const sealWin = (w) => ({ winner: w, endReason: 'seals' });
const deckWin = (w) => ({ winner: w, endReason: 'deck' });
const draw = { winner: null, endReason: 'deck' };

test('targets are 7 and 11; anything else falls back to 11', () => {
  assert.deepEqual(TARGETS, [7, 11]);
  assert.equal(newMatch({ target: 7 }).target, 7);
  assert.equal(newMatch({ target: 11 }).target, 11);
  assert.equal(newMatch({ target: 9 }).target, 11);
  assert.equal(newMatch().target, 11);
});

test('points: 2 for sealing both, 1 for a deck win, 0 for a draw, only the winner scores', () => {
  assert.deepEqual(pointsFor(sealWin(0)), [2, 0]);
  assert.deepEqual(pointsFor(sealWin(1)), [0, 2]);
  assert.deepEqual(pointsFor(deckWin(0)), [1, 0]);
  assert.deepEqual(pointsFor(deckWin(1)), [0, 1]);
  assert.deepEqual(pointsFor(draw), [0, 0]);
});

test('the opener alternates every game from the chosen first player', () => {
  for (const first of [0, 1]) {
    const m = newMatch({ target: 11, first });
    const seen = [];
    for (let i = 0; i < 5; i++) {
      seen.push(m.nextFirst);
      recordGame(m, draw);
    }
    assert.deepEqual(seen, [first, 1 - first, first, 1 - first, first]);
  }
});

test('a draw still flips the opener and counts as a game', () => {
  const m = newMatch({ first: 0 });
  recordGame(m, draw);
  assert.equal(m.games, 1);
  assert.equal(m.nextFirst, 1);
  assert.deepEqual(m.scores, [0, 0]);
  assert.equal(m.over, false);
});

test('first to 7 wins the match, and the winner can overshoot', () => {
  const m = newMatch({ target: 7 });
  recordGame(m, sealWin(0)); // 2
  recordGame(m, sealWin(1)); // foe 2
  recordGame(m, sealWin(0)); // 4
  recordGame(m, deckWin(0)); // 5
  recordGame(m, deckWin(1)); // foe 3
  assert.equal(m.over, false);
  recordGame(m, sealWin(0)); // 7
  assert.equal(m.over, true);
  assert.equal(m.winner, 0);
  assert.deepEqual(m.scores, [7, 3]);
  const m2 = newMatch({ target: 7 });
  for (const w of [0, 0, 0]) recordGame(m2, sealWin(w)); // 6
  recordGame(m2, sealWin(0)); // 8
  assert.equal(m2.over, true);
  assert.deepEqual(m2.scores, [8, 0]);
});

test('first to 11 wins; the foe can win too', () => {
  const m = newMatch({ target: 11 });
  for (let i = 0; i < 5; i++) recordGame(m, sealWin(1)); // 10
  assert.equal(m.over, false);
  recordGame(m, deckWin(1)); // 11
  assert.equal(m.over, true);
  assert.equal(m.winner, 1);
});

test('a finished match ignores further games', () => {
  const m = newMatch({ target: 7 });
  for (let i = 0; i < 4; i++) recordGame(m, sealWin(0)); // 8
  const snap = JSON.stringify(m);
  recordGame(m, sealWin(1));
  assert.equal(JSON.stringify(m), snap);
});

test('history keeps who opened each game', () => {
  const m = newMatch({ target: 11, first: 1 });
  recordGame(m, sealWin(0));
  recordGame(m, deckWin(1));
  assert.deepEqual(m.history.map((h) => h.first), [1, 0]);
  assert.deepEqual(m.history.map((h) => h.points), [[2, 0], [0, 1]]);
});

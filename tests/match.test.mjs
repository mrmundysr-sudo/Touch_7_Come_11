import test from 'node:test';
import assert from 'node:assert/strict';
import { newMatch, recordGame, pointsFor, TARGETS } from '../www/js/engine/match.js';
import { seeded } from '../www/js/engine/cards.js';
import { newGame, endTurn, previewEnd, forceLegal, runStep } from '../www/js/engine/rules.js';
import { planTurn } from '../www/js/engine/ai.js';

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

// ---- consolation point: a seal-out loser who still holds one seal gets 1 point ----
const SEVEN = 1, ELEVEN = 2;
const sealOut = (w, done) => ({ winner: w, endReason: 'seals', done });

test('seal-out loss with one seal held earns the loser 1 point; with none it earns 0', () => {
  assert.deepEqual(pointsFor(sealOut(0, [3, SEVEN])), [2, 1]);
  assert.deepEqual(pointsFor(sealOut(0, [3, ELEVEN])), [2, 1]);
  assert.deepEqual(pointsFor(sealOut(0, [3, 0])), [2, 0]);
  assert.deepEqual(pointsFor(sealOut(1, [SEVEN, 3])), [1, 2]);
  assert.deepEqual(pointsFor(sealOut(1, [0, 3])), [0, 2]);
});

test('the consolation point is capped at 1 and needs the done mask', () => {
  assert.deepEqual(pointsFor(sealOut(0, [3, 3])), [2, 1]);
  assert.deepEqual(pointsFor({ winner: 0, endReason: 'seals' }), [2, 0]);
});

test('deck-out games never give a consolation point, whatever is held', () => {
  assert.deepEqual(pointsFor({ winner: 0, endReason: 'deck', done: [SEVEN, ELEVEN] }), [1, 0]);
  assert.deepEqual(pointsFor({ winner: 1, endReason: 'deck', done: [SEVEN, SEVEN] }), [0, 1]);
  assert.deepEqual(pointsFor({ winner: null, endReason: 'deck', done: [SEVEN, SEVEN] }), [0, 0]);
});

test('both players can score in the same game and the scores accumulate', () => {
  const m = newMatch({ target: 11 });
  recordGame(m, sealOut(0, [3, SEVEN]));
  recordGame(m, sealOut(1, [ELEVEN, 3]));
  recordGame(m, sealOut(0, [3, 0]));
  assert.deepEqual(m.scores, [5, 3]);
  assert.deepEqual(m.history.map((h) => h.points), [[2, 1], [1, 2], [2, 0]]);
});

test('both reaching the target in the same game: the higher total wins', () => {
  const m = newMatch({ target: 7 });
  m.scores = [6, 5];
  recordGame(m, sealOut(0, [3, SEVEN])); // 8 - 6
  assert.equal(m.over, true);
  assert.equal(m.winner, 0);
  assert.equal(m.suddenDeath, false);
  const m2 = newMatch({ target: 7 });
  m2.scores = [6, 5];
  recordGame(m2, sealOut(1, [SEVEN, 3])); // 7 - 7 -> level
  assert.equal(m2.over, false);
});

test('level at or past the target means sudden death until someone leads', () => {
  const m = newMatch({ target: 7 });
  m.scores = [6, 5];
  recordGame(m, sealOut(1, [SEVEN, 3])); // 7 - 7
  assert.equal(m.over, false);
  assert.equal(m.suddenDeath, true);
  recordGame(m, draw); // still level
  assert.equal(m.over, false);
  assert.equal(m.suddenDeath, true);
  recordGame(m, deckWin(1)); // 7 - 8
  assert.equal(m.over, true);
  assert.equal(m.winner, 1);
  assert.equal(m.suddenDeath, false);
});

test('a sudden-death round can be decided by the consolation point alone', () => {
  const m = newMatch({ target: 7 });
  m.scores = [6, 6];
  recordGame(m, sealOut(0, [3, ELEVEN])); // 8 - 7
  assert.equal(m.over, true);
  assert.equal(m.winner, 0);
});

// ---- AI mirror matches: they always finish, and the round counts are sane ----
function playRound(seed, first) {
  const rng = seeded(seed);
  const P = { wOpp: 0.6, oppSeal: 12, ownSeal: 12, forceRefill: 0 };
  const g = newGame({ rng, first, lockBreak: true });
  let guard = 0;
  while (!g.over && guard++ < 400) {
    const p = g.turn;
    const { plan } = planTurn(g, p, P, 'professional', rng);
    for (const m of plan) assert.ok(runStep(g, m).ok);
    if (!previewEnd(g).legal) forceLegal(g);
    assert.ok(endTurn(g, { rng, force: true }).ok);
  }
  assert.ok(g.over, 'round must finish');
  return g;
}

test('AI mirror matches to 7 and 11 always finish; report round counts and sudden deaths', () => {
  for (const target of [7, 11]) {
    let rounds = 0, longest = 0, sudden = 0, consolations = 0, n = 40;
    for (let k = 0; k < n; k++) {
      const m = newMatch({ target, first: k % 2 });
      let seed = 90000 + k * 100;
      while (!m.over) {
        assert.ok(m.games < 60, 'a match should not run away');
        const g = playRound(seed++, m.nextFirst);
        recordGame(m, { winner: g.winner, endReason: g.endReason, done: g.done });
        if (m.suddenDeath) sudden++;
      }
      rounds += m.games; longest = Math.max(longest, m.games);
      consolations += m.history.filter((h) => h.points[0] + h.points[1] === 3).length;
      assert.ok(m.scores[m.winner] > m.scores[1 - m.winner], 'the winner leads');
      assert.ok(m.scores[m.winner] >= target);
    }
    console.log(`  to ${target}: avg ${(rounds / n).toFixed(1)} rounds, longest ${longest}, sudden-death rounds ${sudden}, consolation points ${consolations}`);
  }
});

test('a double seal-out (opener + matching reply) scores 2 each, whoever opened', () => {
  assert.deepEqual(pointsFor({ winner: null, endReason: 'double' }), [2, 2]);
  assert.deepEqual(pointsFor({ winner: null, endReason: 'double', done: [3, 3] }), [2, 2]);
  const m = newMatch({ target: 7, first: 0 });
  recordGame(m, { winner: null, endReason: 'double' });
  assert.deepEqual(m.scores, [2, 2]);
  assert.equal(m.games, 1);
  assert.equal(m.nextFirst, 1, 'the opener still alternates');
  assert.equal(m.over, false);
});

test('double seal-outs can leave the match level at the target: sudden death, then a lead wins', () => {
  const m = newMatch({ target: 7, first: 0 });
  for (let i = 0; i < 4; i++) recordGame(m, { winner: null, endReason: 'double' });
  assert.deepEqual(m.scores, [8, 8]);
  assert.equal(m.over, false);
  assert.equal(m.suddenDeath, true);
  recordGame(m, { winner: 1, endReason: 'seals', done: [0, 3] });
  assert.equal(m.over, true);
  assert.equal(m.winner, 1);
});

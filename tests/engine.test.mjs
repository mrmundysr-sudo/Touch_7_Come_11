import test from 'node:test';
import assert from 'node:assert/strict';
import { cardId, seeded, is13, valueOf } from '../www/js/engine/cards.js';
import { applyFull } from '../www/js/engine/core.js';
import { newGame, playCard, endTurn, previewEnd, canPlay, forceLegal, lockPair, unlockPair, lockOptions, runStep } from '../www/js/engine/rules.js';
import { planTurn } from '../www/js/engine/ai.js';

const SUN = 0, BLOOM = 1, MOON = 2, THORN = 3;
const c = (suit, rank) => cardId(suit, rank);

/** Build a custom state: piles are arrays of card ids (bottom->top). */
function mk({ piles, hands = [[], []], turn = 0, lb, done = [0, 0], deck = [], discard = [], lockBreak = true }) {
  const full = piles.slice();
  while (full.length < 8) full.push([c(SUN, 1)]);
  return {
    piles: full, lb: lb || new Array(8).fill(0), done, hands, deck, discard, turn, first: turn, plays: 0,
    turns: [0, 0], reshuffles: 0, over: false, winner: null, endReason: null, lockBreak, redeals: 0, openSeals: [],
    stats: { busts: [0, 0], seals: [0, 0], breaks: [0, 0] },
  };
}

test('card values: positive suits add, negative subtract, 13 has no value', () => {
  assert.equal(valueOf(c(SUN, 5)), 5);
  assert.equal(valueOf(c(BLOOM, 12)), 12);
  assert.equal(valueOf(c(MOON, 5)), -5);
  assert.equal(valueOf(c(THORN, 1)), -1);
  assert.equal(valueOf(c(SUN, 13)), 0);
  assert.ok(is13(c(THORN, 13)));
});

test('deal: 4 piles + 4-card hand each, 36 left, never a 13 on top, nothing starts locked', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const g = newGame({ rng: seeded(seed) });
    assert.equal(g.deck.length + g.piles.flat().length + g.hands.flat().length, 52);
    assert.equal(g.hands[0].length, 4);
    assert.equal(g.hands[1].length, 4);
    for (const p of g.piles) assert.ok(p.length >= 1 && !is13(p[p.length - 1]));
    assert.deepEqual(g.done, [0, 0]);
    assert.ok(g.lb.every((v) => v === 0));
  }
});

test('every card goes on top; tuck is no longer a mode', () => {
  const s = mk({ piles: [[c(SUN, 3)]], hands: [[c(BLOOM, 4), c(MOON, 2)], []] });
  assert.equal(canPlay(s, c(BLOOM, 4), 0, 'tuck'), false);
  assert.ok(playCard(s, c(BLOOM, 4), 0, 'cover').ok);
  assert.ok(playCard(s, c(MOON, 2), 0, 'cover').ok);
  assert.deepEqual(s.piles[0], [c(SUN, 3), c(BLOOM, 4), c(MOON, 2)]);
});

test('13 on a pile busts the whole pile into the discard', () => {
  const s = mk({ piles: [[c(SUN, 3), c(BLOOM, 5), c(MOON, 2)]], hands: [[c(THORN, 13)], []] });
  const r = playCard(s, c(THORN, 13), 0, 'cover');
  assert.ok(r.ok);
  assert.deepEqual(s.piles[0], []);
  assert.equal(s.discard.length, 4);
  assert.ok(r.events.some((e) => e.t === 'bust' && e.force === THORN));
});

test('a 13 may start an empty pile (base), and a card played on it hides it without busting', () => {
  const s = mk({ piles: [[]], hands: [[c(SUN, 13), c(BLOOM, 4)], []] });
  assert.ok(playCard(s, c(SUN, 13), 0, 'cover').ok);
  assert.deepEqual(s.piles[0], [c(SUN, 13)]);
  assert.ok(playCard(s, c(BLOOM, 4), 0, 'cover').ok);
  assert.deepEqual(s.piles[0], [c(SUN, 13), c(BLOOM, 4)]);
  assert.equal(s.discard.length, 0);
});

test('end of turn: 13 left on top is illegal; covering it makes it legal', () => {
  const s = mk({ piles: [[]], hands: [[c(SUN, 13), c(SUN, 6)], []] });
  playCard(s, c(SUN, 13), 0, 'cover');
  playCard(s, c(SUN, 6), 3, 'cover');
  assert.equal(previewEnd(s).legal, false);
  assert.equal(previewEnd(s).reason, 'force-on-top');
  const s2 = mk({ piles: [[]], hands: [[c(SUN, 13), c(SUN, 6)], []] });
  playCard(s2, c(SUN, 13), 0, 'cover');
  playCard(s2, c(SUN, 6), 0, 'cover');
  assert.equal(previewEnd(s2).legal, true);
});

test('own empty pile must be refilled before ending the turn', () => {
  const s = mk({ piles: [[c(SUN, 2), c(SUN, 3)]], hands: [[c(MOON, 13), c(BLOOM, 1)], []] });
  playCard(s, c(MOON, 13), 0, 'cover');            // busts own pile -> empty
  playCard(s, c(BLOOM, 1), 5, 'cover');            // plays elsewhere
  const pv = previewEnd(s);
  assert.equal(pv.legal, false);
  assert.equal(pv.reason, 'empty-pile');
});

test('a pile emptied by the opponent may stay empty through MY end of turn only if it is theirs', () => {
  const s = mk({ piles: [[c(SUN, 5)], [c(SUN, 4)], [c(SUN, 9)], [c(SUN, 8)], [c(SUN, 2), c(SUN, 3)]], hands: [[c(MOON, 13)], []] });
  playCard(s, c(MOON, 13), 4, 'cover');            // bust opponent's pile
  const pv = previewEnd(s);
  assert.equal(pv.legal, true, 'opponent empty pile is their job to refill');
});

test('nothing locks by itself: ending a turn with a 7 pair showing does not seal it', () => {
  const s = mk({ piles: [[c(SUN, 3)], [c(BLOOM, 4)], [c(SUN, 9)], [c(SUN, 1)]], hands: [[], []], deck: [1, 2, 3, 4, 5, 6, 7, 8] });
  assert.ok(endTurn(s, {}).ok);
  assert.equal(s.done[0], 0);
  assert.deepEqual(s.lb, new Array(8).fill(0));
});

test('LOCK: the player chooses a pair that adds to 7 or 11; empty pile counts as 0', () => {
  const s = mk({ piles: [[c(SUN, 3)], [c(BLOOM, 4)], [c(SUN, 9)], [c(SUN, 1)]], hands: [[], []] });
  assert.deepEqual(lockOptions(s).map((o) => [o.piles.join(), o.value]), [['0,1', 7]]);
  assert.equal(lockPair(s, [0, 2], 1).ok, false, '3 + 9 is not 7');
  assert.equal(lockPair(s, [0, 1], 2).ok, false, 'a 7 pair cannot lock the 11');
  assert.equal(lockPair(s, [4, 5], 1).ok, false, "cannot lock the opponent's piles");
  const r = lockPair(s, [0, 1], 1);
  assert.ok(r.ok);
  assert.ok(r.events.some((e) => e.t === 'seal' && e.value === 7));
  assert.equal(s.done[0], 1);
  assert.deepEqual(s.lb.slice(0, 4), [1, 1, 0, 0]);
  assert.equal(lockPair(s, [0, 1], 1).ok, false, 'already locked');
  const z = mk({ piles: [[], [c(SUN, 7)], [c(SUN, 9)], [c(MOON, 2)]], hands: [[], []] });
  assert.ok(lockPair(z, [0, 1], 1).ok, 'empty pile (0) + 7');
  const z2 = mk({ piles: [[], [], [c(SUN, 9)], [c(SUN, 3)]], hands: [[], []] });
  assert.equal(lockOptions(z2).length, 0);
  assert.equal(previewEnd(z2).legal, false, 'two empty piles still block the end of the turn');
});

test('LOCK: a pile with a 13 on top cannot be locked', () => {
  const s = mk({ piles: [[c(SUN, 3)], [c(BLOOM, 4), c(THORN, 13)], [c(SUN, 9)], [c(SUN, 1)]], hands: [[], []] });
  assert.equal(lockOptions(s).length, 0);
});

test('UNLOCK: a player can free their own pair on their turn, any number of times, then play on it', () => {
  const s = mk({ piles: [[c(SUN, 3)], [c(BLOOM, 4)], [c(SUN, 9)], [c(SUN, 1)]], hands: [[c(SUN, 2)], []] });
  assert.ok(lockPair(s, [0, 1], 1).ok);
  assert.equal(canPlay(s, c(SUN, 2), 0, 'cover'), false, 'locked piles are frozen');
  for (let k = 0; k < 3; k++) {
    const u = unlockPair(s, 1);
    assert.ok(u.ok);
    assert.ok(u.events.some((e) => e.t === 'unlock' && e.bit === 1));
    assert.equal(s.done[0], 0);
    assert.deepEqual(s.lb, new Array(8).fill(0));
    assert.deepEqual(s.piles[0], [c(SUN, 3)], 'cards stay where they were');
    assert.ok(lockPair(s, [0, 1], 1).ok);
  }
  assert.ok(unlockPair(s, 1).ok);
  assert.equal(unlockPair(s, 1).ok, false, 'nothing left to unlock');
  assert.equal(unlockPair(s, 2).ok, false, 'the 11 was never locked');
  assert.ok(playCard(s, c(SUN, 2), 0, 'cover').ok);
});

test('lock and unlock only work on your own turn, and only on your own piles', () => {
  const s = mk({ piles: [[c(SUN, 3)], [c(BLOOM, 4)]], hands: [[], []], turn: 1 });
  s.piles[4] = [c(SUN, 3)]; s.piles[5] = [c(BLOOM, 4)];
  assert.equal(lockPair(s, [0, 1], 1).ok, false, "it is the opponent's turn, so player 0's piles are not theirs");
  assert.ok(lockPair(s, [4, 5], 1).ok);
  s.turn = 0;
  assert.equal(unlockPair(s, 1).ok, false, "cannot unlock the opponent's pair");
});

test('both targets locked wins when the turn ends (not before)', () => {
  const s = mk({ piles: [[c(SUN, 3)], [c(BLOOM, 4)], [c(SUN, 6)], [c(BLOOM, 5)]], hands: [[], []] });
  assert.ok(lockPair(s, [0, 1], 1).ok);
  assert.equal(s.over, false);
  assert.ok(lockPair(s, [2, 3], 2).ok);
  assert.equal(s.over, false, 'locking alone never ends the game');
  assert.equal(previewEnd(s).win, true);
  const r = endTurn(s, {});
  assert.ok(r.ok);
  assert.equal(s.over, true);
  assert.equal(s.winner, 0);
  const t = mk({ piles: [[c(SUN, 3)], [c(BLOOM, 4)], [c(SUN, 6)], [c(BLOOM, 5)]], hands: [[], [c(SUN, 2)]], deck: [1, 2, 3, 4, 5, 6, 7, 8] });
  lockPair(t, [0, 1], 1); lockPair(t, [2, 3], 2); unlockPair(t, 2);
  assert.ok(endTurn(t, {}).ok);
  assert.equal(t.over, false, 'unlocking before ending takes the win away');
});

test('locked piles satisfy the end-of-turn rules (an empty locked pile is fine)', () => {
  const s = mk({ piles: [[], [c(SUN, 7)], [c(SUN, 9)], [c(MOON, 2)]], hands: [[], []] });
  assert.equal(previewEnd(s).legal, false);
  lockPair(s, [0, 1], 1);
  assert.equal(previewEnd(s).legal, true);
});

test('runStep runs AI plan steps', () => {
  const s = mk({ piles: [[c(SUN, 3)], [c(BLOOM, 4)], [c(SUN, 9)], [c(SUN, 1)]], hands: [[c(SUN, 2)], []] });
  assert.ok(runStep(s, { type: 'play', card: c(SUN, 2), pile: 2, mode: 'cover' }).ok);
  assert.ok(runStep(s, { type: 'lock', piles: [0, 1], bit: 1 }).ok);
  assert.ok(runStep(s, { type: 'unlock', bit: 1 }).ok);
});

test('seals are frozen: normal cards cannot go on a sealed pile', () => {
  const s = mk({ piles: [[c(SUN, 3)], [c(BLOOM, 4)]], lb: [1, 1, 0, 0, 0, 0, 0, 0], done: [1, 0], hands: [[c(SUN, 2)], []] });
  assert.equal(canPlay(s, c(SUN, 2), 0, 'cover'), false);
  assert.equal(canPlay(s, c(SUN, 2), 0, 'tuck'), false);
});

test('LOCK-BREAKING: a 13 on a sealed pile busts only that pile, partner stays intact and goes live', () => {
  const s = mk({ piles: [[c(SUN, 3)], [c(BLOOM, 4)], [c(SUN, 9)], [c(SUN, 8)]], lb: [1, 1, 0, 0, 0, 0, 0, 0], done: [1, 0], turn: 1, hands: [[], [c(MOON, 13), c(SUN, 1)]] });
  const r = playCard(s, c(MOON, 13), 0, 'cover');
  assert.ok(r.ok);
  assert.deepEqual(s.piles[0], []);
  assert.deepEqual(s.piles[1], [c(BLOOM, 4)]);
  assert.deepEqual(s.lb.slice(0, 4), [0, 0, 0, 0]);
  assert.equal(s.done[0], 0);
  assert.ok(r.events.some((e) => e.t === 'unseal'));
  assert.equal(canPlay(s, c(SUN, 1), 1, 'cover'), true, 'former partner is a normal live pile again');
});

test('lock-breaking can be switched off', () => {
  const s = mk({ piles: [[c(SUN, 3)], [c(BLOOM, 4)]], lb: [1, 1, 0, 0, 0, 0, 0, 0], done: [1, 0], turn: 1, hands: [[], [c(MOON, 13)]], lockBreak: false });
  assert.equal(canPlay(s, c(MOON, 13), 0, 'cover'), false);
});

test('hand refills to 4 at end of turn, discard reshuffles into the deck when it runs dry', () => {
  const s = mk({ piles: [[c(SUN, 3)]], hands: [[], [c(SUN, 2), c(SUN, 5), c(SUN, 6), c(SUN, 7)]], deck: [c(MOON, 1)], discard: [c(MOON, 2), c(MOON, 3), c(MOON, 4), c(MOON, 5), c(MOON, 6)] });
  const r = endTurn(s, { rng: seeded(5) });
  assert.ok(r.ok);
  assert.equal(s.hands[0].length, 4);
  assert.equal(s.reshuffles, 1);
  assert.ok(r.events.some((e) => e.t === 'reshuffle'));
});

test('game ends and is scored when the next player has no cards left', () => {
  const s = mk({ piles: [[c(SUN, 3)]], hands: [[], []], deck: [], discard: [] });
  const r = endTurn(s, {});
  assert.ok(r.ok);
  assert.equal(s.over, true);
  assert.equal(s.endReason, 'deck');
});

test('applyFull never mutates its inputs', () => {
  const piles = [[c(SUN, 3)], [c(SUN, 4)], [], [], [], [], [], []];
  const lb = new Array(8).fill(0); const done = [0, 0];
  const snap = JSON.stringify([piles, lb, done]);
  applyFull(piles, lb, done, c(MOON, 13), 0, 'cover');
  applyFull(piles, lb, done, c(MOON, 5), 1, 'cover');
  assert.equal(JSON.stringify([piles, lb, done]), snap);
});

// ------------------------------------------------------------------ AI full games
function playFullGame(seed, diffs, personas, lockBreak = true) {
  const rng = seeded(seed);
  const g = newGame({ rng, first: 'random', lockBreak });
  let guard = 0, fallbacks = 0, turnsTaken = 0;
  while (!g.over && guard++ < 400) {
    const p = g.turn;
    const { plan, legal } = planTurn(g, p, personas[p], diffs[p], rng);
    for (const m of plan) {
      const r = runStep(g, m);
      assert.ok(r.ok, `AI produced an illegal step (seed ${seed})`);
    }
    if (!previewEnd(g).legal) { fallbacks++; forceLegal(g); }
    const e = endTurn(g, { rng, force: true });
    assert.ok(e.ok, 'a turn must always be able to end');
    turnsTaken++;
  }
  return { g, fallbacks, turnsTaken, guard };
}

test('AI plays complete, legal games to a finish (all difficulties)', () => {
  const P = { wOpp: 0.6, oppSeal: 12, ownSeal: 12, forceRefill: 0.2 };
  for (const d of ['beginner', 'experienced', 'professional']) {
    let over = 0, plays = 0, fb = 0, n = 40;
    for (let s = 1; s <= n; s++) {
      const r = playFullGame(1000 * s + 7, [d, d], [P, P]);
      assert.ok(r.guard < 399, 'game should not run away');
      if (r.g.over) over++;
      plays += r.turnsTaken; fb += r.fallbacks;
    }
    assert.equal(over, n, `${d}: every game must reach a result`);
    console.log(`  ${d.padEnd(13)} mirror: avg turns ${(plays / n).toFixed(1)}  fallback turns ${fb}`);
  }
});

test('AI mirror games finish in a sensible number of turns (player-chosen locks, lock-breaking on)', () => {
  const P = { wOpp: 0.6, oppSeal: 12, ownSeal: 12, forceRefill: 0 };
  let plays = 0, deckouts = 0, long = 0, first = 0, n = 120, fb = 0;
  for (let s = 1; s <= n; s++) {
    const r = playFullGame(50000 + s, ['professional', 'professional'], [P, P]);
    plays += r.turnsTaken; fb += r.fallbacks;
    if (r.g.endReason === 'deck') deckouts++;
    if (r.turnsTaken >= 10) long++;
    if (r.g.winner === r.g.first) first++;
  }
  console.log(`  pro mirror: avg total turns ${(plays / n).toFixed(1)} (python: 9.9), >=10 turns ${(100 * long / n).toFixed(0)}% (python: 26%), deck-outs ${(100 * deckouts / n).toFixed(0)}%, first player wins ${(100 * first / n).toFixed(0)}%, fallbacks ${fb}`);
  assert.ok(plays / n > 5 && plays / n < 16);
});

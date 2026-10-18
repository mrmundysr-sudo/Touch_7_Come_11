// Touch 7 Come 11 - game state machine (rules as finalised in the rulebook, plus lock-breaking).
// Player 0 is the human, player 1 is the opponent. Everything here is pure game logic (no DOM, no audio),
// so the same code is unit-tested in Node and drives the real game.
import { freshDeck, shuffle, suitOf, topIs13 } from './cards.js';
import {
  HAND_SIZE, POP, applyFull, bestSealOption, endCandidatesCore, ownPiles, playerDistance, sealOptions,
} from './core.js';

export { HAND_SIZE };

export function newGame({ rng = Math.random, first = 'random', lockBreak = true } = {}) {
  let redeals = 0;
  for (;;) {
    const deck = freshDeck(rng);
    const piles = Array.from({ length: 8 }, () => [deck.pop()]);
    const hands = [[], []];
    for (let p = 0; p < 2; p++) for (let k = 0; k < HAND_SIZE; k++) hands[p].push(deck.pop());
    for (let i = 0; i < 8; i++) while (topIs13(piles[i])) piles[i].push(deck.pop()); // a dealt 13 is covered
    const lb = new Array(8).fill(0);
    const done = [0, 0];
    let tooGood = false;
    const openSeals = [];
    for (let p = 0; p < 2; p++) {
      const info = sealOptions(piles, lb, done, p);
      if (info.rem && info.rem.length === 2 && info.win && info.win.length === 2) { tooGood = true; break; }
      const pick = bestSealOption(info, rng);
      if (pick) {
        for (const i of pick.piles) lb[i] = pick.bit;
        done[p] |= pick.bit;
        openSeals.push({ player: p, piles: pick.piles, bit: pick.bit, value: pick.value });
      }
    }
    if (tooGood) { redeals++; continue; }
    const turn = first === 'random' ? (rng() < 0.5 ? 0 : 1) : first;
    return {
      piles, lb, done, hands, deck, discard: [], turn, first: turn, plays: 0, turns: [0, 0], reshuffles: 0,
      over: false, winner: null, endReason: null, lockBreak, redeals, openSeals,
      stats: { busts: [0, 0], seals: [0, 0], breaks: [0, 0], tucks: [0, 0] },
    };
  }
}

export const snapshot = (s) => JSON.parse(JSON.stringify(s));
export function restore(state, snap) {
  const copy = JSON.parse(JSON.stringify(snap));
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, copy);
}

/** Is it legal to play `card` on `pile` in `mode` right now?  (UI helper; does not change anything.) */
export function canPlay(state, card, pile, mode) {
  return !state.over && applyFull(state.piles, state.lb, state.done, card, pile, mode, state.lockBreak) !== null;
}

/** For the highlight logic: every {pile, modes[]} where `card` could go. */
export function playTargets(state, card) {
  const out = [];
  for (let pile = 0; pile < 8; pile++) {
    const modes = ['cover', 'tuck'].filter((m) => canPlay(state, card, pile, m));
    if (modes.length) out.push({ pile, modes });
  }
  return out;
}

/** Play a card from the current player's hand. Returns {ok, events} - events drive animation and sound. */
export function playCard(state, card, pile, mode) {
  if (state.over) return { ok: false, reason: 'over', events: [] };
  const p = state.turn;
  const hi = state.hands[p].indexOf(card);
  if (hi < 0) return { ok: false, reason: 'not-in-hand', events: [] };
  const r = applyFull(state.piles, state.lb, state.done, card, pile, mode, state.lockBreak);
  if (!r) return { ok: false, reason: 'illegal', events: [] };
  state.hands[p].splice(hi, 1);
  const events = [];
  const before = state.piles[pile].length;
  state.piles = r.piles;
  state.lb = r.lb;
  state.done = r.done;
  if (r.discarded.length) state.discard.push(...r.discarded);
  events.push({ t: 'place', player: p, card, pile, mode, kind: r.kind, handIndex: hi, depthBefore: before });
  if (r.kind === 'tuck') state.stats.tucks[p]++;
  if (r.kind === 'bust') {
    state.stats.busts[p]++;
    events.push({ t: 'bust', player: p, card, pile, force: suitOf(card), discarded: r.discarded, owner: pile >> 2 });
    if (r.broke) {
      state.stats.breaks[p]++;
      events.push({ t: 'unseal', player: p, owner: r.broke.owner, piles: r.broke.piles, bit: r.broke.bit, cracked: pile });
    }
  }
  state.plays++;
  return { ok: true, events };
}

function endCandidates(state) {
  return endCandidatesCore(state.piles, state.lb, state.done, state.turn);
}

/** Safety valve preview: same seals, but ignore the "no empty pile / no 13 on top" requirements. */
function forcedPreview(state) {
  const info = sealOptions(state.piles, state.lb, state.done, state.turn);
  let cands;
  if (info.win) cands = [{ seals: info.win, win: true }];
  else if (info.options.length) cands = info.options.map((o) => ({ seals: [o], win: false }));
  else cands = [{ seals: [], win: false }];
  return { legal: true, reason: null, choices: cands, needsChoice: false, win: cands[0].win };
}

/** What would happen if the player ended their turn now? (UI helper) */
export function previewEnd(state) {
  const p = state.turn;
  if (state.over) return { legal: false, reason: 'over' };
  if (state.hands[p].length > 0) return { legal: false, reason: 'cards-left' };
  const { legal, reason } = endCandidates(state);
  if (!legal.length) return { legal: false, reason };
  return { legal: true, reason: null, choices: legal, needsChoice: legal.length > 1 && !legal[0].win, win: legal[0].win };
}

/** Finish the turn: seal pairs, check the win, refill the hand, hand over to the other player. */
export function endTurn(state, { choice = null, rng = Math.random, force = false } = {}) {
  const p = state.turn;
  const events = [];
  let pv = previewEnd(state);
  if (!pv.legal && force && state.hands[p].length === 0) pv = forcedPreview(state);
  if (!pv.legal) return { ok: false, reason: pv.reason, events };
  let pick = choice != null ? pv.choices[choice] : null;
  if (!pick) {
    if (pv.choices.length === 1 || pv.win) pick = pv.choices[0];
    else {
      const best = bestSealOption({ ...sealOptions(state.piles, state.lb, state.done, p), options: pv.choices.map((c) => c.seals[0]) }, rng);
      pick = pv.choices.find((c) => c.seals[0] === best) || pv.choices[0];
    }
  }
  for (const o of pick.seals) {
    for (const i of o.piles) state.lb[i] = o.bit;
    state.done[p] |= o.bit;
    state.stats.seals[p]++;
    events.push({ t: 'seal', player: p, piles: o.piles, bit: o.bit, value: o.value });
  }
  state.turns[p]++;
  if (state.done[p] === 3) {
    state.over = true; state.winner = p; state.endReason = 'seals';
    events.push({ t: 'gameover', winner: p, reason: 'seals' });
    return { ok: true, events };
  }
  // refill the hand
  const drawn = [];
  const hand = state.hands[p];
  while (hand.length < HAND_SIZE) {
    if (!state.deck.length) {
      if (state.discard.length) {
        state.deck = shuffle(state.discard.splice(0), rng);
        state.reshuffles++;
        events.push({ t: 'reshuffle' });
      } else break;
    }
    const c = state.deck.pop();
    hand.push(c);
    drawn.push(c);
  }
  events.push({ t: 'draw', player: p, cards: drawn });
  state.turn = 1 - p;
  events.push({ t: 'turn', player: state.turn });
  if (!state.hands[state.turn].length) finishByDeck(state, events);
  return { ok: true, events };
}

function finishByDeck(state, events) {
  state.over = true;
  state.endReason = 'deck';
  const score = (p) => [POP[state.done[p]], -playerDistance(state.piles, state.lb, state.done, p)];
  const a = score(0);
  const b = score(1);
  if (a[0] !== b[0]) state.winner = a[0] > b[0] ? 0 : 1;
  else if (a[1] !== b[1]) state.winner = a[1] > b[1] ? 0 : 1;
  else state.winner = null;
  events.push({ t: 'gameover', winner: state.winner, reason: 'deck' });
}

/** Safety valve: if the player truly cannot finish (should be vanishingly rare), release stray 13s. */
export function forceLegal(state) {
  const events = [];
  for (let i = 0; i < 8; i++) {
    if (state.lb[i]) continue;
    while (topIs13(state.piles[i])) {
      const c = state.piles[i].pop();
      state.discard.push(c);
      events.push({ t: 'forced', pile: i, card: c });
    }
  }
  return events;
}

export function livePiles(state, p) {
  return ownPiles(p).filter((i) => !state.lb[i]);
}

export function sealedTargets(state, p) {
  return { seven: !!(state.done[p] & 1), eleven: !!(state.done[p] & 2) };
}

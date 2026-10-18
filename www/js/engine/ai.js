// Opponent AI: beam search over the 4 cards of a turn, scored by a "personality" evaluation.
// The AI only ever looks at what a human could see (the top cards) plus its own hand.
import { is13, topIs13, topValue } from './cards.js';
import { POP, applyFull, distance, endCandidatesCore, ownPiles, remainingTargets } from './core.js';

/** How strong the opponent plays. width = search breadth, sloppy = chance to settle for a worse plan. */
export const DIFFICULTIES = {
  beginner: { width: 14, sloppy: 0.4, topK: 7, oppMul: 0.35, noise: 0.5 },
  experienced: { width: 60, sloppy: 0.12, topK: 3, oppMul: 0.85, noise: 0.12 },
  professional: { width: 150, sloppy: 0, topK: 1, oppMul: 1.0, noise: 0.01 },
};

/** Personality knobs (see data/characters.json): how much they care about hurting you vs building. */
export const DEFAULT_PERSONA = { wOpp: 0.6, oppSeal: 12, ownSeal: 12, forceRefill: 0.2 };

function evalBoard(piles, lb, done, p, prm) {
  const q = 1 - p;
  const ownLive = ownPiles(p).filter((i) => !lb[i]);
  const oppLive = ownPiles(q).filter((i) => !lb[i]);
  const od = distance(ownLive.map((i) => topValue(piles[i])), remainingTargets(done[p]));
  const pd = distance(oppLive.map((i) => topValue(piles[i])), remainingTargets(done[q]));
  let pen = 0;
  for (const i of ownLive) {
    if (topIs13(piles[i])) pen += 4;
    if (!piles[i].length) pen += 1;
  }
  let oppEmpty = 0;
  for (const i of oppLive) {
    if (topIs13(piles[i])) pen += 4;
    if (!piles[i].length) oppEmpty++;
  }
  return -od + prm.wOpp * pd + prm.ownSeal * POP[done[p]] - prm.oppSeal * POP[done[q]] - pen + prm.forceRefill * oppEmpty;
}

/** Pick the best legal way to end the turn for a finished board and score it (seals applied). */
function scoreFinal(piles, lb, done, p, prm) {
  const { legal } = endCandidatesCore(piles, lb, done, p);
  if (!legal.length) return null;
  let best = null;
  for (const c of legal) {
    if (c.win) return { score: 1e6, cand: c };
    const nlb = lb.slice();
    const nd = done.slice();
    for (const o of c.seals) {
      for (const i of o.piles) nlb[i] = o.bit;
      nd[p] |= o.bit;
    }
    const s = evalBoard(piles, nlb, nd, p, prm);
    if (!best || s > best.score) best = { score: s, cand: c };
  }
  return best;
}

/**
 * Decide the whole turn for player p.  Returns {plan:[{card,pile,mode}], legal:boolean, score}.
 * `persona` = personality knobs, `difficulty` = key of DIFFICULTIES, rng = () => [0,1).
 */
export function planTurn(state, p, persona = DEFAULT_PERSONA, difficulty = 'professional', rng = Math.random) {
  const diff = DIFFICULTIES[difficulty] || DIFFICULTIES.professional;
  const prm = {
    wOpp: persona.wOpp * diff.oppMul,
    oppSeal: persona.oppSeal * (diff.oppMul > 0.5 ? 1 : 0.4),
    ownSeal: persona.ownSeal,
    forceRefill: persona.forceRefill * diff.oppMul,
  };
  const lockBreak = state.lockBreak;
  const hand = state.hands[p].slice();

  const search = (width) => {
    let beam = [{ score: 0, piles: state.piles, lb: state.lb, done: state.done, rest: hand, plan: [] }];
    for (let step = 0; step < hand.length; step++) {
      const cand = new Map();
      for (const b of beam) {
        for (let ci = 0; ci < b.rest.length; ci++) {
          const card = b.rest[ci];
          const nrest = b.rest.slice(0, ci).concat(b.rest.slice(ci + 1));
          for (let i = 0; i < 8; i++) {
            for (const mode of ['cover']) {
              const r = applyFull(b.piles, b.lb, b.done, card, i, mode, lockBreak);
              if (!r) continue;
              let key = nrest.join(',');
              for (let k = 0; k < 8; k++) key += '/' + r.piles[k].join('.') + (r.lb[k] ? '#' : '');
              const sc = evalBoard(r.piles, r.lb, r.done, p, prm) + rng() * diff.noise;
              const prev = cand.get(key);
              if (!prev || prev.score < sc) cand.set(key, { score: sc, piles: r.piles, lb: r.lb, done: r.done, rest: nrest, plan: b.plan.concat([{ card, pile: i, mode }]) });
            }
          }
        }
      }
      if (!cand.size) break;
      const all = Array.from(cand.values());
      // the last card is never pruned: every finished board gets a legality check
      beam = step === hand.length - 1 ? all : all.sort((x, y) => y.score - x.score).slice(0, width);
    }
    const finals = [];
    for (const b of beam) {
      const f = scoreFinal(b.piles, b.lb, b.done, p, prm);
      if (f) finals.push({ score: f.score + rng() * diff.noise * 0.2, plan: b.plan, win: f.score >= 1e6 });
    }
    return { finals, fallback: beam.sort((x, y) => y.score - x.score)[0] };
  };

  let res = search(diff.width);
  if (!res.finals.length) res = search(Math.max(diff.width * 3, 200));   // widen once before giving up
  const { finals, fallback } = res;
  if (!finals.length) return { plan: fallback ? fallback.plan : [], legal: false, score: -1e9 };
  finals.sort((x, y) => y.score - x.score);
  let pick = finals[0];
  if (!pick.win || diff.sloppy > 0.3) {
    if (rng() < diff.sloppy) pick = finals[Math.min(finals.length - 1, Math.floor(rng() * Math.min(diff.topK, finals.length)))];
  }
  return { plan: pick.plan, legal: true, score: pick.score };
}

/** Quick helper for banter/tests: is this plan going to bust something of the opponent's? */
export function planSummary(state, p, plan) {
  let busts = 0;
  for (const m of plan) if (is13(m.card) && m.mode === 'cover' && state.piles[m.pile].length) busts++;
  return { busts };
}

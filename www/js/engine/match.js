// Match play: a race to 7 or 11 points across several games. Pure data, no DOM.
//
// Points per game (only the winner scores):
//   - winning by sealing both targets: 2
//   - winning when the deck runs dry:  1
//   - a drawn game:                    0
// The first player to reach the target wins the match. The player who opens the first game is chosen by the caller;
// after that the opening seat alternates every game.

export const TARGETS = [7, 11];
export const POINTS = { seals: 2, deck: 1, draw: 0 };

/** @param {{target?: number, first?: 0|1}} opts first = who opens game 1 (0 = you, 1 = the foe). */
export function newMatch({ target = 11, first = 0 } = {}) {
  return {
    target: TARGETS.includes(target) ? target : 11,
    scores: [0, 0],
    games: 0,
    nextFirst: first === 1 ? 1 : 0,
    over: false,
    winner: null,
    history: [], // [{ winner, reason, points, first }]
  };
}

/** Points a finished game is worth, as [you, foe]. */
export function pointsFor(game) {
  const pts = [0, 0];
  if (game.winner === 0 || game.winner === 1) {
    pts[game.winner] = game.endReason === 'seals' ? POINTS.seals : POINTS.deck;
  }
  return pts;
}

/**
 * Record a finished game into the match (mutates and returns it).
 * `game` needs { winner, endReason }. Flips the opener for the next game.
 */
export function recordGame(match, game) {
  if (match.over) return match;
  const pts = pointsFor(game);
  match.scores[0] += pts[0];
  match.scores[1] += pts[1];
  match.games++;
  match.history.push({ winner: game.winner, reason: game.endReason, points: pts, first: match.nextFirst });
  match.nextFirst = 1 - match.nextFirst;
  if (match.scores[0] >= match.target || match.scores[1] >= match.target) {
    match.over = true;
    match.winner = match.scores[0] > match.scores[1] ? 0 : 1; // only one player scores per game, so never level
  }
  return match;
}

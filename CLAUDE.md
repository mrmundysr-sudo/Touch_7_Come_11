# CLAUDE.md

Guidance for Claude when working in this repo.

## What this is
**Touch 7 Come 11** is a two-player card duel (you vs. a wizard or witch). The goal is to seal one pair of piles that adds to **7** and another that adds to **11**. It is a plain HTML/CSS/JS web app (no bundler, ES modules) packaged for Android with Capacitor (`appId` `com.touch7come11.game`, `webDir` `www`).

## Layout
- `www/` - the entire app (this is what Capacitor ships)
  - `index.html`, `css/main.css`
  - `js/engine/` - pure game logic, no DOM: `cards.js` (card ids, seeded RNG), `core.js`, `rules.js` (newGame, playCard, endTurn, ...), `ai.js` (opponent turn planning)
  - `js/ui/` - `game.js` (table UI), `cardview.js`
  - `js/main.js` (app flow), `assets.js`, `audio.js`, `store.js`, `util.js`
  - `data/text.json` (UI strings), `data/characters.json` (opponent names, personalities, banter)
  - `art/` + `art/art-config.json` - images loaded **by slot name**; `audio/` + `audio/audio-config.json` - sounds by name
  - `fonts/`, `licenses/` - OFL fonts (Gloock, Crimson Pro, Arsenal SC)
- `tests/engine.test.mjs` - rule engine and AI tests (Node's built-in test runner)
- `tools/` - `serve.mjs` (dev server), `prepare_art.py`, `gen_audio.py`, `patch_android.py`, `icons/`
- `.github/workflows/android.yml` - CI that tests, builds the debug APK and publishes it as a pre-release
- `capacitor.config.json`, `package.json`

## Commands
- `npm test` - run the rule engine and AI tests (run before every commit)
- `npm run serve` - dev server at http://localhost:8080 (use a phone-size window)
- `python3 tools/prepare_art.py <visual-assets-folder> www/art` - regenerate art from the App Visual Builder export
- `python3 tools/gen_audio.py www/audio` - regenerate synthesized sounds

## Conventions
- Keep game rules in `www/js/engine/` free of DOM and browser APIs so they stay testable under Node. Any rule or AI change needs a test in `tests/engine.test.mjs`.
- Do not hard-code art, sound or text paths/strings in JS. Use the slot names in `art-config.json`, the names in `audio-config.json`, and `data/text.json` / `data/characters.json`. The README documents the available slots (including optional mood art and per-card overrides).
- Game state is plain data (piles are arrays of card ids, bottom to top). Tests build custom states with the `mk()` helper; match that shape when the state structure changes.
- Suits are Sun, Bloom, Moon, Thorn (ranks 1-13). Card art overrides live at `www/art/cards/{suit}_{rank}.webp`.
- Fonts are SIL OFL; keep `www/licenses` current if fonts change.

## Android build
- CI runs on pushes to `main`/`master` and on manual dispatch: `npm test`, `npm install`, `npx cap add android`, `tools/patch_android.py` (portrait lock, dark theme, fullscreen, icons), `npx cap sync android`, then `./gradlew assembleDebug`.
- The `android/` folder is generated in CI and is not committed. Change native settings in `tools/patch_android.py`, not by editing generated files.
- Each successful build is published as a GitHub pre-release named `apk-<run_number>` containing `touch-7-come-11.apk`.

## Do not touch
- `t7c11.zip.touchmanifest` and `.touch-uploads/` are upload-chunk bookkeeping for the original project archive. Leave them alone.

## Git
- Default branch is `main`. Work happens on `claude/...` branches merged via pull request.

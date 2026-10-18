# Touch 7 Come 11

A two-player card duel: you against a wizard or a witch. Seal one pair of piles that adds to **7** and another that adds to **11**.

## Get the APK (GitHub)
1. Create a new GitHub repository and upload everything in this folder (keep the `.github` folder).
2. Open the **Actions** tab. The *Build Android APK* workflow runs on every push (or press **Run workflow**).
3. When it finishes, open the run and download the **touch-7-come-11-apk** artifact. Unzip it and install `app-debug.apk` on your phone (allow "install unknown apps").

## Swap the art (no code changes)
Every picture is loaded by **slot name** from `www/art/art-config.json`. Replace the file, or point a slot at a new path:
- `splash.background`, `table.background`, `result.win.background`, `result.loss.background`
- `character.witch.neutral`, `character.wizard.neutral`
- mood art: add `character.witch.smug`, `.worried`, `.angry`, `.happy`, `.defeated` (same for `wizard`) to `slots` and they are used automatically
- `result.win.banner`, `result.loss.banner`, `ui.playAgain`, `ui.coin7`, `ui.coin11`
- cards: set `"cards": {"useOverrides": true}` and add `www/art/cards/{sun|bloom|moon|thorn}_{1-13}.webp` (and `cards/back.webp`)

## Swap sounds
`www/audio/audio-config.json` maps each sound name to its `.ogg` / `.m4a` file. Replace the files or edit the paths.

## Edit words
- UI text: `www/data/text.json`
- Opponent names, personalities and banter: `www/data/characters.json`

## Develop
- `npm test` - rule engine and AI tests
- `npm run serve` then open http://localhost:8080 (any modern browser, phone-size window)
- `python3 tools/prepare_art.py <visual-assets-folder> www/art` regenerates art from the App Visual Builder export
- `python3 tools/gen_audio.py www/audio` regenerates the synthesized sounds

Fonts (Gloock, Crimson Pro, Arsenal SC) are SIL Open Font License; see `www/licenses`.

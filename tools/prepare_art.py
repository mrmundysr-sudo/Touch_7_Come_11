#!/usr/bin/env python3
"""Prepare the app's art from the Visual Builder export.

Usage:  python3 tools/prepare_art.py <path-to-unzipped-visual-assets> [out-dir]

Reads the Visual Builder export (manifest.json + pages/...), fixes what the app
needs (transparent witch cut-out, split Win/Lose banner, coin crops, launcher
icons) and writes web-friendly files plus www/art/art-config.json.

The game never hard-codes image files: it loads every visual through the slot
names in art-config.json.  To swap any art later, either replace the file in
www/art/ (same name) or edit the path in art-config.json.
"""
import json, shutil, sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("art_zip")
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("www/art")
ICON_OUT = Path("tools/icons")


def save(img, rel, **kw):
    p = OUT / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    img.save(p, **kw)
    print(f"  {rel:42s} {img.size[0]}x{img.size[1]}  {p.stat().st_size/1024:7.0f} KB")
    return rel


def remove_baked_checkerboard(img):
    """The witch export has a fake transparency checkerboard baked into RGB.
    Flood-fill the neutral grey/white squares from the border, keep the rest."""
    rgb = np.array(img.convert("RGB")).astype(np.int16)
    h, w, _ = rgb.shape
    mx, mn = rgb.max(axis=2), rgb.min(axis=2)
    # checker squares are neutral greys around 128 and 192 (soft edges between)
    cand = ((mx - mn) <= 18) & (mx >= 105) & (mx <= 224)
    import cv2
    _, lab = cv2.connectedComponents(cand.astype(np.uint8), connectivity=4)
    border = set(lab[0, :]) | set(lab[-1, :]) | set(lab[:, 0]) | set(lab[:, -1])
    border.discard(0)
    seen = np.isin(lab, list(border))        # neutral squares touching the image border = background
    bg = Image.fromarray((seen * 255).astype(np.uint8))
    # pull the matte in 1px and soften, so no light fringe survives
    bg = bg.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(1.1))
    alpha = 255 - np.array(bg).astype(np.int32)
    alpha = np.clip((alpha - 40) * 255 / 175, 0, 255).astype(np.uint8)
    # keep only the biggest opaque blob (drops stray checker islands)
    import cv2
    n, lab, stats, _ = cv2.connectedComponentsWithStats((alpha > 40).astype(np.uint8), 8)
    if n > 1:
        keep = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        alpha = np.where(lab == keep, alpha, 0).astype(np.uint8)
    out = img.convert("RGBA")
    out.putalpha(Image.fromarray(alpha))
    return out


def trim_alpha(img, pad=6):
    bb = img.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    if not bb:
        return img
    l, t, r, b = bb
    return img.crop((max(0, l - pad), max(0, t - pad), min(img.width, r + pad), min(img.height, b + pad)))


def round_coin(img, cx, cy, r_inner, r_outer):
    size = int(r_outer * 2)
    crop = img.convert("RGB").crop((int(cx - r_outer), int(cy - r_outer), int(cx + r_outer), int(cy + r_outer)))
    yy, xx = np.mgrid[0:size, 0:size]
    d = np.hypot(xx - size / 2, yy - size / 2)
    a = np.clip((r_outer - d) / max(1, r_outer - r_inner), 0, 1)
    out = crop.convert("RGBA")
    out.putalpha(Image.fromarray((a * 255).astype(np.uint8)))
    return out


def main():
    manifest = json.loads((SRC / "manifest.json").read_text())
    pages = {p["id"]: p for p in manifest["pages"]}
    P = lambda pid, slot, i=None: SRC / (pages[pid]["slots"][slot]["path"] if i is None else pages[pid]["slots"][slot][i]["path"])
    OUT.mkdir(parents=True, exist_ok=True)
    slots = {}
    print("Backgrounds")
    slots["splash.background"] = save(Image.open(P("page_01", "clean")).convert("RGB"), "backgrounds/splash.webp", quality=93, method=6)
    slots["table.background"] = save(Image.open(P("page_03", "clean")).convert("RGB"), "backgrounds/table.webp", quality=93, method=6)
    slots["result.win.background"] = save(Image.open(P("page_04", "clean")).convert("RGB"), "backgrounds/result_win.webp", quality=93, method=6)
    slots["result.loss.background"] = save(Image.open(P("page_05", "clean")).convert("RGB"), "backgrounds/result_loss.webp", quality=93, method=6)

    print("Characters")
    # page_03 'other' slots: [0] = witch (opaque, baked checkerboard), [1] = wizard (real alpha)
    witch = trim_alpha(remove_baked_checkerboard(Image.open(P("page_03", "other", 0))))
    wizard = trim_alpha(Image.open(P("page_03", "other", 1)).convert("RGBA"))
    slots["character.witch.neutral"] = save(witch, "characters/witch/neutral.webp", lossless=True, method=6)
    slots["character.wizard.neutral"] = save(wizard, "characters/wizard/neutral.webp", lossless=True, method=6)

    print("UI")
    both = Image.open(P("page_04", "other", 1)).convert("RGBA")       # 'You Win!' | 'You Lose!'
    play = Image.open(P("page_04", "other", 0)).convert("RGBA")       # 'Play Again'
    a = np.array(both.getchannel("A")).astype(float).sum(0)
    mid = slice(int(both.width * 0.4), int(both.width * 0.6))
    split = int(np.argmin(a[mid])) + mid.start
    win = trim_alpha(both.crop((0, 0, split, both.height)))
    lose = trim_alpha(both.crop((split, 0, both.width, both.height)))
    slots["result.win.banner"] = save(win, "ui/banner_win.webp", lossless=True, method=6)
    slots["result.loss.banner"] = save(lose, "ui/banner_lose.webp", lossless=True, method=6)
    slots["ui.playAgain"] = save(trim_alpha(play), "ui/btn_play_again.webp", lossless=True, method=6)

    splash = Image.open(P("page_01", "clean")).convert("RGB")
    slots["ui.coin7"] = save(round_coin(splash, 262, 1172, 118, 150), "ui/coin_7.webp", lossless=True, method=6)
    slots["ui.coin11"] = save(round_coin(splash, 583, 1172, 118, 150), "ui/coin_11.webp", lossless=True, method=6)

    cfg = {
        "version": 1,
        "note": "Every visual is loaded by slot name. Replace the file (same name) or change the path here - no code changes needed.",
        "slots": slots,
        "characterMoods": ["neutral", "smug", "worried", "angry", "happy", "defeated"],
        "characterMoodSlotPattern": "character.{id}.{mood}",
        "cards": {
            "overridePattern": "cards/{suit}_{rank}.webp",
            "overrideBack": "cards/back.webp",
            "suits": ["sun", "bloom", "moon", "thorn"],
            "useOverrides": False,
            "note": "Optional. Set useOverrides to true, then if cards/<suit>_<rank>.webp exists (rank 1-13) it replaces the drawn card face; cards/back.webp replaces the card back."
        },
        "source": {"app": manifest.get("app_name"), "exported_at": manifest.get("exported_at")},
    }
    (OUT / "art-config.json").write_text(json.dumps(cfg, indent=2))
    shutil.copy(SRC / "manifest.json", OUT / "source_manifest.json")

    print("Icons")
    ICON_OUT.mkdir(parents=True, exist_ok=True)
    c7 = Image.open(OUT / slots["ui.coin7"]).convert("RGBA")
    c11 = Image.open(OUT / slots["ui.coin11"]).convert("RGBA")
    S = 1024
    def fg_layer(scale):
        layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        d = int(S * scale)
        for im, dx in ((c7, -0.30), (c11, 0.30)):
            t = im.resize((d, d), Image.LANCZOS)
            layer.alpha_composite(t, (int(S / 2 - d / 2 + dx * d * 0.85), int(S / 2 - d / 2)))
        return layer
    bg = Image.new("RGBA", (S, S))
    px = np.zeros((S, S, 4), np.uint8)
    yy, xx = np.mgrid[0:S, 0:S]
    r = np.hypot(xx - S / 2, yy - S * 0.42) / (S * 0.75)
    for ch, (c0, c1) in enumerate(((52, 12), (28, 8), (96, 38))):
        px[..., ch] = np.clip(c0 + (c1 - c0) * np.clip(r, 0, 1), 0, 255)
    px[..., 3] = 255
    bg = Image.fromarray(px, "RGBA")
    fg = fg_layer(0.52)
    icon = bg.copy(); icon.alpha_composite(fg_layer(0.60))
    icon.convert("RGB").save(ICON_OUT / "icon-1024.png")
    fg.save(ICON_OUT / "icon-foreground-1024.png")
    bg.convert("RGB").save(ICON_OUT / "icon-background-1024.png")
    print("  icons written to", ICON_OUT)


if __name__ == "__main__":
    main()

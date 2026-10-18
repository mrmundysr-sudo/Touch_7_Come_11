#!/usr/bin/env python3
"""Synthesise every sound effect and the two music loops for Touch 7 Come 11.

Usage: python3 tools/gen_audio.py [out-dir]    (default: www/audio)

Writes 44.1 kHz stereo .wav, then encodes .ogg (Android/desktop) and .m4a (iOS-safe)
next to an audio-config.json that lists every sound by name.  The app loads sounds
only through that config, so any sound can be replaced by dropping in a new file.
All sounds are peak-normalised below 0 dBFS (no clipping) with short fades (no clicks).
"""
import json, subprocess, sys, wave
from pathlib import Path

import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve

SR = 44100
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("www/audio")
RNG = np.random.default_rng(711)


# ---------------------------------------------------------------- helpers
def tt(dur):
    return np.arange(int(dur * SR)) / SR


def hz(m):                       # midi note -> Hz
    return 440.0 * 2 ** ((m - 69) / 12)


def sine(f, dur, ph=0.0):
    return np.sin(2 * np.pi * f * tt(dur) + ph)


def sweep(f0, f1, dur, expo=True):
    t = tt(dur)
    if expo:
        f = f0 * (f1 / f0) ** (t / dur)
    else:
        f = f0 + (f1 - f0) * t / dur
    return np.sin(2 * np.pi * np.cumsum(f) / SR)


def saw(f, dur, detune_cents=0.0):
    f = f * 2 ** (detune_cents / 1200)
    ph = (f * tt(dur)) % 1.0
    return 2 * ph - 1


def noise(dur):
    return RNG.standard_normal(int(dur * SR))


def bp(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, hi], btype="band", fs=SR, output="sos"), x)


def lp(x, fc, order=2):
    return sosfilt(butter(order, fc, btype="low", fs=SR, output="sos"), x)


def hp(x, fc, order=2):
    return sosfilt(butter(order, fc, btype="high", fs=SR, output="sos"), x)


def decay(n, tau):
    return np.exp(-np.arange(n) / SR / tau)


def adsr(n, a, d, s, r):
    e = np.ones(n)
    na, nd, nr = int(a * SR), int(d * SR), int(r * SR)
    na = max(1, min(na, n))
    e[:na] = np.linspace(0, 1, na)
    nd = min(nd, n - na)
    if nd > 0:
        e[na:na + nd] = np.linspace(1, s, nd)
        e[na + nd:] = s
    nr = min(nr, n)
    if nr > 0:
        e[-nr:] *= np.linspace(1, 0, nr)
    return e


def fade(x, fin=0.004, fout=0.02):
    x = x.copy()
    a, b = int(fin * SR), int(fout * SR)
    if a:
        x[:a] *= np.linspace(0, 1, a)
    if b:
        x[-b:] *= np.linspace(1, 0, b)
    return x


def pad_to(x, n):
    return np.pad(x, (0, max(0, n - len(x))))[:n]


def place(buf, x, at):
    i = int(at * SR)
    n = min(len(x), len(buf) - i)
    if n > 0:
        buf[i:i + n] += x[:n]
    return buf


def stereo(x, pan=0.0):
    pan = (pan + 1) / 2
    return np.stack([x * np.cos(pan * np.pi / 2), x * np.sin(pan * np.pi / 2)], axis=1)


def reverb(st, rt=1.6, wet=0.25, damp=5000):
    n = int(rt * SR)
    t = np.arange(n) / SR
    out = np.zeros((len(st) + n, 2))
    for ch in range(2):
        ir = RNG.standard_normal(n) * np.exp(-t / (rt / 4.5))
        ir = lp(ir, damp)
        ir[: int(0.012 * SR)] *= np.linspace(0, 1, int(0.012 * SR))
        ir /= np.sqrt((ir ** 2).sum())
        c = fftconvolve(st[:, ch], ir)[: len(out)]
        out[: len(c), ch] = c
    dry = np.pad(st, ((0, n), (0, 0)))
    return dry * (1 - wet * 0.5) + out * wet * 1.6


def tail_trim(st, thresh=1e-4):
    mag = np.abs(st).max(axis=1)
    idx = np.where(mag > thresh)[0]
    return st[: (idx[-1] + 1 if len(idx) else len(st))]


def finish(st, peak_db=-2.5, fin=0.003, fout=0.04):
    st = tail_trim(st)
    st = st - st.mean(axis=0, keepdims=True)           # remove DC
    st = np.stack([fade(st[:, 0], fin, fout), fade(st[:, 1], fin, fout)], axis=1)
    st = st / (np.abs(st).max() + 1e-12) * 10 ** (peak_db / 20)
    return st


def bell(f, dur, amp=1.0, bright=1.0, tau=0.9):
    """Struck-bell tone: inharmonic partials with individual decays."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    parts = [(1.0, 1.0, 1.0), (2.0, 0.5, 0.75), (2.756, 0.32 * bright, 0.55), (4.1, 0.16 * bright, 0.4), (5.4, 0.12 * bright, 0.3), (8.93, 0.05 * bright, 0.18)]
    x = np.zeros(n)
    for ratio, a, d in parts:
        x += a * np.sin(2 * np.pi * f * ratio * t) * np.exp(-t / (tau * d))
    x *= np.minimum(1, t / 0.002)
    return amp * x / 2.0


def glass(f, dur, amp=1.0, tau=1.2):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(2 * np.pi * 2 * f * t + 0.5) + 0.12 * np.sin(2 * np.pi * 3.01 * f * t)) * np.exp(-t / tau)
    return amp * x * np.minimum(1, t / 0.008)


def pluck(f, dur, amp=1.0, tau=0.5, bright=1.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = np.zeros(n)
    for k in range(1, 9):
        x += (1 / k ** 1.3) * np.sin(2 * np.pi * f * k * t) * np.exp(-t / (tau / (1 + 0.7 * (k - 1) * bright)))
    x *= np.minimum(1, t / 0.003)
    return amp * x * 0.7


def echo(st, delay=0.375, fb=0.35, mix=0.35, taps=4):
    out = st.copy()
    d = int(delay * SR)
    cur = st
    for k in range(1, taps + 1):
        cur = np.pad(cur, ((d, 0), (0, 0)))[: len(st)] * fb
        # ping-pong
        out += mix * (cur[:, ::-1] if k % 2 else cur)
    return out


# ---------------------------------------------------------------- sound effects
def sfx_tap():
    x = bell(1320, 0.18, 0.5, 0.4, tau=0.12)
    click = bp(noise(0.03), 2500, 7000) * decay(int(0.03 * SR), 0.006)
    x[: len(click)] += 0.25 * click
    return stereo(x)


def sfx_select():
    n = 0.16
    sw = hp(noise(n), 900) * np.sin(np.linspace(0, np.pi, int(n * SR))) ** 2 * 0.25
    b = bell(1568, 0.3, 0.4, 0.5, tau=0.18)
    x = pad_to(sw, int(0.3 * SR)) + b
    return reverb(stereo(x), 0.5, 0.15)


def sfx_deselect():
    b = bell(1046, 0.2, 0.35, 0.3, tau=0.1)
    return stereo(b)


def sfx_draw():
    out = np.zeros(int(0.55 * SR))
    for i in range(4):
        sw = bp(noise(0.12), 1200, 5200) * np.sin(np.linspace(0, np.pi, int(0.12 * SR))) ** 1.5
        out = place(out, sw * 0.5, i * 0.11)
        out = place(out, bell(1760 + 110 * i, 0.2, 0.12, 0.3, 0.08), i * 0.11)
    return reverb(stereo(out), 0.5, 0.12)


def sfx_shuffle():
    dur = 1.4
    out = np.zeros(int(dur * SR))
    for i in range(34):
        at = RNG.uniform(0, dur - 0.1)
        sw = bp(noise(0.07), 900, 6500) * np.sin(np.linspace(0, np.pi, int(0.07 * SR))) * RNG.uniform(0.2, 0.55)
        out = place(out, sw, at)
    out *= np.sin(np.linspace(0.2, np.pi - 0.2, len(out))) ** 0.5
    return reverb(stereo(out), 0.6, 0.1)


def sfx_place():
    thump = sweep(150, 62, 0.16) * decay(int(0.16 * SR), 0.05)
    slap = bp(noise(0.09), 1500, 5200) * decay(int(0.09 * SR), 0.018)
    x = pad_to(thump * 0.9, int(0.22 * SR)); x[: len(slap)] += slap * 0.9
    return reverb(stereo(x), 0.45, 0.1)


def sfx_tuck():
    n = 0.28
    sl = bp(noise(n), 700, 3200) * np.sin(np.linspace(0, np.pi, int(n * SR))) ** 2 * 0.7
    tick = sweep(110, 70, 0.1) * decay(int(0.1 * SR), 0.04) * 0.5
    x = sl.copy(); x[: len(tick)] += tick
    return reverb(stereo(x), 0.45, 0.1)


def sfx_error():
    x = np.zeros(int(0.32 * SR))
    for at in (0, 0.11):
        x = place(x, sweep(180, 90, 0.14) * decay(int(0.14 * SR), 0.05) * 0.9, at)
    return stereo(x)


def sfx_pop():
    x = sweep(520, 900, 0.07) * decay(int(0.07 * SR), 0.02)
    return stereo(x * 0.6)


def sfx_toggle_on():
    x = np.zeros(int(0.3 * SR)); x = place(x, bell(880, 0.2, 0.4, 0.3, 0.1), 0); x = place(x, bell(1318, 0.25, 0.4, 0.3, 0.12), 0.07)
    return stereo(x)


def sfx_toggle_off():
    x = np.zeros(int(0.3 * SR)); x = place(x, bell(1318, 0.2, 0.4, 0.3, 0.1), 0); x = place(x, bell(880, 0.25, 0.4, 0.3, 0.12), 0.07)
    return stereo(x)


def sfx_your_turn():
    x = np.zeros(int(1.2 * SR)); x = place(x, bell(hz(76), 1.1, 0.55, 0.5, 0.5), 0); x = place(x, bell(hz(83), 1.1, 0.5, 0.5, 0.5), 0.16)
    return reverb(stereo(x), 1.2, 0.2)


def sfx_foe_turn():
    x = np.zeros(int(1.0 * SR)); x = place(x, bell(hz(69), 0.9, 0.45, 0.2, 0.45), 0); x = place(x, bell(hz(62), 1.0, 0.45, 0.2, 0.55), 0.18)
    return reverb(stereo(x), 1.0, 0.22)


def sfx_bust_flare():
    d = 1.3; n = int(d * SR); t = np.arange(n) / SR
    boom = sweep(95, 34, d) * decay(n, 0.28) * 1.0
    fire = bp(noise(d), 300, 3200) * (np.exp(-t / 0.35) * (1 - np.exp(-t / 0.01)))
    fire *= (1 + 0.6 * np.sin(2 * np.pi * 23 * t)) / 1.6
    crack = np.zeros(n)
    for _ in range(26):
        at = RNG.uniform(0.02, 0.9); c = hp(noise(0.012), 2500) * decay(int(0.012 * SR), 0.003) * RNG.uniform(0.2, 0.8)
        crack = place(crack, c, at)
    shimmer = sweep(600, 2600, 0.5) * np.sin(np.linspace(0, np.pi, int(0.5 * SR))) * 0.12
    x = boom + 0.55 * fire + 0.5 * crack + pad_to(shimmer, n)
    return reverb(stereo(x), 1.1, 0.2)


def sfx_bust_overgrowth():
    d = 1.4; n = int(d * SR); t = np.arange(n) / SR
    leaves = hp(noise(d), 1800) * (np.sin(np.pi * np.minimum(t / 0.9, 1)) ** 1.2) * (1 + 0.5 * np.sin(2 * np.pi * 14 * t)) * 0.35
    creak = lp(saw(60, d) + 0.5 * saw(60.8, d), 450) * np.exp(-t / 0.5) * 0.4
    creak *= 1 + 0.5 * np.sin(2 * np.pi * 7 * t)
    thump = sweep(120, 48, 0.25) * decay(int(0.25 * SR), 0.09)
    x = leaves + creak + pad_to(thump, n) * 0.9
    for i, m in enumerate((79, 83, 86, 91)):
        x = place(x, bell(hz(m), 0.8, 0.22, 0.4, 0.3), 0.15 + 0.09 * i)
    return reverb(stereo(x), 1.2, 0.22)


def sfx_bust_eclipse():
    d = 1.6; n = int(d * SR); t = np.arange(n) / SR
    drone = sweep(210, 38, d) * decay(n, 0.7) * 0.9
    swell = lp(noise(d), 700) * (np.sin(np.pi * np.minimum(t / 1.2, 1)) ** 2) * 0.5
    ring = (bell(hz(60), 1.4, 0.35, 0.2, 0.9))
    x = drone + swell + pad_to(ring, n)
    x[: int(0.01 * SR)] *= np.linspace(0, 1, int(0.01 * SR))
    rev = np.zeros(n); rev = place(rev, hp(noise(0.5), 3000) * np.sin(np.linspace(0, np.pi, int(0.5 * SR))) ** 3 * 0.18, 0.05)
    return reverb(stereo(x + rev), 1.6, 0.3, 3000)


def sfx_bust_bramble():
    d = 1.2; n = int(d * SR)
    x = np.zeros(n)
    for _ in range(9):
        at = RNG.uniform(0, 0.55)
        s = bp(noise(0.09), 2500, 7500) * np.sin(np.linspace(0, np.pi, int(0.09 * SR))) ** 0.7 * RNG.uniform(0.25, 0.6)
        x = place(x, s, at)
    x = place(x, sweep(130, 52, 0.22) * decay(int(0.22 * SR), 0.08) * 0.95, 0.0)
    for f, at in ((1480, 0.04), (1568, 0.05), (2349, 0.12)):          # dissonant tiny pings
        x = place(x, bell(f, 0.7, 0.16, 0.9, 0.18), at)
    return reverb(stereo(x), 0.9, 0.2)


def sfx_seal():
    d = 2.2; x = np.zeros(int(d * SR))
    for i, m in enumerate((72, 79, 84, 88, 91)):
        x = place(x, glass(hz(m), 1.9, 0.5 / (1 + 0.15 * i), 1.1), 0.0 + i * 0.07)
    x = place(x, sweep(100, 55, 0.3) * decay(int(0.3 * SR), 0.1) * 0.8, 0)
    sp = hp(noise(0.7), 5000) * np.sin(np.linspace(0, np.pi, int(0.7 * SR))) ** 2 * 0.09
    x = place(x, sp, 0.05)
    return reverb(stereo(x), 1.6, 0.28)


def sfx_unseal():
    d = 1.3; x = np.zeros(int(d * SR))
    c = hp(noise(0.06), 3500) * decay(int(0.06 * SR), 0.012) * 1.2
    x = place(x, c, 0)
    for i, m in enumerate((96, 91, 85, 79, 72)):
        x = place(x, glass(hz(m), 0.5, 0.2, 0.12), 0.03 + i * 0.06)
    x = place(x, sweep(140, 45, 0.35) * decay(int(0.35 * SR), 0.12) * 0.9, 0.02)
    return reverb(stereo(x), 1.0, 0.2)


def sfx_win():
    d = 4.2; x = np.zeros(int(d * SR))
    notes = [(60, 0.0), (64, 0.18), (67, 0.36), (72, 0.54), (76, 0.8), (79, 1.05), (84, 1.35)]
    for m, at in notes:
        x = place(x, bell(hz(m), 2.2, 0.45, 0.6, 0.9), at)
        x = place(x, pluck(hz(m - 12), 1.2, 0.2, 0.6), at)
    for m in (60, 64, 67, 72, 76):
        x = place(x, lp(saw(hz(m), 2.6), 1400) * adsr(int(2.6 * SR), 0.5, 0.4, 0.7, 1.4) * 0.07, 1.35)
    for i in range(14):
        x = place(x, bell(hz(RNG.choice([88, 91, 95, 100])), 0.6, 0.07, 0.8, 0.25), 1.4 + i * 0.1)
    return reverb(stereo(x), 2.0, 0.28)


def sfx_lose():
    d = 4.0; x = np.zeros(int(d * SR))
    for m, at in ((67, 0.0), (63, 0.5), (60, 1.0), (55, 1.55)):
        x = place(x, bell(hz(m), 2.2, 0.4, 0.3, 1.0), at)
    for m in (43, 50, 55, 58):
        x = place(x, lp(saw(hz(m), 3.4), 500) * adsr(int(3.4 * SR), 0.4, 0.4, 0.7, 1.6) * 0.1, 0.9)
    x = place(x, sweep(120, 40, 0.8) * decay(int(0.8 * SR), 0.3) * 0.7, 1.55)
    return reverb(stereo(x), 2.2, 0.3, 3500)


def sfx_swoosh():           # character reaction / screen transition
    d = 0.5
    x = bp(noise(d), 400, 4500) * np.sin(np.linspace(0, np.pi, int(d * SR))) ** 2 * 0.5
    return reverb(stereo(x), 0.6, 0.15)


# ---------------------------------------------------------------- music
def chord_pad(notes, dur, tail=2.2, bright=1100, vel=0.1):
    n = int((dur + tail) * SR)
    x = np.zeros(n)
    for m in notes:
        for dt in (-7, 0, 7):
            x += saw(hz(m), dur + tail, dt)
    x = lp(x, bright, 2)
    x *= adsr(n, 1.4, 0.6, 0.8, tail) * vel / len(notes)
    return x


def music(chords, bpm, bars, bell_motif, pulse=False, seed=1):
    beat = 60.0 / bpm
    bar = beat * 4
    L = bar * bars
    n = int(L * SR)
    tail = 3.0
    N = n + int(tail * SR)
    L_ = np.zeros((N, 2))
    rng = np.random.default_rng(seed)
    per = bars // len(chords)
    for ci, (root, notes) in enumerate(chords):
        at = ci * per * bar
        dur = per * bar
        pad = chord_pad(notes, dur, tail=2.4)
        i0 = int(at * SR)
        pl = stereo(pad, -0.2) * 0.55 + stereo(np.roll(pad, 400), 0.2) * 0.55
        m = min(len(pl), N - i0)
        L_[i0: i0 + m] += pl[:m]
        bass = sine(hz(root), dur + 1.5) * adsr(int((dur + 1.5) * SR), 0.8, 0.3, 0.8, 1.4) * 0.22 + 0.04 * sine(hz(root + 12), dur + 1.5) * adsr(int((dur + 1.5) * SR), 1.2, 0.3, 0.7, 1.4)
        b = stereo(bass)
        L_[int(at * SR): int(at * SR) + len(b)] += b[: N - int(at * SR)]
        # arpeggio plucks (eighth notes)
        steps = int(dur / (beat / 2))
        order = [0, 2, 1, 3, 2, 4, 3, 1] if len(notes) >= 5 else [0, 1, 2, 3, 2, 1]
        for s in range(steps):
            m = notes[order[s % len(order)] % len(notes)] + (12 if (s // 8) % 2 else 0)
            vel = 0.20 * (0.75 + 0.25 * rng.random()) * (1.0 if s % 2 == 0 else 0.75)
            p = pluck(hz(m + 12), 1.4, vel, 0.55)
            pn = stereo(p, np.sin(s * 0.7) * 0.5)
            i0 = int((at + s * beat / 2) * SR)
            if i0 + len(pn) <= N:
                L_[i0: i0 + len(pn)] += pn
    for bar_i, beat_i, m in bell_motif:
        at = bar_i * bar + beat_i * beat
        b = stereo(bell(hz(m), 3.2, 0.34, 0.45, 1.4), 0.15)
        i0 = int(at * SR)
        L_[i0: i0 + len(b)] += b[: N - i0]
    if pulse:
        for k in range(int(bars * 2)):
            at = k * 2 * beat
            th = sweep(78, 46, 0.35) * decay(int(0.35 * SR), 0.11) * 0.28
            i0 = int(at * SR)
            L_[i0: i0 + len(th), :] += stereo(th)[: N - i0]
        for k in range(int(bars * 8)):
            at = k * beat / 2 + beat / 4
            sh = hp(noise(0.05), 6500) * decay(int(0.05 * SR), 0.012) * 0.025
            i0 = int(at * SR)
            L_[i0: i0 + len(sh), :] += stereo(sh, 0.4 * np.sin(k))[: N - i0]
    L_ = echo(L_, beat * 0.75, 0.38, 0.26, 4)
    L_ = reverb(L_, 2.8, 0.34, 4200)
    # fold the tail back over the start so the loop is seamless
    body = L_[:n].copy()
    tailpart = L_[n:]
    body[: len(tailpart)] += tailpart[: n]
    body = body - body.mean(axis=0, keepdims=True)
    return body


def music_menu():
    chords = [  # (bass midi, chord tones)
        (38, [50, 57, 62, 65, 69]),     # Dm9
        (34, [46, 53, 57, 62, 65]),     # Bbmaj7
        (41, [53, 57, 60, 64, 67]),     # Fmaj7
        (36, [48, 55, 60, 64, 67]),     # Cmaj7/add9 feel
    ]
    motif = [(0, 2, 81), (1, 1, 77), (2, 0, 84), (2, 3, 79), (4, 2, 81), (5, 1, 74), (6, 0, 76), (7, 2, 72)]
    return music(chords, 66, 8, motif, False, 3)


def music_game():
    chords = [
        (33, [45, 52, 57, 60, 64]),     # Am9
        (41, [53, 57, 60, 64, 67]),     # Fmaj7
        (36, [48, 55, 59, 64, 67]),     # Cmaj7
        (31, [47, 55, 59, 62, 66]),     # Gadd... brighter lift
    ]
    motif = [(0, 3, 76), (1, 2, 81), (2, 1, 79), (3, 0, 83), (4, 3, 76), (5, 2, 72), (6, 1, 79), (7, 3, 74)]
    return music(chords, 72, 8, motif, True, 9)


# ---------------------------------------------------------------- build
SFX = {
    "tap": sfx_tap, "select": sfx_select, "deselect": sfx_deselect, "draw": sfx_draw, "shuffle": sfx_shuffle,
    "place": sfx_place, "tuck": sfx_tuck, "error": sfx_error, "pop": sfx_pop, "toggleOn": sfx_toggle_on,
    "toggleOff": sfx_toggle_off, "yourTurn": sfx_your_turn, "foeTurn": sfx_foe_turn,
    "bustFlare": sfx_bust_flare, "bustOvergrowth": sfx_bust_overgrowth, "bustEclipse": sfx_bust_eclipse,
    "bustBramble": sfx_bust_bramble, "seal": sfx_seal, "unseal": sfx_unseal, "win": sfx_win, "lose": sfx_lose,
    "swoosh": sfx_swoosh,
}
PEAK = {"tap": -6, "select": -6, "deselect": -8, "draw": -6, "shuffle": -7, "place": -3, "tuck": -6, "error": -5, "pop": -9,
        "toggleOn": -7, "toggleOff": -8, "yourTurn": -5, "foeTurn": -7, "swoosh": -8}


def write_wav(path, st):
    pcm = (np.clip(st, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())


def encode(wav, stem, loop=False):
    for ext, args in ((".ogg", ["-c:a", "libvorbis", "-q:a", "5"]), (".m4a", ["-c:a", "aac", "-b:a", "128k"])):
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), *args, str(stem.with_suffix(ext))], check=True)


def main():
    (OUT / "sfx").mkdir(parents=True, exist_ok=True)
    (OUT / "music").mkdir(parents=True, exist_ok=True)
    cfg = {"version": 1, "note": "Sounds load by name from this file. Replace a file (keep the name) or edit the paths; list several formats and the first playable one is used.", "sfx": {}, "music": {}, "gain": {}}
    report = []
    for name, fn in SFX.items():
        st = finish(fn(), PEAK.get(name, -3))
        wav = OUT / "sfx" / f"{name}.wav"; write_wav(wav, st); encode(wav, wav.with_suffix(""))
        wav.unlink()
        cfg["sfx"][name] = [f"sfx/{name}.ogg", f"sfx/{name}.m4a"]
        report.append((name, len(st) / SR, 20 * np.log10(np.abs(st).max()), 20 * np.log10(np.sqrt((st ** 2).mean()))))
    for name, fn in (("menu", music_menu), ("game", music_game)):
        st = fn()
        st = st / np.abs(st).max() * 10 ** (-3 / 20)
        wav = OUT / "music" / f"{name}.wav"; write_wav(wav, st); encode(wav, wav.with_suffix(""), True)
        wav.unlink()
        cfg["music"][name] = {"files": [f"music/{name}.ogg", f"music/{name}.m4a"], "loop": True, "gain": 0.55}
        seam = np.abs(st[0] - st[-1]).max()
        report.append((f"music:{name}", len(st) / SR, 20 * np.log10(np.abs(st).max()), 20 * np.log10(np.sqrt((st ** 2).mean()))))
        print(f"  loop seam jump {name}: {seam:.4f}")
    (OUT / "audio-config.json").write_text(json.dumps(cfg, indent=2))
    print(f"{'sound':18s}{'sec':>6s}{'peak dB':>9s}{'rms dB':>9s}")
    for n, d, p, r in report:
        print(f"{n:18s}{d:6.2f}{p:9.1f}{r:9.1f}")


if __name__ == "__main__":
    main()

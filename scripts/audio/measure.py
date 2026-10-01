#!/usr/bin/env python3
"""Measure every shipped sound, because nobody building this can listen to it.

    python3 scripts/audio/measure.py            # measure audio/dist against audio/manifest.json
    python3 scripts/audio/measure.py --md       # also rewrite audio/MEASUREMENTS.md

Each file is decoded the way a browser would (ffmpeg honours the MP4 edit list,
as Chrome/Safari/Firefox do) and checked for the defects that make an ambient
app sound cheap. Exit status is non-zero if any check fails.

  seam      what the ear hears across the loop point (last 50 ms -> first 50 ms):
            click  = high-frequency energy in a 2 ms window centred on the seam, as a
                     percentile of every 2 ms window in the loop (a click is an outlier;
                     pass < p99);
            level  = |dB| between the 50 ms either side of the seam, vs. the same
                     measure between neighbouring 50 ms windows elsewhere (pass < p99);
            jump   = |x[0] - x[-1]| as a percentile of all sample-to-sample steps (pass < p99.9).
  loudness  EBU R128 integrated over the loop (pass: within 1 LU of target) and true
            peak (pass: <= -1 dBTP); for the bowl, over the texture as the app plays it.
  clip / dc samples at full scale (pass: 0); per-channel mean (pass: below -60 dBFS).
  repeat    does the loop contain the same material twice? Circular autocorrelation
            of the onset pattern (24 bands, 20 ms, frame-to-frame change) at lags
            from 3 s to half the loop. A loop built from a repeated chunk scores ~1;
            natural material scores near 0, even when its swells recur (waves, gusts).
            Flag > 0.35. `--self-test` proves it fires.
  distinct  for each sound, its nearest neighbour by level-normalised 1/3-octave
            spectrum (mean |dB|), then how far apart the pair is in modulation (how
            the envelope moves) and fine texture (impulsiveness + tonality). A pair
            under 3 dB in spectrum AND under 1 dB in motion AND under 2 dB in texture
            would read as one sound with two names — the defect the old synthesised
            palette shipped with — and fails.
"""
import json
import os
import re
import subprocess
import sys
import tempfile

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
DIST = os.path.join(ROOT, 'audio', 'dist')
MANIFEST = os.path.join(ROOT, 'audio', 'manifest.json')
RECIPE = os.path.join(ROOT, 'audio', 'recipe.json')
OUT_MD = os.path.join(ROOT, 'audio', 'MEASUREMENTS.md')
SR = 48000


def decode(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '2', '-ar', str(SR), '-f', 'f32le', '-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).astype(np.float64)


def ebur128(x):
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, 'm.wav')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '2', '-i', '-', p],
                       input=np.ascontiguousarray(x, dtype=np.float32).tobytes(), check=True)
        err = subprocess.run(['ffmpeg', '-nostats', '-i', p, '-af', 'ebur128=peak=true', '-f', 'null', '-'],
                             capture_output=True, text=True).stderr
    s = err[err.rfind('Summary:'):]
    return (float(re.search(r'I:\s+(-?[\d.]+|-inf) LUFS', s).group(1)),
            float(re.search(r'Peak:\s+(-?[\d.]+|-inf) dBFS', s).group(1)))


def hp_energy(mono, win):
    d = np.diff(mono, n=2)                      # 2nd difference ~ steep high-pass
    n = len(d) // win * win
    return np.mean(d[:n].reshape(-1, win) ** 2, axis=1)


def seam_checks(loop):
    mono = loop.mean(axis=1)
    L = len(mono)
    # click: 2 ms window centred on the seam, in the circular signal
    w = int(0.002 * SR)
    around = np.concatenate([mono[-w:], mono[:w]])
    seam_e = np.mean(np.diff(around, n=2) ** 2)
    all_e = hp_energy(mono, 2 * w)
    click_pct = float(np.mean(all_e < seam_e) * 100)
    # level step across the seam vs. neighbouring windows elsewhere
    v = int(0.05 * SR)
    rms = lambda z: 10 * np.log10(np.mean(z ** 2) + 1e-20)
    seam_step = abs(rms(mono[-v:]) - rms(mono[:v]))
    n = L // v * v
    wins = 10 * np.log10(np.mean(mono[:n].reshape(-1, v) ** 2, axis=1) + 1e-20)
    steps = np.abs(np.diff(wins))
    level_pct = float(np.mean(steps < seam_step) * 100)
    # sample jump
    jump = np.max(np.abs(loop[0] - loop[-1]))
    alls = np.max(np.abs(np.diff(loop, axis=0)), axis=1)
    jump_pct = float(np.mean(alls < jump) * 100)
    return click_pct, seam_step, level_pct, jump_pct


def band_env(x, frame=0.05):
    """8 log-band energies per 50 ms frame (z-scored per band)."""
    mono = x.mean(axis=1)
    hop = int(frame * SR)
    n = len(mono) // hop
    nfft = 4096
    edges = [60, 150, 300, 600, 1200, 2400, 4800, 9600, 20000]
    f = np.fft.rfftfreq(nfft, 1 / SR)
    idx = [(f >= a) & (f < b) for a, b in zip(edges[:-1], edges[1:])]
    win = np.hanning(nfft)
    E = np.zeros((n, 8))
    pad = np.concatenate([mono, mono[:nfft]])
    for i in range(n):
        s = np.abs(np.fft.rfft(pad[i * hop:i * hop + nfft] * win)) ** 2
        E[i] = [10 * np.log10(s[m].sum() + 1e-20) for m in idx]
    return E


def repetition(x, frame=0.02):
    """Does the loop contain the same material twice? Waves, gusts and a drone's
    breathing recur NATURALLY in their slow envelope, so the envelope is the wrong
    thing to compare. A copy repeats its fine detail: every droplet, crackle and
    keystroke onset in the same place. So: 24 log-spaced bands at 20 ms, take the
    frame-to-frame change (onsets; slow swells cancel out), and look for the
    highest circular autocorrelation at any lag from 3 s to half the loop. An
    exact copy scores ~1; independent natural material scores near 0."""
    mono = x.mean(axis=1)
    hop = int(frame * SR)
    n = len(mono) // hop
    nfft = 2048
    f = np.fft.rfftfreq(nfft, 1 / SR)
    edges = np.geomspace(60, 16000, 25)
    idx = [(f >= a) & (f < b) for a, b in zip(edges[:-1], edges[1:])]
    win = np.hanning(nfft)
    pad = np.concatenate([mono, mono[:nfft]])
    frames = np.lib.stride_tricks.sliding_window_view(pad, nfft)[::hop][:n] * win
    S = np.abs(np.fft.rfft(frames, axis=1)) ** 2
    E = np.stack([10 * np.log10(S[:, m].sum(axis=1) + 1e-20) for m in idx], axis=1)
    D = np.diff(np.concatenate([E, E[:1]]), axis=0)      # circular onset sequence
    Z = (D - D.mean(axis=0)) / (D.std(axis=0) + 1e-9)
    Fc = np.fft.rfft(Z, axis=0)
    acc = np.fft.irfft(Fc * np.conj(Fc), n=n, axis=0).sum(axis=1) / (n * Z.shape[1])
    lo, hi = int(3 / frame), n // 2
    seg = acc[lo:hi]
    if not len(seg):
        return 0.0, 0.0
    k = int(np.argmax(seg))
    return float(seg[k]), (lo + k) * frame


def third_octave(x):
    mono = x.mean(axis=1)
    nfft = 8192
    win = np.hanning(nfft)
    acc = np.zeros(nfft // 2 + 1)
    for h in range(0, len(mono) - nfft, nfft):
        acc += np.abs(np.fft.rfft(mono[h:h + nfft] * win)) ** 2
    f = np.fft.rfftfreq(nfft, 1 / SR)
    centers = 50 * 2 ** (np.arange(0, 26) / 3)          # 50 Hz .. 16 kHz
    out = np.array([acc[(f >= c / 2 ** (1 / 6)) & (f < c * 2 ** (1 / 6))].sum() for c in centers])
    s = 10 * np.log10(out + 1e-20)
    return s - s.mean()


def modulation(E):
    """How the envelope moves: per-band std of 50 ms band energy (dB) and mean
    frame-to-frame flux (dB/frame)."""
    return np.concatenate([E.std(axis=0), [np.mean(np.abs(np.diff(E, axis=0)))]])


def texture_vec(x):
    """Fine texture a spectrum cannot see: impulsiveness (99th percentile over the
    median of a 1 ms envelope, dB) in three bands — droplets and crackle score high,
    a smooth wash low — plus tonality (spectral flatness in dB: bubbles and
    voices are tonal, hiss is flat). Rain and a creek share a spectrum; they do not
    share this."""
    mono = x[: 60 * SR].mean(axis=1)
    X = np.fft.rfft(mono)
    f = np.fft.rfftfreq(len(mono), 1 / SR)
    out = []
    for lo, hi in ((300, 1000), (1000, 4000), (4000, 12000)):
        Y = X.copy()
        Y[(f < lo) | (f > hi)] = 0
        y = np.fft.irfft(Y, len(mono))
        env = np.sqrt(np.convolve(y ** 2, np.ones(48) / 48, mode='valid')[::48])
        envdb = 20 * np.log10(env + 1e-12)
        out.append(np.percentile(envdb, 99) - np.median(envdb))
    nfft = 2048
    fr = np.lib.stride_tricks.sliding_window_view(mono, nfft)[::nfft]
    S = np.abs(np.fft.rfft(fr * np.hanning(nfft), axis=1)) ** 2 + 1e-20
    ff = np.fft.rfftfreq(nfft, 1 / SR)
    m = (ff > 200) & (ff < 8000)
    flat = np.exp(np.mean(np.log(S[:, m]), axis=1)) / np.mean(S[:, m], axis=1)
    out.append(10 * np.log10(np.median(flat)))
    return np.array(out)


def hush(colour, seconds=20):
    """Offline twin of the in-browser noise beds (noiseBuffer + the builder's lowpass)."""
    rng = np.random.default_rng(1)
    n = seconds * SR
    w = rng.uniform(-1, 1, n)
    if colour == 'white':
        d = w * 0.5
        cut = 9000
    else:
        # same recurrences as public/index.html noiseBuffer()
        d = np.zeros(n)
        b0 = b1 = b2 = b3 = b4 = b5 = b6 = last = 0.0
        for i in range(n):
            x = w[i]
            if colour == 'pink':
                b0 = 0.99886 * b0 + x * 0.0555179; b1 = 0.99332 * b1 + x * 0.0750759
                b2 = 0.96900 * b2 + x * 0.1538520; b3 = 0.86650 * b3 + x * 0.3104856
                b4 = 0.55000 * b4 + x * 0.5329522; b5 = -0.7616 * b5 - x * 0.0168980
                d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362) * 0.11
                b6 = x * 0.115926
            else:
                last = (last + 0.02 * x) / 1.02
                d[i] = last * 3.5
        cut = 3200 if colour == 'pink' else 900
    # Web Audio up-mixes a mono node to stereo by COPYING it to both channels
    # (L = R = M). ffmpeg's `-ac 2` does not — it spreads a centre channel at
    # -3 dB — so the up-mix is spelled out, or every hush measures 3 dB quiet.
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-f', 'f64le', '-ar', str(SR), '-ac', '1', '-i', '-', '-af',
                          f'lowpass=f={cut},pan=stereo|c0=c0|c1=c0', '-f', 'f32le', '-'],
                         input=np.ascontiguousarray(d).tobytes(), capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).astype(np.float64)


def main():
    manifest = json.load(open(MANIFEST))
    recipe = json.load(open(RECIPE))
    target = recipe['target_lufs']
    rows, fails = [], []
    spectra, mods, textures = {}, {}, {}
    for name, e in manifest['sounds'].items():
        path = os.path.join(DIST, e['file'])
        if not os.path.exists(path):
            fails.append(f'{name}: {e["file"]} missing from audio/dist (run build.py)')
            continue
        x = decode(path)
        dc = 20 * np.log10(np.max(np.abs(x.mean(axis=0))) + 1e-20)
        clip = int(np.sum(np.abs(x) >= 0.999))
        r = {'name': name, 'file': e['file'], 'mb': e['bytes'] / 1e6, 'clip': clip, 'dc': dc}
        if e['kind'] == 'loop':
            a, b = int(round(e['loopStart'] * SR)), int(round(e['loopEnd'] * SR))
            expected = b + int(round(e['loopStart'] * SR))
            r['decoded_delta_ms'] = (len(x) - expected) / SR * 1000
            loop = x[a:b]
            r['seconds'] = len(loop) / SR
            r['click'], r['seam_db'], r['level_pct'], r['jump'] = seam_checks(loop)
            r['lufs'], r['tp'] = ebur128(np.concatenate([loop, loop]))
            E = band_env(loop)
            r['repeat'], r['repeat_lag'] = repetition(loop)
            texture = loop
        else:
            # the bowl, as the app plays it: one strike every texture_interval s
            iv = int(recipe['sounds'][name]['texture_interval'] * SR)
            strikes = [x[int(s['at'] * SR):int((s['at'] + s['dur']) * SR)] for s in e['strikes']]
            texture = np.zeros((iv * 12 + max(len(s) for s in strikes), 2))
            for i in range(12):
                s = strikes[i % len(strikes)]
                texture[i * iv:i * iv + len(s)] += s
            r['seconds'] = len(x) / SR
            r['lufs'], r['tp'] = ebur128(texture)
            _, r['tp'] = ebur128(x)
            r['click'] = r['seam_db'] = r['level_pct'] = r['jump'] = None
            r['repeat'], r['repeat_lag'] = None, None
            r['decoded_delta_ms'] = (len(x) - int(round((e['strikes'][-1]['at'] + e['strikes'][-1]['dur']) * SR))) / SR * 1000
            E = band_env(texture)
        spectra[name] = third_octave(texture)
        mods[name] = modulation(E)
        textures[name] = texture_vec(texture)
        rows.append(r)
    for colour, label in (('brown', 'brown (synth)'), ('pink', 'pink (synth)'), ('white', 'white (synth)')):
        h = hush(colour)
        spectra[label] = third_octave(h)
        mods[label] = modulation(band_env(h))
        textures[label] = texture_vec(h)
    names = list(spectra)
    for r in rows:
        n = r['name']
        best = None
        for m in names:
            if m == n:
                continue
            sd = float(np.mean(np.abs(spectra[n] - spectra[m])))
            md = float(np.mean(np.abs(mods[n] - mods[m])))
            td = float(np.mean(np.abs(textures[n] - textures[m])))
            if best is None or sd < best[1]:
                best = (m, sd, md, td)
        r['nearest'], r['spec_db'], r['mod_db'], r['tex_db'] = best
    # verdicts
    for r in rows:
        f = []
        if abs(r['lufs'] - target) > 1.0:
            f.append(f"loudness {r['lufs']:.1f} LUFS")
        if r['tp'] > -1.0:
            f.append(f"true peak {r['tp']:.1f} dBTP")
        if r['clip']:
            f.append(f"{r['clip']} clipped samples")
        if r['dc'] > -60:
            f.append(f"DC {r['dc']:.0f} dBFS")
        if r['click'] is not None:
            if r['click'] >= 99:
                f.append(f"seam click p{r['click']:.1f}")
            if r['level_pct'] >= 99:
                f.append(f"seam level step p{r['level_pct']:.1f}")
            if r['jump'] >= 99.9:
                f.append(f"seam sample jump p{r['jump']:.2f}")
            if r['repeat'] > 0.35:
                f.append(f"internal repetition {r['repeat']:.2f} at {r['repeat_lag']:.1f} s")
        if abs(r['decoded_delta_ms']) > 60:
            f.append(f"decoded length off by {r['decoded_delta_ms']:.0f} ms")
        if r['spec_db'] < 3.0 and r['mod_db'] < 1.0 and r['tex_db'] < 2.0:
            f.append(f"indistinct from {r['nearest']}")
        r['verdict'] = 'PASS' if not f else 'FAIL: ' + '; '.join(f)
        if f:
            fails.append(f"{r['name']}: {'; '.join(f)}")
    hdr = ('| Sound | File | Loop | Size | LUFS | dBTP | Clip | DC dBFS | Seam click (pctl) | Seam level step dB (pctl) | Seam jump (pctl) '
           '| Repeat (corr @ lag) | Decode Δ | Nearest sound (spectrum / motion / texture, dB) | Verdict |')
    lines = [hdr, '|' + '---|' * 15]
    for r in rows:
        seam = (f"p{r['click']:.0f}", f"{r['seam_db']:.2f} (p{r['level_pct']:.0f})", f"p{r['jump']:.1f}") if r['click'] is not None else ('—', '—', '—')
        rep = f"{r['repeat']:.2f} @ {r['repeat_lag']:.0f} s" if r['repeat'] is not None else 'events'
        lines.append(f"| {r['name']} | `{r['file']}` | {r['seconds']:.0f} s | {r['mb']:.2f} MB | {r['lufs']:.1f} | {r['tp']:.1f} | {r['clip']} | {r['dc']:.0f} "
                     f"| {seam[0]} | {seam[1]} | {seam[2]} | {rep} | {r['decoded_delta_ms']:+.0f} ms | {r['nearest']} ({r['spec_db']:.1f} / {r['mod_db']:.1f} / {r['tex_db']:.1f}) | {r['verdict']} |")
    table = '\n'.join(lines)
    print(table)
    total = sum(r['mb'] for r in rows)
    print(f'\ntotal payload {total:.1f} MB across {len(rows)} files (each fetched only when first played)')
    # presets: each blend's total loudness, as the app mixes it
    pr = presets_report()
    med = sorted(v[0] for v in pr.values())[len(pr) // 2]
    plines = ['| Preset | Mix | LUFS | vs median | Verdict |', '|---|---|---|---|---|']
    for key, (lufs, mix) in pr.items():
        ok = abs(lufs - med) <= 0.5
        if not ok:
            fails.append(f'preset {key}: {lufs:.1f} LUFS, {lufs - med:+.1f} LU from the other blends')
        plines.append(f"| {key} | {', '.join(f'{n} {v}' for n, v in mix.items())} | {lufs:.1f} | {lufs - med:+.1f} | {'PASS' if ok else 'FAIL'} |")
    # the hushes are synthesised in the browser: their levels must give them the
    # same loudness as a recording at RECORDED_LEVEL
    html = open(os.path.join(ROOT, 'public', 'index.html')).read()
    rec_level = float(re.search(r'const RECORDED_LEVEL = ([0-9.]+);', html).group(1))
    want = target + 20 * np.log10(rec_level)
    plines += ['', '| Hush | Level | LUFS | vs a recording | Verdict |', '|---|---|---|---|---|']
    for colour in ('brown', 'pink', 'white'):
        lv = float(re.search(rf"\n  {colour}: +function \(\) \{{.*?level: ([0-9.]+)", html).group(1))
        lufs, _ = ebur128(hush(colour) * lv)
        ok = abs(lufs - want) <= 1.0
        if not ok:
            fails.append(f'hush {colour}: {lufs:.1f} LUFS at level {lv}, recordings sit at {want:.1f}')
        plines.append(f"| {colour} | {lv} | {lufs:.1f} | {lufs - want:+.1f} | {'PASS' if ok else 'FAIL'} |")
    ptable = '\n'.join(plines)
    print('\n' + ptable)
    if '--md' in sys.argv:
        with open(OUT_MD, 'w') as fh:
            fh.write('# Ambient audio — measurements\n\n> Generated by `scripts/audio/measure.py --md`. '
                     'Method and pass thresholds are in that script\'s docstring.\n\n## Files\n\n')
            fh.write(table + '\n\n' + f'Total payload {total:.1f} MB across {len(rows)} files, each fetched only when first played.\n')
            fh.write('\n## Presets (blend loudness, pass within 0.5 LU of the median blend)\n\n' + ptable + '\n')
    if fails:
        print('\nFAILURES:\n  ' + '\n  '.join(fails))
        sys.exit(1)


def presets_report(seconds=60):
    """Integrated loudness of each preset as the app mixes it (layer = file or
    hush twin, x its level x its preset mix value). Presets should land close
    together: picking 'Sleep' after 'Deep work' should not be a volume jump."""
    html = open(os.path.join(ROOT, 'public', 'index.html')).read()
    block = html[html.index('const SOUND_PRESETS = {'):html.index('// ── control ──')]
    presets = {m.group(1): {k: float(v) for k, v in re.findall(r'([a-z]+): ([0-9.]+)', m.group(2))}
               for m in re.finditer(r"\n  ([a-z]+): +\{ label: '[^']*',\s+icon: '[^']*',\s+mix: \{([^}]*)\}", block)}
    hush_level = {k: float(v) for k, v in re.findall(r"\n  (brown|pink|white): +function \(\) \{.*?level: ([0-9.]+)", html)}
    recorded_level = float(re.search(r'const RECORDED_LEVEL = ([0-9.]+);', html).group(1))
    manifest = json.load(open(MANIFEST))
    recipe = json.load(open(RECIPE))
    cache = {}

    def layer(name):
        if name in cache:
            return cache[name]
        if name in hush_level:
            x = np.concatenate([hush(name, 20)] * 3)[: seconds * SR] * hush_level[name]
        else:
            e = manifest['sounds'][name]
            d = decode(os.path.join(DIST, e['file']))
            if e['kind'] == 'loop':
                lp = d[int(e['loopStart'] * SR):int(e['loopEnd'] * SR)]
                x = np.concatenate([lp] * (seconds * SR // len(lp) + 1))[: seconds * SR]
            else:
                iv = int(recipe['sounds'][name]['texture_interval'] * SR)
                x = np.zeros((seconds * SR + 20 * SR, 2))
                st = [d[int(s['at'] * SR):int((s['at'] + s['dur']) * SR)] for s in e['strikes']]
                for i, t in enumerate(range(0, seconds * SR, iv)):
                    s = st[i % len(st)]
                    x[t:t + len(s)] += s
                x = x[: seconds * SR]
            x = x * recorded_level
        cache[name] = x
        return x

    out = {}
    for key, mix in presets.items():
        total = sum(layer(n) * v for n, v in mix.items())
        out[key] = (ebur128(total)[0], mix)
    return out


def self_test():
    """Proof of rejection: each check is fed a loop with exactly the defect it
    exists to catch, and must flag it — and must NOT flag the clean original.
    Uses the shipped rain loop as clean material."""
    manifest = json.load(open(MANIFEST))
    e = manifest['sounds']['rain']
    x = decode(os.path.join(DIST, e['file']))
    clean = x[int(e['loopStart'] * SR):int(e['loopEnd'] * SR)]
    ok = True

    def expect(label, cond):
        nonlocal ok
        print(f"  {'ok  ' if cond else 'FAIL'} {label}")
        ok &= bool(cond)

    c = seam_checks(clean)
    expect(f'clean seam passes (click p{c[0]:.0f}, step p{c[2]:.0f}, jump p{c[3]:.1f})', c[0] < 99 and c[2] < 99 and c[3] < 99.9)
    # naive loop: cut 150 s with no crossfade — the classic cheap-app seam
    naive = x[int(e['loopStart'] * SR):int(e['loopStart'] * SR) + len(clean)].copy()
    naive[-int(0.3 * SR):] *= 0.25                    # a level drop into the cut, as an unmatched cut gives
    c = seam_checks(naive)
    expect(f'unmatched cut is caught (step p{c[2]:.0f})', c[2] >= 99)
    clicky = clean.copy()
    clicky[-1] += 0.3                                 # one-sample discontinuity
    c = seam_checks(clicky)
    expect(f'one-sample click is caught (click p{c[0]:.1f}, jump p{c[3]:.2f})', c[0] >= 99 or c[3] >= 99.9)
    rep, _ = repetition(clean)
    expect(f'clean loop has no recurrence ({rep:.2f})', rep <= 0.35)
    chunk = clean[: 20 * SR]
    tiled = np.concatenate([chunk] * 7)
    rep, lag = repetition(tiled)
    expect(f'20 s chunk tiled 7x is caught ({rep:.2f} at {lag:.1f} s)', rep > 0.35)
    lufs, _ = ebur128(np.concatenate([clean, clean]) * 10 ** (3 / 20))
    expect(f'3 dB hot loop is outside the loudness window ({lufs:.1f} LUFS)', abs(lufs - (-23)) > 1.0)
    s1, s2 = third_octave(clean), third_octave(clean[::-1])
    expect(f'a sound and itself are indistinct ({np.mean(np.abs(s1 - s2)):.2f} dB)', np.mean(np.abs(s1 - s2)) < 3.0)
    print('self-test', 'passed' if ok else 'FAILED')
    return ok


if __name__ == '__main__':
    if '--self-test' in sys.argv:
        sys.exit(0 if self_test() else 1)
    main()

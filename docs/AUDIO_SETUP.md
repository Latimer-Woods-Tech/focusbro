# Ambient audio — how the soundscapes work

> **Third engine.** The first was six labels over three filtered-noise signals
> ("they all sound the same" — literally true). The second synthesised every
> sound from noise, filters and oscillators: distinct, never repeating, and still
> not rain, not a café, not a fire — "they don't sound good, appealing, and other
> apps are better." Every place-sound is now a **recording**. Only the three
> hushes are still synthesised, because noise is noise.

## Where the sounds come from

| Kind | Sounds | Source |
|---|---|---|
| Field recordings | Rain, Ocean, Stream, Forest, Night, Wind, Fireplace, Café, Train | radio aporee ::: maps recordings their recordists dedicated to the **public domain** (mirrored on the Internet Archive as Public Domain Mark 1.0) |
| Generated recordings | Keys, Fan, Bowl strikes | ElevenLabs Sound Effects on our paid plan (commercial use permitted); takes archived in R2 under `sources/elevenlabs/` |
| Rendered from code | Drone | `synth_drone()` in `scripts/audio/build.py` — exactly periodic over the loop, so it has no seam at all (CC0, ours) |
| Synthesised live | Deep / Soft / Bright hush | `noiseBuffer()` in `public/index.html` |

`audio/SOURCES.md` has one row per shipped file: archive item, author, licence,
md5 of the original, the exact segment used and every processing step. Rejected
on licence grounds: anything CC-BY-NC or "personal use", Pixabay, BBC RemArc,
Sonniss bundles, and every item whose uploader could not plausibly be the author
(several "CC0" archive.org items are rips of commercial libraries).

## The pipeline (`scripts/audio/`)

```
audio/recipe.json ──build.py──► audio/dist/<name>.<sha10>.m4a   (R2, not git)
                               audio/manifest.json, audio/SOURCES.md,
                               public/index.html  // <audio-manifest> block
audio/dist ──measure.py──► audio/MEASUREMENTS.md  (non-zero exit on any failure)
```

```bash
python3 scripts/audio/build.py            # needs ffmpeg + numpy; downloads originals, md5-checks them
python3 scripts/audio/measure.py --md     # file checks + preset balance
python3 scripts/audio/measure.py --self-test   # proves each check fires on the defect it exists for
(cd api && node e2e/measure-sounds.mjs)   # Chromium decode + engine balance, against audio/dist
node create-html-module.js                # then upload (below) and commit manifest/SOURCES/MEASUREMENTS/index.html
```

Every loop is mastered the same way, aimed at the things that make a cheap
sound app sound cheap:

- **Cut from the steadiest stretch** of the recording (no single memorable event
  marks the repeat), 1.5–2.5 minutes long (Fan: 60 s, see below).
- **High-passed** per source (wind rumble, handling noise, DC).
- **Equal-power crossfade** of the tail into the head (6–8 s), so the seam has no
  click and no dip in level.
- **One second of circular padding each side.** The app loops between
  `loopStart` and `loopEnd`; AAC encoder priming, end padding and the codec's
  boundary smearing all land in audio that is never played. Measured in Chromium:
  every file decodes to exactly the expected length and every seam is an
  ordinary sample step.
- **-23 LUFS integrated, true peak ≤ -1 dBTP.** Where a recording's transients
  needed it (rain droplets, fire crackle, keystrokes) a limiter ran *circularly*
  (the loop tiled three times, the middle copy kept) so its state is continuous
  across the seam; build.py logs how much of each file it touched (under 1% of
  10 ms windows for every file).
- AAC-LC 160 kb/s, 48 kHz stereo `.m4a` — plays in iOS Safari and Android Chrome.

Special cases: **Keys** is four generated takes of one keyboard joined with
1.5 s crossfades (114 s). **Fan** is one 30 s take played forward then reversed:
stationary airflow reads identically backwards, the turns are sample-continuous,
and the period doubles to 60 s. **Bowl** is three strikes in one file; the app
schedules them at random 14–26 s gaps, never the same strike twice running, each
with a little level and pan variation — nothing in it repeats.

## Hosting

R2 bucket `focusbro-audio` (binding `AUDIO` in `wrangler.toml`, top level and
`[env.production]`), served by `GET /audio/<name>.<sha10>.m4a`
(`api/src/audio.js`): `Content-Type: audio/mp4`, `Accept-Ranges: bytes` with 206
range support, `Cache-Control: public, max-age=31536000, immutable` (the name is
the content hash), 404 on a miss or on any name not of that shape — the
`sources/` takes are unreachable from the web. Same-origin, so the CSP's
`connect-src 'self'` covers the fetch. Upload:

```bash
for f in audio/dist/*.m4a; do
  npx wrangler r2 object put "focusbro-audio/$(basename "$f")" --file "$f" --remote \
    --content-type audio/mp4 --cache-control "public, max-age=31536000, immutable"
done
```

## The engine

A sound is fetched the first time it is played (the tile pulses while it loads),
decoded, and looped through the same per-layer gain → master limiter → media
element path as before. The layer exists the instant it is tapped — it is in the
mix, lit, seen by the ritual and by sharing — and fades in when the audio
arrives. If the file cannot load, the tile says so and the layer leaves the mix.

Memory: a decoded 150 s stereo loop is ~55 MB of PCM, so only the four most
recently used are kept decoded; the compressed bytes are kept regardless and the
file is immutable in the HTTP cache (and the service worker's), so a sound coming
back costs a decode, not a download.

Unchanged and still load-bearing: presets, the ritual (`fb_sound_follow`),
shareable mixes and `?sound=` / `?preset=` links (one tap, never autoplay), Media
Session, the visibilitychange resume, and the output route — master bus →
`MediaStreamAudioDestinationNode` → `<audio id="soundscapeOut">`. That media
element is what a phone treats as playing media (lock screen, background
playback) and what the Android app's foreground service detects; the smoke test
asserts it is playing when a sound starts.

## Loudness

Every file is -23 LUFS; `RECORDED_LEVEL` (1.41, +3 dB) puts the default volume
where the previous engine sat (about -26 LUFS at 50%), and the hush levels are
set so each hush matches a recording at that level (measured on an offline twin
of the generator — `measure.py` gates it within 1 LU). Switching sounds is never
a volume jump and a preset's mix values are plain relative levels. Preset totals
are measured and matched (all six within 0.2 LU). The master limiter sits at
-3 dBFS with a 120 ms release: one layer at the default volume peaks near
-4 dBFS and never touches it. (It was -8 dB / 250 ms, which on recordings would
have ducked the whole bed after every raindrop.)

A trap worth writing down: ffmpeg's `-ac 2` up-mixes mono at -3 dB per channel;
Web Audio copies mono to both channels at full level. The hush twin spells the
up-mix out (`pan=stereo|c0=c0|c1=c0`), or every hush measures 3 dB quiet.

## What the measurements do and do not prove

Nobody building this can listen to it, so `measure.py` checks the defects that
can be measured: seam clicks and level steps, loudness and peaks, clipping, DC,
copied material inside a loop, and whether any two sounds are near-identical in
spectrum, motion and fine texture. It cannot tell you whether a recording is
*pleasant*, whether a bird call becomes irritating on the fortieth hearing, or
whether the café's murmur feels like company. Those need ears; the founder's
listening pass is the remaining gate.

## The hushes

`noiseBuffer(colour)` builds one 30 s buffer per colour and crossfades the
generator's own continuation into its head, so the loop point is one more step
of the same noise. Before, brown noise jumped at the wrap by about its own
standard deviation — a tick every 30 s (`noise-loop-seam.test.js` fails on that
version).

## The breathing pacer's swell (guide pages)

Unchanged: the box and 4-7-8 guides synthesise an ocean swell locked to the
breath (`BREATH_SCRIPT` in `api/src/guides/scripts.js`), measured by
`node e2e/measure-swell.mjs`.

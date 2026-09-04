# Ambient audio — how the soundscapes work

> **This file used to describe an ElevenLabs generation pipeline that produced
> four MP3s at build time. That pipeline never ran.** The four files it named
> (`public/audio/{rain,forest,cafe,ocean}.mp3`) were committed as 170-byte
> stubs, they returned 404 in production for the whole life of the feature, and
> the only code that read them (`playAmbientAudio`) had no callers. Both the
> stubs and that code were removed. There is no build-time audio step and no
> `ELEVENLABS_API_KEY` in this repo.

## The engine

Every soundscape is **synthesised in the browser** with the Web Audio API. No
audio files ship, and nothing is fetched at runtime.

That is a deliberate choice, not a shortcut:

- **A loop becomes wallpaper.** A ten-minute bed still repeats, and a brain that
  filters out repetition stops hearing it — the same reason the check-in copy
  rotates instead of repeating (`checkin-prompt-rotation.test.js`). Synthesis
  never repeats, so it stays audible without ever demanding attention.
- **Zero bytes.** The app is one Worker-served HTML string. Sixteen ten-minute
  beds would be ~100 MB in R2 plus a fetch on every play.
- **Layers are free.** Because each source is a graph rather than a file, they
  combine — sixteen sources make far more than sixteen soundscapes.

## What was wrong before

The previous implementation was one table:

```js
rain:       { type: 'brown', filterFreq: 800  }
fireplace:  { type: 'brown', filterFreq: 400  }
ocean:      { type: 'brown', filterFreq: 600  }
cafe:       { type: 'pink',  filterFreq: 2000 }
forest:     { type: 'pink',  filterFreq: 1200 }
whitenoise: { type: 'white', filterFreq: 8000 }
```

Six labels over **three signals** — a 2-second noise loop through a single
lowpass. Rain, fireplace and ocean were the same sound at three cutoffs. The
founder's report ("they all sound the same") was literally accurate.

## Structure

| Piece | What it does |
|---|---|
| `noiseBuffer(colour)` | One shared 30-second white/pink/brown buffer, generated once |
| `noiseSource(colour)` | A looping view of that buffer at a random offset, so two layers never correlate |
| `burst()` | Short band-passed noise transient — a droplet, a crackle, a cup, a keypress |
| `chirp()` | Swept sine — birdsong, a bubble |
| `struck()` | Inharmonic partials with long decay — a singing bowl |
| `lfo()` | Slow modulation — the ocean swell, the fan blade, the breeze |
| `addJob()` | Places events on the **audio** clock with lookahead; `setInterval` jitter is audible on a crackle |
| `getMaster()` | A brick-wall `DynamicsCompressor`. Layering must never clip or hurt — this is hearing protection, not tone |

A bed alone is a hush. What makes a source *that place* is its events: rain has
droplets and rare thunder, fire has crackle and settling logs, café has drifting
formants and the occasional cup, forest has sparse birdsong.

**Anything event-driven must speak the moment it is tapped** (`addJob(..., true)`).
The bowl strikes every 11–26 seconds; without an immediate first strike, tapping
it did nothing for up to half a minute and read as broken.

## The gate

`api/src/__tests__/soundscape-distinctness.test.js` is what was missing before.
It asserts the palette is broad, that no UI button lacks a builder, that
event-driven sources actually schedule events, that slow sources modulate, that
the limiter is present, and — the proof-of-rejection — that **no two sources
reduce to the same synthesis shape with different numbers**. Five of its seven
cases fail against the previous implementation.

## Measuring it

`docs/` carries no audio fixtures; verify by measurement instead. Drive the page
in headless Chromium, tap each source through an `AnalyserNode` on the master
bus, and compare mean spectra (mean |Δ dB| across bins) plus temporal flux
(dB/frame — how alive a texture is; a static bed reads near zero). Two sources
under ~2 dB apart with low flux will sound the same to a listener regardless of
what they are named.

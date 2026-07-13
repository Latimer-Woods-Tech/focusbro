# 🎵 FocusBro Audio Generation Setup

## Overview

FocusBro uses ElevenLabs API to generate ambient audio files for meditation and focus sessions. This guide explains how to set up and configure audio generation.

## Audio Types Generated

The system generates 4 ambient audio files:

| Audio Type | Description | Use Cases |
|-----------|-------------|-----------|
| **rain.mp3** | Gentle rain sounds with ambient atmosphere | Meditation, Sleep, Focus |
| **forest.mp3** | Forest ambience with birds and rustling | Meditation, Concentration |
| **cafe.mp3** | Café background noise with subtle music | Focus sessions, Productivity |
| **ocean.mp3** | Ocean waves with seagulls and sea sounds | Meditation, Relaxation |

Each file is **10 minutes** long and designed to loop seamlessly.

## Setup Instructions

### 1. Get ElevenLabs API Key

1. Go to [https://elevenlabs.io/](https://elevenlabs.io/)
2. Sign up or log in to your account
3. Navigate to **Account → API Keys**
4. Copy your API key (should start with `sk_` or similar)

### 2. Add to GitHub Secrets

1. Go to your GitHub repository: [focusbro settings](https://github.com/adrper79-dot/focusbro/settings/secrets/actions)
2. Click **"New repository secret"**
3. Create secret with:
   - **Name:** `ELEVENLABS_API_KEY`
   - **Value:** (paste your API key from step 1)
4. Click **Add secret**

### 3. Deploy with Audio Generation

The deployment workflow now automatically:
1. Detects the `ELEVENLABS_API_KEY` secret
2. Runs audio generation script
3. Generates all 4 ambient audio files
4. Embeds them into the deployment
5. Uploads to Cloudflare

**Simply push to main branch:**
```bash
git add .
git commit -m "🎵 Audio generation enabled"
git push origin main
```

GitHub Actions will:
- ✅ Generate all audio files
- ✅ Build HTML module with audio references  
- ✅ Deploy to Cloudflare Workers
- ✅ Purge cache
- ✅ Go live

### 4. Fallback Mode

If `ELEVENLABS_API_KEY` is not set or API fails:
- Script automatically creates placeholder MP3 files
- Audio playback code continues to work
- Users get silent/minimal audio (graceful degradation)
- No deployment failures

## Manual Audio Generation

### Generate Locally

If you want to generate or update audio files locally:

```bash
# With ElevenLabs API key
export ELEVENLABS_API_KEY="sk_..."
node scripts/generate-audio-elevenlabs.js
```

### Using Alternative Sources

If you prefer other audio sources:

1. **Zapsplat.com** (Free, requires login)
   - Download rain, forest, café, ocean ambience
   - Save to `public/audio/`

2. **Freesound.org** (Free, requires account)
   - Search for "ambient rain", "forest ambience", etc.
   - Download MP3 format

3. **Archive.org** (Free, no account)
   - Search ambient/soundscape collections
   - Download and format as needed

### Manual Replacement

If using other sources:
```bash
# Copy your audio files
cp your-audio/rain.mp3 public/audio/rain.mp3
cp your-audio/forest.mp3 public/audio/forest.mp3
cp your-audio/cafe.mp3 public/audio/cafe.mp3
cp your-audio/ocean.mp3 public/audio/ocean.mp3

# Rebuild and deploy
node create-html-module.js
npx wrangler deploy --env production
```

## How It Works

### Audio Generation Flow

```
GitHub Push (main branch)
    ↓
[Workflow Triggered]
    ↓
[Install dependencies]
    ↓
[Generate Audio] ← Uses ELEVENLABS_API_KEY
    ↓
    ├─ rain.mp3 ✅
    ├─ forest.mp3 ✅
    ├─ cafe.mp3 ✅
    └─ ocean.mp3 ✅
    ↓
[Build HTML module] ← Embeds audio references
    ↓
[Deploy Frontend] → Cloudflare Workers
    ↓
[Deploy API] → Cloudflare Workers
    ↓
[Purge Cache] → Clear CDN
    ↓
🎉 Live with Audio!
```

### Audio Playback in Features

**Meditation:**
```javascript
// Automatically plays ambient audio during meditation
startMeditation('bodyscan'); // Plays forest.mp3
startMeditation('mindfulness'); // Plays ocean.mp3
```

**Movement:**
```javascript
// Plays ambient during exercise breaks
startExercise('yoga'); // Plays forest.mp3
```

**Sleep Tracker:**
```javascript
// Plays calming audio for sleep logging
logSleep(); // Optional audio playback
```

### Audio Configuration

Audio settings in `public/index.html`:

```javascript
function playAmbientAudio(type) {
  const audio = new Audio(`/audio/${type}.mp3`);
  audio.loop = true;              // Seamless looping
  audio.volume = 0.3;             // 30% volume (non-intrusive)
  audio.play().catch(e => 
    console.warn('Audio play failed:', e)
  );
  ambientAudioPlayers[type] = audio;
}
```

## Troubleshooting

### Audio Files Not Downloaded

**Problem:** Deployment succeeds but audio doesn't play

**Solutions:**
1. Check GitHub Actions log for audio generation step
2. Verify `ELEVENLABS_API_KEY` secret exists in repo settings
3. Confirm API key is still valid (not expired)
4. Check browser console for audio playback errors

### API Key Issues

**Problem:** Audio generation fails during deployment

**Solutions:**
1. Verify secret name is exactly `ELEVENLABS_API_KEY`
2. Confirm API key has permission for sound generation
3. Check ElevenLabs account has active credits
4. Try creating new API key in ElevenLabs dashboard

### Placeholder Audio Playing

**Problem:** Hearing nothing or minimal audio

**This is expected behavior** when:
- `ELEVENLABS_API_KEY` not set → Uses placeholders
- API unreachable → Falls back to minimal files
- Audio generation disabled

**To fix:** Set up GitHub secret and redeploy

## Advanced Configuration

### Customize Audio Prompts

Edit `scripts/generate-audio-elevenlabs.js`:

```javascript
const AUDIO_CONFIGS = {
  rain: {
    name: 'Rain Ambience',
    prompt: 'Your custom description here',
    duration: 600, // 10 minutes
  },
  // ... more types
};
```

### Change Audio Volume

Edit `public/index.html` in `playAmbientAudio()`:

```javascript
audio.volume = 0.5;  // Change from 0.3 to 0.5 (50%)
```

### Add New Audio Types

1. Add to `AUDIO_CONFIGS` in script
2. Add to features in `public/index.html`
3. Redeploy

Example:
```javascript
thunder: {
  name: 'Thunderstorm Ambience',
  prompt: 'Create a dramatic but calming thunderstorm...',
  duration: 600,
}
```

## Performance Notes

- Audio files are **cached by Cloudflare CDN**
- Files serve from regional edge servers (fast load)
- ~10-15 MB per 10-minute MP3 at 128 kbps
- Total: ~40-60 MB for all 4 audio types
- No impact on deployment size (served separately)

## Next Steps

1. ✅ Set GitHub secret: `ELEVENLABS_API_KEY`
2. ✅ Push to trigger deployment
3. ✅ Wait for audio generation
4. ✅ Test meditation features
5. ✅ Verify audio playback in browser

---

**Questions?** Check the logs:
- GitHub Actions: https://github.com/adrper79-dot/focusbro/actions
- Browser Console: F12 → Console tab (for audio errors)
- Cloudflare: https://dash.cloudflare.com/ → Workers logs

# AegisLink — In-App Sound Assets

This directory contains short synthetic tones for in-app feedback events.
All files are referenced by `mobile/src/hooks/useSoundFX.ts`.

## Required files

| File | Event | Duration | Synthesis spec |
|------|-------|----------|----------------|
| `msg_sent.mp3` | Message sent confirmation | ~100 ms | Sine wave 880 Hz, linear fade-out, -12 dBFS peak |
| `msg_received.mp3` | Incoming message notification | ~150 ms | Sine wave 660 Hz, short attack + decay, -14 dBFS peak |
| `call_incoming.mp3` | Ringing loop for incoming call | ~2 s (loopable) | Two-tone ring (480 Hz + 620 Hz), repeating pattern, -10 dBFS |
| `call_connected.mp3` | Call established | ~200 ms | Ascending two-note chord (440 Hz → 660 Hz), soft attack, -14 dBFS |
| `call_ended.mp3` | Call finished or declined | ~150 ms | Descending two-tone (660 Hz → 440 Hz), slight fade, -14 dBFS |

## Format requirements

- **Container**: MP3 (MPEG-1 Audio Layer III)
- **Sample rate**: 44 100 Hz
- **Channels**: Mono (1 channel)
- **Bit rate**: 128 kbps
- **Encoding**: Constant bit rate (CBR)
- **Normalization**: Peak between -14 dBFS and -10 dBFS so tones are audible
  without being jarring

## Generation tool suggestions

Any of the following free tools can produce these files:

- **Audacity** (GUI): Generate > Tone, then export as MP3
- **SoX** (CLI): `sox -n -r44100 -c1 msg_sent.mp3 synth 0.1 sine 880 fade 0 0.1 0.05`
- **ffmpeg** (CLI):
  ```
  ffmpeg -f lavfi -i "sine=frequency=880:duration=0.1" -ar 44100 -ac 1 msg_sent.mp3
  ```
- **Python / pydub**: programmatic synthesis from NumPy arrays

## Style guide

- Minimalist, synthetic — no percussion, no voice, no ambient noise
- Closest reference tones: Signal (iOS), Threema
- Call ring must loop cleanly without a click at the loop boundary
  (fade last 20 ms to silence before the loop point)
- All tones must pass through a high-pass filter at 100 Hz to remove
  sub-bass that vibrates speaker grills on cheap Android devices

## Placement note

These files are **not tracked by git** (see `.gitignore`). Developers must
generate or source them manually when setting up the project. The app
gracefully degrades to haptics-only when the files are absent (e.g., in the
Expo Go simulator or CI).

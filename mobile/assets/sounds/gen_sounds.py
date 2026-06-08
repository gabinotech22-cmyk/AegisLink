"""
Generate AegisLink in-app sound effects.
Spec: assets/sounds/README.md

Design language (v2 — "calm / secure"):
  - Soft BELL / glass timbre via additive synthesis (a few decaying partials
    under an exponential amplitude envelope) instead of raw sine beeps.
  - Only CONSONANT musical intervals from an A-major pentatonic palette
    (A C# E F#). No close-frequency pairs — the old ringback beat (440+480 Hz)
    and the dissonant 480+620 ring are gone.
  - Gentle attacks + long tails so nothing is piercing or "buzzy".

Run once: python gen_sounds.py
Requires: numpy (pip install numpy), ffmpeg in PATH
"""
import os
import wave
import subprocess
import numpy as np

SR = 44100
OUTDIR = os.path.dirname(os.path.abspath(__file__))

# ── A-major pentatonic palette (Hz) ──────────────────────────────────────────
A4, Cs5, E5, Fs5, A5 = 440.00, 554.37, 659.25, 739.99, 880.00
E4 = 329.63


def bell(freq: float, duration_s: float, decay: float = 7.0,
         partials=(1.0, 2.0, 3.01, 4.2), amps=(1.0, 0.45, 0.22, 0.10)) -> np.ndarray:
    """Soft glass-bell tone: a handful of partials under an exponential decay.

    `decay` is the e-folding rate (higher = shorter tail). A 5 ms raised-cosine
    attack removes the click; the exponential tail makes it ring like a chime.
    """
    n = int(SR * duration_s)
    t = np.linspace(0, duration_s, n, endpoint=False)
    sig = np.zeros(n, dtype=np.float64)
    for p, a in zip(partials, amps):
        sig += a * np.sin(2 * np.pi * freq * p * t)
    env = np.exp(-decay * t)
    # 5 ms raised-cosine attack
    a_n = int(0.005 * SR)
    if a_n > 0:
        env[:a_n] *= 0.5 * (1 - np.cos(np.linspace(0, np.pi, a_n)))
    return sig * env


def soft_tone(freq: float, duration_s: float, attack_s: float, release_s: float,
              freq2: float | None = None) -> np.ndarray:
    """Pure, smooth sine swell (optionally a consonant 2nd voice) with cosine
    attack/release — used for the ringback so there is NO beating."""
    n = int(SR * duration_s)
    t = np.linspace(0, duration_s, n, endpoint=False)
    sig = np.sin(2 * np.pi * freq * t)
    if freq2 is not None:
        sig = 0.6 * sig + 0.4 * np.sin(2 * np.pi * freq2 * t)
    env = np.ones(n)
    a = int(attack_s * SR)
    r = int(release_s * SR)
    if a > 0:
        env[:a] = 0.5 * (1 - np.cos(np.linspace(0, np.pi, a)))
    if r > 0:
        env[-r:] = 0.5 * (1 + np.cos(np.linspace(0, np.pi, r)))
    return sig * env


def place(buf: np.ndarray, sig: np.ndarray, at_s: float) -> None:
    """Mix `sig` into `buf` starting at `at_s` seconds (additive, clipped to len)."""
    s = int(at_s * SR)
    e = min(s + len(sig), len(buf))
    if s < len(buf):
        buf[s:e] += sig[: e - s]


def to_mp3(sig: np.ndarray, name: str, volume_db: float) -> None:
    # Normalise to peak = 1.0 so volume_db maps to dBFS peak.
    peak = float(np.max(np.abs(sig)))
    if peak > 0:
        sig = sig / peak

    wav_path = os.path.join(OUTDIR, name + '.wav')
    mp3_path = os.path.join(OUTDIR, name + '.mp3')

    pcm = (sig * 32767).astype(np.int16)
    with wave.open(wav_path, 'w') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes(pcm.tobytes())

    subprocess.run(
        [
            'ffmpeg', '-y', '-i', wav_path,
            # gentle low-pass to shave any harshness off the top end
            '-af', f'lowpass=f=7000,volume={volume_db}dB',
            '-ar', '44100', '-ac', '1', '-b:a', '128k',
            mp3_path,
        ],
        capture_output=True,
        check=True,
    )
    os.remove(wav_path)
    size = os.path.getsize(mp3_path)
    print(f'  {name}.mp3  {size:,} bytes')


def main() -> None:
    print('Generating AegisLink sound effects (v2 calm/secure)...\n')

    # ── msg_sent ─────────────────────────────────────────────────────────────
    # Single soft pluck, E5, quick tail. Subtle "tick".
    sig = bell(E5, 0.22, decay=16.0)
    to_mp3(sig, 'msg_sent', -13)

    # ── msg_received ─────────────────────────────────────────────────────────
    # Friendly rising major third A4 -> C#5, two soft bells slightly overlapped.
    buf = np.zeros(int(SR * 0.55), dtype=np.float64)
    place(buf, bell(A4, 0.30, decay=10.0), 0.00)
    place(buf, bell(Cs5, 0.34, decay=9.0), 0.12)
    to_mp3(buf, 'msg_received', -13)

    # ── call_incoming ────────────────────────────────────────────────────────
    # Calm looping ringtone: ascending A-major arpeggio of soft bells (A C# E),
    # a bright cap (A5), then a rest. ~2.6 s, ends in silence -> click-free loop.
    buf = np.zeros(int(SR * 2.6), dtype=np.float64)
    place(buf, bell(A4, 0.7, decay=6.0), 0.00)
    place(buf, bell(Cs5, 0.7, decay=6.0), 0.18)
    place(buf, bell(E5, 0.7, decay=6.0), 0.36)
    place(buf, bell(A5, 0.9, decay=5.0), 0.54)
    to_mp3(buf, 'call_incoming', -9)

    # ── call_ringback ────────────────────────────────────────────────────────
    # Smooth consonant swell (E4 + A4, a clean perfect fifth — no beating),
    # 1.2 s on / 1.6 s silence. Loops cleanly: ring first, ends in silence.
    ring = soft_tone(E4, 1.2, attack_s=0.12, release_s=0.25, freq2=A4)
    silence = np.zeros(int(SR * 1.6), dtype=np.float64)
    sig = np.concatenate([ring, silence])
    to_mp3(sig, 'call_ringback', -12)

    # ── call_connected ───────────────────────────────────────────────────────
    # "Secured" ascending chime A4 -> E5 -> A5, soft bells.
    buf = np.zeros(int(SR * 0.6), dtype=np.float64)
    place(buf, bell(A4, 0.22, decay=14.0), 0.00)
    place(buf, bell(E5, 0.22, decay=13.0), 0.09)
    place(buf, bell(A5, 0.30, decay=10.0), 0.18)
    to_mp3(buf, 'call_connected', -13)

    # ── call_ended ───────────────────────────────────────────────────────────
    # Gentle descending E5 -> A4, soft and unobtrusive.
    buf = np.zeros(int(SR * 0.5), dtype=np.float64)
    place(buf, bell(E5, 0.20, decay=15.0), 0.00)
    place(buf, bell(A4, 0.28, decay=12.0), 0.10)
    to_mp3(buf, 'call_ended', -14)

    print('\nAll sounds generated.')


if __name__ == '__main__':
    main()

"""
Generate AegisLink in-app sound effects.
Spec: assets/sounds/README.md

Run once: python gen_sounds.py
Requires: numpy (pip install numpy), ffmpeg in PATH
"""
import os
import wave
import subprocess
import numpy as np

SR = 44100
OUTDIR = os.path.dirname(os.path.abspath(__file__))


def gen_sine(freq: float, duration_s: float) -> np.ndarray:
    t = np.linspace(0, duration_s, int(SR * duration_s), endpoint=False)
    return np.sin(2 * np.pi * freq * t)


def apply_fade(sig: np.ndarray, attack_s: float = 0.0, decay_s: float = 0.0) -> np.ndarray:
    sig = sig.copy()
    a = int(SR * attack_s)
    d = int(SR * decay_s)
    if a > 0:
        sig[:a] *= np.linspace(0, 1, a)
    if d > 0:
        sig[-d:] *= np.linspace(1, 0, d)
    return sig


def to_mp3(sig: np.ndarray, name: str, volume_db: float) -> None:
    # Normalize to peak = 1.0 so volume_db maps exactly to dBFS peak
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
            '-af', f'volume={volume_db}dB',
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
    print('Generating AegisLink sound effects...\n')

    # ── msg_sent ────────────────────────────────────────────────────────────────
    # 880 Hz sine, 100 ms, linear fade-out, -12 dBFS peak
    sig = apply_fade(gen_sine(880, 0.10), attack_s=0.005, decay_s=0.060)
    to_mp3(sig, 'msg_sent', -12)

    # ── msg_received ────────────────────────────────────────────────────────────
    # 660 Hz sine, 150 ms, short attack + decay, -14 dBFS peak
    sig = apply_fade(gen_sine(660, 0.15), attack_s=0.015, decay_s=0.055)
    to_mp3(sig, 'msg_received', -14)

    # ── call_incoming ───────────────────────────────────────────────────────────
    # Two-tone ring (480 Hz + 620 Hz), ~2 s loopable, repeating pattern, -10 dBFS
    # Pattern: ring 0–0.4 s, silence 0.4–0.6 s, ring 0.6–1.0 s,
    #          silence 1.0–1.4 s, ring 1.4–1.8 s, silence 1.8–2.0 s
    # The file ends in silence so the loop point is click-free.
    n_total = int(SR * 2.0)
    sig = np.zeros(n_total, dtype=np.float64)
    fade_n = int(0.020 * SR)  # 20 ms fade on each burst edge
    for start_s, end_s in [(0.0, 0.4), (0.6, 1.0), (1.4, 1.8)]:
        s, e = int(start_s * SR), int(end_s * SR)
        t = np.linspace(0, end_s - start_s, e - s, endpoint=False)
        burst = 0.5 * np.sin(2 * np.pi * 480 * t) + 0.5 * np.sin(2 * np.pi * 620 * t)
        burst[:fade_n] *= np.linspace(0, 1, fade_n)
        burst[-fade_n:] *= np.linspace(1, 0, fade_n)
        sig[s:e] = burst
    to_mp3(sig, 'call_incoming', -10)

    # ── call_ringback ───────────────────────────────────────────────────────────
    # 440 Hz + 480 Hz classic ringback, 1.5 s ring / 1.5 s silence, -12 dBFS
    # Loops cleanly: file starts with the ring burst and ends in silence.
    ring = 0.5 * gen_sine(440, 1.5) + 0.5 * gen_sine(480, 1.5)
    ring = apply_fade(ring, attack_s=0.020, decay_s=0.025)
    silence = np.zeros(int(SR * 1.5), dtype=np.float64)
    sig = np.concatenate([ring, silence])
    to_mp3(sig, 'call_ringback', -12)

    # ── call_connected ──────────────────────────────────────────────────────────
    # Ascending two-note: 440 Hz (90 ms) → 660 Hz (110 ms), soft attack, -14 dBFS
    s1 = apply_fade(gen_sine(440, 0.09), attack_s=0.020, decay_s=0.020)
    s2 = apply_fade(gen_sine(660, 0.11), attack_s=0.020, decay_s=0.025)
    sig = np.concatenate([s1, s2])
    to_mp3(sig, 'call_connected', -14)

    # ── call_ended ──────────────────────────────────────────────────────────────
    # Descending two-tone: 660 Hz (75 ms) → 440 Hz (75 ms), slight fade, -14 dBFS
    s1 = apply_fade(gen_sine(660, 0.075), attack_s=0.010, decay_s=0.015)
    s2 = apply_fade(gen_sine(440, 0.075), attack_s=0.010, decay_s=0.020)
    sig = np.concatenate([s1, s2])
    to_mp3(sig, 'call_ended', -14)

    print('\nAll sounds generated.')


if __name__ == '__main__':
    main()

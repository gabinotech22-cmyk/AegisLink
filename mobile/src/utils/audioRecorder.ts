import { Audio } from 'expo-av';

/**
 * Process-wide Audio.Recording singleton.
 *
 * expo-av allows only ONE prepared `Audio.Recording` per JS process. More than
 * one screen records audio — `VoiceRecorder` (normal voice notes) and
 * `ViewOnceSend` (ephemeral audio). When one screen unmounts mid-recording its
 * async `stopAndUnloadAsync()` may not finish before another screen calls
 * `prepareToRecordAsync()`, which then throws:
 *
 *   "Only one Recording object can be prepared at a given time."
 *
 * In dev this is masked because Fast Refresh resets module state and tears down
 * the native session; in a release build the orphaned native recorder survives,
 * so the next recording attempt on a *different* screen fails hard.
 *
 * A single module-level reference that every recording screen shares lets any
 * screen release the orphan left by any other before preparing its own.
 */
let activeRecording: Audio.Recording | null = null;

/** Register the recorder a screen just prepared so others can release it. */
export function setActiveRecording(rec: Audio.Recording | null): void {
  activeRecording = rec;
}

/** Stop + unload any recorder left prepared by this or another screen. */
export async function releaseActiveRecording(): Promise<void> {
  if (activeRecording) {
    try { await activeRecording.stopAndUnloadAsync(); } catch { /* already gone */ }
    activeRecording = null;
  }
}

/**
 * Prepare + start a recording, releasing any orphaned recorder first and
 * retrying once after resetting the audio session if expo-av still reports the
 * single-recorder lock as held. Returns the started recording, already
 * registered as the active one.
 */
export async function acquireRecording(
  options: Audio.RecordingOptions = Audio.RecordingOptionsPresets.HIGH_QUALITY,
): Promise<Audio.Recording> {
  await releaseActiveRecording();
  await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
  const rec = new Audio.Recording();
  try {
    await rec.prepareToRecordAsync(options);
  } catch {
    // A stale native recorder survived (process-level singleton still bound).
    // Reset the audio session and retry once.
    await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
    await new Promise<void>((r) => setTimeout(r, 150));
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
    await rec.prepareToRecordAsync(options);
  }
  await rec.startAsync();
  activeRecording = rec;
  return rec;
}

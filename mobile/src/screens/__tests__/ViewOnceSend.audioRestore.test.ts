/**
 * ViewOnceSendScreen — stopAudioRecording audio-session restore regression
 * (iOS audit fix #4, branch fix/ios-audit-batch).
 *
 * Same underlying bug as VoiceRecorder.tsx (see
 * VoiceRecorder.test.tsx's "audio session restore" suite for the full
 * behavioural coverage of the identical fix): without restoring
 * `allowsRecordingIOS: false` after stopping a recording, sending an
 * ephemeral (view-once) audio note without ever tapping Preview leaves the
 * iOS audio session stuck in recording mode for the rest of the app
 * session — all later audio (including notification sound FX) routes
 * through the earpiece instead of the speaker.
 *
 * ViewOnceSendScreen has no existing render-level test harness (no prior
 * ViewOnceSend.test.tsx) and pulls in a materially larger mocking surface
 * than VoiceRecorder.tsx (react-native-view-shot, expo-image-manipulator,
 * socket/client, store/identity, store/messages, PanResponder-driven
 * drawing canvas) to reach a full RNTL render. Given the fix itself is a
 * one-line `finally` restore identical in shape to the already
 * behaviourally-tested VoiceRecorder.tsx fix, this is a source-text
 * regression test (same convention as audit-regression.test.ts /
 * wipeDatabase.test.ts's Lock.tsx source checks) rather than a full render
 * test — it fails loudly if the restore call in stopAudioRecording is ever
 * removed or the finally block is bypassed on an error path.
 */
import fs from 'node:fs';
import path from 'node:path';

const VIEW_ONCE_SEND_TSX = path.resolve(__dirname, '..', 'ViewOnceSend.tsx');

describe('ViewOnceSend.tsx — stopAudioRecording restores allowsRecordingIOS: false', () => {
  const src = fs.readFileSync(VIEW_ONCE_SEND_TSX, 'utf8');

  it('wraps the stop/catch logic in a finally block that restores the audio session', () => {
    const start = src.indexOf('async function stopAudioRecording()');
    expect(start).toBeGreaterThan(-1);
    // Bounded slice up to the next top-level function so a `finally` added to
    // some unrelated later function cannot make this test pass by accident.
    const end = src.indexOf('async function playAudio()', start);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);

    expect(body).toContain('finally');
    const finallyIdx = body.indexOf('finally');
    const restoreCallIdx = body.indexOf(
      "setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true })",
    );
    expect(restoreCallIdx).toBeGreaterThan(-1);
    // The restore call must live inside the finally block, not just anywhere
    // in the function (e.g. only on the success path, which is the original bug).
    expect(restoreCallIdx).toBeGreaterThan(finallyIdx);
  });
});

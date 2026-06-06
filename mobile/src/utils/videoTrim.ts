import { Platform } from 'react-native';
import VideoTrim, { showEditor } from 'react-native-video-trim';

/**
 * The native trimmer uses ffmpeg-kit, which only ships arm64-v8a / armeabi-v7a
 * binaries — there is NO x86/x86_64 build. On an x86 Android emulator the editor
 * UI opens but the actual trim call crashes with a fatal UnsatisfiedLinkError
 * ("libffmpegkit_abidetect.so not found"). Detect that case and skip trimming so
 * the app never crashes; the video is then sent untrimmed. Real devices are arm,
 * so this only short-circuits emulators.
 */
export function ffmpegUnavailable(): boolean {
  if (Platform.OS !== 'android') return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = Platform.constants ?? {};
  const hay = `${c.Fingerprint ?? ''} ${c.Model ?? ''} ${c.Brand ?? ''} ${c.Manufacturer ?? ''} ${c.Hardware ?? ''}`.toLowerCase();
  return hay.includes('x86') || hay.includes('sdk_gphone') || hay.includes('emulator') || hay.includes('generic') || hay.includes('ranchu') || hay.includes('goldfish');
}

/**
 * Open the native video trimmer (react-native-video-trim) and resolve with the
 * trimmed output file path, or the ORIGINAL uri if trimming isn't available
 * (x86 emulator), or null if the user cancelled / it failed.
 *
 * The library exposes its result through codegen EventEmitters on the default
 * module export (onFinishTrimming / onCancel / onError); we wrap them in a
 * one-shot promise and always remove the listeners afterwards.
 */
export function trimVideo(uri: string, maxDurationSec = 90): Promise<string | null> {
  // ffmpeg-kit has no x86 binaries — skip the (crashing) trimmer on emulators.
  if (ffmpegUnavailable()) return Promise.resolve(uri);
  return new Promise((resolve) => {
    let settled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const VT = VideoTrim as any;

    const subs: Array<{ remove?: () => void } | undefined> = [];
    const cleanup = () => { subs.forEach((s) => { try { s?.remove?.(); } catch { /* ignore */ } }); };
    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    try {
      subs.push(VT.onFinishTrimming?.((e: { outputPath?: string }) => finish(e?.outputPath ?? null)));
      subs.push(VT.onCancelTrimming?.(() => finish(null)));
      subs.push(VT.onCancel?.(() => finish(null)));
      subs.push(VT.onError?.(() => finish(null)));
    } catch { /* listener wiring failed — fall through to showEditor try/catch */ }

    try {
      showEditor(uri, {
        maxDuration: maxDurationSec,
        saveToPhoto: false,
        removeAfterSavedToPhoto: true,
        enableHapticFeedback: true,
        theme: 'dark',
      });
    } catch {
      finish(null);
    }
  });
}

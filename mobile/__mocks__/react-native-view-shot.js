/**
 * Jest mock for react-native-view-shot. The native capture isn't available in
 * the test environment; MediaEditorModal only calls captureRef on send, which
 * tests don't exercise. Returns a deterministic fake file URI.
 */
const captureRef = () => Promise.resolve('file:///mock-view-shot.jpg');
const releaseCapture = () => {};

module.exports = {
  __esModule: true,
  captureRef,
  releaseCapture,
  captureScreen: () => Promise.resolve('file:///mock-view-shot.jpg'),
  default: { captureRef, releaseCapture },
};

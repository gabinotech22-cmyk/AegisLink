// Global Jest mock for expo-av — avoids native ExponentAV module errors in tests
const React = require('react');

const ResizeMode = {
  CONTAIN: 'contain',
  COVER: 'cover',
  STRETCH: 'stretch',
};

const Video = React.forwardRef(function Video(_props, _ref) {
  return null;
});
Video.displayName = 'Video';

const Audio = {
  Sound: {
    createAsync: jest.fn().mockResolvedValue({
      sound: {
        playAsync: jest.fn().mockResolvedValue(undefined),
        stopAsync: jest.fn().mockResolvedValue(undefined),
        pauseAsync: jest.fn().mockResolvedValue(undefined),
        setPositionAsync: jest.fn().mockResolvedValue(undefined),
        unloadAsync: jest.fn().mockResolvedValue(undefined),
        getStatusAsync: jest.fn().mockResolvedValue({ isPlaying: false, positionMillis: 0, durationMillis: 0 }),
        setOnPlaybackStatusUpdate: jest.fn(),
      },
      status: { isLoaded: true },
    }),
  },
  setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
  requestPermissionsAsync: jest.fn().mockResolvedValue({ granted: true, status: 'granted' }),
  getPermissionsAsync: jest.fn().mockResolvedValue({ granted: true, status: 'granted' }),
  Recording: jest.fn().mockImplementation(() => ({
    prepareToRecordAsync: jest.fn().mockResolvedValue(undefined),
    startAsync: jest.fn().mockResolvedValue(undefined),
    stopAndUnloadAsync: jest.fn().mockResolvedValue(undefined),
    getURI: jest.fn().mockReturnValue('file:///mock-recording.m4a'),
    getStatusAsync: jest.fn().mockResolvedValue({ isDoneRecording: false, durationMillis: 1234, metering: -20 }),
  })),
  RecordingOptionsPresets: {
    HIGH_QUALITY: {},
  },
};

module.exports = { Video, ResizeMode, Audio };

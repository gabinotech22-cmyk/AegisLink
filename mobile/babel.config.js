module.exports = function (api) {
  const isTest = process.env.NODE_ENV === 'test' || process.env.BABEL_ENV === 'test';
  const isProd =
    process.env.NODE_ENV === 'production' || process.env.BABEL_ENV === 'production';
  api.cache(!isTest);

  const plugins = [];
  // Strip console.* (keep error/warn) from production bundles so no plaintext
  // fragments, peer ids, or ratchet state ever leak to logcat. Dev keeps logs.
  if (isProd) {
    plugins.push(['transform-remove-console', { exclude: ['error', 'warn'] }]);
  }
  // react-native-reanimated/plugin MUST stay last.
  if (!isTest) {
    plugins.push('react-native-reanimated/plugin');
  }

  return {
    presets: ['babel-preset-expo'],
    plugins,
  };
};

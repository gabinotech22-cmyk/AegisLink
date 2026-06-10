module.exports = function (api) {
  const isTest = process.env.NODE_ENV === 'test' || process.env.BABEL_ENV === 'test';
  const isProd =
    process.env.NODE_ENV === 'production' ||
    process.env.BABEL_ENV === 'production' ||
    process.env.APP_ENV === 'production'; // set by the EAS prod/preview profiles
  api.cache(!isTest);

  const plugins = [];
  // Strip console.* (keep only error) from production bundles so no plaintext
  // fragments, peer ids, or ratchet state ever leak to logcat. Dev keeps logs.
  // 'warn' is NOT excluded on purpose: the [RDIAG] ratchet diagnostics used
  // console.warn and survived release builds, logging who-talks-to-whom.
  if (isProd) {
    plugins.push(['transform-remove-console', { exclude: ['error'] }]);
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

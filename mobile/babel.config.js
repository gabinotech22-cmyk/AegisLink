module.exports = function (api) {
  const isTest = process.env.NODE_ENV === 'test' || process.env.BABEL_ENV === 'test';
  api.cache(!isTest);
  return {
    presets: ['babel-preset-expo'],
    plugins: isTest ? [] : ['react-native-reanimated/plugin'],
  };
};

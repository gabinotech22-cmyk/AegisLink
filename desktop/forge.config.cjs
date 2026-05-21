module.exports = {
  packagerConfig: { name: 'AegisLink', executableName: 'aegislink' },
  makers: [
    { name: '@electron-forge/maker-squirrel', config: { name: 'AegisLink' } },
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
  ],
}

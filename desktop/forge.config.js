const path = require('path');

module.exports = {
  packagerConfig: {
    asar: {
      // Native modules cannot be loaded from inside an asar archive.
      // Unpack them into app.asar.unpacked/ so Node can require() them.
      unpack: '{**/node_modules/better-sqlite3/**,**/node_modules/keytar/**,**/node_modules/bindings/**,**/node_modules/file-uri-to-path/**}',
    },
    name: 'AegisLink',
    executableName: 'aegislink',
    icon: path.join(__dirname, 'assets', 'icon'),
    // Include the pre-built renderer dist/ and electron/ in the package
    dir: __dirname,
    ignore: [
      /^\/node_modules\/.cache/,
      /^\/src/,
      /^\/\.vite/,
      /^\/out/,
      /^\/\.git/,
      /^\/vite\..*\.config\.js$/,
    ],
    afterCopy: [
      (buildPath, electronVersion, platform, arch, done) => {
        const { execSync } = require('child_process');
        try {
          execSync('npm run rebuild', { cwd: buildPath, stdio: 'inherit' });
        } catch (_) {}
        done();
      },
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32', 'darwin', 'linux'],
    },
  ],
  // No plugin-vite — we build renderer manually before make
};

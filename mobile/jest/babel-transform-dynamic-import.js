/**
 * Test-only Babel plugin: lower dynamic `import('x')` to `Promise.resolve(require('x'))`.
 *
 * Under Jest, the `babel-jest` transform (presets: babel-preset-expo) leaves
 * dynamic `import()` as a native call, which the Jest VM rejects with
 * "A dynamic import callback was invoked without --experimental-vm-modules".
 * Screens that lazy-load modules (e.g. GroupPosts → `import('../db/local')`,
 * Devices → `import('../config')`) therefore can't be rendered in tests.
 *
 * This rewrites ONLY dynamic-import call expressions; static ESM is untouched and
 * left for the preset's module transform. Wholesale CommonJS conversion was tried
 * and broke __esModule interop across the suite — this surgical version does not.
 */
const template = require('@babel/template').default;

const build = template.expression('Promise.resolve(require(SOURCE))');

module.exports = function dynamicImportToRequire() {
  return {
    name: 'transform-dynamic-import-to-require',
    visitor: {
      CallExpression(path) {
        if (path.node.callee.type === 'Import') {
          path.replaceWith(build({ SOURCE: path.node.arguments[0] }));
        }
      },
    },
  };
};

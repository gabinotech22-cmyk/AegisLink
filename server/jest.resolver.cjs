/**
 * Custom Jest resolver — passthrough for `node:`-prefixed core module
 * specifiers (e.g. `node:sqlite`, `node:crypto`).
 *
 * Root cause: jest-resolve decides whether a specifier is a "core module" via
 * `node:module`'s `isBuiltin()`. On some Node 22.x patch releases `isBuiltin`
 * does not (yet) recognize newer/experimental built-ins such as `node:sqlite`.
 * When `isCoreModule()` returns false, jest-resolve falls through to its
 * default file-resolution path, which for a `node:`-prefixed specifier with
 * no matching package strips the `node:` prefix (see
 * `normalizeCoreModuleSpecifier`) and ends up trying to read a literal file
 * named `sqlite` from the project root — surfacing as:
 *
 *   ENOENT: no such file or directory, open 'sqlite'
 *
 * This resolver short-circuits that: any `node:`-prefixed specifier is
 * returned to Jest unchanged, exactly like Node's own ESM/CJS loaders treat
 * it, regardless of whether the host Node version's `isBuiltin()` agrees.
 * Everything else is delegated to Jest's default resolver.
 */

module.exports = (request, options) => {
  if (request.startsWith('node:')) {
    return request;
  }
  return options.defaultResolver(request, options);
};

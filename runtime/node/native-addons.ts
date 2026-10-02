// Loading a Node-API native addon (`require('<path>.node')`).
//
// Node loads a `.node` file with `process.dlopen`, as a shared library built
// against Node's own ABI. This target is not Node and has nothing to hand such
// a library, so the load fails the way node's does when an addon cannot be
// opened: an `Error` whose `code` is `ERR_DLOPEN_FAILED`, thrown from the
// `require` call. Packages that wrap an optional addon -- `kerberos`, and
// `mongodb-client-encryption`'s `mongocrypt` -- already `try` exactly that
// require, and the MongoDB driver turns the failure into its
// `MongoMissingDependencyError` module, the same state as the package being
// absent.
//
// The node-compat plugin's source transform rewrites each such require into a
// call of the function below (see `nativeAddonRequireTransform`), before the
// checker runs. A script, not a module, so the rewritten call needs no import.

interface NativeAddonLoadError extends Error {
  code: 'ERR_DLOPEN_FAILED'
}

function __gea_node_native_addon_unavailable(specifier: string): never {
  const error = new Error(
    `Cannot load native addon '${specifier}': Node-API addons are not supported by the geastack node-compat target`
  ) as NativeAddonLoadError
  error.code = 'ERR_DLOPEN_FAILED'
  throw error
}

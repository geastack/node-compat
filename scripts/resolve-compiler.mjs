// Locate the installed @geastack/compiler without assuming a sibling checkout.
//
// These scripts used to reach for ../compiler/... , which only works when this
// repository sits next to a compiler clone in the same parent directory. That
// is true on a development machine and false for everyone else, so the paths
// are resolved through node's own module resolution instead.
//
// The package's exports map only declares an "import" condition, so
// require.resolve('@geastack/compiler') fails with ERR_PACKAGE_PATH_NOT_EXPORTED.
// './package.json' is exported, so its directory is the reliable anchor.

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/** Absolute path to the installed @geastack/compiler package root. */
export function compilerRoot() {
  try {
    return dirname(require.resolve('@geastack/compiler/package.json'))
  } catch {
    throw new Error(
      '@geastack/compiler is not installed. It is an optional peer dependency of ' +
        '@geastack/node-compat; run `npm install @geastack/compiler` to use this script.',
    )
  }
}

/**
 * Include directory for the C++ runtime headers. The compiler ships
 * `src/targets/cpp/runtime/*.h` and `gea_runtime_builtins.cpp` in its published
 * `files`, so this resolves in an installed tree as well as a source checkout.
 */
export function compilerRuntimeInclude() {
  return join(compilerRoot(), 'src/targets/cpp/runtime')
}

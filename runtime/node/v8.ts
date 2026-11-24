// node:v8, the part a compiled program can reach: the startup-snapshot API that
// libraries probe through `process.getBuiltinModule('v8')` (bson's ObjectId
// asks whether a snapshot is being built). A native executable is never built
// into a V8 startup snapshot, so the answer is always "no", and the callbacks
// that only make sense while building one throw exactly as Node's do outside a
// snapshot build. Everything else is the generated declaration facade.
//
// Every export is a const, function or class: the compiler publishes a
// builtin's namespace to `getBuiltinModule` only for such modules.

export * from './generated/facades/v8'

interface NotBuildingSnapshotError extends Error {
  code: string
}

function notBuildingSnapshot(): never {
  const error = new Error('Operation cannot be invoked when not building startup snapshot') as NotBuildingSnapshotError
  error.code = 'ERR_NOT_BUILDING_SNAPSHOT'
  throw error
}

interface StartupSnapshot {
  isBuildingSnapshot(): boolean
  addSerializeCallback(callback: (data?: unknown) => void, data?: unknown): void
  addDeserializeCallback(callback: (data?: unknown) => void, data?: unknown): void
  setDeserializeMainFunction(callback: (data?: unknown) => void, data?: unknown): void
}

// Node 24's isBuildingSnapshot() returns the number 0 outside a snapshot build;
// its declaration (and every library's use of it) is boolean, so the falsy
// value is spelled `false` here.
export const startupSnapshot: StartupSnapshot = {
  isBuildingSnapshot(): boolean {
    return false
  },
  addSerializeCallback(callback: (data?: unknown) => void, data?: unknown): void {
    void callback
    void data
    notBuildingSnapshot()
  },
  addDeserializeCallback(callback: (data?: unknown) => void, data?: unknown): void {
    void callback
    void data
    notBuildingSnapshot()
  },
  setDeserializeMainFunction(callback: (data?: unknown) => void, data?: unknown): void {
    void callback
    void data
    notBuildingSnapshot()
  }
}

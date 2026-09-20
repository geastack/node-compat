// The ambient, no-implementation tail of the ECMAScript/WHATWG "standard
// library" this compiler recognizes BY NAME and implements itself in the C++
// runtime -- `console`, `TextEncoder`/`TextDecoder`, `btoa`/`atob`, and
// `queueMicrotask`. Unlike `globals.ts`'s `Headers`/`Response`/`Request`/...
// (real classes with real bodies, opt-in via `--globals` because an
// unreferenced class still has to certify), every name below is used
// UNCONDITIONALLY by node-compat's own builtin implementations regardless of
// `--globals` -- `runtime/node/http.ts`, `events.ts` and `net.ts` call
// `queueMicrotask`, `crypto.ts` does too, and a program that logs anything
// calls `console.log` -- so this file is always in the compiled project
// (`scripts/build.mjs`'s `files`, unconditionally).
//
// An explicit `declare global` block keeps these names global under both
// Bundler and NodeNext module detection, including type:module packages.
//
// The `/// <reference no-default-lib="true"/>` pragma is what lets these
// names get the compiler's OWN native implementations instead of lowering to
// unresolved externs: `compiler/src/semantics/host-protocols.ts`
// (`HostCensus.standardLibrary`) keys purely off `SourceFile.hasNoDefaultLib`
// -- "the checker's own flag ... rather than a file-path match" -- so this
// file is treated exactly like `lib.dom.d.ts`/`lib.es5.d.ts` for any AMBIENT
// (body-less) declaration in it, regardless of which file it physically lives
// in. Before this file existed, `'DOM'` sat in `compilerOptions.lib` to
// supply these same names -- which also supplied `Response`/`Headers`/`URL`/
// `FormData` as UNIMPLEMENTED ambient interfaces, silently shadowing
// `globals.ts`'s real classes of the same name (see that file's header). This
// file is the replacement for the part of `'DOM'` node-compat actually needs.
/// <reference no-default-lib="true"/>

// WHATWG HTML §8.2's `console` -- only `log`/`error`, the two members the
// compiler's own host table claims (`compiler/src/targets/cpp/host/
// host-members.ts`'s `coreHostMembers`, keyed `'Console.log'`/`'Console.error'`
// against this interface's OWN NAME, not its declaring file). Declaring more
// members here would just be dead surface: an unclaimed one refuses by name
// at its own call site.
export {}

// Explicit global scope is required when NodeNext treats .ts files as modules.
declare global {
  interface Console {
    log(...data: unknown[]): void
    error(...data: unknown[]): void
    // Real Node's `console.info`/`console.warn` are literal aliases of
    // `log`/`error` (Node's `lib/internal/console/constructor.js` binds both
    // pairs to the same underlying writer) -- declared here because
    // `@hono/node-server`'s own `listener.ts`/`early-hints.ts` call them, but
    // NEITHER is in the compiler's own host table
    // (`compiler/src/targets/cpp/host/host-members.ts`'s `coreHostMembers`
    // claims only `Console.log`/`Console.error`, a file this target does not
    // own). A reached call refuses by name at its own call site, honestly,
    // like `TextEncoder.encodeInto` already does in this file -- not a
    // fabricated behavior.
    info(...data: unknown[]): void
    warn(...data: unknown[]): void
  }
  const console: Console

  // Encoding Standard. Claimed by the compiler's own `coreNativeTypes`
  // (`core-globals.ts`) under exactly these two names, gated on this file's
  // `hasNoDefaultLib` above -- so these stay AMBIENT (no body) rather than
  // becoming node-compat classes: an implementation here would shadow the
  // compiler's own native carrier (`gea::runtime::textcodec::TextEncoder`)
  // instead of using it. `TextEncoder.encodeInto` is deliberately absent, per
  // `host-members.ts`'s own comment on that member: no implementation exists,
  // so a call refuses by name rather than this declaration papering over it.
  interface TextEncoder {
    readonly encoding: string
    encode(input?: string): Uint8Array
  }
  const TextEncoder: {
    readonly prototype: TextEncoder
    new(): TextEncoder
  }
  interface TextDecoder {
    readonly encoding: string
    readonly fatal: boolean
    readonly ignoreBOM: boolean
    decode(input?: BufferSource): string
  }
  const TextDecoder: {
    readonly prototype: TextDecoder
    new(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): TextDecoder
  }

  // HTML Standard §8.3 and `queueMicrotask()` (HTML §8.1.7.3). Claimed by the
  // compiler's own `coreGlobalFunctions` (`core-globals.ts`) under these exact
  // names, on the same `hasNoDefaultLib` gate as `TextEncoder`/`console` above.
  function btoa(data: string): string
  function atob(data: string): string
  function queueMicrotask(callback: () => void): void

  // `TextDecoder.decode`'s parameter type. Not claimed by any compiler table --
  // just a shape both this file and `globals.ts` (hono's `cookie.ts` HMAC
  // signing) need to name.
  type BufferSource = ArrayBufferView | ArrayBuffer
}

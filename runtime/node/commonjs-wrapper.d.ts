// The declaration identity of Node's CommonJS wrapper parameters.
//
// This file is deliberately owned by the node-compat host, not by a caller's
// project or an ambient @types package. geatsc verifies that every admitted
// wrapper Symbol has its complete declaration set here before it gives the
// name module-record semantics.
export {}

declare global {
  namespace NodeJS {
    // This is the wrapper parameter's callable surface, not a host protocol.
    // Static calls on the global `require` binding are authenticated below and
    // lower to CommonJS module records; the type name merely lets declarations
    // that spell `NodeJS.Require` retain that same checker provenance.
    interface Require {
      (specifier: string): any
    }
  }

  var require: (specifier: string) => any
  var exports: any
  var module: { exports: any }
}

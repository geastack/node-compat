# Node 24 API surface tooling

This tool pins `@types/node` 24.13.3 and extracts a deterministic inventory of
the documented Node 24 declaration surface. The generated inventory lives at
`runtime/node/generated/node24-surface.json` and covers canonical `node:*`
modules, bare aliases, runtime exports, types, overload signatures, class and
interface members, and Node globals.

```sh
npm install --ignore-scripts
npm run generate
npm run docs:generate
npm run check
npm run check:imports
npm run check:pilot
npm run check:tcp
```

`check:pilot` compiles and executes `apps/net-stub-pilot`. It verifies that
direct, aliased, namespace, constructor, static method, instance method, and
property uses of implemented `node:net` members run natively, and that reading
a stubbed constant (`node:constants.EACCES`, named or through the CommonJS
default) is inert.

`check:imports` compiles and executes an entry that imports all 57 generated
facades without touching any export. `check:tcp` preserves the existing
MongoDB-oriented bare-`net` client path by connecting to a local echo server
and verifying a complete write/read/close exchange.

`check` also generates a type-only import probe for every inventoried export and
compiles it with TypeScript against the pinned `@types/node` declaration root,
separate from the executable builtin shims (which implement only part of that
contract). This checks that all canonical Node 24 modules and all 1,960 exports
are part of the pinned declaration program. This includes the `export =` object surfaces of `node:constants`,
`node:process`, and the other CommonJS-shaped builtins. The inventory contains
119 Node globals; quoted ambient module symbols are not counted as globals.

`docs:generate` pins the official Node 24.13.0 `all.json` API input, records its
URL, byte count, and SHA-256 digest, and emits a compact metadata snapshot with
stability, lifecycle, source, and structured platform-mention evidence. The
normal `check` validates that all 57 declaration modules map to an official
documentation source.

The inventory describes what the runtime implements, not what an application
uses. The generated compatibility ledger
joins it with registered implementation overlays, rejects unknown public
registrations, records supported overlay signatures, and classifies every
runtime export and member as conformant, partial, stubbed, or plugin-owned.

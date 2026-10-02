// The DECLARATION-ONLY half of `node:buffer`: the `Buffer` type, its
// constructor type, and the encodings both name.
//
// Split out of `buffer.ts` so that NAMING `Buffer` costs nothing. A global
// `Buffer` has to be typed by these declarations (`node-globals.ts`), and
// `reachability.ts` promotes any file a live reference resolves into -- so
// while these declarations sat in the same module as the real `Blob` class,
// every program in the target acquired `Blob`'s body and its obligations,
// Buffer-free programs included: `hono-hello` went from 2 unmet obligations to
// 7 for naming a type it never uses. A module with no implementation in it has
// nothing to acquire.
//
// The `declare` is what makes that true and is not incidental: the
// implementation is the host's, carried natively, so there is no body here to
// compile in the first place -- only a name and a shape.

//
// The implementation is supplied by the node-compat plugin as the native
// `gea_node_buffer` carrier.  That carrier derives from geatsc's
// `gea_cpp_typed_array<uint8_t>`, so Buffer indexing, views, and ArrayBuffer
// aliasing keep the same shared native byte storage as Uint8Array.  These
// declarations intentionally contain no JavaScript implementation and no
// `any`-backed storage; reflection on the global constructor is the only
// dynamic boundary.

export type BufferEncoding =
  | 'utf8'
  | 'utf-8'
  | 'hex'
  | 'base64'
  | 'base64url'
  | 'binary'
  | 'latin1'
  | 'ascii'
  | 'ucs2'
  | 'ucs-2'
  | 'utf16le'
  | 'utf-16le'

export declare interface Buffer extends Uint8Array<ArrayBuffer> {
  readonly _isBuffer?: boolean

  // `@gea-host-no-property-writes` on the members below, and deliberately not
  // on their neighbours: these READ the carrier's bytes or derive a NEW view
  // from it, while `write`/`writeUInt8`/`writeInt32LE`/`writeUInt32LE`/`copy`/
  // `swap32` store into indexed properties of a typed array the program
  // already holds, which is exactly the write this contract denies.
  //
  // Those writers carry the narrower `@gea-host-typed-array-element-writes`
  // instead: they write nothing but the element storage of the typed arrays
  // they are handed. Checked against `gea_node_buffer.hpp`, which every one of
  // them lowers to (`bufferHostMembers` in `plugin/index.mjs`): `write` ->
  // `writeSpan`, the `write{U,}Int*{LE,BE}`/`writeUInt8` family, `copy` (a
  // `memmove` into `target.data()`) and `swap32` each store only through
  // `detail::writable( view ).data()` of the receiver or the `target`
  // argument; the only other effect any of them has is throwing a fresh
  // RangeError. Add the tag to a new member only after reading its native.
  /** @gea-host-no-property-writes */
  subarray(start?: number, end?: number): Buffer
  /** @gea-host-no-property-writes */
  slice(start?: number, end?: number): Buffer
  /** @gea-host-typed-array-element-writes */
  write(string: string, encoding?: BufferEncoding): number
  /** @gea-host-typed-array-element-writes */
  write(string: string, offset: number, encoding?: BufferEncoding): number
  /** @gea-host-typed-array-element-writes */
  write(string: string, offset: number, length: number | undefined, encoding?: BufferEncoding): number
  /** @gea-host-typed-array-element-writes */
  copy(target: Uint8Array, targetStart?: number, sourceStart?: number, sourceEnd?: number): number
  /** @gea-host-no-property-writes */
  readUInt8(offset?: number): number
  /** @gea-host-no-property-writes */
  readInt32LE(offset?: number): number
  /** @gea-host-no-property-writes */
  readUInt32LE(offset?: number): number
  /** @gea-host-no-property-writes */
  readInt32BE(offset?: number): number
  /** @gea-host-no-property-writes */
  readUInt32BE(offset?: number): number
  /** @gea-host-typed-array-element-writes */
  writeUInt8(value: number, offset?: number): number
  /** @gea-host-typed-array-element-writes */
  writeInt32LE(value: number, offset?: number): number
  /** @gea-host-typed-array-element-writes */
  writeUInt32LE(value: number, offset?: number): number
  /** @gea-host-typed-array-element-writes */
  writeInt32BE(value: number, offset?: number): number
  /** @gea-host-typed-array-element-writes */
  writeUInt32BE(value: number, offset?: number): number
  /** @gea-host-no-property-writes */
  toString(encoding?: BufferEncoding, start?: number, end?: number): string
  /** @gea-host-no-property-writes */
  equals(other: Uint8Array): boolean
  /** @gea-host-no-property-writes */
  compare(other: Uint8Array): -1 | 0 | 1
  /** @gea-host-typed-array-element-writes */
  swap32(): Buffer

}

export interface BufferConstructor {
  readonly prototype: Buffer
  // A real construct signature, not a convenience: `new Buffer(...)` itself
  // has been deprecated since Node 6 and nothing this target builds calls
  // it (see `plugin/index.mjs`'s `hostNamespaces` comment for why the VALUE is
  // claimed as a namespace path rather than a callable cell), but `x
  // instanceof Buffer` is real, live code (`@hono/node-server`'s
  // `request.ts`). TypeScript only accepts the right-hand side of
  // `instanceof` when its type is `any`, has a call/construct signature, or
  // is a subtype of `Function` -- a plain bag of static methods satisfies
  // none of those. Giving the constructor type real construct signatures,
  // shaped exactly like `from`'s overloads, is what makes it
  // constructor-shaped without adding a callable JS implementation.
  new (value: string, encoding?: BufferEncoding): Buffer
  new (value: readonly number[] | Uint8Array): Buffer
  new (value: ArrayBufferLike, byteOffset?: number, length?: number): Buffer
  alloc(size: number, fill?: string | number | Uint8Array, encoding?: BufferEncoding): Buffer
  allocUnsafe(size: number): Buffer
  concat(list: readonly Uint8Array[], totalLength?: number): Buffer
  byteLength(value: string | Uint8Array | ArrayBuffer, encoding?: BufferEncoding): number
  from(value: string, encoding?: BufferEncoding): Buffer
  from(value: readonly number[] | Uint8Array): Buffer
  // `ArrayBufferLike`, as node declares it: `view.buffer` is typed that union.
  from(value: ArrayBufferLike, byteOffset?: number, length?: number): Buffer
  isBuffer(value: unknown): value is Buffer
}

// `declare` keeps this file usable as both the forced global provider and the
// `buffer`/`node:buffer` builtin module. Calls and property reads are lowered by
// the plugin directly to the typed C++ carrier.
export declare const Buffer: BufferConstructor

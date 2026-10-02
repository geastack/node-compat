// `node:stream/web` -- the module surface over the WHATWG stream classes.
//
// The implementations are in `runtime/node/whatwg-streams.ts`, which is a
// SCRIPT: its classes land in the real global scope, because that is where
// library code reads them from (`new ReadableStream(...)` with no import in
// sight). See that file's header for why a script, and for the ambient
// declaration this replaced.
//
// Node exposes the same classes twice -- as globals AND as `node:stream/web`
// exports -- so this file is the second half of that, not a second
// implementation. Each name below is a local ALIAS of the one global class:
// `const X = GlobalX` keeps the value identity (`instanceof` still matches
// across both spellings) and `type X<...> = GlobalX<...>` keeps the type
// identity. A single `export { X as Name }` specifier carries both meanings.
//
// The alias is what a module can do at all: `export { ReadableStream }` on a
// name this file does not declare is "Cannot export 'ReadableStream'. Only
// local declarations can be exported from a module."
//
// A generic class's bare name denotes no single value in this target -- there is
// no class object for `ReadableStream<R>`, only the copy each instantiation
// names -- so a read of `ReadableStreamAlias` is a read of the CLASS, never of a
// cell holding one copy's constructor (`genericClassAliasTargetSymbol` in the
// compiler's `class-alias.ts`), and each `new` through the alias selects its own
// copy. `stream.ts` still names the globals directly: it does not need the
// module's chunk-type default below.

type UnderlyingReadableStreamSourceAlias<R> = UnderlyingReadableStreamSource<R>
type QueuingStrategyInitAlias = QueuingStrategyInit
type ReadableStreamReadResultAlias<R> = ReadableStreamReadResult<R>

// The module surface's chunk type defaults to `unknown`, not the global class's
// `Uint8Array`. A WHATWG stream carries ANY chunk -- `controller.enqueue('text')`
// and `enqueue({ id: 1 })` are ordinary -- and a program that imports the class
// from `node:stream/web` and builds `new ReadableStream({ start })` states no
// chunk type for inference to find, so the default IS the answer: `Uint8Array`
// there declares a byte stream the program never asked for, and a dynamic call
// enqueueing a string aborts against it. The global keeps `Uint8Array` because
// library code names it bare and means bytes (Fetch bodies, `@hono/node-server`).
// `unknown` is exactly the dynamic boundary: the `unknown` copy is the one
// `TransformStream` already exposes, so no further physical class is minted.
//
// The default is stated on the CONSTRUCTOR TYPE, not the class: type arguments
// of a `new` are inferred against the construct signature this alias has, and a
// bare type alias default alone would leave `new ReadableStream(...)` on the
// class's own default. The assignment is the identity -- the alias holds the one
// class object, and each `new` through it names the copy its own `R` selects.
type ReadableStreamConstructorAlias = new <R = unknown>(
  underlyingSource?: UnderlyingReadableStreamSource<R>,
  strategy?: QueuingStrategyInit
) => ReadableStream<R>

const ReadableStreamDefaultControllerAlias = ReadableStreamDefaultController
type ReadableStreamDefaultControllerAlias<R = unknown> = ReadableStreamDefaultController<R>

const ReadableStreamBYOBRequestAlias = ReadableStreamBYOBRequest
type ReadableStreamBYOBRequestAlias = ReadableStreamBYOBRequest

const ReadableByteStreamControllerAlias = ReadableByteStreamController
type ReadableByteStreamControllerAlias = ReadableByteStreamController

const ReadableStreamAlias: ReadableStreamConstructorAlias = ReadableStream
type ReadableStreamAlias<R = unknown> = ReadableStream<R>

const ReadableStreamDefaultReaderAlias = ReadableStreamDefaultReader
type ReadableStreamDefaultReaderAlias<R = unknown> = ReadableStreamDefaultReader<R>

const ReadableStreamBYOBReaderAlias = ReadableStreamBYOBReader
type ReadableStreamBYOBReaderAlias = ReadableStreamBYOBReader

const WritableStreamDefaultControllerAlias = WritableStreamDefaultController
type WritableStreamDefaultControllerAlias = WritableStreamDefaultController

const WritableStreamAlias = WritableStream
type WritableStreamAlias = WritableStream

const WritableStreamDefaultWriterAlias = WritableStreamDefaultWriter
type WritableStreamDefaultWriterAlias = WritableStreamDefaultWriter

const TransformStreamDefaultControllerAlias = TransformStreamDefaultController
type TransformStreamDefaultControllerAlias = TransformStreamDefaultController

const TransformStreamAlias = TransformStream
type TransformStreamAlias = TransformStream

const TextEncoderStreamAlias = TextEncoderStream
type TextEncoderStreamAlias = TextEncoderStream

const TextDecoderStreamAlias = TextDecoderStream
type TextDecoderStreamAlias = TextDecoderStream

const CompressionStreamAlias = CompressionStream
type CompressionStreamAlias = CompressionStream

const DecompressionStreamAlias = DecompressionStream
type DecompressionStreamAlias = DecompressionStream

const ByteLengthQueuingStrategyAlias = ByteLengthQueuingStrategy
type ByteLengthQueuingStrategyAlias = ByteLengthQueuingStrategy

const CountQueuingStrategyAlias = CountQueuingStrategy
type CountQueuingStrategyAlias = CountQueuingStrategy

export type {
  UnderlyingReadableStreamSourceAlias as UnderlyingReadableStreamSource,
  QueuingStrategyInitAlias as QueuingStrategyInit,
  ReadableStreamReadResultAlias as ReadableStreamReadResult
}

export {
  ByteLengthQueuingStrategyAlias as ByteLengthQueuingStrategy,
  CompressionStreamAlias as CompressionStream,
  CountQueuingStrategyAlias as CountQueuingStrategy,
  DecompressionStreamAlias as DecompressionStream,
  ReadableByteStreamControllerAlias as ReadableByteStreamController,
  ReadableStreamAlias as ReadableStream,
  ReadableStreamBYOBReaderAlias as ReadableStreamBYOBReader,
  ReadableStreamBYOBRequestAlias as ReadableStreamBYOBRequest,
  ReadableStreamDefaultControllerAlias as ReadableStreamDefaultController,
  ReadableStreamDefaultReaderAlias as ReadableStreamDefaultReader,
  TextDecoderStreamAlias as TextDecoderStream,
  TextEncoderStreamAlias as TextEncoderStream,
  TransformStreamAlias as TransformStream,
  TransformStreamDefaultControllerAlias as TransformStreamDefaultController,
  WritableStreamAlias as WritableStream,
  WritableStreamDefaultControllerAlias as WritableStreamDefaultController,
  WritableStreamDefaultWriterAlias as WritableStreamDefaultWriter
}

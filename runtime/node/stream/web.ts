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
// KNOWN LIMIT, and the reason `stream.ts` names the globals directly instead of
// importing from here: the alias of a GENERIC class does not lower. A generic
// class's bare name denotes no value in this target -- there is no single class
// object for `ReadableStream<R>`, only the copy each instantiation names -- so
// `const ReadableStreamAlias = ReadableStream` reads a cell the program never
// introduces, and emission refuses it with `native-boundary:external-binding`.
// The same rule is already stated for import/export specifiers by
// `namesUninstantiatedGeneric` in the compiler's `producers/
// declaration-lifecycle.ts`; a variable initializer has no equivalent, because
// unlike a specifier it really does need a value. `ReadableStream`,
// `ReadableStreamDefaultController` and `ReadableStreamDefaultReader` are the
// three generic ones, and any program that pulls THIS module in pays for them.
// Importing a non-generic name from here (`WritableStream`) is unaffected.

type UnderlyingReadableStreamSourceAlias<R> = UnderlyingReadableStreamSource<R>
type QueuingStrategyInitAlias = QueuingStrategyInit
type ReadableStreamReadResultAlias<R> = ReadableStreamReadResult<R>

const ReadableStreamDefaultControllerAlias = ReadableStreamDefaultController
type ReadableStreamDefaultControllerAlias<R = Uint8Array> = ReadableStreamDefaultController<R>

const ReadableStreamBYOBRequestAlias = ReadableStreamBYOBRequest
type ReadableStreamBYOBRequestAlias = ReadableStreamBYOBRequest

const ReadableByteStreamControllerAlias = ReadableByteStreamController
type ReadableByteStreamControllerAlias = ReadableByteStreamController

const ReadableStreamAlias = ReadableStream
type ReadableStreamAlias<R = Uint8Array> = ReadableStream<R>

const ReadableStreamDefaultReaderAlias = ReadableStreamDefaultReader
type ReadableStreamDefaultReaderAlias<R = Uint8Array> = ReadableStreamDefaultReader<R>

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

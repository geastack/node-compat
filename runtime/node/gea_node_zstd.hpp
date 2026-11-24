#pragma once

// node:zlib's zstd codecs over libzstd. Included -- and libzstd linked -- only
// when a program reaches a gea::node::zstd:: spelling (see build.mjs).
//
// Compression goes through a context handle so every `params` entry node
// accepts reaches ZSTD_CCtx_setParameter as the number node would pass, not
// only the level: open, set each parameter, compress, close.

#include "gea_runtime.h"
#include "gea_node_buffer.hpp"

#include <zstd.h>

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace gea::node::zstd {
using Bytes = gea::TypedArray<std::uint8_t>;

struct Compressor {
  ZSTD_CCtx* context = nullptr;

  Compressor() = default;
  Compressor(const Compressor&) = delete;
  Compressor& operator=(const Compressor&) = delete;
  ~Compressor() {
    if (context != nullptr) ZSTD_freeCCtx(context);
  }
};

inline std::unordered_map<std::uint64_t, std::unique_ptr<Compressor>>& compressors() {
  static std::unordered_map<std::uint64_t, std::unique_ptr<Compressor>> table;
  return table;
}

inline Compressor& compressorAt(double handle) {
  const auto found = compressors().find(static_cast<std::uint64_t>(handle));
  if (found == compressors().end()) gea::host::throwRuntimeError("Error", "zstd binding closed");
  return *found->second;
}

[[noreturn]] inline void fail(std::size_t code) {
  gea::host::throwRuntimeError("Error", ZSTD_getErrorName(code));
}

inline double compressorOpen() {
  static std::uint64_t last = 0;
  auto compressor = std::make_unique<Compressor>();
  compressor->context = ZSTD_createCCtx();
  if (compressor->context == nullptr) gea::host::throwRuntimeError("Error", "Cannot allocate memory");
  compressors().emplace(++last, std::move(compressor));
  return static_cast<double>(last);
}

inline void compressorSet(double handle, double key, double value) {
  const std::size_t result = ZSTD_CCtx_setParameter(compressorAt(handle).context, static_cast<ZSTD_cParameter>(static_cast<int>(key)),
                                                    static_cast<int>(value));
  if (ZSTD_isError(result)) fail(result);
}

inline gea::Ref<gea::TypedArray<std::uint8_t>> compress(double handle, const Bytes& bytes) {
  Compressor& compressor = compressorAt(handle);
  std::vector<std::uint8_t> output(ZSTD_compressBound(bytes.size()));
  const std::size_t written = ZSTD_compress2(compressor.context, output.data(), output.size(), bytes.data(), bytes.size());
  if (ZSTD_isError(written)) fail(written);
  output.resize(written);
  return gea::node::buffer::detail::bufferResult(std::move(output));
}

inline void compressorClose(double handle) {
  compressors().erase(static_cast<std::uint64_t>(handle));
}

// Streams the frame out rather than trusting a declared content size: a frame
// written by a streaming encoder carries none, and node decodes those too.
inline gea::Ref<gea::TypedArray<std::uint8_t>> decompress(const Bytes& bytes) {
  std::unique_ptr<ZSTD_DCtx, decltype(&ZSTD_freeDCtx)> context(ZSTD_createDCtx(), &ZSTD_freeDCtx);
  if (context == nullptr) gea::host::throwRuntimeError("Error", "Cannot allocate memory");
  ZSTD_inBuffer input{bytes.data(), bytes.size(), 0};
  std::vector<std::uint8_t> output;
  const std::size_t chunk = ZSTD_DStreamOutSize();
  std::size_t hint = 1;
  while (input.pos < input.size || hint != 0) {
    const std::size_t used = output.size();
    output.resize(used + chunk);
    ZSTD_outBuffer out{output.data() + used, chunk, 0};
    hint = ZSTD_decompressStream(context.get(), &out, &input);
    if (ZSTD_isError(hint)) fail(hint);
    output.resize(used + out.pos);
    // All input consumed, no output produced and the frame still open: the
    // input ends mid-frame.
    if (hint != 0 && input.pos == input.size && out.pos < chunk) gea::host::throwRuntimeError("Error", "unexpected end of file");
  }
  return gea::node::buffer::detail::bufferResult(std::move(output));
}

}  // namespace gea::node::zstd

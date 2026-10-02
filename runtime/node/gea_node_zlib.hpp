#pragma once

// node:zlib's codecs, over the platform's own zlib -- the library node itself
// vendors. TypeScript owns the API shape (`runtime/node/zlib.ts`); only whole
// byte buffers cross this boundary, as native typed-array views, so a
// compressed payload is never boxed.
//
// `windowBits` selects the framing exactly as zlib defines it, and node's
// classes map onto it one to one: 15 is the zlib wrapper (Deflate/Inflate),
// 31 is gzip (Gzip/Gunzip), -15 is raw deflate (DeflateRaw/InflateRaw), and
// 47 detects zlib or gzip from the header (Unzip).
#include "gea_runtime.h"

#include <zlib.h>

#include <cmath>
#include <cstdint>
#include <limits>
#include <string>
#include <vector>

namespace gea::node::zlib {
using Bytes = gea::TypedArray<std::uint8_t>;

/** node's message for a zlib return code, with zlib's own detail when it has one. */
[[noreturn]] inline void fail(int code, const z_stream& stream) {
  std::string message = stream.msg != nullptr ? stream.msg : "";
  if (message.empty()) {
    switch (code) {
      case Z_BUF_ERROR: message = "unexpected end of file"; break;
      case Z_MEM_ERROR: message = "Cannot allocate memory"; break;
      case Z_STREAM_ERROR: message = "zlib stream error"; break;
      case Z_NEED_DICT: message = "Missing dictionary"; break;
      default: message = "zlib error"; break;
    }
  }
  gea::host::throwRuntimeError("Error", message);
}

inline int framing(double windowBits) {
  if (windowBits == 15.0 || windowBits == 31.0 || windowBits == -15.0 || windowBits == 47.0) return static_cast<int>(windowBits);
  gea::host::throwRuntimeError("RangeError", "Unsupported zlib framing");
}

inline Bytef* input(const Bytes& bytes) {
  // zlib reads through a non-const pointer it never writes; a zero-length
  // input still needs a valid address.
  static Bytef empty = 0;
  return bytes.size() == 0 ? &empty : const_cast<Bytef*>(reinterpret_cast<const Bytef*>(bytes.data()));
}

inline std::vector<std::uint8_t> inflate(const Bytes& bytes, double windowBits) {
  const int bits = framing(windowBits);
  z_stream stream{};
  if (inflateInit2(&stream, bits) != Z_OK) fail(Z_MEM_ERROR, stream);
  std::vector<std::uint8_t> output;
  std::size_t remaining = bytes.size();
  Bytef* next = input(bytes);
  constexpr std::size_t chunk = 64 * 1024;
  for (;;) {
    const uInt take = static_cast<uInt>(std::min<std::size_t>(remaining, std::numeric_limits<uInt>::max()));
    stream.next_in = next;
    stream.avail_in = take;
    int code = Z_OK;
    do {
      const std::size_t used = output.size();
      output.resize(used + chunk);
      stream.next_out = reinterpret_cast<Bytef*>(output.data() + used);
      stream.avail_out = static_cast<uInt>(chunk);
      code = ::inflate(&stream, Z_NO_FLUSH);
      output.resize(used + (chunk - stream.avail_out));
      if (code != Z_OK && code != Z_STREAM_END && code != Z_BUF_ERROR) {
        inflateEnd(&stream);
        fail(code, stream);
      }
    } while (code == Z_OK && stream.avail_out == 0);
    next += take - stream.avail_in;
    remaining -= take - stream.avail_in;
    if (code == Z_STREAM_END) {
      // node's Gunzip reads every member of a multi-member gzip file; bytes
      // after a zlib or raw stream are ignored, as node ignores them.
      if (remaining == 0 || (bits != 31 && bits != 47)) break;
      if (inflateReset(&stream) != Z_OK) {
        inflateEnd(&stream);
        fail(Z_STREAM_ERROR, stream);
      }
      continue;
    }
    if (remaining == 0 || take == stream.avail_in) {
      // Input exhausted (or no progress) before the stream ended: node's
      // "unexpected end of file".
      inflateEnd(&stream);
      stream.msg = nullptr;
      fail(Z_BUF_ERROR, stream);
    }
  }
  inflateEnd(&stream);
  return output;
}

inline std::vector<std::uint8_t> deflate(const Bytes& bytes, double windowBits, double level) {
  const int bits = framing(windowBits);
  if (bits == 47) gea::host::throwRuntimeError("RangeError", "Unsupported zlib framing");
  if (!std::isfinite(level) || level < -1.0 || level > 9.0 || std::trunc(level) != level)
    gea::host::throwRuntimeError("RangeError", "The value of \"options.level\" is out of range. It must be >= -1 and <= 9.");
  z_stream stream{};
  if (deflateInit2(&stream, static_cast<int>(level), Z_DEFLATED, bits, 8, Z_DEFAULT_STRATEGY) != Z_OK) fail(Z_MEM_ERROR, stream);
  std::vector<std::uint8_t> output(deflateBound(&stream, static_cast<uLong>(bytes.size())));
  std::size_t remaining = bytes.size();
  Bytef* next = input(bytes);
  std::size_t written = 0;
  int code = Z_OK;
  while (code != Z_STREAM_END) {
    const uInt take = static_cast<uInt>(std::min<std::size_t>(remaining, std::numeric_limits<uInt>::max()));
    stream.next_in = next;
    stream.avail_in = take;
    if (output.size() - written < 64) output.resize(output.size() + 64 * 1024);
    const std::size_t room = std::min<std::size_t>(output.size() - written, std::numeric_limits<uInt>::max());
    stream.next_out = reinterpret_cast<Bytef*>(output.data() + written);
    stream.avail_out = static_cast<uInt>(room);
    code = ::deflate(&stream, remaining == take ? Z_FINISH : Z_NO_FLUSH);
    if (code == Z_STREAM_ERROR) {
      deflateEnd(&stream);
      fail(code, stream);
    }
    written += room - stream.avail_out;
    next += take - stream.avail_in;
    remaining -= take - stream.avail_in;
  }
  deflateEnd(&stream);
  output.resize(written);
  return output;
}

}  // namespace gea::node::zlib

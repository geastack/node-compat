#pragma once

#include "gea_runtime.h"
#include "gea_node_buffer.hpp"

#include <brotli/decode.h>

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace gea::node::brotli {
using Bytes = gea::TypedArray<std::uint8_t>;

inline gea::Ref<gea::TypedArray<std::uint8_t>> decompress(const Bytes& bytes) {
  BrotliDecoderState* state = BrotliDecoderCreateInstance(nullptr, nullptr, nullptr);
  if (state == nullptr) gea::host::throwRuntimeError("Error", "Cannot allocate memory");
  static const std::uint8_t empty = 0;
  const std::uint8_t* nextIn = bytes.size() == 0 ? &empty : reinterpret_cast<const std::uint8_t*>(bytes.data());
  std::size_t availableIn = bytes.size();
  std::vector<std::uint8_t> output;
  constexpr std::size_t chunk = 64 * 1024;
  BrotliDecoderResult result = BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT;
  while (result == BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT) {
    const std::size_t used = output.size();
    output.resize(used + chunk);
    std::uint8_t* nextOut = output.data() + used;
    std::size_t availableOut = chunk;
    result = BrotliDecoderDecompressStream(state, &availableIn, &nextIn, &availableOut, &nextOut, nullptr);
    output.resize(used + (chunk - availableOut));
  }
  if (result == BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT) {
    BrotliDecoderDestroyInstance(state);
    gea::host::throwRuntimeError("Error", "unexpected end of file");
  }
  if (result != BROTLI_DECODER_RESULT_SUCCESS) {
    BrotliDecoderDestroyInstance(state);
    gea::host::throwRuntimeError("Error", "Decompression failed");
  }
  BrotliDecoderDestroyInstance(state);
  return gea::node::buffer::detail::bufferResult(std::move(output));
}

struct Stream {
  BrotliDecoderState* state = nullptr;
  bool finished = false;
  bool leftover = false;

  Stream() = default;
  Stream(const Stream&) = delete;
  Stream& operator=(const Stream&) = delete;
  ~Stream() {
    if (state != nullptr) BrotliDecoderDestroyInstance(state);
  }
};

inline std::unordered_map<std::uint64_t, std::unique_ptr<Stream>>& streams() {
  static std::unordered_map<std::uint64_t, std::unique_ptr<Stream>> table;
  return table;
}

inline Stream& streamAt(double handle) {
  const auto found = streams().find(static_cast<std::uint64_t>(handle));
  if (found == streams().end()) gea::host::throwRuntimeError("Error", "brotli binding closed");
  return *found->second;
}

inline double streamOpen() {
  static std::uint64_t last = 0;
  auto stream = std::make_unique<Stream>();
  stream->state = BrotliDecoderCreateInstance(nullptr, nullptr, nullptr);
  if (stream->state == nullptr) gea::host::throwRuntimeError("Error", "Cannot allocate memory");
  streams().emplace(++last, std::move(stream));
  return static_cast<double>(last);
}

inline gea::Ref<gea::TypedArray<std::uint8_t>> streamWrite(double handle, const Bytes& bytes) {
  Stream& stream = streamAt(handle);
  std::vector<std::uint8_t> output;
  stream.leftover = bytes.size() > 0;
  if (stream.finished) return gea::node::buffer::detail::bufferResult(std::move(output));
  static const std::uint8_t empty = 0;
  const std::uint8_t* nextIn = bytes.size() == 0 ? &empty : reinterpret_cast<const std::uint8_t*>(bytes.data());
  std::size_t availableIn = bytes.size();
  constexpr std::size_t chunk = 64 * 1024;
  BrotliDecoderResult result = BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT;
  while (result == BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT) {
    const std::size_t used = output.size();
    output.resize(used + chunk);
    std::uint8_t* nextOut = output.data() + used;
    std::size_t availableOut = chunk;
    result = BrotliDecoderDecompressStream(stream.state, &availableIn, &nextIn, &availableOut, &nextOut, nullptr);
    output.resize(used + (chunk - availableOut));
  }
  if (result == BROTLI_DECODER_RESULT_ERROR) gea::host::throwRuntimeError("Error", "Decompression failed");
  if (result == BROTLI_DECODER_RESULT_SUCCESS) stream.finished = true;
  stream.leftover = availableIn > 0;
  return gea::node::buffer::detail::bufferResult(std::move(output));
}

inline bool streamLeftover(double handle) {
  return streamAt(handle).leftover;
}

inline void streamFinish(double handle) {
  if (!streamAt(handle).finished) gea::host::throwRuntimeError("Error", "unexpected end of file");
}

inline void streamClose(double handle) {
  streams().erase(static_cast<std::uint64_t>(handle));
}

}

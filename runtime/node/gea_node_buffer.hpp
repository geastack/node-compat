#pragma once

// node's `Buffer`, over the carrier geatsc already emits for a typed array.
//
// v1 answers this with `gea_node_buffer` (`gea_node_buffer.hpp`, beside this
// file): a CLASS deriving from `gea_cpp_typed_array<uint8_t>`, carrying every
// Buffer member as its own method. That shape is not available here and should
// not be recreated: v2 has no `gea_cpp_typed_array`, and `Buffer` is not a
// nominal type to v2 at all -- `runtime/node/buffer-types.ts` declares it as an
// interface EXTENDING `Uint8Array<ArrayBuffer>`, which the compiler's
// heritage-closed typed-array rule carries as `gea::TypedArray<std::uint8_t>`,
// the same carrier every `Uint8Array` in the program already has. A Buffer and
// a Uint8Array are then physically one thing, which is what node itself
// promises (`Buffer.prototype instanceof Uint8Array`) and what makes
// `Buffer.from(view)` and `view.set(buffer)` boundaries with nothing to
// convert. A `gea::node::Buffer : gea::TypedArray<std::uint8_t>` would instead
// give the program two C++ types for one carrier and put a slice at every
// boundary the declarations say is an identity.
//
// So these are FREE FUNCTIONS, and their signatures are dictated by the host
// boundary rather than chosen: `targets/cpp/host/emit-host-arity.ts` renders a
// `typed-array` argument through `gea::detail::hostTypedArrayArgument`, which
// yields `const gea::TypedArray<T>&`, and an `array-object` argument through
// `gea::detail::hostArrayArgument`, which yields `std::vector<E>`. A
// `typed-array` RESULT is wrapped in `gea::detail::hostTypedArrayResult<T>`,
// which is overloaded for a finished byte vector and for a view the host
// already holds. Buffer's factories return the latter after attaching the
// opaque Buffer brand: the emitter's wrapper preserves it, and a plain
// Uint8Array remains the same physical carrier without acquiring the brand.
//
// The codecs:
// hex, base64, base64url, latin1, ascii and utf16le, with the same surrogate
// handling. What is NOT re-derived here is UTF-8 itself -- `gea::runtime::text`
// and `gea::runtime::textcodec` already own the encode and decode directions,
// replacement-character rule included, and a second implementation here would
// be a second answer to one question.

#include "gea_runtime.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <string>
#include <vector>

namespace gea::node {

/**
 * The object behind the `Buffer` PATH.
 *
 * `plugin/index.mjs` claims `Buffer` as a host namespace, so every use of the name
 * resolves to a spelling and no object called `Buffer` is ever materialized --
 * but a path is not nothing, and the compiler asks what carries the root itself
 * (`PluginCapabilities.hostNamespaceRootTypes`). Without an answer the only one
 * available is `BufferConstructor`'s own declaration, whose eight signatures
 * collapse to a single callable carrier, and reading `.from` off that is the
 * refusal the namespace claim exists to remove.
 *
 * Empty, and correspondingly so: unlike gea's `gea::host::window`, this host
 * holds no state behind the name -- every static is a free function in
 * `gea::node::buffer` below. The type exists so the carrier question has a real
 * answer, and the instance so a program that holds the root as a value (none
 * does; `new Buffer(...)` has been deprecated since node 6) still links.
 */
struct BufferFacade {};
inline constexpr BufferFacade buffer_facade{};

}  // namespace gea::node

namespace gea::node::buffer {

/** The one view type every function here takes: `Buffer` IS `Uint8Array`. */
using View = gea::TypedArray<std::uint8_t>;

namespace detail {

[[noreturn]] inline void throwRange(const char* message) { gea::host::throwRuntimeError("RangeError", message); }

[[noreturn]] inline void throwType(const std::string& message) { gea::host::throwRuntimeError("TypeError", message); }

/** Allocation accepts Node's finite, non-negative ToIntegerOrInfinity result. */
inline std::size_t allocationSize(double value) {
  if (!std::isfinite(value) || value < 0.0) throwRange("Buffer size is outside the supported range");
  const double integer = std::trunc(value);
  if (integer > static_cast<double>(std::vector<std::uint8_t>{}.max_size())) throwRange("Buffer size is outside the supported range");
  return static_cast<std::size_t>(integer);
}

/** ArrayBuffer overloads use ToIndex: NaN becomes zero, fractions truncate, negatives and infinities throw. */
inline std::size_t arrayBufferIndex(double value, const char* message) {
  constexpr double maxSafeInteger = 9007199254740991.0;  // 2^53 - 1, ECMA-262's ToIndex ceiling.
  if (std::isnan(value)) return 0;
  if (!std::isfinite(value)) throwRange(message);
  const double integer = std::trunc(value);
  // ToIndex rejects a negative INTEGER. Values in (-1, 0) truncate to -0 and
  // therefore select the first byte, as Node does.
  if (integer < 0.0) throwRange(message);
  if (integer > maxSafeInteger) throwRange(message);
  // On a narrow target, prove the native result fits before casting.  The
  // branch is absent on 53+-bit size_t targets, avoiding a rounded
  // double(size_t::max()) comparison on 64-bit hosts.
  if constexpr (std::numeric_limits<std::size_t>::digits < 53) {
    if (integer > static_cast<double>(std::numeric_limits<std::size_t>::max())) throwRange(message);
  }
  return static_cast<std::size_t>(integer);
}

/** `Buffer.from(arrayBuffer, offset, length)` applies ToIndex to length too. */
inline std::size_t arrayBufferLength(double value, const char* message) {
  return arrayBufferIndex(value, message);
}

/** Numeric Buffer read/write offsets must be finite, integral, and in range. */
inline std::size_t integerOffset(double value, const char* message) {
  if (!std::isfinite(value) || value < 0.0 || std::trunc(value) != value) throwRange(message);
  if (value > static_cast<double>(std::numeric_limits<std::size_t>::max())) throwRange(message);
  return static_cast<std::size_t>(value);
}

inline std::size_t readableOffset(const View& view, double value, std::size_t width) {
  const std::size_t offset = integerOffset(value, "Offset is outside the bounds of the Buffer");
  if (offset > view.size() || width > view.size() - offset) throwRange("Offset is outside the bounds of the Buffer");
  return offset;
}

inline std::size_t writableOffset(const View& view, double value) {
  const std::size_t offset = integerOffset(value, "Offset is outside the bounds of the Buffer");
  if (offset > view.size()) throwRange("Offset is outside the bounds of the Buffer");
  return offset;
}

/**
 * A Buffer range index, which is NOT `gea::detail::relativeIndex`.
 *
 * `Buffer.toString` clamps negative positions to zero rather than interpreting
 * them relative to the end as `slice`/`subarray` do. NaN becomes zero and
 * positive infinity becomes the byte length.
 */
inline std::size_t stringRangeIndex(double value, std::size_t length) {
  if (std::isnan(value)) return 0;
  if (!std::isfinite(value)) return value < 0.0 ? 0 : length;
  const double integer = std::trunc(value);
  if (integer <= 0.0) return 0;
  return integer >= static_cast<double>(length) ? length : static_cast<std::size_t>(integer);
}

/** Buffer.copy uses its legacy uint32-like coercion, then validates finite negatives. */
inline std::size_t copyIndex(double value, const char* message) {
  if (!std::isfinite(value)) return 0;
  const double integer = std::floor(value);
  if (integer < 0.0) throwRange(message);
  if (integer > static_cast<double>(std::numeric_limits<std::size_t>::max())) {
    return std::numeric_limits<std::size_t>::max();
  }
  return static_cast<std::size_t>(integer);
}

/** node's encoding aliases, folded to the names the codecs below switch on. */
inline std::string normalizeEncoding(std::string encoding) {
  for (char& ch : encoding) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
  if (encoding.empty() || encoding == "utf-8") return "utf8";
  if (encoding == "ucs2" || encoding == "ucs-2" || encoding == "utf-16le") return "utf16le";
  if (encoding == "binary") return "latin1";
  if (encoding == "utf8" || encoding == "hex" || encoding == "base64" || encoding == "base64url" || encoding == "latin1" || encoding == "ascii" || encoding == "utf16le") {
    return encoding;
  }
  throwType(std::string("Unknown encoding: ") + encoding);
}

inline int hexDigit(unsigned char ch) {
  if (ch >= '0' && ch <= '9') return ch - '0';
  if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
  if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
  return -1;
}

// `+`/`-` and `/`/`_` both accepted, so one decoder answers base64 and
// base64url: node's own decoder does not distinguish them either -- the
// difference between the two is entirely in what `toString` EMITS.
inline int base64Digit(unsigned char ch) {
  if (ch >= 'A' && ch <= 'Z') return ch - 'A';
  if (ch >= 'a' && ch <= 'z') return ch - 'a' + 26;
  if (ch >= '0' && ch <= '9') return ch - '0' + 52;
  if (ch == '+' || ch == '-') return 62;
  if (ch == '/' || ch == '_') return 63;
  return -1;
}

inline std::vector<std::uint8_t> decodeBase64(const std::string& input) {
  std::vector<std::uint8_t> out;
  out.reserve((input.size() / 4) * 3);
  std::uint32_t accumulator = 0;
  int bits = 0;
  for (unsigned char ch : input) {
    const int digit = base64Digit(ch);
    if (digit < 0) continue;
    accumulator = (accumulator << 6) | static_cast<std::uint32_t>(digit);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<std::uint8_t>((accumulator >> bits) & 0xff));
    }
  }
  return out;
}

inline std::string encodeBase64(const std::uint8_t* data, std::size_t begin, std::size_t end, bool url) {
  static constexpr char plain[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  static constexpr char safe[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const char* digits = url ? safe : plain;
  std::string out;
  out.reserve(((end - begin + 2) / 3) * 4);
  for (std::size_t index = begin; index < end; index += 3) {
    const bool hasSecond = index + 1 < end;
    const bool hasThird = index + 2 < end;
    const std::uint32_t triple = (static_cast<std::uint32_t>(data[index]) << 16) |
                                 (static_cast<std::uint32_t>(hasSecond ? data[index + 1] : 0u) << 8) |
                                 static_cast<std::uint32_t>(hasThird ? data[index + 2] : 0u);
    out.push_back(digits[(triple >> 18) & 63]);
    out.push_back(digits[(triple >> 12) & 63]);
    out.push_back(hasSecond ? digits[(triple >> 6) & 63] : '=');
    out.push_back(hasThird ? digits[triple & 63] : '=');
  }
  // `base64url` is unpadded by definition (RFC 4648 section 5), so the `=` the
  // shared loop above wrote for a partial group is removed rather than never
  // written -- `base64` keeps them, and the two differ only here.
  if (url) {
    while (!out.empty() && out.back() == '=') out.pop_back();
  }
  return out;
}

/**
 * The code points of a JS string, which this runtime stores as UTF-8.
 *
 * A latin1, ascii or utf16le encode is therefore a DECODE followed by a
 * re-encode, not a byte copy: `'é'` is two bytes here and one latin1 byte, and
 * treating the storage as the answer would write both.
 */
inline std::vector<std::uint32_t> codePointsOf(const std::string& input) {
  std::vector<std::uint32_t> points;
  points.reserve(input.size());
  std::size_t index = 0;
  while (index < input.size()) {
    std::uint32_t point = 0;
    std::size_t next = index;
    if (!gea::runtime::text::decodeNextUtf8(input, index, point, next, true)) {
      points.push_back(0xfffd);
      index += 1;
      continue;
    }
    points.push_back(point);
    index = next;
  }
  return points;
}

inline std::vector<std::uint8_t> encodeString(const std::string& input, std::string encoding) {
  encoding = normalizeEncoding(std::move(encoding));
  if (encoding == "hex") {
    std::vector<std::uint8_t> out;
    out.reserve(input.size() / 2);
    for (std::size_t index = 0; index + 1 < input.size(); index += 2) {
      const int high = hexDigit(static_cast<unsigned char>(input[index]));
      const int low = hexDigit(static_cast<unsigned char>(input[index + 1]));
      // node stops at the first pair that is not hex rather than skipping it.
      if (high < 0 || low < 0) break;
      out.push_back(static_cast<std::uint8_t>((high << 4) | low));
    }
    return out;
  }
  if (encoding == "base64" || encoding == "base64url") return decodeBase64(input);
  if (encoding == "latin1" || encoding == "ascii") {
    std::vector<std::uint8_t> out;
    for (std::uint32_t point : codePointsOf(input)) out.push_back(static_cast<std::uint8_t>(encoding == "ascii" ? (point & 0x7fu) : (point & 0xffu)));
    return out;
  }
  if (encoding == "utf16le") {
    std::vector<std::uint8_t> out;
    for (std::uint32_t point : codePointsOf(input)) {
      if (point > 0x10ffff) point = 0xfffd;
      if (point >= 0x10000) {
        const std::uint32_t adjusted = point - 0x10000;
        const std::uint16_t high = static_cast<std::uint16_t>(0xd800 + (adjusted >> 10));
        const std::uint16_t low = static_cast<std::uint16_t>(0xdc00 + (adjusted & 0x3ff));
        out.push_back(static_cast<std::uint8_t>(high & 0xff));
        out.push_back(static_cast<std::uint8_t>(high >> 8));
        out.push_back(static_cast<std::uint8_t>(low & 0xff));
        out.push_back(static_cast<std::uint8_t>(low >> 8));
        continue;
      }
      out.push_back(static_cast<std::uint8_t>(point & 0xff));
      out.push_back(static_cast<std::uint8_t>((point >> 8) & 0xff));
    }
    return out;
  }
  // Runtime strings may contain WTF-8 surrogates; the shared encoder owns
  // their replacement/joining rule for both TextEncoder and Buffer.
  std::vector<std::uint8_t> out;
  out.reserve(input.size());
  gea::runtime::textcodec::visitUtf8(input, [&](const char *data, std::size_t count, bool) {
    out.insert(out.end(), data, data + count);
    return true;
  });
  return out;
}

/**
 * The receiver of a mutating member, as a writable view.
 *
 * The `const` is the HOST BOUNDARY's, not the program's:
 * `gea::detail::hostTypedArrayArgument` hands every typed array across as
 * `const TypedArray<T>&` because most hosts only read one. `buf.write(...)`
 * and `buf.copy(...)` are specified to mutate their receiver, and the object
 * behind the reference is a mutable view the program owns -- so this is the
 * one place that says so, once and by name, rather than each member casting
 * for itself.
 */
inline View& writable(const View& view) { return const_cast<View&>(view); }

// One process-wide identity for the JavaScript Buffer brand. The generic
// typed-array carrier stores only this opaque address; Node owns its meaning.
inline constexpr char bufferBrand = 0;

inline gea::Ref<View> markBuffer(gea::Ref<View> view) {
  if (view) view->setHostBrand(&bufferBrand);
  return view;
}

inline gea::Ref<View> bufferResult(std::vector<std::uint8_t> bytes) {
  return markBuffer(gea::detail::hostTypedArrayResult<std::uint8_t>(std::move(bytes)));
}

}  // namespace detail

// -- the statics, reached through `Buffer` as a host NAMESPACE ---------------

inline gea::Ref<View> alloc(double size) {
  return detail::bufferResult(std::vector<std::uint8_t>(detail::allocationSize(size), std::uint8_t{0}));
}

inline gea::Ref<View> alloc(double size, double fill) {
  const std::uint8_t byte = static_cast<std::uint8_t>(static_cast<std::uint64_t>(std::isfinite(fill) ? std::trunc(fill) : 0.0) & 0xffu);
  return detail::bufferResult(std::vector<std::uint8_t>(detail::allocationSize(size), byte));
}

inline gea::Ref<View> alloc(double size, const std::string& fill, const std::string& encoding = "utf8") {
  std::vector<std::uint8_t> out(detail::allocationSize(size), std::uint8_t{0});
  const std::vector<std::uint8_t> pattern = detail::encodeString(fill, encoding);
  if (pattern.empty()) return detail::bufferResult(std::move(out));
  for (std::size_t index = 0; index < out.size(); ++index) out[index] = pattern[index % pattern.size()];
  return detail::bufferResult(std::move(out));
}

inline gea::Ref<View> alloc(double size, const View& fill, const std::string& = "utf8") {
  std::vector<std::uint8_t> out(detail::allocationSize(size), std::uint8_t{0});
  if (fill.size() == 0) return detail::bufferResult(std::move(out));
  for (std::size_t index = 0; index < out.size(); ++index) out[index] = fill.data()[index % fill.size()];
  return detail::bufferResult(std::move(out));
}

/**
 * `Buffer.allocUnsafe` IS `Buffer.alloc` here, deliberately.
 *
 * node permits an `allocUnsafe` buffer to hold whatever was in its pool; it
 * does not promise it. Zeroing is a strictly stronger guarantee, so every
 * program correct under node stays correct here, and the class of bug the
 * unsafe form invites -- uninitialized bytes reaching the wire -- cannot occur.
 */
inline gea::Ref<View> allocUnsafe(double size) { return alloc(size); }

inline gea::Ref<View> from(const std::string& text, const std::string& encoding = "utf8") {
  return detail::bufferResult(detail::encodeString(text, encoding));
}

/** `Buffer.from(view)`: a COPY, per node -- `Buffer.from(u8)` does not alias `u8`. */
inline gea::Ref<View> from(const View& view) {
  return detail::bufferResult(std::vector<std::uint8_t>(view.data(), view.data() + view.size()));
}

/** `Buffer.from(arrayLike)`, over the vector the host boundary hands an `array-object` across as. */
inline gea::Ref<View> from(const std::vector<double>& values) {
  std::vector<std::uint8_t> out;
  out.reserve(values.size());
  for (double value : values) out.push_back(static_cast<std::uint8_t>(static_cast<std::uint64_t>(std::isfinite(value) ? std::trunc(value) : 0.0) & 0xffu));
  return detail::bufferResult(std::move(out));
}

/**
 * `Buffer.from(arrayBuffer, byteOffset?, length?)`: a VIEW over the block, the
 * one `from` node specifies as sharing rather than copying.
 *
 * Returns the view itself rather than a byte vector, which
 * `hostTypedArrayResult`'s second overload takes unchanged -- returning bytes
 * here would copy and lose exactly the aliasing this overload exists for.
 */
inline gea::Ref<View> from(const gea::Ref<gea::ArrayBuffer>& block, double byteOffset, double length) {
  const std::size_t total = block ? block->size() : 0;
  const std::size_t offset = detail::arrayBufferIndex(byteOffset, "Start offset is outside the bounds of the buffer");
  if (offset > total) detail::throwRange("Start offset is outside the bounds of the buffer");
  const std::size_t count = detail::arrayBufferLength(length, "Length is outside the bounds of the buffer");
  if (count > total - offset) detail::throwRange("Length is outside the bounds of the buffer");
  return detail::markBuffer(gea::makeRef<View>(View::fromBuffer(block, offset, count)));
}

inline gea::Ref<View> from(const gea::Ref<gea::ArrayBuffer>& block, double byteOffset) {
  const std::size_t total = block ? block->size() : 0;
  const std::size_t offset = detail::arrayBufferIndex(byteOffset, "Start offset is outside the bounds of the buffer");
  if (offset > total) detail::throwRange("Start offset is outside the bounds of the buffer");
  return detail::markBuffer(gea::makeRef<View>(View::fromBuffer(block, offset, total - offset)));
}

inline gea::Ref<View> from(const gea::Ref<gea::ArrayBuffer>& block) { return from(block, 0.0); }

/**
 * `Buffer.concat(list)`, over a list of anything with `data()`/`size()`.
 *
 * A template because the element carrier is the program's: an array of
 * `Uint8Array` crosses the boundary as `std::vector<gea::Ref<View>>` and an
 * array of `Buffer` as the same, but a host row states one spelling for both
 * and neither element type is this file's to name.
 */
template <typename List>
inline gea::Ref<View> concat(const List& list) {
  std::size_t total = 0;
  for (const auto& item : list) total += gea::detail::hostTypedArrayArgument(item).size();
  std::vector<std::uint8_t> out;
  out.reserve(total);
  for (const auto& item : list) {
    const View& view = gea::detail::hostTypedArrayArgument(item);
    out.insert(out.end(), view.data(), view.data() + view.size());
  }
  return detail::bufferResult(std::move(out));
}

template <typename List>
inline gea::Ref<View> concat(const List& list, double requestedLength) {
  std::vector<std::uint8_t> out(detail::allocationSize(requestedLength), std::uint8_t{0});
  std::size_t offset = 0;
  for (const auto& item : list) {
    if (offset >= out.size()) break;
    const View& view = gea::detail::hostTypedArrayArgument(item);
    const std::size_t count = std::min(view.size(), out.size() - offset);
    if (count != 0) std::copy_n(view.data(), count, out.data() + offset);
    offset += count;
  }
  return detail::bufferResult(std::move(out));
}

inline double byteLength(const std::string& text, const std::string& encoding = "utf8") {
  if (detail::normalizeEncoding(encoding) == "utf8") return static_cast<double>(gea::runtime::textcodec::utf8ByteLength(text));
  return static_cast<double>(detail::encodeString(text, encoding).size());
}

inline double byteLength(const View& view) { return static_cast<double>(view.size()); }

inline double byteLength(const gea::Ref<gea::ArrayBuffer>& block) { return static_cast<double>(block ? block->size() : 0); }

/**
 * `Buffer.isBuffer(value)`.
 *
 * A Buffer and a Uint8Array intentionally share one byte-view carrier (see the
 * header note), but Buffer factories attach Node's opaque host brand to the
 * view. Subarray and slice preserve it in the generic carrier. The dynamic
 * overload checks the erased payload type before reading that same marker,
 * which is required because Node declares this predicate's input `unknown`.
 * Every other carrier is certainly not a Buffer.
 */
inline bool isBuffer(const View& view) { return view.hasHostBrand(&detail::bufferBrand); }

inline bool isBuffer(const gea::Value& value) {
  using Handle = gea::Ref<View>;
  if (value.tag() != gea::Value::Tag::Object || value.payloadType() != gea::detail::payloadTypeTagFor<Handle>()) return false;
  const Handle& view = value.as<Handle>();
  return view && isBuffer(*view);
}

template <typename Value>
inline bool isBuffer(const Value&) {
  return false;
}

// -- the instance members, keyed on the carrier -----------------------------

inline gea::Ref<View> subarray(const View& view, double begin = 0.0, double end = std::numeric_limits<double>::infinity()) {
  return view.subarray(begin, end);
}

inline gea::Ref<View> slice(const View& view, double begin = 0.0, double end = std::numeric_limits<double>::infinity()) {
  return view.subarray(begin, end);
}

inline std::string toString(
    const View& view,
    const std::string& requestedEncoding = "utf8",
    double requestedBegin = 0.0,
    double requestedEnd = std::numeric_limits<double>::infinity()) {
  const std::uint8_t* data = view.data();
  const std::size_t begin = detail::stringRangeIndex(requestedBegin, view.size());
  const std::size_t end = std::max(begin, detail::stringRangeIndex(requestedEnd, view.size()));
  const std::string encoding = detail::normalizeEncoding(requestedEncoding);
  if (encoding == "hex") {
    static constexpr char digits[] = "0123456789abcdef";
    std::string out;
    out.reserve((end - begin) * 2);
    for (std::size_t index = begin; index < end; ++index) {
      out.push_back(digits[data[index] >> 4]);
      out.push_back(digits[data[index] & 15]);
    }
    return out;
  }
  if (encoding == "base64" || encoding == "base64url") return detail::encodeBase64(data, begin, end, encoding == "base64url");
  if (encoding == "latin1" || encoding == "ascii") {
    std::string out;
    out.reserve(end - begin);
    for (std::size_t index = begin; index < end; ++index) gea::runtime::text::appendUtf8(out, encoding == "ascii" ? (data[index] & 0x7fu) : data[index]);
    return out;
  }
  if (encoding == "utf16le") {
    std::string out;
    for (std::size_t index = begin; index + 1 < end; index += 2) {
      const std::uint16_t first = static_cast<std::uint16_t>(data[index] | (static_cast<std::uint16_t>(data[index + 1]) << 8));
      if (first >= 0xd800 && first <= 0xdbff && index + 3 < end) {
        const std::uint16_t second = static_cast<std::uint16_t>(data[index + 2] | (static_cast<std::uint16_t>(data[index + 3]) << 8));
        if (second >= 0xdc00 && second <= 0xdfff) {
          gea::runtime::text::appendUtf8(out, 0x10000u + ((static_cast<std::uint32_t>(first) - 0xd800u) << 10) + (second - 0xdc00u));
          index += 2;
          continue;
        }
      }
      gea::runtime::text::appendUtf8(out, first >= 0xd800 && first <= 0xdfff ? 0xfffdu : first);
    }
    return out;
  }
  return gea::runtime::textcodec::decodeUtf8Buffer(data + begin, end - begin, false, true);
}

// ToString of a Buffer the program only holds boxed (`body + chunk` in a
// 'data' listener, where Node types `chunk` as `any`): UTF-8, not the
// comma-joined bytes a plain Uint8Array answers. Stated to the runtime against
// the brand, and only where the runtime has the table to state it to.
#ifdef GEA_HOST_VIEW_TO_STRING
inline const bool bufferToStringRegistered =
    gea::detail::registerHostViewToString(&detail::bufferBrand, +[](const View& view) { return toString(view); });
#endif

inline double writeSpan(const View& view, const std::string& text, std::size_t offset, std::size_t requested, const std::string& encoding) {
  if (detail::normalizeEncoding(encoding) == "utf8") {
    if (requested == 0) return 0;
    return static_cast<double>(gea::runtime::textcodec::writeUtf8(text, detail::writable(view).data() + offset, requested));
  }
  const std::vector<std::uint8_t> bytes = detail::encodeString(text, encoding);
  const std::size_t count = std::min(requested, bytes.size());
  if (count != 0) std::copy_n(bytes.data(), count, detail::writable(view).data() + offset);
  return static_cast<double>(count);
}

inline double write(const View& view, const std::string& text) { return writeSpan(view, text, 0, view.size(), "utf8"); }

inline double write(const View& view, const std::string& text, double offset) {
  const std::size_t start = detail::writableOffset(view, offset);
  return writeSpan(view, text, start, view.size() - start, "utf8");
}

inline double write(const View& view, const std::string& text, double offset, double length, const std::string& encoding) {
  const std::size_t start = detail::writableOffset(view, offset);
  const std::size_t requested = detail::integerOffset(length, "Length is outside the bounds of the Buffer");
  if (requested > view.size()) detail::throwRange("Length is outside the bounds of the Buffer");
  return writeSpan(view, text, start, std::min(view.size() - start, requested), encoding);
}

inline double write(const View& view, const std::string& text, double offset, double length) { return write(view, text, offset, length, "utf8"); }

/** `buf.write(text, offset, encoding)`: node's own three-argument overload, whose third argument is the ENCODING and not a length. */
inline double write(const View& view, const std::string& text, double offset, const std::string& encoding) {
  const std::size_t start = detail::writableOffset(view, offset);
  return writeSpan(view, text, start, view.size() - start, encoding);
}

/** An explicit JavaScript `undefined` in the length slot selects the remaining-capacity default. */
inline double write(const View& view, const std::string& text, double offset, const gea::Undefined&, const std::string& encoding) {
  const std::size_t start = detail::writableOffset(view, offset);
  return writeSpan(view, text, start, view.size() - start, encoding);
}

inline double write(const View& view, const std::string& text, double offset, const gea::Undefined& length) { return write(view, text, offset, length, "utf8"); }

inline double write(const View& view, const std::string& text, const std::string& encoding) {
  return writeSpan(view, text, 0, view.size(), encoding);
}

inline double copy(
    const View& source,
    const View& target,
    double requestedTargetStart,
    double requestedSourceStart,
    double requestedSourceEnd) {
  const std::size_t targetStart = detail::copyIndex(requestedTargetStart, "targetStart is outside the bounds of the Buffer");
  const std::size_t sourceStart = detail::copyIndex(requestedSourceStart, "sourceStart is outside the bounds of the Buffer");
  const std::size_t requestedEnd = detail::copyIndex(requestedSourceEnd, "sourceEnd is outside the bounds of the Buffer");
  if (targetStart >= target.size()) return 0;
  if (sourceStart > source.size()) detail::throwRange("sourceStart is outside the bounds of the Buffer");
  const std::size_t sourceEnd = std::max(sourceStart, std::min(requestedEnd, source.size()));
  const std::size_t count = std::min(sourceEnd - sourceStart, target.size() - targetStart);
  // `memmove`, not `memcpy`: a Buffer may be copied onto itself, and
  // `Buffer.prototype.copy` is specified to handle the overlap.
  if (count != 0) std::memmove(detail::writable(target).data() + targetStart, source.data() + sourceStart, count);
  return static_cast<double>(count);
}


inline double copy(const View& source, const View& target, double targetStart, double sourceStart) {
  return copy(source, target, targetStart, sourceStart, static_cast<double>(source.size()));
}

inline double copy(const View& source, const View& target, double targetStart) {
  return copy(source, target, targetStart, 0.0, static_cast<double>(source.size()));
}

inline double copy(const View& source, const View& target) {
  return copy(source, target, 0.0, 0.0, static_cast<double>(source.size()));
}

inline double readUInt8(const View& view, double offset = 0.0) {
  const std::size_t index = detail::readableOffset(view, offset, 1);
  return static_cast<double>(view.data()[index]);
}

inline double readUInt32LE(const View& view, double offset = 0.0) {
  const std::size_t index = detail::readableOffset(view, offset, 4);
  const std::uint8_t* data = view.data();
  return static_cast<double>(static_cast<std::uint32_t>(data[index]) | (static_cast<std::uint32_t>(data[index + 1]) << 8) |
                             (static_cast<std::uint32_t>(data[index + 2]) << 16) | (static_cast<std::uint32_t>(data[index + 3]) << 24));
}

inline double readInt32LE(const View& view, double offset = 0.0) {
  return static_cast<double>(static_cast<std::int32_t>(static_cast<std::uint32_t>(readUInt32LE(view, offset))));
}

inline double writeUInt8(const View& view, double value, double offset = 0.0) {
  const std::size_t index = detail::readableOffset(view, offset, 1);
  const double integer = std::isnan(value) ? 0.0 : std::trunc(value);
  if (!std::isfinite(value) || integer < 0.0 || integer > 255.0) detail::throwRange("Value is outside the range of a uint8");
  detail::writable(view).data()[index] = static_cast<std::uint8_t>(integer);
  return static_cast<double>(index + 1);
}

inline double writeUInt32LE(const View& view, double value, double offset = 0.0) {
  const std::size_t index = detail::readableOffset(view, offset, 4);
  const double integer = std::isnan(value) ? 0.0 : std::trunc(value);
  if (!std::isfinite(value) || integer < 0.0 || integer > 4294967295.0) detail::throwRange("Value is outside the range of a uint32");
  const std::uint32_t bits = static_cast<std::uint32_t>(integer);
  std::uint8_t* data = detail::writable(view).data();
  data[index] = static_cast<std::uint8_t>(bits & 0xffu);
  data[index + 1] = static_cast<std::uint8_t>((bits >> 8) & 0xffu);
  data[index + 2] = static_cast<std::uint8_t>((bits >> 16) & 0xffu);
  data[index + 3] = static_cast<std::uint8_t>((bits >> 24) & 0xffu);
  return static_cast<double>(index + 4);
}

inline double writeInt32LE(const View& view, double value, double offset = 0.0) {
  const double integer = std::isnan(value) ? 0.0 : std::trunc(value);
  if (!std::isfinite(value) || integer < -2147483648.0 || integer > 2147483647.0) detail::throwRange("Value is outside the range of an int32");
  const std::int32_t signedValue = static_cast<std::int32_t>(integer);
  return writeUInt32LE(view, static_cast<double>(static_cast<std::uint32_t>(signedValue)), offset);
}

inline bool equals(const View& left, const View& right) {
  if (left.size() != right.size()) return false;
  return left.size() == 0 || std::equal(left.data(), left.data() + left.size(), right.data());
}

inline double compare(const View& left, const View& right) {
  const std::size_t shared = std::min(left.size(), right.size());
  for (std::size_t index = 0; index < shared; ++index) {
    if (left.data()[index] < right.data()[index]) return -1.0;
    if (left.data()[index] > right.data()[index]) return 1.0;
  }
  return left.size() < right.size() ? -1.0 : left.size() > right.size() ? 1.0 : 0.0;
}

/** `buf.swap32()`, in place, answering the receiver -- node's own contract. */
inline const View& swap32(const View& view) {
  if (view.size() % 4 != 0) detail::throwRange("Buffer size must be a multiple of 32-bits");
  std::uint8_t* data = detail::writable(view).data();
  for (std::size_t index = 0; index + 3 < view.size(); index += 4) {
    std::swap(data[index], data[index + 3]);
    std::swap(data[index + 1], data[index + 2]);
  }
  return view;
}

/** The identity-preserving host boundary used when `swap32()` publishes its receiver. */
inline gea::Ref<View> swap32(const gea::Ref<View>& view) {
  swap32(*view);
  return view;
}

}  // namespace gea::node::buffer

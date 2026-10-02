#include "gea_node_buffer.hpp"

#include <cassert>
#include <cstdint>
#include <string>
#include <vector>

namespace {

template <typename Call>
void expectsThrow(Call&& call) {
  try {
    call();
  } catch (...) {
    return;
  }
  assert(false && "expected Buffer operation to throw");
}

}  // namespace

int main() {
  using namespace gea::node::buffer;

  auto source = from(std::string("hello"));
  auto shared = slice(*source, 1, 4);
  writeUInt8(*shared, static_cast<double>('A'));
  assert(toString(*source) == "hAllo");
  assert(isBuffer(*source) && isBuffer(*shared));

  auto plain = gea::makeRef<View>(3);
  writeUInt8(*plain, 1, 0);
  auto copied = from(*plain);
  writeUInt8(*plain, 9, 0);
  assert(readUInt8(*copied, 0) == 1 && !isBuffer(*plain));

  auto bytes = gea::makeRef<gea::ArrayBuffer>(4, std::uint8_t{0});
  auto aliased = from(bytes, 1, 2);
  writeUInt8(*aliased, 0x7f, 0);
  assert((*bytes)[1] == 0x7f && isBuffer(*aliased));

  assert(toString(*from(std::string("ff80"), "hex"), "hex") == "ff80");
  assert(toString(*from(std::string("Zm9v"), "base64"), "utf8") == "foo");
  assert(toString(*from(std::string("\xC3\xA9"), "latin1"), "latin1") == "\xC3\xA9");

  const std::vector<gea::Ref<View>> pieces{from(std::string("a")), from(std::string("b"))};
  assert(toString(*concat(pieces)) == "ab");
  assert(equals(*from(std::string("a")), *from(std::string("a"))));
  assert(compare(*from(std::string("a")), *from(std::string("b"))) < 0);

  // `alloc`/`allocUnsafe`/`from`/`concat` now build the ArrayBuffer directly
  // (see `detail::bufferFromSize`/`bufferFromArrayBuffer`), on both sides of
  // `gea::ArrayBuffer`'s 64-byte inline threshold -- each result must still be
  // its own independent block (no accidental sharing between two `alloc`
  // calls) and must still read back exactly what was written.
  auto smallAlloc = alloc(16.0, 7.0);
  auto otherSmallAlloc = alloc(16.0, 9.0);
  assert(readUInt8(*smallAlloc, 0) == 7 && readUInt8(*otherSmallAlloc, 0) == 9);
  writeUInt8(*smallAlloc, 1, 0);
  assert(readUInt8(*otherSmallAlloc, 0) == 9 && isBuffer(*smallAlloc));

  auto largeAlloc = allocUnsafe(300.0);
  assert(largeAlloc->size() == 300);
  writeUInt8(*largeAlloc, 0xab, 299);
  assert(readUInt8(*largeAlloc, 299) == 0xab);

  const View& smallView = *smallAlloc;
  auto smallCopy = from(smallView);
  writeUInt8(*smallAlloc, 42, 0);
  assert(readUInt8(*smallCopy, 0) == 1 && readUInt8(*smallAlloc, 0) == 42);

  const std::vector<gea::Ref<View>> sizedPieces{allocUnsafe(70.0), allocUnsafe(70.0)};
  auto concatenated = concat(sizedPieces);
  assert(concatenated->size() == 140 && isBuffer(*concatenated));

  expectsThrow([] { alloc(-1); });
  expectsThrow([&] { from(bytes, 5); });
  expectsThrow([&] { readUInt8(*source, source->size()); });
  expectsThrow([] { from(std::string("x"), "not-an-encoding"); });
}

#include "gea_node_buffer.hpp"
#include <cassert>
#include <cstring>

int main() {
  using namespace gea::node::buffer;
  const std::string high = "\xed\xa0\xbd", low = "\xed\xb8\x80";
  const std::string smile = "\xf0\x9f\x98\x80", replacement = "\xef\xbf\xbd";
  for (const auto &[input, expected] : {std::pair{std::string("hello"), std::string("hello")},
       std::pair{std::string("a\xc3\xa9z"), std::string("a\xc3\xa9z")},
       std::pair{high, replacement}, std::pair{low, replacement}, std::pair{high + low, smile},
       std::pair{smile, smile}, std::pair{std::string(), std::string()}}) {
    assert(byteLength(input) == expected.size());
    auto bytes = from(input);
    assert(bytes->size() == expected.size());
    if (!expected.empty()) assert(std::memcmp(bytes->data(), expected.data(), expected.size()) == 0);
    auto encoded = gea::runtime::textcodec::TextEncoder{}.encode(input);
    assert(encoded->size() == expected.size());
    for (std::size_t capacity = 0; capacity <= expected.size() + 1; ++capacity) {
      auto target = alloc(capacity + 2, 0x7f);
      const auto count = static_cast<std::size_t>(write(*target, input, 1, capacity));
      std::size_t wanted = std::min(capacity, expected.size());
      while (wanted < expected.size() && wanted > 0 && (static_cast<unsigned char>(expected[wanted]) & 0xc0) == 0x80) --wanted;
      assert(count == wanted);
      if (count) assert(std::memcmp(target->data() + 1, expected.data(), count) == 0);
      assert(target->data()[0] == 0x7f && target->data()[count + 1] == 0x7f);
    }
  }
}

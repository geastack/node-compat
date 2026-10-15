#pragma once

// Cryptographic primitives use the platform provider. TypeScript owns the
// Hash/Hmac lifecycle; bytes cross this boundary as native typed-array views.
#include "gea_runtime.h"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <string>
#include <vector>

#if defined(__APPLE__)
#include <CommonCrypto/CommonDigest.h>
#include <CommonCrypto/CommonHMAC.h>
#include <CommonCrypto/CommonKeyDerivation.h>
#include <string.h>
#elif defined(_WIN32)
// Windows' own provider, CNG (bcrypt.dll): no third-party library to link.
#include "../gea_node_windows.hpp"
#include "../gea_node_windows_cleanup.hpp"
#include <cstring>
#else
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#endif

namespace gea::node::crypto {
using Bytes = gea::TypedArray<std::uint8_t>;

[[noreturn]] inline void error(const std::string& name, const std::string& message) {
  gea::host::throwRuntimeError(name.c_str(), message);
}

inline const std::uint8_t* data(const Bytes& bytes) {
  // Some platform APIs reject nullptr even for a zero-length input.
  static constexpr std::uint8_t empty = 0;
  return bytes.size() == 0 ? &empty : bytes.data();
}

#if defined(__APPLE__) || defined(_WIN32)
enum class Algorithm { md5, sha1, sha224, sha256, sha384, sha512 };
inline Algorithm algorithm(std::string name) {
  for (char& ch : name) if (ch >= 'A' && ch <= 'Z') ch += 'a' - 'A';
  if (name == "md5") return Algorithm::md5;
  if (name == "sha1" || name == "sha-1") return Algorithm::sha1;
  if (name == "sha224" || name == "sha-224") return Algorithm::sha224;
  if (name == "sha256" || name == "sha-256") return Algorithm::sha256;
  if (name == "sha384" || name == "sha-384") return Algorithm::sha384;
  if (name == "sha512" || name == "sha-512") return Algorithm::sha512;
  error("Error", "Digest method not supported: " + name);
}
#endif
#if defined(_WIN32)
inline std::size_t digestSize(Algorithm value) {
  switch (value) {
    case Algorithm::md5: return 16;
    case Algorithm::sha1: return 20;
    case Algorithm::sha224: return 28;
    case Algorithm::sha256: return 32;
    case Algorithm::sha384: return 48;
    case Algorithm::sha512: return 64;
  }
  return 0;
}

// The HMAC block size (RFC 2104's B) of each digest.
inline std::size_t blockSize(Algorithm value) {
  return value == Algorithm::sha384 || value == Algorithm::sha512 ? 128 : 64;
}

// SHA-224, which CNG does not offer: SHA-256's compression function with its
// own initial value, truncated to 28 bytes (FIPS 180-4, 6.3).
class Sha224 {
 public:
  void update(const std::uint8_t* bytes, std::size_t size) {
    length_ += size;
    while (size > 0) {
      const std::size_t take = std::min<std::size_t>(size, 64 - used_);
      std::memcpy(buffer_ + used_, bytes, take);
      used_ += take;
      bytes += take;
      size -= take;
      if (used_ == 64) {
        compress(buffer_);
        used_ = 0;
      }
    }
  }

  void finish(std::uint8_t* out) {
    const std::uint64_t bits = length_ * 8;
    const std::uint8_t pad = 0x80;
    update(&pad, 1);
    const std::uint8_t zero = 0;
    while (used_ != 56) update(&zero, 1);
    std::uint8_t tail[8];
    for (int index = 0; index < 8; ++index) tail[index] = static_cast<std::uint8_t>(bits >> (56 - 8 * index));
    update(tail, 8);
    for (int word = 0; word < 7; ++word)
      for (int index = 0; index < 4; ++index) out[word * 4 + index] = static_cast<std::uint8_t>(state_[word] >> (24 - 8 * index));
  }

 private:
  static std::uint32_t rotate(std::uint32_t value, int count) { return (value >> count) | (value << (32 - count)); }

  void compress(const std::uint8_t* block) {
    static constexpr std::uint32_t k[64] = {
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
        0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
        0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
        0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
        0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
    std::uint32_t w[64];
    for (int index = 0; index < 16; ++index)
      w[index] = (std::uint32_t(block[index * 4]) << 24) | (std::uint32_t(block[index * 4 + 1]) << 16) |
                 (std::uint32_t(block[index * 4 + 2]) << 8) | std::uint32_t(block[index * 4 + 3]);
    for (int index = 16; index < 64; ++index) {
      const std::uint32_t s0 = rotate(w[index - 15], 7) ^ rotate(w[index - 15], 18) ^ (w[index - 15] >> 3);
      const std::uint32_t s1 = rotate(w[index - 2], 17) ^ rotate(w[index - 2], 19) ^ (w[index - 2] >> 10);
      w[index] = w[index - 16] + s0 + w[index - 7] + s1;
    }
    std::uint32_t a = state_[0], b = state_[1], c = state_[2], d = state_[3], e = state_[4], f = state_[5], g = state_[6],
                  h = state_[7];
    for (int index = 0; index < 64; ++index) {
      const std::uint32_t t1 = h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + k[index] + w[index];
      const std::uint32_t t2 = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      h = g;
      g = f;
      f = e;
      e = d + t1;
      d = c;
      c = b;
      b = a;
      a = t1 + t2;
    }
    state_[0] += a;
    state_[1] += b;
    state_[2] += c;
    state_[3] += d;
    state_[4] += e;
    state_[5] += f;
    state_[6] += g;
    state_[7] += h;
  }

  std::uint32_t state_[8] = {0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4};
  std::uint64_t length_ = 0;
  std::uint8_t buffer_[64] = {};
  std::size_t used_ = 0;
};

// One CNG algorithm provider per digest (and per HMAC digest), opened on first
// use and kept for the life of the process.
inline BCRYPT_ALG_HANDLE provider(Algorithm value, bool hmac) {
  static BCRYPT_ALG_HANDLE handles[12] = {};
  BCRYPT_ALG_HANDLE& handle = handles[static_cast<int>(value) * 2 + (hmac ? 1 : 0)];
  if (handle == nullptr) {
    const wchar_t* name = value == Algorithm::md5      ? BCRYPT_MD5_ALGORITHM
                          : value == Algorithm::sha1   ? BCRYPT_SHA1_ALGORITHM
                          : value == Algorithm::sha256 ? BCRYPT_SHA256_ALGORITHM
                          : value == Algorithm::sha384 ? BCRYPT_SHA384_ALGORITHM
                                                       : BCRYPT_SHA512_ALGORITHM;
    if (::BCryptOpenAlgorithmProvider(&handle, name, nullptr, hmac ? BCRYPT_ALG_HANDLE_HMAC_FLAG : 0) < 0) {
      handle = nullptr;
      error("Error", "Hash operation failed");
    }
  }
  return handle;
}

// A running digest over several pieces: CNG's, or the SHA-224 above.
class Hasher {
 public:
  explicit Hasher(Algorithm value) : algorithm_(value) {
    if (value != Algorithm::sha224 && ::BCryptCreateHash(provider(value, false), &hash_, nullptr, 0, nullptr, 0, 0) < 0)
      error("Error", "Hash operation failed");
  }
  Hasher(const Hasher&) = delete;
  Hasher& operator=(const Hasher&) = delete;
  ~Hasher() {
    if (hash_ != nullptr) ::BCryptDestroyHash(hash_);
  }

  void update(const std::uint8_t* bytes, std::size_t size) {
    if (algorithm_ == Algorithm::sha224) {
      sha224_.update(bytes, size);
      return;
    }
    while (size > 0) {
      const ULONG chunk = static_cast<ULONG>(std::min<std::size_t>(size, 0x40000000u));
      if (::BCryptHashData(hash_, const_cast<PUCHAR>(bytes), chunk, 0) < 0) error("Error", "Hash operation failed");
      bytes += chunk;
      size -= chunk;
    }
  }

  std::vector<std::uint8_t> finish() {
    std::vector<std::uint8_t> result(digestSize(algorithm_));
    if (algorithm_ == Algorithm::sha224) sha224_.finish(result.data());
    else if (::BCryptFinishHash(hash_, result.data(), static_cast<ULONG>(result.size()), 0) < 0)
      error("Error", "Hash operation failed");
    return result;
  }

 private:
  Algorithm algorithm_;
  BCRYPT_HASH_HANDLE hash_ = nullptr;
  Sha224 sha224_;
};

// RFC 2104 over `Hasher`, so every digest -- SHA-224 included -- and every key
// length (an empty one too) takes the same path.
inline std::vector<std::uint8_t> hmacOf(Algorithm value, const std::uint8_t* key, std::size_t keySize,
                                        const std::uint8_t* bytes, std::size_t size) {
  const std::size_t block = blockSize(value);
  std::vector<std::uint8_t> padded(block, 0);
  if (keySize > block) {
    Hasher shortened(value);
    shortened.update(key, keySize);
    const std::vector<std::uint8_t> digestOfKey = shortened.finish();
    std::copy(digestOfKey.begin(), digestOfKey.end(), padded.begin());
  } else if (keySize > 0) {
    std::memcpy(padded.data(), key, keySize);
  }
  std::vector<std::uint8_t> pad(block);
  for (std::size_t index = 0; index < block; ++index) pad[index] = static_cast<std::uint8_t>(padded[index] ^ 0x36);
  Hasher inner(value);
  inner.update(pad.data(), block);
  inner.update(bytes, size);
  const std::vector<std::uint8_t> innerDigest = inner.finish();
  for (std::size_t index = 0; index < block; ++index) pad[index] = static_cast<std::uint8_t>(padded[index] ^ 0x5c);
  Hasher outer(value);
  outer.update(pad.data(), block);
  outer.update(innerDigest.data(), innerDigest.size());
  return outer.finish();
}
#endif
#if defined(__APPLE__)
inline std::size_t digestSize(Algorithm value) {
  switch (value) {
    case Algorithm::md5: return CC_MD5_DIGEST_LENGTH;
    case Algorithm::sha1: return CC_SHA1_DIGEST_LENGTH;
    case Algorithm::sha224: return CC_SHA224_DIGEST_LENGTH;
    case Algorithm::sha256: return CC_SHA256_DIGEST_LENGTH;
    case Algorithm::sha384: return CC_SHA384_DIGEST_LENGTH;
    case Algorithm::sha512: return CC_SHA512_DIGEST_LENGTH;
  }
}
inline CCHmacAlgorithm hmacAlgorithm(Algorithm value) {
  switch (value) {
    case Algorithm::md5: return kCCHmacAlgMD5;
    case Algorithm::sha1: return kCCHmacAlgSHA1;
    case Algorithm::sha224: return kCCHmacAlgSHA224;
    case Algorithm::sha256: return kCCHmacAlgSHA256;
    case Algorithm::sha384: return kCCHmacAlgSHA384;
    case Algorithm::sha512: return kCCHmacAlgSHA512;
  }
}
#elif !defined(_WIN32)
inline const EVP_MD* algorithm(const std::string& name) {
  const EVP_MD* value = EVP_get_digestbyname(name.c_str());
  if (!value) error("Error", "Digest method not supported: " + name);
  return value;
}
#endif

inline void validate(const std::string& name) { (void)algorithm(name); }

inline std::vector<std::uint8_t> digest(const std::string& name, const Bytes& bytes) {
  const auto method = algorithm(name);
#if defined(__APPLE__)
  // CommonCrypto's one-shot digest API takes CC_LONG, not size_t.
  if (bytes.size() > std::numeric_limits<CC_LONG>::max()) error("RangeError", "Hash input is too large");
  std::vector<std::uint8_t> result(digestSize(method));
  const auto length = static_cast<CC_LONG>(bytes.size());
  switch (method) {
    case Algorithm::md5: CC_MD5(data(bytes), length, result.data()); break;
    case Algorithm::sha1: CC_SHA1(data(bytes), length, result.data()); break;
    case Algorithm::sha224: CC_SHA224(data(bytes), length, result.data()); break;
    case Algorithm::sha256: CC_SHA256(data(bytes), length, result.data()); break;
    case Algorithm::sha384: CC_SHA384(data(bytes), length, result.data()); break;
    case Algorithm::sha512: CC_SHA512(data(bytes), length, result.data()); break;
  }
#elif defined(_WIN32)
  Hasher hasher(method);
  hasher.update(data(bytes), bytes.size());
  std::vector<std::uint8_t> result = hasher.finish();
#else
  std::vector<std::uint8_t> result(EVP_MAX_MD_SIZE);
  unsigned int length = 0;
  if (EVP_Digest(data(bytes), bytes.size(), result.data(), &length, method, nullptr) != 1)
    error("Error", "Hash operation failed");
  result.resize(length);
#endif
  return result;
}

inline std::vector<std::uint8_t> hmac(const std::string& name, const Bytes& key, const Bytes& bytes) {
  const auto method = algorithm(name);
#if defined(__APPLE__)
  std::vector<std::uint8_t> result(digestSize(method));
  CCHmac(hmacAlgorithm(method), data(key), key.size(), data(bytes), bytes.size(), result.data());
#elif defined(_WIN32)
  std::vector<std::uint8_t> result = hmacOf(method, data(key), key.size(), data(bytes), bytes.size());
#else
  if (key.size() > static_cast<std::size_t>(std::numeric_limits<int>::max())) error("RangeError", "HMAC key is too large");
  std::vector<std::uint8_t> result(EVP_MAX_MD_SIZE);
  unsigned int length = 0;
  if (!HMAC(method, data(key), static_cast<int>(key.size()), data(bytes), bytes.size(), result.data(), &length))
    error("Error", "HMAC operation failed");
  result.resize(length);
#endif
  return result;
}

inline std::vector<std::uint8_t> pbkdf2(const Bytes& password, const Bytes& salt, double iterations,
                                      double keyLength, const std::string& name) {
  if (!std::isfinite(iterations) || iterations < 1 || iterations > 2147483647 || std::trunc(iterations) != iterations)
    error("RangeError", "PBKDF2 iterations must be a positive integer");
  if (!std::isfinite(keyLength) || keyLength < 0 || keyLength > 2147483647 || std::trunc(keyLength) != keyLength)
    error("RangeError", "PBKDF2 key length is out of range");
  const auto method = algorithm(name);
  if (keyLength == 0) error("Error", "Deriving bits failed");
  std::vector<std::uint8_t> result(static_cast<std::size_t>(keyLength));
#if defined(__APPLE__)
  CCPseudoRandomAlgorithm prf;
  switch (method) {
    case Algorithm::sha1: prf = kCCPRFHmacAlgSHA1; break;
    case Algorithm::sha224: prf = kCCPRFHmacAlgSHA224; break;
    case Algorithm::sha256: prf = kCCPRFHmacAlgSHA256; break;
    case Algorithm::sha384: prf = kCCPRFHmacAlgSHA384; break;
    case Algorithm::sha512: prf = kCCPRFHmacAlgSHA512; break;
    default: error("Error", "PBKDF2 digest not supported: " + name);
  }
  if (result.empty()) return result;
  if (CCKeyDerivationPBKDF(kCCPBKDF2, reinterpret_cast<const char*>(data(password)), password.size(),
                          data(salt), salt.size(), prf, static_cast<unsigned int>(iterations), result.data(), result.size()) != 0)
    error("Error", "PBKDF2 operation failed");
#elif defined(_WIN32)
  if (result.empty()) return result;
  // CNG derives every digest it has; SHA-224 (and MD5, which OpenSSL accepts
  // here too) take RFC 8018's loop over the HMAC above.
  if (method != Algorithm::sha224 && method != Algorithm::md5 &&
      ::BCryptDeriveKeyPBKDF2(provider(method, true), const_cast<PUCHAR>(data(password)), static_cast<ULONG>(password.size()),
                              const_cast<PUCHAR>(data(salt)), static_cast<ULONG>(salt.size()),
                              static_cast<ULONGLONG>(iterations), result.data(), static_cast<ULONG>(result.size()), 0) >= 0)
    return result;
  const std::size_t length = digestSize(method);
  std::vector<std::uint8_t> block(salt.size() + 4);
  if (salt.size() != 0) std::memcpy(block.data(), salt.data(), salt.size());
  for (std::size_t offset = 0, index = 1; offset < result.size(); offset += length, ++index) {
    block[salt.size()] = static_cast<std::uint8_t>(index >> 24);
    block[salt.size() + 1] = static_cast<std::uint8_t>(index >> 16);
    block[salt.size() + 2] = static_cast<std::uint8_t>(index >> 8);
    block[salt.size() + 3] = static_cast<std::uint8_t>(index);
    std::vector<std::uint8_t> u = hmacOf(method, data(password), password.size(), block.data(), block.size());
    std::vector<std::uint8_t> t = u;
    for (double round = 1; round < iterations; ++round) {
      u = hmacOf(method, data(password), password.size(), u.data(), u.size());
      for (std::size_t byte = 0; byte < length; ++byte) t[byte] ^= u[byte];
    }
    std::memcpy(result.data() + offset, t.data(), std::min(length, result.size() - offset));
  }
#else
  if (password.size() > static_cast<std::size_t>(std::numeric_limits<int>::max()) ||
      salt.size() > static_cast<std::size_t>(std::numeric_limits<int>::max())) error("RangeError", "PBKDF2 input is too large");
  if (result.empty()) return result;
  if (PKCS5_PBKDF2_HMAC(reinterpret_cast<const char*>(data(password)), static_cast<int>(password.size()),
                        data(salt), static_cast<int>(salt.size()), static_cast<int>(iterations), method,
                        static_cast<int>(keyLength), result.data()) != 1) error("Error", "PBKDF2 operation failed");
#endif
  return result;
}

inline bool timingSafeEqual(const Bytes& left, const Bytes& right) {
  if (left.size() != right.size()) error("RangeError", "Input buffers must have the same byte length");
#if defined(__APPLE__)
  return timingsafe_bcmp(data(left), data(right), left.size()) == 0;
#elif defined(_WIN32)
  volatile std::uint8_t difference = 0;
  for (std::size_t index = 0; index < left.size(); ++index) difference = difference | (data(left)[index] ^ data(right)[index]);
  return difference == 0;
#else
  return CRYPTO_memcmp(data(left), data(right), left.size()) == 0;
#endif
}

inline double getFips() {
#if defined(__APPLE__) || defined(_WIN32)
  return 0;
#elif OPENSSL_VERSION_NUMBER >= 0x30000000L
  return EVP_default_properties_is_fips_enabled(nullptr) ? 1 : 0;
#else
  return FIPS_mode() ? 1 : 0;
#endif
}
}  // namespace gea::node::crypto

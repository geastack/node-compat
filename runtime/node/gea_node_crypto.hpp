#pragma once

// Cryptographic primitives use the platform provider. TypeScript owns the
// Hash/Hmac lifecycle; bytes cross this boundary as native typed-array views.
#include "gea_runtime.h"
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

#if defined(__APPLE__)
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
#else
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
#else
  return CRYPTO_memcmp(data(left), data(right), left.size()) == 0;
#endif
}

inline double getFips() {
#if defined(__APPLE__)
  return 0;
#elif OPENSSL_VERSION_NUMBER >= 0x30000000L
  return EVP_default_properties_is_fips_enabled(nullptr) ? 1 : 0;
#else
  return FIPS_mode() ? 1 : 0;
#endif
}
}  // namespace gea::node::crypto

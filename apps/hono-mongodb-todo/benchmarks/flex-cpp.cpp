#include <bsoncxx/builder/basic/array.hpp>
#include <bsoncxx/builder/basic/document.hpp>
#include <bsoncxx/builder/basic/kvp.hpp>
#include <bsoncxx/document/view.hpp>
#include <bsoncxx/oid.hpp>
#include <mongocxx/client.hpp>
#include <mongocxx/instance.hpp>
#include <mongocxx/pool.hpp>
#include <mongocxx/uri.hpp>

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using bsoncxx::builder::basic::array;
using bsoncxx::builder::basic::kvp;
using bsoncxx::builder::basic::make_document;

static std::string env_string(const char* name, const char* fallback) {
  const char* value = std::getenv(name);
  return value ? value : fallback;
}

static std::size_t env_size(const char* name, std::size_t fallback) {
  const char* value = std::getenv(name);
  return value ? std::stoul(value) : fallback;
}

static double elapsed_ms(std::chrono::steady_clock::time_point started_at) {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started_at).count();
}

static inline void benchmark_memory_barrier(const void* value) {
  asm volatile("" : : "r"(value) : "memory");
}

static bsoncxx::document::value large_document() {
  array values;
  for (int index = 0; index < 4096; ++index) values.append(index);
  return make_document(kvp("_id", bsoncxx::oid{}), kvp("payload", std::string(256 * 1024, 'x')), kvp("values", values.extract()));
}

static bsoncxx::document::value benchmark_document(const std::string& mode) {
  if (mode == "bson-small") {
    static const std::string payload = [] {
      std::string value;
      for (int index = 0; index < 16; ++index) value += "0123456789abcdef";
      return value;
    }();
    return make_document(kvp("_id", bsoncxx::oid{}), kvp("title", "todo"), kvp("completed", false),
                         kvp("revision", 1), kvp("payload", payload));
  }
  if (mode == "bson-string-256k") return make_document(kvp("payload", std::string(256 * 1024, 'x')));
  if (mode == "bson-array-4096") {
    array values;
    for (int index = 0; index < 4096; ++index) values.append(index);
    return make_document(kvp("values", values.extract()));
  }
  throw std::runtime_error("unknown BSON mode: " + mode);
}

static void run_bson(const std::string& mode, std::size_t iterations) {
  const auto bytes = benchmark_document(mode);
  std::size_t checksum = 0;
  auto started = std::chrono::steady_clock::now();
  for (std::size_t index = 0; index < iterations; ++index) {
    auto encoded = benchmark_document(mode);
    checksum += encoded.view().length();
  }
  const double encode = elapsed_ms(started);
  started = std::chrono::steady_clock::now();
  for (std::size_t index = 0; index < iterations; ++index) {
    const bsoncxx::document::view decoded{bytes.view().data(), bytes.view().length()};
    benchmark_memory_barrier(decoded.data());
    if (mode == "bson-small") {
      checksum += static_cast<std::size_t>(decoded["revision"].get_int32().value);
    } else if (mode == "bson-string-256k") {
      checksum += decoded["payload"].get_string().value.size();
    } else {
      checksum += static_cast<std::size_t>(std::distance(decoded["values"].get_array().value.begin(), decoded["values"].get_array().value.end()));
    }
  }
  const double decode = elapsed_ms(started);
  std::cout << std::fixed << std::setprecision(3)
            << "FLEX_RESULT:{\"driver\":\"cpp-official\",\"mode\":\"" << mode << "\",\"checksum\":" << checksum
            << ",\"operations\":{\"encode\":" << iterations << ",\"decode\":" << iterations
            << "},\"milliseconds\":{\"encode\":" << encode << ",\"decode\":" << decode
            << "},\"bytes\":" << bytes.view().length() << "}\n";
}

int main() {
  const std::string mode = env_string("BENCH_MODE", "bson-small");
  const std::size_t iterations = env_size("BENCH_ITERATIONS", 1000);
  const std::size_t pool_size = env_size("BENCH_POOL_SIZE", 4);
  const std::size_t concurrency = env_size("BENCH_CONCURRENCY", 64);
  const std::string collection_name = env_string("BENCH_COLLECTION", "flex_cpp");
  mongocxx::instance instance{};
  if (mode.rfind("bson-", 0) == 0) {
    run_bson(mode, iterations);
    return 0;
  }

  const std::string uri = "mongodb://127.0.0.1:27017/?directConnection=true&retryWrites=false&minPoolSize=1&maxPoolSize=" + std::to_string(pool_size);
  if (mode == "concurrent") {
    mongocxx::pool pool{mongocxx::uri{uri}};
    {
      auto client = pool.acquire();
      (*client)["admin"].run_command(make_document(kvp("ping", 1)));
    }
    std::atomic<std::size_t> completed{0};
    std::vector<std::thread> workers;
    const auto started = std::chrono::steady_clock::now();
    for (std::size_t worker = 0; worker < concurrency; ++worker) {
      const std::size_t count = iterations / concurrency + (worker < iterations % concurrency ? 1 : 0);
      workers.emplace_back([&pool, &completed, count]() {
        auto client = pool.acquire();
        for (std::size_t index = 0; index < count; ++index) {
          (*client)["admin"].run_command(make_document(kvp("ping", 1)));
          ++completed;
        }
      });
    }
    for (auto& worker : workers) worker.join();
    const double milliseconds = elapsed_ms(started);
    std::cout << std::fixed << std::setprecision(3)
              << "FLEX_RESULT:{\"driver\":\"cpp-official\",\"mode\":\"concurrent\",\"iterations\":" << completed
              << ",\"poolSize\":" << pool_size << ",\"concurrency\":" << concurrency
              << ",\"milliseconds\":{\"concurrentPing\":" << milliseconds << "}}\n";
    return 0;
  }

  mongocxx::client client{mongocxx::uri{uri}};
  auto collection = client["gea_driver_benchmark"][collection_name];
  if (mode == "batch") {
    const std::size_t batch_size = 100;
    std::size_t inserted = 0;
    auto started = std::chrono::steady_clock::now();
    while (inserted < iterations) {
      const std::size_t count = std::min(batch_size, iterations - inserted);
      std::vector<bsoncxx::document::value> owned;
      std::vector<bsoncxx::document::view> views;
      owned.reserve(count);
      views.reserve(count);
      for (std::size_t index = 0; index < count; ++index) {
        owned.push_back(make_document(kvp("_id", bsoncxx::oid{}), kvp("group", "batch"), kvp("revision", 1), kvp("payload", std::string(256, 'x'))));
      }
      for (const auto& value : owned) views.push_back(value.view());
      collection.insert_many(views);
      inserted += count;
    }
    const double insert_batch = elapsed_ms(started);
    started = std::chrono::steady_clock::now();
    auto updated = collection.update_many(make_document(kvp("group", "batch")), make_document(kvp("$set", make_document(kvp("revision", 2)))));
    if (!updated || updated->matched_count() != iterations) throw std::runtime_error("bulk update count mismatch");
    const double bulk_update = elapsed_ms(started);
    std::cout << std::fixed << std::setprecision(3)
              << "FLEX_RESULT:{\"driver\":\"cpp-official\",\"mode\":\"batch\",\"iterations\":" << iterations
              << ",\"batchSize\":100,\"milliseconds\":{\"insertBatch\":" << insert_batch << ",\"bulkUpdate\":" << bulk_update << "}}\n";
    return 0;
  }

  std::vector<bsoncxx::oid> ids;
  ids.reserve(iterations);
  auto started = std::chrono::steady_clock::now();
  for (std::size_t index = 0; index < iterations; ++index) {
    auto value = large_document();
    ids.push_back(value.view()["_id"].get_oid().value);
    collection.insert_one(value.view());
  }
  const double large_insert = elapsed_ms(started);
  started = std::chrono::steady_clock::now();
  for (const auto& id : ids) {
    auto found = collection.find_one(make_document(kvp("_id", id)));
    if (!found || std::distance((*found)["values"].get_array().value.begin(), (*found)["values"].get_array().value.end()) != 4096) {
      throw std::runtime_error("large document mismatch");
    }
  }
  const double large_find = elapsed_ms(started);
  std::cout << std::fixed << std::setprecision(3)
            << "FLEX_RESULT:{\"driver\":\"cpp-official\",\"mode\":\"large\",\"iterations\":" << iterations
            << ",\"documentBytes\":262144,\"arrayElements\":4096,\"milliseconds\":{\"largeInsert\":" << large_insert
            << ",\"largeFind\":" << large_find << "}}\n";
}

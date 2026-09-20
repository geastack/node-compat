#include <bsoncxx/builder/basic/document.hpp>
#include <bsoncxx/builder/basic/kvp.hpp>
#include <bsoncxx/oid.hpp>
#include <mongocxx/client.hpp>
#include <mongocxx/instance.hpp>
#include <mongocxx/uri.hpp>

#include <chrono>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using bsoncxx::builder::basic::document;
using bsoncxx::builder::basic::kvp;
using bsoncxx::builder::basic::make_document;

static bsoncxx::oid object_id_for(std::size_t index) {
  std::ostringstream value;
  value << "000000000000000000" << std::setw(6) << std::setfill('0') << index;
  return bsoncxx::oid(value.str());
}

static double elapsed_ms(std::chrono::steady_clock::time_point started_at) {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started_at).count();
}

int main() {
  const std::size_t iterations = std::stoul(std::getenv("BENCH_ITERATIONS") ? std::getenv("BENCH_ITERATIONS") : "1000");
  const std::size_t warmup = std::stoul(std::getenv("BENCH_WARMUP") ? std::getenv("BENCH_WARMUP") : "50");
  const std::string collection_name = std::getenv("BENCH_COLLECTION") ? std::getenv("BENCH_COLLECTION") : "driver_cpp";
  const std::string payload(16 * 16, 'x');
  mongocxx::instance instance{};
  mongocxx::client client{mongocxx::uri{"mongodb://127.0.0.1:27017/?directConnection=true&retryWrites=false&maxPoolSize=1&minPoolSize=1"}};
  auto collection = client["gea_driver_benchmark"][collection_name];
  std::vector<bsoncxx::oid> ids;
  std::vector<bsoncxx::document::value> documents;
  ids.reserve(iterations);
  documents.reserve(iterations);
  for (std::size_t index = 0; index < iterations; ++index) {
    ids.push_back(object_id_for(index + 1000));
    documents.push_back(make_document(kvp("_id", ids.back()), kvp("title", "todo"), kvp("completed", false),
                                      kvp("revision", 1), kvp("payload", payload)));
  }

  client["admin"].run_command(make_document(kvp("ping", 1)));
  for (std::size_t index = 0; index < warmup; ++index) {
    const auto id = object_id_for(index);
    collection.delete_one(make_document(kvp("_id", id)));
    auto value = make_document(kvp("_id", id), kvp("title", "warmup"), kvp("completed", false),
                               kvp("revision", 1), kvp("payload", payload));
    collection.insert_one(value.view());
    collection.find_one(make_document(kvp("_id", id)));
    collection.update_one(make_document(kvp("_id", id)),
                          make_document(kvp("$set", make_document(kvp("completed", true), kvp("revision", 2)))));
    collection.delete_one(make_document(kvp("_id", id)));
  }
  auto started_at = std::chrono::steady_clock::now();
  for (const auto& value : documents) collection.insert_one(value.view());
  const double insert_ms = elapsed_ms(started_at);

  started_at = std::chrono::steady_clock::now();
  for (const auto& id : ids) {
    if (!collection.find_one(make_document(kvp("_id", id)))) throw std::runtime_error("findOne missed a seeded document");
  }
  const double find_ms = elapsed_ms(started_at);

  started_at = std::chrono::steady_clock::now();
  for (const auto& id : ids) {
    auto result = collection.update_one(make_document(kvp("_id", id)),
      make_document(kvp("$set", make_document(kvp("completed", true), kvp("revision", 2)))));
    if (!result || result->matched_count() != 1) throw std::runtime_error("updateOne missed a seeded document");
  }
  const double update_ms = elapsed_ms(started_at);

  started_at = std::chrono::steady_clock::now();
  for (const auto& id : ids) {
    auto result = collection.delete_one(make_document(kvp("_id", id)));
    if (!result || result->deleted_count() != 1) throw std::runtime_error("deleteOne missed a seeded document");
  }
  const double delete_ms = elapsed_ms(started_at);

  std::cout << std::fixed << std::setprecision(3)
            << "BENCH_RESULT:{\"driver\":\"cpp-official\",\"iterations\":" << iterations
            << ",\"transport\":\"one warmed pooled connection\",\"milliseconds\":{\"insertOne\":" << insert_ms
            << ",\"findOne\":" << find_ms << ",\"updateOne\":" << update_ms << ",\"deleteOne\":" << delete_ms << "}}\n";
}

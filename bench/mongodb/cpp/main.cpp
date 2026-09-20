#include <bsoncxx/builder/basic/document.hpp>
#include <bsoncxx/builder/basic/kvp.hpp>
#include <bsoncxx/document/value.hpp>
#include <bsoncxx/document/view.hpp>
#include <mongocxx/client.hpp>
#include <mongocxx/exception/exception.hpp>
#include <mongocxx/instance.hpp>
#include <mongocxx/uri.hpp>

#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <exception>
#include <iomanip>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {

using bsoncxx::builder::basic::kvp;
using bsoncxx::builder::basic::make_document;

bsoncxx::document::value make_todo(std::int64_t id) {
    return make_document(
        kvp("_id", id),
        kvp("seq", id),
        kvp("title", "todo item"),
        kvp("completed", false),
        kvp("owner", "benchmark"),
        kvp("priority", std::int32_t{3}));
}

std::size_t parse_positive(char const* text, char const* name) {
    std::size_t offset = 0;
    auto const parsed = std::stoull(text, &offset);
    if (offset != std::string_view{text}.size() || parsed == 0 || parsed > std::numeric_limits<std::size_t>::max()) {
        throw std::invalid_argument(std::string{name} + " must be a positive size_t");
    }
    return static_cast<std::size_t>(parsed);
}

std::string append_write_concern(std::string const& base_uri, std::string const& journal) {
    return base_uri + (base_uri.find('?') == std::string::npos ? "?" : "&") + "w=1&journal=" + journal;
}

void drop_if_present(mongocxx::collection& collection) {
    try {
        collection.drop();
    } catch (mongocxx::exception const&) {
        // Every timed collection has a unique name. A missing namespace is the
        // expected state; any real write failure is still caught by insertion.
    }
}

}  // namespace

int main(int argc, char** argv) try {
    if (argc != 7) {
        std::cerr
            << "usage: mongodb-write-benchmark <base-uri> <insert-one|insert-many> <false|true> <documents> <batch-size> <collection>\n";
        return 2;
    }

    std::string const base_uri = argv[1];
    std::string const workload = argv[2];
    std::string const journal = argv[3];
    if ((workload != "insert-one" && workload != "insert-many") || (journal != "false" && journal != "true")) {
        throw std::invalid_argument("invalid workload or journal setting");
    }
    auto const documents = parse_positive(argv[4], "documents");
    auto const batch_size = parse_positive(argv[5], "batch-size");
    std::string const collection_name = argv[6];
    if (documents > static_cast<std::size_t>(std::numeric_limits<std::int64_t>::max())) {
        throw std::invalid_argument("documents must fit in int64");
    }

    mongocxx::instance instance{};
    mongocxx::client client{mongocxx::uri{append_write_concern(base_uri, journal)}};
    auto database = client["gea_mongodb_write_bench"];
    database.run_command(make_document(kvp("ping", 1)));

    auto target = database[collection_name];
    auto warmup = database[collection_name + "_warmup"];
    drop_if_present(target);
    drop_if_present(warmup);

    std::vector<bsoncxx::document::value> values;
    values.reserve(documents);
    for (std::size_t index = 0; index < documents; ++index) {
        values.push_back(make_todo(static_cast<std::int64_t>(index)));
    }

    std::vector<std::vector<bsoncxx::document::view>> batches;
    batches.reserve((documents + batch_size - 1) / batch_size);
    for (std::size_t offset = 0; offset < documents; offset += batch_size) {
        auto& batch = batches.emplace_back();
        auto const end = std::min(offset + batch_size, documents);
        batch.reserve(end - offset);
        for (auto index = offset; index < end; ++index) batch.push_back(values[index].view());
    }

    auto const warmup_count = workload == "insert-one" ? std::min<std::size_t>(documents, 16)
                                                       : std::min(documents, batch_size);
    std::vector<bsoncxx::document::value> warmup_values;
    std::vector<bsoncxx::document::view> warmup_views;
    warmup_values.reserve(warmup_count);
    warmup_views.reserve(warmup_count);
    for (std::size_t index = 0; index < warmup_count; ++index) {
        warmup_values.push_back(make_todo(-static_cast<std::int64_t>(index) - 1));
    }
    for (auto const& value : warmup_values) warmup_views.push_back(value.view());

    if (workload == "insert-one") {
        for (auto const& value : warmup_values) {
            auto result = warmup.insert_one(value.view());
            if (!result) throw std::runtime_error("warmup insertOne was not acknowledged");
        }
    } else {
        auto result = warmup.insert_many(warmup_views);
        if (!result || result->inserted_count() != static_cast<std::int32_t>(warmup_count)) {
            throw std::runtime_error("warmup insertMany count mismatch");
        }
    }
    drop_if_present(warmup);

    std::size_t operations = 0;
    std::size_t acknowledged_documents = 0;
    auto const started = std::chrono::steady_clock::now();
    if (workload == "insert-one") {
        for (auto const& value : values) {
            auto result = target.insert_one(value.view());
            if (!result) throw std::runtime_error("insertOne was not acknowledged");
            ++operations;
            ++acknowledged_documents;
        }
    } else {
        for (auto const& batch : batches) {
            auto result = target.insert_many(batch);
            if (!result || result->inserted_count() != static_cast<std::int32_t>(batch.size())) {
                throw std::runtime_error("insertMany count mismatch");
            }
            ++operations;
            acknowledged_documents += static_cast<std::size_t>(result->inserted_count());
        }
    }
    auto const stopped = std::chrono::steady_clock::now();

    auto const count = target.count_documents(make_document());
    if (acknowledged_documents != documents || count != static_cast<std::int64_t>(documents)) {
        throw std::runtime_error("inserted-count mismatch");
    }

    auto const elapsed_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(stopped - started).count();
    auto const elapsed_seconds = static_cast<double>(elapsed_ns) / 1'000'000'000.0;
    std::cout << std::fixed << std::setprecision(6)
              << "{\"driver\":\"cpp\",\"workload\":\"" << workload
              << "\",\"write_concern\":\"w1-j" << journal << "\",\"documents\":" << documents
              << ",\"operations\":" << operations << ",\"batch_size\":" << batch_size
              << ",\"elapsed_ns\":\"" << elapsed_ns << "\",\"count\":" << count
              << ",\"documents_per_second\":" << static_cast<double>(documents) / elapsed_seconds
              << ",\"operations_per_second\":" << static_cast<double>(operations) / elapsed_seconds << "}\n";
    return 0;
} catch (std::exception const& error) {
    std::cerr << "mongodb-write-benchmark: " << error.what() << '\n';
    return 1;
}

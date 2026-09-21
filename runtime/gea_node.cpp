// SPDX-License-Identifier: Apache-2.0
// node-compat native runtime.
//
// Emitted as its own generated C++ source by the node-compat geatsc plugin.
// This is the thin native layer the geatsc-compiled Node builtins
// (runtime/node/*.ts) sit on: a small reactor event loop and TCP/HTTP over
// sockets, written as proper namespaced OOP C++ (RAII, a polymorphic watcher
// interface — not C soup).
//
// Compiled under -std=gnu++20 -fno-exceptions -fno-rtti -Os.
#ifndef GEA_NODE_RUNTIME_INCLUDED
#define GEA_NODE_RUNTIME_INCLUDED

// The native carriers and byte adapters arrive from `gea_node.hpp`.

#include <algorithm>
#include <atomic>
#include <charconv>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <deque>
#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <execinfo.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <spawn.h>
#include <climits>
#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif

extern char **environ;
#include <unistd.h>
#ifdef __linux__
#include <sys/epoll.h>
#include <sys/random.h>
#endif

// ---------------------------------------------------------------------------
// The microtask queue.
//
// The loop below drains microtasks at six points, and the request path enqueues
// them. The compiler's runtime owns no queue of its own -- deliberately, a
// microtask queue being a host's concern rather than the language's -- so the
// queue is defined here, beside the loop that drains it, and
// `plugin/index.mjs` points the compiled program's `queueMicrotask` at the same
// symbol.
//
// It is reached through ONE spelling; a call site that named a queue directly
// would be a second authority on which one this reactor uses.
// ---------------------------------------------------------------------------
namespace gea::node {
inline std::deque<std::function<void()>> &microtasks() {
  static std::deque<std::function<void()>> queue;
  return queue;
}
inline void queue_microtask(std::function<void()> callback) { microtasks().push_back(std::move(callback)); }
inline void drain_microtasks() {
  // Popped before it runs: a microtask that enqueues another must not see its
  // own entry still in the queue, and the drain has to reach the new one.
  while (!microtasks().empty()) {
    // Node's next-tick queue outranks both Promise reactions and host
    // `queueMicrotask` callbacks. A callback may enqueue more ticks, so the
    // priority boundary is every individual microtask, not just the start of
    // one reactor turn.
    drain_next_ticks();
    std::function<void()> task = std::move(microtasks().front());
    microtasks().pop_front();
    task();
  }
  drain_next_ticks();
}
inline std::deque<std::function<void()>> &next_ticks() {
  static std::deque<std::function<void()>> queue;
  return queue;
}
inline void queue_next_tick(std::function<void()> callback) { next_ticks().push_back(std::move(callback)); }
inline void drain_next_ticks() {
  while (!next_ticks().empty()) {
    std::function<void()> task = std::move(next_ticks().front());
    next_ticks().pop_front();
    task();
  }
}
}  // namespace gea::node

namespace gea::node {

namespace {

[[noreturn]] inline void mongodb_exchange_fail(const char *operation) {
  std::fprintf(stderr, "gea: MongoDB wire %s failed: %s\n", operation, std::strerror(errno));
  std::abort();
}

inline int mongodb_connect_socket(const std::string &host, unsigned int port) {
  const std::string service = std::to_string(port);
  addrinfo query{};
  query.ai_family = AF_UNSPEC;
  query.ai_socktype = SOCK_STREAM;
  addrinfo *resolved = nullptr;
  if (::getaddrinfo(host.c_str(), service.c_str(), &query, &resolved) != 0) mongodb_exchange_fail("resolve");

  int fd = -1;
  for (addrinfo *candidate = resolved; candidate != nullptr; candidate = candidate->ai_next) {
    fd = ::socket(candidate->ai_family, candidate->ai_socktype, candidate->ai_protocol);
    if (fd < 0) continue;
    int enabled = 1;
    ::setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &enabled, sizeof(enabled));
    ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &enabled, sizeof(enabled));
    if (::connect(fd, candidate->ai_addr, candidate->ai_addrlen) == 0) break;
    ::close(fd);
    fd = -1;
  }
  ::freeaddrinfo(resolved);
  if (fd < 0) mongodb_exchange_fail("connect");
  return fd;
}

class MongoConnectionPool {
 public:
  MongoConnectionPool(std::string host, unsigned int port, std::size_t max_size)
      : host_(std::move(host)), port_(port), max_size_(max_size) {
    idle_.push_back(mongodb_connect_socket(host_, port_));
  }

  ~MongoConnectionPool() {
    for (const int fd : idle_) ::close(fd);
  }

  int lease() {
    if (!idle_.empty()) {
      const int fd = idle_.back();
      idle_.pop_back();
      ++leased_;
      return fd;
    }
    if (leased_ >= max_size_) {
      errno = EBUSY;
      mongodb_exchange_fail("pool lease");
    }
    ++leased_;
    return mongodb_connect_socket(host_, port_);
  }

  void release(int fd) {
    if (leased_ == 0) {
      errno = EINVAL;
      mongodb_exchange_fail("pool release");
    }
    --leased_;
    idle_.push_back(fd);
  }

 private:
  std::string host_;
  unsigned int port_;
  std::size_t max_size_;
  std::size_t leased_ = 0;
  std::vector<int> idle_;
};

inline std::unordered_map<std::uint64_t, std::unique_ptr<MongoConnectionPool>> &mongodb_pools() {
  static std::unordered_map<std::uint64_t, std::unique_ptr<MongoConnectionPool>> pools;
  return pools;
}

inline std::uint64_t &mongodb_next_pool_id() {
  static std::uint64_t id = 1;
  return id;
}

inline MongoConnectionPool &mongodb_pool_for(double pool_id) {
  const auto found = mongodb_pools().find(static_cast<std::uint64_t>(pool_id));
  if (found == mongodb_pools().end()) {
    errno = EINVAL;
    mongodb_exchange_fail("pool lookup");
  }
  return *found->second;
}

inline void mongodb_send_all(int fd, const std::uint8_t *bytes, std::size_t length) {
  std::size_t sent = 0;
  while (sent < length) {
#ifdef MSG_NOSIGNAL
    const ssize_t count = ::send(fd, bytes + sent, length - sent, MSG_NOSIGNAL);
#else
    const ssize_t count = ::send(fd, bytes + sent, length - sent, 0);
#endif
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) mongodb_exchange_fail("write");
    sent += static_cast<std::size_t>(count);
  }
}

inline void mongodb_read_all(int fd, std::uint8_t *bytes, std::size_t length) {
  std::size_t received = 0;
  while (received < length) {
    const ssize_t count = ::recv(fd, bytes + received, length - received, 0);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) mongodb_exchange_fail("read");
    received += static_cast<std::size_t>(count);
  }
}

}  // namespace

inline double mongodb_pool_open(std::string host, double port, double max_size) {
  const std::uint64_t id = mongodb_next_pool_id()++;
  const std::size_t bounded_size =
      std::max<std::size_t>(1, std::min<std::size_t>(64, static_cast<std::size_t>(max_size)));
  mongodb_pools().emplace(
      id, std::make_unique<MongoConnectionPool>(std::move(host), static_cast<unsigned int>(port), bounded_size));
  return static_cast<double>(id);
}

inline std::vector<std::uint8_t> mongodb_pool_exchange(double pool_id, const gea::TypedArray<std::uint8_t> &request) {
  MongoConnectionPool &pool = mongodb_pool_for(pool_id);
  const int fd = pool.lease();
  mongodb_send_all(fd, request.data(), request.size());
  std::uint8_t header[4]{};
  mongodb_read_all(fd, header, sizeof(header));
  const std::uint32_t length = static_cast<std::uint32_t>(header[0]) |
                               (static_cast<std::uint32_t>(header[1]) << 8) |
                               (static_cast<std::uint32_t>(header[2]) << 16) |
                               (static_cast<std::uint32_t>(header[3]) << 24);
  if (length < 21 || length > 64u * 1024u * 1024u) {
    std::fprintf(stderr, "gea: MongoDB returned invalid wire message length %u\n", length);
    std::abort();
  }
  std::vector<std::uint8_t> response(length);
  std::copy(std::begin(header), std::end(header), response.begin());
  mongodb_read_all(fd, response.data() + sizeof(header), response.size() - sizeof(header));
  pool.release(fd);
  return response;
}

inline void mongodb_pool_close(double pool_id) {
  mongodb_pools().erase(static_cast<std::uint64_t>(pool_id));
}

}  // namespace gea::node


// ---------------------------------------------------------------------------
// Reactor-integrated timers. setTimeout/setInterval in compiled TS lower to
// the __gea_node_set_timeout/... intrinsics (plugin-mapped), which register
// here; the EventLoop polls with nextDelayMs() and fires due timers each pass.
// ---------------------------------------------------------------------------
namespace gea::node::timers {

struct Timer {
  double id;
  double dueMs;
  double intervalMs;
  bool repeats;
  bool referenced;
  std::function<void()> callback;
};

inline std::vector<Timer> &registry() {
  static std::vector<Timer> timers;
  return timers;
}

inline double nowMs() {
  using namespace std::chrono;
  return duration_cast<duration<double, std::milli>>(steady_clock::now().time_since_epoch()).count();
}

inline double nextTimerId() {
  static double id = 0;
  return ++id;
}

inline bool hasPending() { return !registry().empty(); }
inline bool hasReferenced() {
  for (const Timer &timer : registry())
    if (timer.referenced) return true;
  return false;
}

// Poll timeout in ms until the earliest timer is due (0 if already due,
// capped so a far-future timer cannot starve the loop of periodic passes).
inline int nextDelayMs() {
  const auto &timers = registry();
  if (timers.empty()) return -1;
  double earliest = timers[0].dueMs;
  for (const Timer &timer : timers) earliest = std::min(earliest, timer.dueMs);
  const double delay = earliest - nowMs();
  if (delay <= 0) return 0;
  if (delay > 60000) return 60000;
  return static_cast<int>(delay) + 1;
}

inline double add(std::function<void()> callback, double delayMs, bool repeats) {
  const double id = nextTimerId();
  if (delayMs < 0) delayMs = 0;
  registry().push_back(Timer{id, nowMs() + delayMs, delayMs, repeats, true, std::move(callback)});
  return id;
}

inline void remove(double id) {
  auto &timers = registry();
  timers.erase(std::remove_if(timers.begin(), timers.end(), [&](const Timer &timer) { return timer.id == id; }),
               timers.end());
}

inline void unref(double id) {
  for (Timer &timer : registry()) {
    if (timer.id == id) {
      timer.referenced = false;
      return;
    }
  }
}

inline void fireDue() {
  const double now = nowMs();
  // Collect due timers first: callbacks may add/clear timers while running.
  std::vector<Timer> due;
  auto &timers = registry();
  for (std::size_t i = 0; i < timers.size();) {
    if (timers[i].dueMs <= now) {
      due.push_back(timers[i]);
      if (timers[i].repeats) {
        timers[i].dueMs = now + std::max(timers[i].intervalMs, 1.0);
        ++i;
      } else {
        timers.erase(timers.begin() + static_cast<std::ptrdiff_t>(i));
      }
    } else {
      ++i;
    }
  }
  std::sort(due.begin(), due.end(), [](const Timer &a, const Timer &b) {
    return a.dueMs != b.dueMs ? a.dueMs < b.dueMs : a.id < b.id;
  });
  for (Timer &timer : due) {
    if (timer.callback) timer.callback();
  }
}

}  // namespace gea::node::timers

// ---------------------------------------------------------------------------
// Size-class free-list allocator (global operator new/delete override).
//
// A server's steady-state request path allocates the same handful of block
// sizes over and over (req/res control blocks, header vectors, body/response
// strings, map entries). Routing those through the system malloc dominated
// the non-syscall profile (~650 leaf samples of malloc/free vs ~4200 syscall).
// Recycling freed blocks per size class turns each of those into a pointer
// pop/push.
//
// Safety model: pooled blocks are carved from 1 MB-aligned arena chunks whose
// bases are registered in a global table. `release` masks the pointer to its
// chunk base and looks it up — a hit recycles onto the size-class free list, a
// miss means the block came from some other allocator (malloc passthrough for
// large sizes, or a system `operator new` in a library path that did not
// resolve to this override) and is handed to `free`, which is correct for the
// malloc-backed default `operator new` on both macOS and Linux. This makes
// cross-pairing (their new → our delete) safe by construction. The reverse
// direction (our new → their delete) is prevented by exporting the override
// with default visibility so every image in the process resolves to it.
//
// Free lists are thread_local: the node runtime is a single-threaded reactor,
// and any stray secondary thread gets its own lists (a cross-thread free just
// migrates the block). The chunk table is global and append-only (chunks are
// never returned to the OS), with atomic entries so any thread can look up
// membership. Set GEA_NO_POOL_ALLOC=1 to route every allocation to malloc.
// ---------------------------------------------------------------------------
namespace gea::node::alloc {

inline constexpr std::size_t kGranule = 16;                    // size-class step
inline constexpr std::size_t kMaxPooled = 4096;                // larger blocks pass through
inline constexpr std::size_t kClassCount = kMaxPooled / kGranule;
inline constexpr std::size_t kChunkSize = std::size_t(1) << 20;  // 1 MB, alignment == size
inline constexpr std::size_t kChunkTableSize = 8192;             // power of two; 8 GB of chunks
inline constexpr std::size_t kMaxProbe = 64;

// Each entry packs (chunkBase >> 20) << 12 | sizeClass. 0 = empty. Entries are
// written once and never removed, so a relaxed-read hit is always valid.
inline std::atomic<std::uint64_t> g_chunk_table[kChunkTableSize];

// POD, zero-initialized — safe to touch during static initialization.
inline thread_local void *g_free[kClassCount];
inline thread_local char *g_bump[kClassCount];
inline thread_local char *g_bump_end[kClassCount];

/**
 * Per-size-class allocation census, printed at exit under `GEA_ALLOC_CENSUS=1`.
 *
 * The pool makes each allocation cheap -- a free-list pop is two loads and a
 * store -- so when `allocate` shows up in a profile it is saying the request
 * path allocates OFTEN, not slowly. A profile cannot say how many times or in
 * what sizes, and that is exactly what decides whether the answer is a faster
 * allocator or fewer objects. Counting is off unless asked for, and the
 * counters are thread-local, so the measured path pays one predictable branch.
 */
inline void installAllocCensusExit();

inline int allocCensusLevel() {
  static const int level = [] {
    const char *value = std::getenv("GEA_ALLOC_CENSUS");
    const int n = value == nullptr ? 0 : value[0] - '0';
    if (n >= 1) installAllocCensusExit();
    return n >= 1 && n <= 2 ? n : 0;
  }();
  return level;
}

inline bool allocCensusEnabled() { return allocCensusLevel() >= 1; }

/**
 * Caller census (`GEA_ALLOC_CENSUS=2`): which call sites allocate, not just
 * how big. A size histogram says "18 blocks of <=32B per request" without
 * saying whether that is one std::string per header or eighteen short-lived
 * runtime objects, and those two findings point at opposite fixes. Frames are
 * captured with backtrace() and bucketed by the whole 4-frame prefix, so two
 * paths reaching the same leaf stay distinguishable. Reported as
 * binary-relative offsets, which addr2line resolves against the executable.
 */
inline constexpr std::size_t kCallerFrames = 4;
inline constexpr std::size_t kCallerSlots = 4096;

struct CallerSite {
  void *frames[kCallerFrames];
  std::uint64_t count;
};
inline thread_local CallerSite g_callers[kCallerSlots];
inline thread_local std::uint64_t g_callers_lost;

inline void recordCallerSite() {
  void *raw[kCallerFrames + 3];
  const int depth = ::backtrace(raw, static_cast<int>(kCallerFrames + 3));
  // Frame 0 is backtrace itself; 1 is allocate (or the operator new it was
  // inlined into). Start at 2 so the first recorded frame is request-path code.
  const int first = depth > 2 ? 2 : depth;
  std::uint64_t hash = 1469598103934665603ull;
  void *frames[kCallerFrames] = {};
  for (std::size_t i = 0; i < kCallerFrames; ++i) {
    const int index = first + static_cast<int>(i);
    frames[i] = index < depth ? raw[index] : nullptr;
    hash = (hash ^ reinterpret_cast<std::uintptr_t>(frames[i])) * 1099511628211ull;
  }
  std::size_t slot = static_cast<std::size_t>(hash) & (kCallerSlots - 1);
  for (std::size_t probe = 0; probe < 64; ++probe) {
    CallerSite &site = g_callers[slot];
    if (site.count == 0) {
      for (std::size_t i = 0; i < kCallerFrames; ++i) site.frames[i] = frames[i];
      site.count = 1;
      return;
    }
    bool same = true;
    for (std::size_t i = 0; i < kCallerFrames; ++i)
      if (site.frames[i] != frames[i]) { same = false; break; }
    if (same) { ++site.count; return; }
    slot = (slot + 1) & (kCallerSlots - 1);
  }
  ++g_callers_lost;
}

inline void reportCallerCensus() {
  if (allocCensusLevel() < 2) return;
  Dl_info info;
  std::uintptr_t base = 0;
  if (::dladdr(reinterpret_cast<void *>(&reportCallerCensus), &info) && info.dli_fbase)
    base = reinterpret_cast<std::uintptr_t>(info.dli_fbase);
  std::vector<const CallerSite *> sites;
  for (std::size_t i = 0; i < kCallerSlots; ++i)
    if (g_callers[i].count != 0) sites.push_back(&g_callers[i]);
  std::sort(sites.begin(), sites.end(),
            [](const CallerSite *a, const CallerSite *b) { return a->count > b->count; });
  std::fprintf(stderr, "gea-alloc-callers: sites=%zu lost=%llu base=0x%llx\n", sites.size(),
               static_cast<unsigned long long>(g_callers_lost),
               static_cast<unsigned long long>(base));
  const std::size_t shown = sites.size() < 30 ? sites.size() : 30;
  for (std::size_t i = 0; i < shown; ++i) {
    std::fprintf(stderr, "  %8llu", static_cast<unsigned long long>(sites[i]->count));
    for (std::size_t f = 0; f < kCallerFrames; ++f) {
      if (sites[i]->frames[f] == nullptr) break;
      std::fprintf(stderr, " %llx",
                   static_cast<unsigned long long>(
                       reinterpret_cast<std::uintptr_t>(sites[i]->frames[f]) - base));
    }
    std::fputc('\n', stderr);
  }
}

inline thread_local std::uint64_t g_census[kClassCount + 1];
inline thread_local std::uint64_t g_census_large;

inline void reportAllocCensus();

/**
 * Make the census survive how a server actually stops.
 *
 * A benchmark harness ends the server with SIGTERM, whose default action
 * terminates the process without running `atexit`, so a report registered
 * there alone would never print. Installed only when the census is enabled,
 * so the ordinary signal behaviour is untouched.
 */
inline void installAllocCensusExit() {
  ::atexit(reportAllocCensus);
  struct Handler {
    static void onSignal(int) { std::exit(0); }
  };
  ::signal(SIGTERM, &Handler::onSignal);
  ::signal(SIGINT, &Handler::onSignal);
}

inline void reportAllocCensus() {
  if (!allocCensusEnabled()) return;
  std::uint64_t total = 0;
  for (std::size_t klass = 1; klass <= kClassCount; ++klass) total += g_census[klass];
  total += g_census_large;
  std::fprintf(stderr, "gea-alloc-census: total=%llu\n", static_cast<unsigned long long>(total));
  for (std::size_t klass = 1; klass <= kClassCount; ++klass) {
    if (g_census[klass] == 0) continue;
    std::fprintf(stderr, "  <=%zuB %llu\n", klass * kGranule,
                 static_cast<unsigned long long>(g_census[klass]));
  }
  if (g_census_large != 0)
    std::fprintf(stderr, "  large %llu\n", static_cast<unsigned long long>(g_census_large));
  reportCallerCensus();
}

inline bool poolDisabled() {
#ifdef __APPLE__
  // Apple's prebuilt libc++.dylib has INTERNALIZED free() calls (e.g. inside
  // the out-of-line std::string::__grow_by_and_replace): a buffer allocated by
  // this pool via an inlined operator new gets freed by the dylib's raw free()
  // — "pointer being freed was not allocated", SIGABRT. No operator override
  // can intercept those, so pooling is unsafe on macOS (a malloc-zone
  // replacement would be the correct mechanism there). Linux interposition via
  // the executable's exported operators is fully consistent — pool stays on.
  static const bool disabled = [] {
    const char *p = std::getenv("GEA_POOL_ALLOC");  // opt-in for experiments only
    return !(p && *p == '1');
  }();
  return disabled;
#else
  static const bool disabled = [] {
    const char *p = std::getenv("GEA_NO_POOL_ALLOC");
    return p && *p == '1';
  }();
  return disabled;
#endif
}

inline std::size_t chunkSlot(std::uintptr_t base) {
  return (static_cast<std::size_t>(base >> 20) * 0x9E3779B97F4A7C15ull) & (kChunkTableSize - 1);
}

inline bool registerChunk(std::uintptr_t base, std::size_t klass) {
  const std::uint64_t entry = (static_cast<std::uint64_t>(base >> 20) << 12) | klass;
  std::size_t slot = chunkSlot(base);
  for (std::size_t probe = 0; probe < kMaxProbe; ++probe) {
    std::uint64_t expected = 0;
    if (g_chunk_table[slot].compare_exchange_strong(expected, entry, std::memory_order_release, std::memory_order_relaxed))
      return true;
    slot = (slot + 1) & (kChunkTableSize - 1);
  }
  return false;  // table saturated — caller falls back to malloc
}

inline std::size_t lookupChunkClass(std::uintptr_t base) {
  const std::uint64_t key = static_cast<std::uint64_t>(base >> 20) << 12;
  std::size_t slot = chunkSlot(base);
  for (std::size_t probe = 0; probe < kMaxProbe; ++probe) {
    const std::uint64_t entry = g_chunk_table[slot].load(std::memory_order_acquire);
    if (entry == 0) return 0;
    if ((entry & ~0xFFFull) == key) return static_cast<std::size_t>(entry & 0xFFF);
    slot = (slot + 1) & (kChunkTableSize - 1);
  }
  return 0;
}

// Free-list links are stored in the first bytes of recycled blocks — memory
// that previously held arbitrary object types. Read/write them with memcpy
// (the blessed type-punning form): a raw `*(void **)block` violates strict
// aliasing, and clang at -O2 reorders those accesses against the surrounding
// object stores (observed as a SIGABRT on the first request).
inline void *loadFreeLink(const void *block) noexcept {
  void *next;
  std::memcpy(&next, block, sizeof next);
  return next;
}
inline void storeFreeLink(void *block, void *next) noexcept { std::memcpy(block, &next, sizeof next); }

inline void *allocate(std::size_t size) noexcept {
  const std::size_t klass = (size + kGranule - 1) / kGranule;  // 1-based class index
  if (allocCensusEnabled()) {
    if (klass >= 1 && klass <= kClassCount) ++g_census[klass];
    else ++g_census_large;
    if (allocCensusLevel() >= 2) recordCallerSite();
  }
  if (klass >= 1 && klass <= kClassCount && !poolDisabled()) {
    void *&head = g_free[klass - 1];
    if (head) {
      void *block = head;
      head = loadFreeLink(block);
      return block;
    }
    const std::size_t bytes = klass * kGranule;
    char *&bump = g_bump[klass - 1];
    char *&end = g_bump_end[klass - 1];
    if (bump == nullptr || static_cast<std::size_t>(end - bump) < bytes) {
      void *chunk = nullptr;
      if (posix_memalign(&chunk, kChunkSize, kChunkSize) == 0 && chunk) {
        if (registerChunk(reinterpret_cast<std::uintptr_t>(chunk), klass)) {
          bump = static_cast<char *>(chunk);
          end = bump + kChunkSize;
        } else {
          std::free(chunk);  // table saturated — stop pooling this class
        }
      }
    }
    if (bump != nullptr && static_cast<std::size_t>(end - bump) >= bytes) {
      void *block = bump;
      bump += bytes;
      return block;
    }
  }
  void *block = std::malloc(size ? size : 1);
  if (!block) std::abort();
  return block;
}

// The steady-state request path frees from the same couple of hot chunks, so a
// one-entry cache in front of the table probe catches almost every release.
inline thread_local std::uintptr_t g_last_chunk_base;
inline thread_local std::size_t g_last_chunk_class;

inline void release(void *ptr) noexcept {
  if (!ptr) return;
  const std::uintptr_t base = reinterpret_cast<std::uintptr_t>(ptr) & ~(kChunkSize - 1);
  std::size_t klass;
  if (base == g_last_chunk_base && g_last_chunk_class != 0) {
    klass = g_last_chunk_class;
  } else {
    klass = lookupChunkClass(base);
    if (klass != 0) {
      g_last_chunk_base = base;
      g_last_chunk_class = klass;
    }
  }
  if (klass != 0) {
    void *&head = g_free[klass - 1];
    storeFreeLink(ptr, head);
    head = ptr;
    return;
  }
  std::free(ptr);
}

}  // namespace gea::node::alloc

#define GEA_ALLOC_EXPORT __attribute__((visibility("default")))
#ifdef GEA_NODE_IMPLEMENTATION
GEA_ALLOC_EXPORT void *operator new(std::size_t size) { return gea::node::alloc::allocate(size); }
GEA_ALLOC_EXPORT void *operator new(std::size_t size, const std::nothrow_t &) noexcept { return gea::node::alloc::allocate(size); }
GEA_ALLOC_EXPORT void *operator new[](std::size_t size) { return gea::node::alloc::allocate(size); }
GEA_ALLOC_EXPORT void *operator new[](std::size_t size, const std::nothrow_t &) noexcept { return gea::node::alloc::allocate(size); }
GEA_ALLOC_EXPORT void operator delete(void *ptr) noexcept { gea::node::alloc::release(ptr); }
GEA_ALLOC_EXPORT void operator delete(void *ptr, std::size_t) noexcept { gea::node::alloc::release(ptr); }
GEA_ALLOC_EXPORT void operator delete(void *ptr, const std::nothrow_t &) noexcept { gea::node::alloc::release(ptr); }
GEA_ALLOC_EXPORT void operator delete[](void *ptr) noexcept { gea::node::alloc::release(ptr); }
GEA_ALLOC_EXPORT void operator delete[](void *ptr, std::size_t) noexcept { gea::node::alloc::release(ptr); }
GEA_ALLOC_EXPORT void operator delete[](void *ptr, const std::nothrow_t &) noexcept { gea::node::alloc::release(ptr); }
#endif

namespace gea::node {

// ---------------------------------------------------------------------------
// A file descriptor the event loop watches. Concrete watchers (listener,
// connection) implement the readiness callback.
// ---------------------------------------------------------------------------
class IoWatcher {
public:
  virtual ~IoWatcher() = default;
  virtual int fd() const noexcept = 0;
  virtual short interestedEvents() const noexcept = 0;  // POLLIN | POLLOUT
  virtual void onReady(short revents) = 0;
  virtual bool isReferenced() const noexcept { return true; }
};

// ---------------------------------------------------------------------------
// A minimal single-threaded poll() reactor. Borrowed watchers outlive the loop
// (e.g. a listener owned by its server); adopted watchers are owned by the loop
// (e.g. accepted connections) and destroyed when closed.
// ---------------------------------------------------------------------------
class EventLoop {
public:
#ifdef __linux__
  EventLoop() : epollFd_(::epoll_create1(EPOLL_CLOEXEC)) {}
  ~EventLoop() {
    if (epollFd_ >= 0) ::close(epollFd_);
  }
#endif

  void addBorrowed(IoWatcher *watcher) {
    borrowed_.push_back(watcher);
    watcherAdded(watcher);
  }
  void adopt(std::unique_ptr<IoWatcher> watcher) {
    watcherAdded(watcher.get());
    owned_.push_back(std::move(watcher));
  }

  // Defer removal until the current dispatch pass completes, so a watcher can
  // close itself from inside its own onReady().
  void close(IoWatcher *watcher) {
    if (std::find(closing_.begin(), closing_.end(), watcher) != closing_.end()) return;
    closing_.push_back(watcher);
#ifdef __linux__
    // Stop readiness delivery immediately but retain the C++ object until no
    // outer or nested dispatch snapshot can still contain its pointer.
    if (epollFd_ >= 0) {
      ::epoll_ctl(epollFd_, EPOLL_CTL_DEL, watcher->fd(), nullptr);
      epollInterest_.erase(watcher);
    }
#endif
  }

  void run() {
#ifdef __linux__
    if (epollFd_ >= 0) {
      (void)runEpoll(nullptr);
      return;
    }
#endif
    (void)runPoll(nullptr);
  }

  // Drive the same reactor used by the normal Node run loop until an awaited
  // host operation settles. This deliberately does not wait for the reactor to
  // become empty: a connected client socket remains watched for future reads,
  // so "run everything" would never return from an individual operation.
  //
  // Returns false only when no referenced timer or live watcher can make
  // progress (or the platform wait fails) while the predicate is still false.
  bool runUntil(const std::function<bool()> &done) {
    if (!done || done()) return true;
#ifdef __linux__
    if (epollFd_ >= 0) return runEpoll(&done);
#endif
    return runPoll(&done);
  }

private:
  using StopPredicate = const std::function<bool()> *;

  static bool stopRequested(StopPredicate done) {
    return done != nullptr && static_cast<bool>(*done) && (*done)();
  }

  // An await may pump the reactor from inside an existing watcher callback
  // (for example, outbound I/O issued by an HTTP handler). Watchers closed
  // by that nested pass must remain alive until the outer callback and its
  // ready-watcher snapshot have both finished. The closing_ membership check
  // prevents any such watcher from being dispatched again in the meantime.
  void dispatchWatcher(IoWatcher *watcher, short revents) {
    ++dispatchDepth_;
    watcher->onReady(revents);
    --dispatchDepth_;
  }

  void purgeClosedIfSafe() {
    if (dispatchDepth_ == 0) purgeClosed();
  }

  // poll() backend — the portable fallback (macOS, or epoll_create failure).
  bool runPoll(StopPredicate done) {
    std::vector<pollfd> pfds;
    std::vector<IoWatcher *> polledWatchers;
    std::vector<std::pair<IoWatcher *, short>> ready;
    for (;;) {
      gea::node::drain_microtasks();
      if (stopRequested(done)) {
        purgeClosedIfSafe();
        return true;
      }
      pfds.clear();
      polledWatchers.clear();
      bool haveReferencedWatcher = false;
      forEachWatcher([&](IoWatcher *w) {
        if (isClosing(w)) return;
        pfds.push_back(pollfd{w->fd(), w->interestedEvents(), 0});
        polledWatchers.push_back(w);
        if (w->isReferenced()) haveReferencedWatcher = true;
      });
      const bool timersPending = gea::node::timers::hasPending();
      if ((pfds.empty() || (done == nullptr && !haveReferencedWatcher)) &&
          !gea::node::timers::hasReferenced()) {
        purgeClosedIfSafe();
        return stopRequested(done);  // only unref work remains
      }

      const int timeout = timersPending ? gea::node::timers::nextDelayMs() : -1;
      const int events = ::poll(pfds.data(), static_cast<nfds_t>(pfds.size()), timeout);
      if (events < 0) {
        if (errno == EINTR) continue;
        purgeClosedIfSafe();
        return stopRequested(done);
      }

      // Keep the watcher set alive for the whole post-poll pass. Timer and
      // microtask callbacks may themselves await host work and recursively
      // pump this loop; any watcher they close must remain valid until the
      // pollfd snapshot below is no longer in use.
      ++dispatchDepth_;
      gea::node::timers::fireDue();
      gea::node::drain_microtasks();
      if (stopRequested(done)) {
        --dispatchDepth_;
        purgeClosedIfSafe();
        return true;
      }

      // Snapshot ready watchers before dispatching (a handler may add/close).
      ready.clear();
      for (std::size_t i = 0; i < pfds.size(); ++i) {
        IoWatcher *watcher = polledWatchers[i];
        if (!isClosing(watcher) && pfds[i].revents != 0) ready.emplace_back(watcher, pfds[i].revents);
      }
      for (const auto &[watcher, revents] : ready) {
        if (isClosing(watcher)) continue;
        if (revents != 0) dispatchWatcher(watcher, revents);
        if (stopRequested(done)) break;
      }
      // Handler promises progress here: continuations queued during dispatch
      // (async handlers, body-delivery microtasks) run before the next poll.
      gea::node::drain_microtasks();
      const bool stopped = stopRequested(done);
      --dispatchDepth_;
      purgeClosedIfSafe();
      if (stopped) return true;
    }
  }

#ifdef __linux__
  // epoll backend: the kernel wait is O(ready) instead of poll()'s O(watchers)
  // array copy + scan per wakeup. Watchers register on add; interest changes
  // (POLLOUT wanted only while a response is buffered) are synced with
  // EPOLL_CTL_MOD each pass — a cheap userland compare, a syscall only when
  // the interest actually changed.
  bool runEpoll(StopPredicate done) {
    epoll_event events[128];
    for (;;) {
      gea::node::drain_microtasks();
      if (stopRequested(done)) {
        purgeClosedIfSafe();
        return true;
      }
      bool haveWatchers = false;
      bool haveReferencedWatcher = false;
      forEachWatcher([&](IoWatcher *w) {
        if (isClosing(w)) return;
        haveWatchers = true;
        if (w->isReferenced()) haveReferencedWatcher = true;
        const short want = w->interestedEvents();
        auto found = epollInterest_.find(w);
        if (found != epollInterest_.end() && found->second != want) {
          epoll_event ev{};
          ev.events = static_cast<uint32_t>(want);
          ev.data.ptr = w;
          ::epoll_ctl(epollFd_, EPOLL_CTL_MOD, w->fd(), &ev);
          found->second = want;
        }
      });
      const bool timersPending = gea::node::timers::hasPending();
      if ((!haveWatchers || (done == nullptr && !haveReferencedWatcher)) &&
          !gea::node::timers::hasReferenced()) {
        purgeClosedIfSafe();
        return stopRequested(done);
      }

      const int timeout = timersPending ? gea::node::timers::nextDelayMs() : -1;
      const int count = ::epoll_wait(epollFd_, events, 128, timeout);
      if (count < 0) {
        if (errno == EINTR) continue;
        purgeClosedIfSafe();
        return stopRequested(done);
      }

      // epoll stores raw watcher pointers in its event snapshot. Preserve
      // those objects across timer/microtask callbacks and nested pumps until
      // this entire batch has been consumed.
      ++dispatchDepth_;
      gea::node::timers::fireDue();
      gea::node::drain_microtasks();
      if (stopRequested(done)) {
        --dispatchDepth_;
        purgeClosedIfSafe();
        return true;
      }

      for (int i = 0; i < count; ++i) {
        auto *watcher = static_cast<IoWatcher *>(events[i].data.ptr);
        if (isClosing(watcher)) continue;
        // Linux defines the EPOLL* event bits to coincide with the POLL* bits.
        dispatchWatcher(
            watcher,
            static_cast<short>(events[i].events & (POLLIN | POLLOUT | POLLERR | POLLHUP | POLLNVAL)));
        if (stopRequested(done)) break;
      }
      gea::node::drain_microtasks();
      const bool stopped = stopRequested(done);
      --dispatchDepth_;
      purgeClosedIfSafe();
      if (stopped) return true;
    }
  }
#endif

  void watcherAdded(IoWatcher *watcher) {
#ifdef __linux__
    if (epollFd_ >= 0) {
      const short want = watcher->interestedEvents();
      epoll_event ev{};
      ev.events = static_cast<uint32_t>(want);
      ev.data.ptr = watcher;
      ::epoll_ctl(epollFd_, EPOLL_CTL_ADD, watcher->fd(), &ev);
      epollInterest_[watcher] = want;
    }
#else
    (void)watcher;
#endif
  }

public:

private:
  template <typename Fn>
  void forEachWatcher(Fn &&fn) {
    for (IoWatcher *w : borrowed_) fn(w);
    for (const std::unique_ptr<IoWatcher> &w : owned_) fn(w.get());
  }

  bool isClosing(IoWatcher *watcher) const {
    return std::find(closing_.begin(), closing_.end(), watcher) != closing_.end();
  }

  void purgeClosed() {
    for (IoWatcher *watcher : closing_) {
      borrowed_.erase(std::remove(borrowed_.begin(), borrowed_.end(), watcher), borrowed_.end());
      owned_.erase(std::remove_if(owned_.begin(), owned_.end(),
                                  [&](const std::unique_ptr<IoWatcher> &owned) { return owned.get() == watcher; }),
                   owned_.end());
    }
    closing_.clear();
  }

  std::vector<IoWatcher *> borrowed_;
  std::vector<std::unique_ptr<IoWatcher>> owned_;
  std::vector<IoWatcher *> closing_;
  std::size_t dispatchDepth_ = 0;
#ifdef __linux__
  int epollFd_ = -1;
  std::unordered_map<IoWatcher *, short> epollInterest_;
#endif
};

// Every Node client and HTTP server in a process shares one reactor. This is
// essential for lazy clients created inside an HTTP handler: the server's run
// loop must also drive the newly-created outbound socket.
inline EventLoop &clientEventLoop() {
  static EventLoop loop;
  return loop;
}

// ---------------------------------------------------------------------------
// A non-blocking TCP socket wrapper (RAII: closes its fd on destruction).
// ---------------------------------------------------------------------------
class Socket {
public:
  explicit Socket(int fd) noexcept : fd_(fd) {
#if defined(__APPLE__) && defined(SO_NOSIGPIPE)
    if (fd_ >= 0) {
      const int enabled = 1;
      (void)::setsockopt(fd_, SOL_SOCKET, SO_NOSIGPIPE, &enabled, sizeof(enabled));
    }
#endif
  }
  Socket(const Socket &) = delete;
  Socket &operator=(const Socket &) = delete;
  Socket(Socket &&other) noexcept : fd_(other.fd_) { other.fd_ = -1; }
  ~Socket() {
    if (fd_ >= 0) ::close(fd_);
  }

  int fd() const noexcept { return fd_; }

  void makeNonBlocking() const {
    const int flags = ::fcntl(fd_, F_GETFL, 0);
    if (flags >= 0) ::fcntl(fd_, F_SETFL, flags | O_NONBLOCK);
  }

  void setTcpNoDelay(bool enabled = true) const {
    const int value = enabled ? 1 : 0;
    ::setsockopt(fd_, IPPROTO_TCP, TCP_NODELAY, &value, sizeof(value));
  }

private:
  int fd_;
};

// ---------------------------------------------------------------------------
// Outbound TCP connections for node:net.
//
// The callback is deliberately zero-argument. TS drains event codes and pulls
// bytes through net_read() as gea_node_buffer, keeping MongoDB wire payloads on
// the native byte carrier instead of boxing them as gea_cpp_value.
// ---------------------------------------------------------------------------
class ClientConnection;

inline std::unordered_map<std::uint64_t, ClientConnection *> &clientConnectionRegistry() {
  static std::unordered_map<std::uint64_t, ClientConnection *> map;
  return map;
}

inline std::uint64_t nextClientConnectionId() {
  static std::uint64_t id = 0;
  return ++id;
}

enum class ClientEvent : int { connect = 1, data = 2, error = 3, close = 4, drain = 5, finish = 6, end = 7 };

class ClientConnection final : public IoWatcher {
public:
  ClientConnection(EventLoop &loop, Socket socket, std::uint64_t id, std::string remote_address,
                   std::string remote_family, int port,
                   std::function<void()> notify, int initial_error, bool initially_connected = false,
                   std::function<void()> on_closed = {})
      : loop_(loop), socket_(std::move(socket)), id_(id), remoteAddress_(std::move(remote_address)),
        remoteFamily_(std::move(remote_family)), port_(port),
        notify_(std::move(notify)), initialError_(initial_error), connecting_(!initially_connected),
        connected_(initially_connected), onClosed_(std::move(on_closed)) {
    clientConnectionRegistry()[id_] = this;
  }

  ~ClientConnection() override {
    clientConnectionRegistry().erase(id_);
    if (onClosed_) onClosed_();
  }

  int fd() const noexcept override { return socket_.fd(); }
  bool isReferenced() const noexcept override { return referenced_; }

  short interestedEvents() const noexcept override {
    if (connecting_) return POLLOUT;
    return static_cast<short>(((paused_ || peerEnded_) ? 0 : POLLIN) |
                              (outSent_ < outBuffer_.size() ? POLLOUT : 0));
  }

  void onReady(short revents) override {
    if (closing_) return;

    if (connecting_) completeConnect();
    if (!closing_ && connected_ && (revents & POLLOUT)) flushWrites();
    if (!closing_ && connected_ && (revents & POLLIN)) readAvailable();

    if (!closing_ && (revents & (POLLERR | POLLNVAL))) {
      int socketError = 0;
      socklen_t length = sizeof(socketError);
      (void)::getsockopt(socket_.fd(), SOL_SOCKET, SO_ERROR, &socketError, &length);
      fail(socketError == 0 ? EIO : socketError);
    } else if (!closing_ && (revents & POLLHUP)) {
      closeFromPeer();
    }

    deliverPending();
    if (closing_) loop_.close(this);
  }

  int nextEvent() {
    if (events_.empty()) return 0;
    const int event = events_.front();
    events_.pop_front();
    return event;
  }

  std::vector<std::uint8_t> readChunk() {
    if (chunks_.empty()) return {};
    auto chunk = std::move(chunks_.front());
    chunks_.pop_front();
    return chunk;
  }

  const std::string &errorText() const { return errorText_; }
  const std::string &remoteAddress() const { return remoteAddress_; }
  const std::string &remoteFamily() const { return remoteFamily_; }
  int remotePort() const { return port_; }

  std::string localAddress() const {
    sockaddr_storage address{};
    socklen_t length = sizeof(address);
    if (::getsockname(socket_.fd(), reinterpret_cast<sockaddr *>(&address), &length) != 0) return {};
    char host[NI_MAXHOST]{};
    if (::getnameinfo(reinterpret_cast<sockaddr *>(&address), length, host, sizeof(host), nullptr, 0,
                      NI_NUMERICHOST) != 0)
      return {};
    return host;
  }

  int localPort() const {
    sockaddr_storage address{};
    socklen_t length = sizeof(address);
    if (::getsockname(socket_.fd(), reinterpret_cast<sockaddr *>(&address), &length) != 0) return 0;
    if (address.ss_family == AF_INET)
      return ntohs(reinterpret_cast<const sockaddr_in *>(&address)->sin_port);
    if (address.ss_family == AF_INET6)
      return ntohs(reinterpret_cast<const sockaddr_in6 *>(&address)->sin6_port);
    return 0;
  }

  std::string localFamily() const {
    sockaddr_storage address{};
    socklen_t length = sizeof(address);
    if (::getsockname(socket_.fd(), reinterpret_cast<sockaddr *>(&address), &length) != 0) return {};
    if (address.ss_family == AF_INET) return "IPv4";
    if (address.ss_family == AF_INET6) return "IPv6";
    return {};
  }

  bool write(const std::uint8_t *data, std::size_t size) {
    if (closing_ || endRequested_) return false;
    if (size != 0) outBuffer_.append(reinterpret_cast<const char *>(data), size);
    if (connected_) {
      const bool ok = flushWrites();
      if (!ok) {
        notifySoon();
        if (closing_) loop_.close(this);
      } else if (!events_.empty()) {
        notifySoon();
      }
    }
    // MongoDB's command writes are much smaller than Node's default writable
    // high-water mark. We accept them into outBuffer_ and report writable.
    return !closing_;
  }

  std::size_t bufferSize() const { return outBuffer_.size() - outSent_; }

  void end() {
    if (closing_ || endRequested_) return;
    endRequested_ = true;
    finishWriteSideIfReady();
    if (!events_.empty()) notifySoon();
  }

  void destroy() {
    if (closing_) return;
    closing_ = true;
    loop_.close(this);
  }

  void resetAndDestroy() {
    if (closing_) return;
    linger reset{1, 0};
    (void)::setsockopt(socket_.fd(), SOL_SOCKET, SO_LINGER, &reset, sizeof(reset));
    destroy();
  }

  void setPaused(bool paused) { paused_ = paused; }
  void setReferenced(bool referenced) { referenced_ = referenced; }
  void setNotify(std::function<void()> notify) {
    notify_ = std::move(notify);
    if (!events_.empty()) notifySoon();
  }

  void setKeepAlive(bool enabled, int initialDelayMs) {
    const int value = enabled ? 1 : 0;
    (void)::setsockopt(socket_.fd(), SOL_SOCKET, SO_KEEPALIVE, &value, sizeof(value));
    if (!enabled || initialDelayMs <= 0) return;
    const int seconds = std::max(1, initialDelayMs / 1000);
#if defined(__APPLE__) && defined(TCP_KEEPALIVE)
    (void)::setsockopt(socket_.fd(), IPPROTO_TCP, TCP_KEEPALIVE, &seconds, sizeof(seconds));
#elif defined(TCP_KEEPIDLE)
    (void)::setsockopt(socket_.fd(), IPPROTO_TCP, TCP_KEEPIDLE, &seconds, sizeof(seconds));
#endif
  }

  void setNoDelay(bool enabled) { socket_.setTcpNoDelay(enabled); }

private:
  void completeConnect() {
    int socketError = initialError_;
    if (socketError == 0) {
      socklen_t length = sizeof(socketError);
      if (::getsockopt(socket_.fd(), SOL_SOCKET, SO_ERROR, &socketError, &length) != 0) socketError = errno;
    }
    connecting_ = false;
    if (socketError != 0) {
      fail(socketError);
      return;
    }
    connected_ = true;
    events_.push_back(static_cast<int>(ClientEvent::connect));
    finishWriteSideIfReady();
  }

  bool flushWrites() {
    while (outSent_ < outBuffer_.size()) {
#ifdef MSG_NOSIGNAL
      const ssize_t count = ::send(socket_.fd(), outBuffer_.data() + outSent_, outBuffer_.size() - outSent_, MSG_NOSIGNAL);
#else
      const ssize_t count = ::send(socket_.fd(), outBuffer_.data() + outSent_, outBuffer_.size() - outSent_, 0);
#endif
      if (count > 0) {
        outSent_ += static_cast<std::size_t>(count);
        continue;
      }
      if (count < 0 && errno == EINTR) continue;
      if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return true;
      fail(count < 0 ? errno : EPIPE);
      return false;
    }
    if (!outBuffer_.empty()) events_.push_back(static_cast<int>(ClientEvent::drain));
    outBuffer_.clear();
    outSent_ = 0;
    finishWriteSideIfReady();
    return true;
  }

  void finishWriteSideIfReady() {
    if (!connected_ || !endRequested_ || finishEmitted_ || outSent_ < outBuffer_.size()) return;
    (void)::shutdown(socket_.fd(), SHUT_WR);
    finishEmitted_ = true;
    events_.push_back(static_cast<int>(ClientEvent::finish));
    if (peerEnded_) {
      events_.push_back(static_cast<int>(ClientEvent::close));
      closing_ = true;
    }
  }

  void readAvailable() {
    std::uint8_t bytes[65536];
    for (;;) {
      const ssize_t count = ::recv(socket_.fd(), bytes, sizeof(bytes), 0);
      if (count > 0) {
        chunks_.emplace_back(bytes, bytes + count);
        events_.push_back(static_cast<int>(ClientEvent::data));
        continue;
      }
      if (count == 0) {
        closeFromPeer();
        return;
      }
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) return;
      fail(errno);
      return;
    }
  }

  void closeFromPeer() {
    if (closing_ || peerEnded_) return;
    peerEnded_ = true;
    events_.push_back(static_cast<int>(ClientEvent::end));
    if (finishEmitted_) {
      events_.push_back(static_cast<int>(ClientEvent::close));
      closing_ = true;
    }
  }

  void fail(int error) {
    if (closing_) return;
    errorText_ = std::strerror(error);
    events_.push_back(static_cast<int>(ClientEvent::error));
    events_.push_back(static_cast<int>(ClientEvent::close));
    closing_ = true;
  }

  void deliverPending() {
    if (!events_.empty() && notify_) notify_();
  }

  void notifySoon() {
    if (!notify_) return;
    auto notify = notify_;
    gea::node::queue_microtask([notify = std::move(notify)]() mutable { notify(); });
  }

  EventLoop &loop_;
  Socket socket_;
  std::uint64_t id_;
  std::string remoteAddress_;
  std::string remoteFamily_;
  int port_;
  std::function<void()> notify_;
  int initialError_ = 0;
  bool connecting_ = true;
  bool connected_ = false;
  bool closing_ = false;
  bool paused_ = false;
  bool referenced_ = true;
  bool endRequested_ = false;
  bool finishEmitted_ = false;
  bool peerEnded_ = false;
  std::deque<int> events_;
  std::deque<std::vector<std::uint8_t>> chunks_;
  std::string errorText_;
  std::string outBuffer_;
  std::size_t outSent_ = 0;
  std::function<void()> onClosed_;
};

inline ClientConnection *findClientConnection(double id) {
  const auto found = clientConnectionRegistry().find(static_cast<std::uint64_t>(id));
  return found == clientConnectionRegistry().end() ? nullptr : found->second;
}

inline std::string &lastNetCreateError() {
  static thread_local std::string error;
  return error;
}

inline bool bindClientSocket(int fd, int family, int socketType, int protocol, const std::string &localAddress,
                      int localPort, std::string &error) {
  addrinfo query{};
  query.ai_family = family;
  query.ai_socktype = socketType;
  query.ai_protocol = protocol;
  query.ai_flags = localAddress.empty() ? AI_PASSIVE : 0;
  addrinfo *resolved = nullptr;
  const std::string service = std::to_string(localPort);
  const int status = ::getaddrinfo(localAddress.empty() ? nullptr : localAddress.c_str(), service.c_str(), &query,
                                   &resolved);
  if (status != 0) {
    error = ::gai_strerror(status);
    return false;
  }
  bool bound = false;
  int lastError = EADDRNOTAVAIL;
  for (addrinfo *candidate = resolved; candidate; candidate = candidate->ai_next) {
    if (::bind(fd, candidate->ai_addr, candidate->ai_addrlen) == 0) {
      bound = true;
      break;
    }
    lastError = errno;
  }
  ::freeaddrinfo(resolved);
  if (!bound) error = std::strerror(lastError);
  return bound;
}

inline double net_create_native(std::string host, double requestedPort, double requestedFamily, double requestedHints,
                         std::string localAddress, double requestedLocalPort, bool bindLocal,
                         std::function<void()> notify) {
  ::signal(SIGPIPE, SIG_IGN);
  lastNetCreateError().clear();
  if (requestedPort < 0 || requestedPort > 65535 || requestedLocalPort < 0 || requestedLocalPort > 65535) {
    lastNetCreateError() = "Invalid TCP port";
    return 0;
  }
  const int port = static_cast<int>(requestedPort);
  const int localPort = static_cast<int>(requestedLocalPort);
  const int family = requestedFamily == 4 ? AF_INET : requestedFamily == 6 ? AF_INET6 : AF_UNSPEC;
  addrinfo query{};
  query.ai_family = family;
  query.ai_socktype = SOCK_STREAM;
  query.ai_protocol = IPPROTO_TCP;
  query.ai_flags = static_cast<int>(requestedHints);
  addrinfo *resolved = nullptr;
  const std::string service = std::to_string(port);
  const int resolveStatus = ::getaddrinfo(host.c_str(), service.c_str(), &query, &resolved);
  if (resolveStatus != 0) {
    lastNetCreateError() = ::gai_strerror(resolveStatus);
    return 0;
  }

  int selectedFd = -1;
  int selectedFamily = AF_UNSPEC;
  std::string selectedAddress;
  int lastError = ECONNREFUSED;
  for (addrinfo *candidate = resolved; candidate; candidate = candidate->ai_next) {
    const int fd = ::socket(candidate->ai_family, candidate->ai_socktype, candidate->ai_protocol);
    if (fd < 0) {
      lastError = errno;
      continue;
    }
    const int flags = ::fcntl(fd, F_GETFL, 0);
    if (flags >= 0) ::fcntl(fd, F_SETFL, flags | O_NONBLOCK);
    if (bindLocal &&
        !bindClientSocket(fd, candidate->ai_family, candidate->ai_socktype, candidate->ai_protocol,
                          localAddress, localPort, lastNetCreateError())) {
      ::close(fd);
      continue;
    }
    if (::connect(fd, candidate->ai_addr, candidate->ai_addrlen) != 0 && errno != EINPROGRESS) {
      lastError = errno;
      ::close(fd);
      continue;
    }
    char numericHost[NI_MAXHOST]{};
    if (::getnameinfo(candidate->ai_addr, candidate->ai_addrlen, numericHost, sizeof(numericHost), nullptr, 0,
                      NI_NUMERICHOST) == 0)
      selectedAddress = numericHost;
    else
      selectedAddress = host;
    selectedFamily = candidate->ai_family;
    selectedFd = fd;
    break;
  }
  ::freeaddrinfo(resolved);
  if (selectedFd < 0) {
    if (lastNetCreateError().empty()) lastNetCreateError() = std::strerror(lastError);
    return 0;
  }

  const std::uint64_t id = nextClientConnectionId();
  Socket socket(selectedFd);
  auto connection = std::make_unique<ClientConnection>(
      clientEventLoop(), std::move(socket), id, std::move(selectedAddress),
      selectedFamily == AF_INET6 ? "IPv6" : "IPv4", port, std::move(notify), 0);
  clientEventLoop().adopt(std::move(connection));
  return static_cast<double>(id);
}

inline std::string net_create_error() { return lastNetCreateError(); }

inline double net_next_event(double id) {
  ClientConnection *connection = findClientConnection(id);
  return connection ? static_cast<double>(connection->nextEvent()) : 0.0;
}

inline std::vector<std::uint8_t> net_read(double id) {
  ClientConnection *connection = findClientConnection(id);
  return connection ? connection->readChunk() : std::vector<std::uint8_t>{};
}

inline std::string net_error(double id) {
  ClientConnection *connection = findClientConnection(id);
  return connection ? connection->errorText() : std::string("Socket is closed");
}

inline bool net_write(double id, const gea::TypedArray<std::uint8_t> &buffer) {
  ClientConnection *connection = findClientConnection(id);
  return connection && connection->write(buffer.data(), buffer.size());
}

inline double net_buffer_size(double id) {
  ClientConnection *connection = findClientConnection(id);
  return connection ? static_cast<double>(connection->bufferSize()) : 0.0;
}

inline void net_end(double id) {
  if (ClientConnection *connection = findClientConnection(id)) connection->end();
}

inline void net_destroy(double id) {
  if (ClientConnection *connection = findClientConnection(id)) connection->destroy();
}

inline void net_reset_and_destroy(double id) {
  if (ClientConnection *connection = findClientConnection(id)) connection->resetAndDestroy();
}

inline void net_set_paused(double id, bool paused) {
  if (ClientConnection *connection = findClientConnection(id)) connection->setPaused(paused);
}

inline void net_set_referenced(double id, bool referenced) {
  if (ClientConnection *connection = findClientConnection(id)) connection->setReferenced(referenced);
}

inline void net_set_notify_native(double id, std::function<void()> notify) {
  if (ClientConnection *connection = findClientConnection(id)) connection->setNotify(std::move(notify));
}

inline void net_set_keep_alive(double id, bool enabled, double initialDelayMs) {
  if (ClientConnection *connection = findClientConnection(id)) {
    connection->setKeepAlive(enabled, static_cast<int>(std::max(0.0, initialDelayMs)));
  }
}

inline void net_set_no_delay(double id, bool enabled) {
  if (ClientConnection *connection = findClientConnection(id)) connection->setNoDelay(enabled);
}

inline std::string net_remote_address(double id) {
  ClientConnection *connection = findClientConnection(id);
  return connection ? connection->remoteAddress() : std::string();
}

inline double net_remote_port(double id) {
  ClientConnection *connection = findClientConnection(id);
  return connection ? static_cast<double>(connection->remotePort()) : 0.0;
}

inline std::string net_remote_family(double id) {
  ClientConnection *connection = findClientConnection(id);
  return connection ? connection->remoteFamily() : std::string();
}

inline std::string net_local_address(double id) {
  ClientConnection *connection = findClientConnection(id);
  return connection ? connection->localAddress() : std::string();
}

inline double net_local_port(double id) {
  ClientConnection *connection = findClientConnection(id);
  return connection ? static_cast<double>(connection->localPort()) : 0.0;
}

inline std::string net_local_family(double id) {
  ClientConnection *connection = findClientConnection(id);
  return connection ? connection->localFamily() : std::string();
}

// ---------------------------------------------------------------------------
// TCP servers for node:net. The listener and every accepted socket share the
// client reactor, so a compiled process can host servers and clients without a
// second event loop. TypeScript drains lightweight event codes and adopts
// accepted ClientConnection ids into ordinary node:net Socket facades.
// ---------------------------------------------------------------------------
class NetServerListener;

enum class NetServerEvent : int { listening = 1, connection = 2, error = 3, close = 4, drop = 5 };

struct NetServerState : std::enable_shared_from_this<NetServerState> {
  std::uint64_t id = 0;
  std::function<void()> notify;
  NetServerListener *listener = nullptr;
  std::deque<int> events;
  std::deque<std::uint64_t> accepted;
  std::string errorText;
  std::string address;
  std::string family;
  int port = 0;
  std::size_t connections = 0;
  std::size_t maxConnections = 0;
  bool listening = false;
  bool closing = false;
  bool referenced = true;
  bool closeEmitted = false;

  void notifySoon() {
    if (!notify) return;
    auto callback = notify;
    gea::node::queue_microtask([callback = std::move(callback)]() mutable { callback(); });
  }

  void push(NetServerEvent event) {
    events.push_back(static_cast<int>(event));
    notifySoon();
  }

  void maybeEmitClose() {
    if (!closing || connections != 0 || closeEmitted) return;
    closeEmitted = true;
    push(NetServerEvent::close);
  }

  void connectionClosed() {
    if (connections > 0) --connections;
    maybeEmitClose();
  }
};

inline std::unordered_map<std::uint64_t, std::shared_ptr<NetServerState>> &netServerRegistry() {
  static std::unordered_map<std::uint64_t, std::shared_ptr<NetServerState>> map;
  return map;
}

inline std::uint64_t nextNetServerId() {
  static std::uint64_t id = 0;
  return ++id;
}

inline std::shared_ptr<NetServerState> findNetServer(double id) {
  const auto found = netServerRegistry().find(static_cast<std::uint64_t>(id));
  return found == netServerRegistry().end() ? nullptr : found->second;
}

inline std::string &lastNetServerCreateError() {
  static thread_local std::string error;
  return error;
}

class NetServerListener final : public IoWatcher {
public:
  NetServerListener(EventLoop &loop, Socket socket, std::shared_ptr<NetServerState> state)
      : loop_(loop), socket_(std::move(socket)), state_(std::move(state)) {}

  ~NetServerListener() override {
    if (state_->listener == this) state_->listener = nullptr;
  }

  int fd() const noexcept override { return socket_.fd(); }
  short interestedEvents() const noexcept override { return POLLIN; }
  bool isReferenced() const noexcept override { return state_->referenced; }

  void onReady(short revents) override {
    if (state_->closing) return;
    if (revents & POLLIN) acceptAvailable();
    if (!state_->closing && (revents & (POLLERR | POLLHUP | POLLNVAL))) {
      int socketError = 0;
      socklen_t length = sizeof(socketError);
      (void)::getsockopt(socket_.fd(), SOL_SOCKET, SO_ERROR, &socketError, &length);
      state_->errorText = std::strerror(socketError == 0 ? EIO : socketError);
      state_->push(NetServerEvent::error);
      stop();
    }
  }

  void stop() {
    if (state_->listener == this) state_->listener = nullptr;
    state_->listening = false;
    state_->closing = true;
    loop_.close(this);
    state_->maybeEmitClose();
  }

private:
  void acceptAvailable() {
    for (;;) {
      sockaddr_storage peer{};
      socklen_t peerLength = sizeof(peer);
      const int clientFd = ::accept(socket_.fd(), reinterpret_cast<sockaddr *>(&peer), &peerLength);
      if (clientFd < 0) {
        if (errno == EINTR) continue;
        if (errno == EAGAIN || errno == EWOULDBLOCK) return;
        state_->errorText = std::strerror(errno);
        state_->push(NetServerEvent::error);
        return;
      }

      const int flags = ::fcntl(clientFd, F_GETFL, 0);
      if (flags >= 0) (void)::fcntl(clientFd, F_SETFL, flags | O_NONBLOCK);

      if (state_->maxConnections != 0 && state_->connections >= state_->maxConnections) {
        ::close(clientFd);
        state_->push(NetServerEvent::drop);
        continue;
      }

      char host[NI_MAXHOST]{};
      char service[NI_MAXSERV]{};
      const int nameStatus = ::getnameinfo(reinterpret_cast<sockaddr *>(&peer), peerLength, host, sizeof(host),
                                           service, sizeof(service), NI_NUMERICHOST | NI_NUMERICSERV);
      const std::string remoteAddress = nameStatus == 0 ? std::string(host) : std::string();
      const int remotePort = nameStatus == 0 ? std::atoi(service) : 0;
      const std::string remoteFamily = peer.ss_family == AF_INET6 ? "IPv6" : "IPv4";
      const std::uint64_t connectionId = nextClientConnectionId();
      ++state_->connections;
      std::weak_ptr<NetServerState> weakState = state_;
      auto connection = std::make_unique<ClientConnection>(
          loop_, Socket(clientFd), connectionId, remoteAddress, remoteFamily, remotePort, std::function<void()>{}, 0,
          true, [weakState]() {
            if (const auto state = weakState.lock()) state->connectionClosed();
          });
      loop_.adopt(std::move(connection));
      state_->accepted.push_back(connectionId);
      state_->push(NetServerEvent::connection);
    }
  }

  EventLoop &loop_;
  Socket socket_;
  std::shared_ptr<NetServerState> state_;
};

inline double net_server_listen_native(std::string host, double requestedPort, double requestedFamily,
                                double requestedBacklog, bool reusePort, bool ipv6Only,
                                double requestedMaxConnections, std::function<void()> notify) {
  ::signal(SIGPIPE, SIG_IGN);
  lastNetServerCreateError().clear();
  if (requestedPort < 0 || requestedPort > 65535) {
    lastNetServerCreateError() = "Invalid TCP port";
    return 0;
  }

  const int family = requestedFamily == 4 ? AF_INET : requestedFamily == 6 ? AF_INET6 : AF_UNSPEC;
  addrinfo query{};
  query.ai_family = family;
  query.ai_socktype = SOCK_STREAM;
  query.ai_protocol = IPPROTO_TCP;
  query.ai_flags = AI_PASSIVE;
  addrinfo *resolved = nullptr;
  const std::string service = std::to_string(static_cast<int>(requestedPort));
  const int resolveStatus = ::getaddrinfo(host.empty() ? nullptr : host.c_str(), service.c_str(), &query, &resolved);
  if (resolveStatus != 0) {
    lastNetServerCreateError() = ::gai_strerror(resolveStatus);
    return 0;
  }

  int selectedFd = -1;
  int selectedFamily = AF_UNSPEC;
  int lastError = EADDRNOTAVAIL;
  for (addrinfo *candidate = resolved; candidate; candidate = candidate->ai_next) {
    const int fd = ::socket(candidate->ai_family, candidate->ai_socktype, candidate->ai_protocol);
    if (fd < 0) {
      lastError = errno;
      continue;
    }
    const int enabled = 1;
    (void)::setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &enabled, sizeof(enabled));
#if defined(SO_REUSEPORT)
    // A cluster worker shares its port with its siblings the way makeListener
    // already does for node:http: the kernel distributes the connections.
    if (reusePort || std::getenv("GEA_CLUSTER_WORKER_ID") != nullptr)
      (void)::setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &enabled, sizeof(enabled));
#else
    (void)reusePort;
#endif
    if (candidate->ai_family == AF_INET6) {
      const int only = ipv6Only ? 1 : 0;
      (void)::setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &only, sizeof(only));
    }
    if (::bind(fd, candidate->ai_addr, candidate->ai_addrlen) != 0) {
      lastError = errno;
      ::close(fd);
      continue;
    }
    const int backlog = std::max(1, static_cast<int>(requestedBacklog));
    if (::listen(fd, backlog) != 0) {
      lastError = errno;
      ::close(fd);
      continue;
    }
    const int flags = ::fcntl(fd, F_GETFL, 0);
    if (flags >= 0) (void)::fcntl(fd, F_SETFL, flags | O_NONBLOCK);
    selectedFd = fd;
    selectedFamily = candidate->ai_family;
    break;
  }
  ::freeaddrinfo(resolved);
  if (selectedFd < 0) {
    lastNetServerCreateError() = std::strerror(lastError);
    return 0;
  }

  sockaddr_storage bound{};
  socklen_t boundLength = sizeof(bound);
  char boundHost[NI_MAXHOST]{};
  char boundService[NI_MAXSERV]{};
  if (::getsockname(selectedFd, reinterpret_cast<sockaddr *>(&bound), &boundLength) != 0 ||
      ::getnameinfo(reinterpret_cast<sockaddr *>(&bound), boundLength, boundHost, sizeof(boundHost), boundService,
                    sizeof(boundService), NI_NUMERICHOST | NI_NUMERICSERV) != 0) {
    lastNetServerCreateError() = std::strerror(errno);
    ::close(selectedFd);
    return 0;
  }

  const std::uint64_t id = nextNetServerId();
  auto state = std::make_shared<NetServerState>();
  state->id = id;
  state->notify = std::move(notify);
  state->address = boundHost;
  state->port = std::atoi(boundService);
  state->family = selectedFamily == AF_INET6 ? "IPv6" : "IPv4";
  state->maxConnections = requestedMaxConnections > 0
                              ? static_cast<std::size_t>(requestedMaxConnections)
                              : 0;
  state->listening = true;
  netServerRegistry()[id] = state;
  auto listener = std::make_unique<NetServerListener>(clientEventLoop(), Socket(selectedFd), state);
  state->listener = listener.get();
  clientEventLoop().adopt(std::move(listener));
  state->push(NetServerEvent::listening);
  return static_cast<double>(id);
}

inline std::string net_server_create_error() { return lastNetServerCreateError(); }

inline std::string net_server_error(double id) {
  const auto state = findNetServer(id);
  return state ? state->errorText : std::string("Server is closed");
}

inline double net_server_next_event(double id) {
  const auto state = findNetServer(id);
  if (!state || state->events.empty()) return 0.0;
  const int event = state->events.front();
  state->events.pop_front();
  return static_cast<double>(event);
}

inline double net_server_take_connection(double id) {
  const auto state = findNetServer(id);
  if (!state || state->accepted.empty()) return 0.0;
  const std::uint64_t connection = state->accepted.front();
  state->accepted.pop_front();
  return static_cast<double>(connection);
}

inline void net_server_close(double id) {
  const auto state = findNetServer(id);
  if (!state || state->closing) return;
  if (state->listener) state->listener->stop();
  else {
    state->listening = false;
    state->closing = true;
    state->maybeEmitClose();
  }
}

inline void net_server_set_referenced(double id, bool referenced) {
  if (const auto state = findNetServer(id)) state->referenced = referenced;
}

inline void net_server_set_max_connections(double id, double maxConnections) {
  if (const auto state = findNetServer(id)) {
    state->maxConnections = maxConnections > 0 ? static_cast<std::size_t>(maxConnections) : 0;
  }
}

inline double net_server_connections(double id) {
  const auto state = findNetServer(id);
  return state ? static_cast<double>(state->connections) : 0.0;
}

inline std::string net_server_address(double id) {
  const auto state = findNetServer(id);
  return state ? state->address : std::string();
}

inline double net_server_port(double id) {
  const auto state = findNetServer(id);
  return state ? static_cast<double>(state->port) : 0.0;
}

inline std::string net_server_family(double id) {
  const auto state = findNetServer(id);
  return state ? state->family : std::string();
}

inline double net_is_ip(const std::string &input) {
  // Darwin's inet_pton accepts legacy leading-zero IPv4 components
  // ("01.2.3.4"), while Node's net.isIP intentionally requires strict
  // dotted-decimal input. Parse IPv4 before consulting the platform IPv6
  // parser so behavior is identical across macOS and Linux.
  int componentCount = 0;
  std::size_t componentStart = 0;
  bool validIpv4 = !input.empty();
  for (std::size_t index = 0; validIpv4 && index <= input.size(); ++index) {
    if (index < input.size() && input[index] != '.') continue;
    const std::size_t length = index - componentStart;
    if (length == 0 || length > 3 || (length > 1 && input[componentStart] == '0')) {
      validIpv4 = false;
      break;
    }
    int value = 0;
    for (std::size_t digit = componentStart; digit < index; ++digit) {
      const char character = input[digit];
      if (character < '0' || character > '9') {
        validIpv4 = false;
        break;
      }
      value = value * 10 + (character - '0');
    }
    if (!validIpv4 || value > 255) {
      validIpv4 = false;
      break;
    }
    ++componentCount;
    componentStart = index + 1;
  }
  if (validIpv4 && componentCount == 4) return 4.0;
  in6_addr ipv6{};
  if (::inet_pton(AF_INET6, input.c_str(), &ipv6) == 1) return 6.0;
  return 0.0;
}

inline std::string net_normalize_ip(const std::string &input, double family) {
  if (family == 4.0) return net_is_ip(input) == 4.0 ? input : std::string();
  if (family != 6.0) return std::string();

  // SocketAddress accepts an IPv6 scope suffix but exposes only the canonical
  // numeric address. Keep that behavior separate from net.isIP(), which must
  // continue rejecting scoped input.
  const std::size_t scope = input.find('%');
  const std::string numeric = scope == std::string::npos ? input : input.substr(0, scope);
  in6_addr address{};
  if (::inet_pton(AF_INET6, numeric.c_str(), &address) != 1) return std::string();
  char normalized[INET6_ADDRSTRLEN]{};
  if (::inet_ntop(AF_INET6, &address, normalized, sizeof(normalized)) == nullptr) return std::string();
  return normalized;
}

namespace {
inline bool parseComparableIp(const std::string &input, double family, std::uint8_t (&bytes)[16]) {
  std::memset(bytes, 0, sizeof(bytes));
  if (family == 4.0) {
    if (net_is_ip(input) != 4.0) return false;
    in_addr address{};
    if (::inet_pton(AF_INET, input.c_str(), &address) != 1) return false;
    bytes[10] = 0xff;
    bytes[11] = 0xff;
    std::memcpy(bytes + 12, &address, 4);
    return true;
  }
  if (family != 6.0) return false;
  const std::size_t scope = input.find('%');
  const std::string numeric = scope == std::string::npos ? input : input.substr(0, scope);
  in6_addr address{};
  if (::inet_pton(AF_INET6, numeric.c_str(), &address) != 1) return false;
  std::memcpy(bytes, &address, 16);
  return true;
}
}  // namespace

inline double net_ip_compare(const std::string &left, double leftFamily, const std::string &right, double rightFamily) {
  std::uint8_t leftBytes[16]{};
  std::uint8_t rightBytes[16]{};
  if (!parseComparableIp(left, leftFamily, leftBytes) || !parseComparableIp(right, rightFamily, rightBytes)) return 2.0;
  const int result = std::memcmp(leftBytes, rightBytes, 16);
  return result < 0 ? -1.0 : result > 0 ? 1.0 : 0.0;
}

inline bool net_ip_in_subnet(const std::string &address, double addressFamily, const std::string &network,
                      double networkFamily, double prefixValue) {
  std::uint8_t addressBytes[16]{};
  std::uint8_t networkBytes[16]{};
  if (!parseComparableIp(address, addressFamily, addressBytes) ||
      !parseComparableIp(network, networkFamily, networkBytes))
    return false;
  int prefix = static_cast<int>(prefixValue);
  if (networkFamily == 4.0) prefix += 96;
  if (prefix < 0 || prefix > 128) return false;
  const int wholeBytes = prefix / 8;
  const int remainingBits = prefix % 8;
  if (wholeBytes > 0 && std::memcmp(addressBytes, networkBytes, static_cast<std::size_t>(wholeBytes)) != 0) return false;
  if (remainingBits == 0) return true;
  const std::uint8_t mask = static_cast<std::uint8_t>(0xffu << (8 - remainingBits));
  return (addressBytes[wholeBytes] & mask) == (networkBytes[wholeBytes] & mask);
}

// ---------------------------------------------------------------------------
// Connection registry. Connections are template-instantiated on the concrete
// responder type, so the TS-side intrinsics reach them through this
// type-erased interface. Ids are monotonically increasing and never reused;
// an op on a dead connection is a registry miss and a safe no-op.
// ---------------------------------------------------------------------------
class HttpConnectionBase : public IoWatcher {
public:
  virtual void enqueueResponseBytes(std::string_view data) = 0;
  /** Both parts appended, then ONE flush. Two `enqueueResponseBytes` calls
   *  would flush twice and so could cost a second `send` for a write issued
   *  outside the reactor pass. */
  virtual void enqueueResponseParts(std::string_view head, std::string_view body) = 0;
  /**
   * The response header block, serialized straight into the connection's own
   * retained output buffer instead of into a string the response object owns.
   *
   * A `ServerResponse` is a fresh object per request, so a header block built
   * in one of its fields starts from an empty `std::string` every time and
   * regrows through 15 -> 30 -> 60 -> 120 -> 240 bytes: four allocations and
   * four copies per response, for bytes whose only destination is this buffer.
   * The buffer here is warm -- `flush()` clears it and keeps its capacity --
   * so the same appends cost nothing but the memcpy.
   *
   * `headBegin` writes the status line, `headField` one `Name: value` line,
   * and `headEnd` the lines Node computes itself (Date, Connection,
   * Keep-Alive, the framing header) plus the blank line. Nothing is flushed:
   * the block leaves with the first body bytes, exactly as Node holds
   * `_header` until the first write. `headEnd` answers the two facts the
   * caller still needs -- see `kHeadChunked` / `kHeadKeepAlive`.
   */
  virtual void headBegin(int status, std::string_view message) = 0;
  virtual void headField(std::string_view name, std::string_view value) = 0;
  virtual int headEnd(int flags, double autoContentLength) = 0;
  /** Header-block bytes the caller has already spelled; appended, not flushed. */
  virtual void headRaw(std::string_view text) = 0;
  /** A whole chunked body in one piece: size line, bytes, terminator; one flush. */
  virtual void enqueueFinalChunk(std::string_view data) = 0;
  virtual void responseComplete(bool keepAlive) = 0;
  virtual void hardDestroy() = 0;
  virtual std::string peerName() const = 0;
};

// `headEnd` inputs. The response object knows these; the reactor does not.
inline constexpr int kHeadNoBody = 1;        // HEAD, 1xx, 204, 304: no framing header, no body
inline constexpr int kHeadHttp10 = 2;        // cannot chunk: an unframed body runs to connection close
inline constexpr int kHeadKeepAliveAsked = 4;
inline constexpr int kHeadSendDate = 8;
// `headEnd` outputs.
inline constexpr int kHeadChunked = 1;
inline constexpr int kHeadKeepAlive = 2;

inline std::unordered_map<std::uint64_t, HttpConnectionBase *> &connectionRegistry() {
  static std::unordered_map<std::uint64_t, HttpConnectionBase *> map;
  return map;
}

inline std::uint64_t nextConnectionId() {
  static std::uint64_t id = 0;
  return ++id;
}

// One-entry cache: a request's write/done ops hit the same connection
// back-to-back; skip the hash lookup for the repeat.
inline std::uint64_t g_lastConnectionId = 0;
inline HttpConnectionBase *g_lastConnection = nullptr;

inline HttpConnectionBase *findConnection(double id) {
  const auto key = static_cast<std::uint64_t>(id);
  if (key == g_lastConnectionId && g_lastConnection) return g_lastConnection;
  auto &registry = connectionRegistry();
  const auto found = registry.find(key);
  if (found == registry.end()) return nullptr;
  g_lastConnectionId = key;
  g_lastConnection = found->second;
  return found->second;
}

inline void invalidateConnectionCache(std::uint64_t id) {
  if (g_lastConnectionId == id) {
    g_lastConnectionId = 0;
    g_lastConnection = nullptr;
  }
}

// server.close() hook — set by serve() for the active listener.
inline std::function<void()> &listenerCloser() {
  static std::function<void()> fn;
  return fn;
}

// RFC 7231 IMF-fixdate for the Date response header, cached per second.
struct HttpDateCache {
  std::string text;
  time_t second = 0;
};

inline HttpDateCache &httpDateCache() {
  static HttpDateCache cache;
  return cache;
}

inline const std::string &cachedHttpDate() {
  HttpDateCache &cache = httpDateCache();
  const time_t now = ::time(nullptr);
  if (now != cache.second) {
    cache.second = now;
    tm parts{};
    ::gmtime_r(&now, &parts);
    char buffer[64];
    const std::size_t n = ::strftime(buffer, sizeof(buffer), "%a, %d %b %Y %H:%M:%S GMT", &parts);
    cache.text.assign(buffer, n);
  }
  return cache.text;
}

/**
 * Which second the cached date belongs to.
 *
 * `cachedHttpDate` reformats once a second, but its RESULT crosses the host
 * boundary by value, and twenty-nine characters is past what any std::string
 * keeps inline -- so reading the date cost an allocation and a free on every
 * single response, for a string that changes once a second. Handing out the
 * second lets the caller keep the whole `Date: ...` line it already built and
 * rebuild it only when this number changes.
 */
inline time_t cachedHttpDateSecond() {
  cachedHttpDate();
  return httpDateCache().second;
}

inline bool asciiEqualsIgnoreCase(std::string_view a, const char *b) {
  const std::size_t bLength = std::strlen(b);
  if (a.size() != bLength) return false;
  for (std::size_t i = 0; i < a.size(); ++i) {
    char ca = a[i];
    char cb = b[i];
    if (ca >= 'A' && ca <= 'Z') ca = static_cast<char>(ca - 'A' + 'a');
    if (cb >= 'A' && cb <= 'Z') cb = static_cast<char>(cb - 'A' + 'a');
    if (ca != cb) return false;
  }
  return true;
}

// Case-insensitive "does the comma-separated header value contain this token".
inline bool headerValueHasToken(std::string_view value, const char *token) {
  std::size_t pos = 0;
  while (pos < value.size()) {
    std::size_t comma = value.find(',', pos);
    if (comma == std::string_view::npos) comma = value.size();
    std::string_view item = value.substr(pos, comma - pos);
    while (!item.empty() && (item.front() == ' ' || item.front() == '\t')) item.remove_prefix(1);
    while (!item.empty() && (item.back() == ' ' || item.back() == '\t')) item.remove_suffix(1);
    if (asciiEqualsIgnoreCase(item, token)) return true;
    pos = comma + 1;
  }
  return false;
}

template <typename Responder>
class HttpServer;  // forward

// ---------------------------------------------------------------------------
// One accepted HTTP/1.x connection. Parses full requests (request line,
// headers, content-length and chunked bodies, limits, 100-continue) and
// dispatches each into the geatsc-compiled responder with a connection id.
// The TS side streams response bytes back via enqueueResponseBytes and
// signals completion via responseComplete — so a response can finish
// synchronously, from a microtask (async handler), or from a timer.
// Pipelining stays ordered: the next buffered request is not dispatched
// until the current response completes.
// ---------------------------------------------------------------------------
template <typename Responder>
class HttpConnection final : public HttpConnectionBase {
public:
  HttpConnection(EventLoop &loop, HttpServer<Responder> &server, int fd)
      : loop_(loop), server_(server), socket_(fd), id_(nextConnectionId()) {
    socket_.makeNonBlocking();
    socket_.setTcpNoDelay();
    connectionRegistry()[id_] = this;
  }

  ~HttpConnection() override {
    connectionRegistry().erase(id_);
    invalidateConnectionCache(id_);
  }

  int fd() const noexcept override { return socket_.fd(); }
  short interestedEvents() const noexcept override {
    return static_cast<short>(POLLIN | (outsent_ >= outbuf_.size() ? 0 : POLLOUT));
  }

  void onReady(short revents) override {
    if (revents & (POLLERR | POLLNVAL)) {
      loop_.close(this);
      return;
    }
    if (revents & (POLLIN | POLLHUP)) {
      if (!readAvailable()) {
        peerClosed_ = true;
        if (!busy_ && outsent_ >= outbuf_.size()) {
          loop_.close(this);
          return;
        }
      }
      processing_ = true;
      processInput();
      processing_ = false;
    }
    flushAndMaybeClose();
  }

  // ---- ops reachable from TypeScript through the registry ----

  void enqueueResponseBytes(std::string_view data) override {
    // Append into the retained buffer. `flush()` clears it but keeps its
    // capacity, so in steady state this is a memcpy into warm storage and the
    // connection allocates nothing per response.
    //
    // This deliberately replaces an earlier `outbuf_ = std::move(data)` fast
    // path taken when the buffer was empty. Stealing the caller's string saved
    // the memcpy, but it DISCARDED the warm capacity every single response --
    // the buffer `flush()` had just cleared for reuse was freed and replaced
    // by a fresh allocation, so the saving was paid for with an allocate/free
    // pair per response. A few hundred bytes of memcpy is cheaper than that.
    headMark_ = std::string::npos;
    outbuf_.append(data);
    // Streaming writes issued outside the reactor pass (async handlers,
    // timers) flush eagerly; writes during dispatch batch into the pass flush.
    if (!processing_) flushAndMaybeClose();
  }

  void enqueueResponseParts(std::string_view head, std::string_view body) override {
    headMark_ = std::string::npos;
    outbuf_.append(head);
    outbuf_.append(body);
    if (!processing_) flushAndMaybeClose();
  }

  void headBegin(int status, std::string_view message) override {
    headMark_ = outbuf_.size();
    headHasContentLength_ = false;
    headHasTransferEncoding_ = false;
    headHasDate_ = false;
    headHasConnection_ = false;
    headConnectionClose_ = false;
    if (status == 200 && message == "OK") {
      outbuf_.append("HTTP/1.1 200 OK\r\n");
      return;
    }
    outbuf_.append("HTTP/1.1 ");
    char digits[16];
    const auto converted = std::to_chars(digits, digits + sizeof(digits), status);
    outbuf_.append(digits, static_cast<std::size_t>(converted.ptr - digits));
    outbuf_.push_back(' ');
    outbuf_.append(message);
    outbuf_.append("\r\n");
  }

  void headField(std::string_view name, std::string_view value) override {
    // The four names the framing decision reads. Length first: almost every
    // header an application sets fails all four on that alone.
    switch (name.size()) {
      case 4:
        if (asciiEqualsIgnoreCase(name, "date")) headHasDate_ = true;
        break;
      case 10:
        if (asciiEqualsIgnoreCase(name, "connection")) {
          headHasConnection_ = true;
          if (asciiEqualsIgnoreCase(value, "close")) headConnectionClose_ = true;
        }
        break;
      case 14:
        if (asciiEqualsIgnoreCase(name, "content-length")) headHasContentLength_ = true;
        break;
      case 17:
        if (asciiEqualsIgnoreCase(name, "transfer-encoding")) headHasTransferEncoding_ = true;
        break;
      default:
        break;
    }
    outbuf_.append(name);
    outbuf_.append(": ");
    outbuf_.append(value);
    outbuf_.append("\r\n");
  }

  void headRaw(std::string_view text) override {
    if (headMark_ == std::string::npos) headMark_ = outbuf_.size();
    outbuf_.append(text);
  }

  int headEnd(int flags, double autoContentLength) override {
    const bool noBody = (flags & kHeadNoBody) != 0;
    bool chunked = false;
    bool closeDelimited = false;
    bool writeContentLength = false;
    if (noBody || headHasContentLength_ || headHasTransferEncoding_) {
      // No body, or the application framed it itself: serialize as given.
    } else if (autoContentLength >= 0) {
      writeContentLength = true;
    } else if ((flags & kHeadHttp10) != 0) {
      closeDelimited = true;
    } else {
      chunked = true;
    }
    bool keepAlive = (flags & kHeadKeepAliveAsked) != 0;
    if (headConnectionClose_ || closeDelimited) keepAlive = false;
    // The overwhelmingly common tail -- Date, keep-alive, chunked -- is the
    // same bytes for every response in a given second, so it is assembled once
    // per second and appended as one piece instead of as seven.
    if (chunked && keepAlive && !headHasConnection_ && !headHasDate_ && (flags & kHeadSendDate) != 0) {
      static thread_local time_t tailSecond = 0;
      static thread_local std::string tail;
      const std::string &date = cachedHttpDate();
      const time_t second = httpDateCache().second;
      if (second != tailSecond || tail.empty()) {
        tailSecond = second;
        tail.assign("Date: ");
        tail.append(date);
        tail.append("\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\nTransfer-Encoding: chunked\r\n\r\n");
      }
      outbuf_.append(tail);
      return kHeadChunked | kHeadKeepAlive;
    }
    if ((flags & kHeadSendDate) != 0 && !headHasDate_) {
      outbuf_.append("Date: ");
      outbuf_.append(cachedHttpDate());
      outbuf_.append("\r\n");
    }
    if (!headHasConnection_) {
      if (keepAlive) outbuf_.append("Connection: keep-alive\r\nKeep-Alive: timeout=5\r\n");
      else outbuf_.append("Connection: close\r\n");
    }
    if (writeContentLength) {
      outbuf_.append("Content-Length: ");
      char digits[24];
      const auto converted = std::to_chars(digits, digits + sizeof(digits), static_cast<std::uint64_t>(autoContentLength));
      outbuf_.append(digits, static_cast<std::size_t>(converted.ptr - digits));
      outbuf_.append("\r\n");
    } else if (chunked) {
      outbuf_.append("Transfer-Encoding: chunked\r\n");
    }
    outbuf_.append("\r\n");
    return (chunked ? kHeadChunked : 0) | (keepAlive ? kHeadKeepAlive : 0);
  }

  void enqueueFinalChunk(std::string_view data) override {
    headMark_ = std::string::npos;
    if (!data.empty()) {
      char digits[24];
      const auto converted = std::to_chars(digits, digits + sizeof(digits), data.size(), 16);
      outbuf_.append(digits, static_cast<std::size_t>(converted.ptr - digits));
      outbuf_.append("\r\n");
      outbuf_.append(data);
      outbuf_.append("\r\n");
    }
    outbuf_.append("0\r\n\r\n");
    if (!processing_) flushAndMaybeClose();
  }


  void responseComplete(bool keepAlive) override {
    busy_ = false;
    if (!keepAlive) closing_ = true;
    if (!processing_) {
      processing_ = true;
      processInput();
      processing_ = false;
      flushAndMaybeClose();
    }
  }

  void hardDestroy() override {
    closing_ = true;
    loop_.close(this);
  }

  std::string peerName() const override {
    sockaddr_in addr{};
    socklen_t length = sizeof(addr);
    if (::getpeername(socket_.fd(), reinterpret_cast<sockaddr *>(&addr), &length) != 0) return std::string();
    char ip[INET_ADDRSTRLEN] = {0};
    ::inet_ntop(AF_INET, &addr.sin_addr, ip, sizeof(ip));
    std::string out(ip);
    out += ' ';
    out += std::to_string(static_cast<unsigned>(ntohs(addr.sin_port)));
    return out;
  }

private:
  enum class ReadState { kHead, kBodyFixed, kChunkSize, kChunkData, kChunkCrlf, kTrailers };

  static constexpr std::size_t kMaxHeadBytes = 16384;              // Node --max-http-header-size default
  static constexpr std::size_t kMaxBodyBytes = 64 * 1024 * 1024;   // hard cap; Node itself is unbounded
  // How much output capacity one connection may retain between responses.
  // Above this, `flush()` releases it rather than pinning it for the life of
  // a keep-alive connection that sent one large body.
  static constexpr std::size_t kMaxRetainedOutBuf = 64 * 1024;
  // The same cap on the way in. `inbuf_` is consumed with `erase(0, n)`, which
  // never shrinks, so without this a keep-alive connection that once carried a
  // large upload pins that much for the rest of its life -- per connection.
  static constexpr std::size_t kMaxRetainedInBuf = 64 * 1024;

  bool readAvailable() {
    char buffer[65536];
    for (;;) {
      const ssize_t n = ::recv(socket_.fd(), buffer, sizeof(buffer), 0);
      if (n > 0) {
        inbuf_.append(buffer, static_cast<std::size_t>(n));
        if (n < static_cast<ssize_t>(sizeof(buffer))) return true;  // likely drained
        continue;
      }
      if (n == 0) return false;  // peer closed
      return errno == EAGAIN || errno == EWOULDBLOCK;
    }
  }

  void sendErrorAndClose(int status, const char *reason) {
    // Shape matches Node's parser-level error responses: status line +
    // Connection: close, nothing else (no Date, no Content-Length).
    std::string response = "HTTP/1.1 ";
    response += std::to_string(status);
    response += ' ';
    response += reason;
    response += "\r\nConnection: close\r\n\r\n";
    enqueueResponseBytes(response);
    busy_ = true;  // stop parsing anything further on this connection
    closing_ = true;
  }

  // Parse buffered input; dispatch each complete request while idle.
  void processInput() {
    for (;;) {
      if (busy_ || closing_) return;
      if (state_ == ReadState::kHead) {
        const std::size_t headEnd = inbuf_.find("\r\n\r\n");
        if (headEnd == std::string::npos) {
          if (inbuf_.size() > kMaxHeadBytes) sendErrorAndClose(431, "Request Header Fields Too Large");
          // Everything buffered has been consumed and the next request has not
          // begun: the one moment releasing capacity costs nothing. Gated on
          // EMPTY so the steady state -- a warm buffer sized for ordinary
          // requests -- keeps its storage and allocates nothing per request.
          if (inbuf_.empty() && inbuf_.capacity() > kMaxRetainedInBuf) inbuf_.shrink_to_fit();
          return;
        }
        if (headEnd + 4 > kMaxHeadBytes) {
          sendErrorAndClose(431, "Request Header Fields Too Large");
          return;
        }
        const int parseStatus = parseHead(std::string_view(inbuf_.data(), headEnd));
        inbuf_.erase(0, headEnd + 4);
        if (parseStatus == 400) {
          sendErrorAndClose(400, "Bad Request");
          return;
        }
        if (parseStatus == 501) {
          sendErrorAndClose(501, "Not Implemented");
          return;
        }
        if (expectContinue_) outbuf_ += "HTTP/1.1 100 Continue\r\n\r\n";
        if (chunked_) {
          state_ = ReadState::kChunkSize;
        } else if (bodyRemaining_ > 0) {
          state_ = ReadState::kBodyFixed;
        } else {
          dispatchCurrent();
        }
        continue;
      }
      if (state_ == ReadState::kBodyFixed) {
        const std::size_t take = std::min(bodyRemaining_, inbuf_.size());
        body_.append(inbuf_.data(), take);
        inbuf_.erase(0, take);
        bodyRemaining_ -= take;
        if (body_.size() > kMaxBodyBytes) {
          sendErrorAndClose(413, "Payload Too Large");
          return;
        }
        if (bodyRemaining_ > 0) return;  // need more bytes
        state_ = ReadState::kHead;
        dispatchCurrent();
        continue;
      }
      if (state_ == ReadState::kChunkSize) {
        const std::size_t eol = inbuf_.find("\r\n");
        if (eol == std::string::npos) {
          if (inbuf_.size() > 1024) sendErrorAndClose(400, "Bad Request");
          return;
        }
        std::size_t size = 0;
        bool sawDigit = false;
        for (std::size_t i = 0; i < eol; ++i) {
          const char c = inbuf_[i];
          if (c == ';') break;  // chunk extensions — ignored
          std::size_t digit;
          if (c >= '0' && c <= '9') digit = static_cast<std::size_t>(c - '0');
          else if (c >= 'a' && c <= 'f') digit = static_cast<std::size_t>(c - 'a' + 10);
          else if (c >= 'A' && c <= 'F') digit = static_cast<std::size_t>(c - 'A' + 10);
          else {
            sendErrorAndClose(400, "Bad Request");
            return;
          }
          size = size * 16 + digit;
          sawDigit = true;
          if (size > kMaxBodyBytes) {
            sendErrorAndClose(413, "Payload Too Large");
            return;
          }
        }
        if (!sawDigit) {
          sendErrorAndClose(400, "Bad Request");
          return;
        }
        inbuf_.erase(0, eol + 2);
        chunkRemaining_ = size;
        state_ = size == 0 ? ReadState::kTrailers : ReadState::kChunkData;
        continue;
      }
      if (state_ == ReadState::kChunkData) {
        const std::size_t take = std::min(chunkRemaining_, inbuf_.size());
        body_.append(inbuf_.data(), take);
        inbuf_.erase(0, take);
        chunkRemaining_ -= take;
        if (body_.size() > kMaxBodyBytes) {
          sendErrorAndClose(413, "Payload Too Large");
          return;
        }
        if (chunkRemaining_ > 0) return;
        state_ = ReadState::kChunkCrlf;
        continue;
      }
      if (state_ == ReadState::kChunkCrlf) {
        if (inbuf_.size() < 2) return;
        if (inbuf_[0] != '\r' || inbuf_[1] != '\n') {
          sendErrorAndClose(400, "Bad Request");
          return;
        }
        inbuf_.erase(0, 2);
        state_ = ReadState::kChunkSize;
        continue;
      }
      if (state_ == ReadState::kTrailers) {
        const std::size_t eol = inbuf_.find("\r\n");
        if (eol == std::string::npos) return;
        inbuf_.erase(0, eol + 2);
        if (eol == 0) {
          // Empty line: trailer section over (trailers parsed + discarded).
          state_ = ReadState::kHead;
          dispatchCurrent();
        }
        continue;
      }
      return;
    }
  }

  // Returns 0 (ok), 400, or 501. Fills the current-request fields.
  int parseHead(std::string_view head) {
    rawHead_.clear();
    body_.clear();
    bodyRemaining_ = 0;
    chunkRemaining_ = 0;
    chunked_ = false;
    expectContinue_ = false;

    std::size_t lineEnd = head.find("\r\n");
    const std::string_view line = head.substr(0, lineEnd == std::string_view::npos ? head.size() : lineEnd);
    const std::size_t sp1 = line.find(' ');
    if (sp1 == std::string_view::npos || sp1 == 0) return 400;
    const std::size_t sp2 = line.find(' ', sp1 + 1);
    if (sp2 == std::string_view::npos || sp2 == sp1 + 1) return 400;
    method_.assign(line.data(), sp1);
    target_.assign(line.data() + sp1 + 1, sp2 - sp1 - 1);
    version_.assign(line.data() + sp2 + 1, line.size() - sp2 - 1);
    if (version_ != "HTTP/1.1" && version_ != "HTTP/1.0") return 400;
    keepAlive_ = version_ == "HTTP/1.1";
    // Hand the raw header BLOCK to TS as one buffer; the [name, value, ...]
    // array materializes lazily only if the app reads req.rawHeaders/headers.
    if (lineEnd != std::string_view::npos && lineEnd + 2 < head.size()) {
      rawHead_.assign(head.data() + lineEnd + 2, head.size() - lineEnd - 2);
    }

    bool haveContentLength = false;
    std::string_view contentLengthValue;
    std::size_t pos = lineEnd == std::string_view::npos ? head.size() : lineEnd + 2;
    while (pos < head.size()) {
      std::size_t eol = head.find("\r\n", pos);
      if (eol == std::string_view::npos) eol = head.size();
      const std::string_view header = head.substr(pos, eol - pos);
      pos = eol + 2;
      if (header.empty()) continue;
      const std::size_t colon = header.find(':');
      if (colon == std::string_view::npos || colon == 0) return 400;
      const std::string_view name = header.substr(0, colon);
      for (const char c : name) {
        if (c == ' ' || c == '\t') return 400;  // smuggling guard: no WS in field names
      }
      std::size_t valueStart = colon + 1;
      while (valueStart < header.size() && (header[valueStart] == ' ' || header[valueStart] == '\t')) ++valueStart;
      std::size_t valueEnd = header.size();
      while (valueEnd > valueStart && (header[valueEnd - 1] == ' ' || header[valueEnd - 1] == '\t')) --valueEnd;
      const std::string_view value = header.substr(valueStart, valueEnd - valueStart);

      if (asciiEqualsIgnoreCase(name, "content-length")) {
        if (haveContentLength && value != contentLengthValue) return 400;
        haveContentLength = true;
        contentLengthValue = value;
      } else if (asciiEqualsIgnoreCase(name, "transfer-encoding")) {
        if (headerValueHasToken(value, "chunked")) chunked_ = true;
        else return 400;  // matches Node: unsupported transfer-encoding → 400
      } else if (asciiEqualsIgnoreCase(name, "connection")) {
        if (headerValueHasToken(value, "close")) keepAlive_ = false;
        else if (headerValueHasToken(value, "keep-alive")) keepAlive_ = true;
      } else if (asciiEqualsIgnoreCase(name, "expect")) {
        if (asciiEqualsIgnoreCase(value, "100-continue")) expectContinue_ = true;
      }
    }

    if (!chunked_ && haveContentLength) {
      // RFC 9112: Transfer-Encoding wins over Content-Length when both appear.
      std::size_t parsed = 0;
      if (contentLengthValue.empty()) return 400;
      for (const char c : contentLengthValue) {
        if (c < '0' || c > '9') return 400;
        parsed = parsed * 10 + static_cast<std::size_t>(c - '0');
        if (parsed > kMaxBodyBytes) return 400;
      }
      bodyRemaining_ = parsed;
    }
    return 0;
  }

  void dispatchCurrent() {
    busy_ = true;
    double flags = keepAlive_ ? 1.0 : 0.0;
    if (firstRequest_) flags += 2.0;
    firstRequest_ = false;
    // A handler that throws is isolated to ITS request -- 500 and close the
    // connection -- rather than taking the process down, which is the
    // documented deviation from real Node (`runtime/node/http.ts`).
    //
    // How a throw arrives differs by runtime and only that: v1 sets a global
    // flag and returns normally, v2 propagates a real C++ exception carrying a
    // `gea::Value`. Each arm reads its own runtime's answer; `handlerThrew`
    // then says the same thing to the same recovery below.
    bool handlerThrew = false;
    try {
      server_.responder()(static_cast<double>(id_), flags, std::move(method_), std::move(target_),
                          std::move(version_), std::move(rawHead_), std::move(body_));
    } catch (...) {
      handlerThrew = true;
    }
    method_.clear();
    target_.clear();
    version_.clear();
    rawHead_.clear();
    body_.clear();
    if (handlerThrew) {
      if (busy_) {
        // A header block the handler committed but never released (it threw
        // between `writeHead` and the first body write) is still sitting at
        // the tail of the buffer. It was never the response; the 500 is.
        if (headMark_ != std::string::npos && headMark_ >= outsent_ && headMark_ <= outbuf_.size()) outbuf_.resize(headMark_);
        enqueueResponseBytes(
            "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        busy_ = false;
        closing_ = true;
      }
    }
    if (busy_ && peerClosed_) closing_ = true;  // half-closed peer: finish this response, take no more
  }

  bool flush() {
    while (outsent_ < outbuf_.size()) {
      const ssize_t n = ::send(socket_.fd(), outbuf_.data() + outsent_, outbuf_.size() - outsent_, 0);
      if (n > 0) {
        outsent_ += static_cast<std::size_t>(n);
        continue;
      }
      if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return true;  // retry on writable
      return false;
    }
    outbuf_.clear();
    headMark_ = std::string::npos;
    // `clear()` keeps capacity, which is the point -- the next response reuses
    // it. Cap what a connection may hold onto so a single large body does not
    // pin that much per connection for the rest of its life.
    if (outbuf_.capacity() > kMaxRetainedOutBuf) outbuf_.shrink_to_fit();
    outsent_ = 0;
    return true;
  }

  void flushAndMaybeClose() {
    if (!flush()) {
      loop_.close(this);
      return;
    }
    const bool drained = outsent_ >= outbuf_.size();
    if (drained && !busy_ && (closing_ || peerClosed_)) loop_.close(this);
  }

  EventLoop &loop_;
  HttpServer<Responder> &server_;
  Socket socket_;
  std::uint64_t id_;
  std::string inbuf_;
  std::string outbuf_;
  std::size_t outsent_ = 0;  // bytes of outbuf_ already written to the socket

  ReadState state_ = ReadState::kHead;
  bool busy_ = false;         // a dispatched request is awaiting responseComplete
  bool closing_ = false;      // no further requests; close once drained
  bool peerClosed_ = false;   // read side saw EOF
  bool processing_ = false;   // inside the reactor's processInput pass
  bool firstRequest_ = true;

  // The header block being serialized by `headBegin`/`headField`/`headEnd`.
  // `headMark_` is where it starts in `outbuf_` until body bytes release it.
  std::size_t headMark_ = std::string::npos;
  bool headHasContentLength_ = false;
  bool headHasTransferEncoding_ = false;
  bool headHasDate_ = false;
  bool headHasConnection_ = false;
  bool headConnectionClose_ = false;

  // Current request being parsed.
  std::string method_;
  std::string target_;
  std::string version_;
  std::string rawHead_;
  std::string body_;
  std::size_t bodyRemaining_ = 0;
  std::size_t chunkRemaining_ = 0;
  bool chunked_ = false;
  bool keepAlive_ = true;
  bool expectContinue_ = false;
};

// ---------------------------------------------------------------------------
// The listening server. Owns the responder invoked once per parsed request.
// ---------------------------------------------------------------------------
template <typename Responder>
class HttpServer final : public IoWatcher {
public:
  HttpServer(EventLoop &loop, int port, Responder responder)
      : loop_(loop), listener_(makeListener(port)), responder_(std::move(responder)) {}

  bool valid() const noexcept { return listener_.fd() >= 0; }
  const Responder &responder() const noexcept { return responder_; }
  Responder &responder() noexcept { return responder_; }

  int fd() const noexcept override { return listener_.fd(); }
  short interestedEvents() const noexcept override { return POLLIN; }

  void onReady(short revents) override {
    if ((revents & POLLIN) == 0) return;
    for (;;) {
      const int clientFd = ::accept(listener_.fd(), nullptr, nullptr);
      if (clientFd < 0) break;  // EAGAIN: drained
      loop_.adopt(std::make_unique<HttpConnection<Responder>>(loop_, *this, clientFd));
    }
  }

private:
  static Socket makeListener(int port) {
    const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    Socket socket(fd);
    if (fd < 0) return socket;
    const int one = 1;
    ::setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
#ifdef SO_REUSEPORT
    ::setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &one, sizeof(one));
#endif
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(static_cast<uint16_t>(port));
    if (::bind(fd, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) < 0) return Socket(-1);
    if (::listen(fd, 1024) < 0) return Socket(-1);
    socket.makeNonBlocking();
    return socket;
  }

  EventLoop &loop_;
  Socket listener_;
  Responder responder_;
};

// Build a complete raw HTTP/1.1 response (used by the __gea_serve_hello demo).
inline std::string makeResponse(const char *contentType, const std::string &body) {
  char header[256];
  const int n = std::snprintf(header, sizeof(header),
                              "HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %zu\r\nConnection: keep-alive\r\n\r\n",
                              contentType, body.size());
  std::string out;
  out.append(header, static_cast<std::size_t>(n));
  out.append(body);
  return out;
}

// Run a server on `port` with the given responder until the loop drains.
// Templated on the concrete responder type — the whole listener→connection→
// dispatch chain monomorphizes on it, so the responder call is direct.
//
// GEA_WORKERS=N (N > 1) forks into N single-threaded worker processes BEFORE
// the listen socket exists. Each worker then opens its OWN SO_REUSEPORT
// socket (makeListener already sets the option), so the kernel hash-balances
// incoming connections across N independent reactors — the nginx / node
// `cluster` deployment shape. Forking pre-socket means no shared accept
// queue and no thundering herd; forking post-app-setup means every worker
// inherits the fully-built JS world (routes, closures) copy-on-write and
// nothing is shared afterwards, so the runtime's single-thread assumptions
// (pool allocator free lists, microtask queue, boxed values) hold per
// process exactly as they do today. The parent serves as worker 0.
template <typename Responder>
inline void serve(int port, Responder responder) {
  ::signal(SIGPIPE, SIG_IGN);
  int workers = 1;
  if (const char *env = std::getenv("GEA_WORKERS")) {
    const int parsed = std::atoi(env);
    if (parsed > 1 && parsed <= 256) workers = parsed;
  }
  bool isParent = true;
  if (workers > 1) {
    ::signal(SIGCHLD, SIG_IGN);  // auto-reap workers that exit
    for (int i = 1; i < workers && isParent; ++i) {
      const pid_t pid = ::fork();
      if (pid == 0) isParent = false;
      else if (pid < 0) std::fprintf(stderr, "gea-node: fork failed for worker %d: %s\n", i, std::strerror(errno));
    }
  }
  EventLoop &loop = clientEventLoop();
  HttpServer<Responder> server(loop, port, std::move(responder));
  if (!server.valid()) {
    std::fprintf(stderr, "gea-node: failed to bind port %d: %s\n", port, std::strerror(errno));
    return;
  }
  if (isParent) {
    if (workers > 1) std::fprintf(stderr, "gea-node: listening on http://127.0.0.1:%d (%d workers)\n", port, workers);
    else std::fprintf(stderr, "gea-node: listening on http://127.0.0.1:%d\n", port);
  }
  loop.addBorrowed(&server);
  listenerCloser() = [&loop, &server]() { loop.close(&server); };
  loop.run();
  listenerCloser() = nullptr;
}

// OS byte operations use one native byte vector internally. Each compiler's
// boundary below wraps it in its own typed Buffer carrier without boxing.
static void byteOperationError(const std::string &name, const std::string &message) {
  gea::Value error = gea::Value::object();
  error.setProperty(gea::PropertyKey::string("name"), gea::Value::box(gea::Value::Tag::String, name));
  error.setProperty(gea::PropertyKey::string("message"), gea::Value::box(gea::Value::Tag::String, message));
  throw error;
}

static std::vector<std::uint8_t> randomByteVector(double requested_size) {
  if (!std::isfinite(requested_size) || requested_size < 0 || requested_size > 2147483647.0) {
    byteOperationError("RangeError", "randomBytes size is out of range");
    return {};
  }
  std::vector<std::uint8_t> out(static_cast<std::size_t>(requested_size));
  if (out.empty()) return out;
  std::uint8_t *data = out.data();

  std::size_t offset = 0;
#ifdef __linux__
  while (offset < out.size()) {
    const ssize_t count = ::getrandom(data + offset, out.size() - offset, 0);
    if (count > 0) {
      offset += static_cast<std::size_t>(count);
      continue;
    }
    if (count < 0 && errno == EINTR) continue;
    break;
  }
#elif defined(__APPLE__)
  ::arc4random_buf(data, out.size());
  offset = out.size();
#endif

  // Portable fallback for hosts without getrandom/arc4random, or for a short
  // kernel read. /dev/urandom is the same OS CSPRNG Node ultimately relies on.
  if (offset < out.size()) {
    const int fd = ::open("/dev/urandom", O_RDONLY);
    if (fd >= 0) {
      while (offset < out.size()) {
        const ssize_t count = ::read(fd, data + offset, out.size() - offset);
        if (count > 0) offset += static_cast<std::size_t>(count);
        else if (count < 0 && errno == EINTR) continue;
        else break;
      }
      ::close(fd);
    }
  }
  if (offset < out.size()) {
    byteOperationError("Error", "Unable to obtain secure random bytes");
    return {};
  }
  return out;
}

static std::vector<std::uint8_t> readFileByteVector(const std::string &path) {
  const int fd = ::open(path.c_str(), O_RDONLY);
  if (fd < 0) {
    byteOperationError("Error", std::string("open '") + path + "': " + std::strerror(errno));
    return {};
  }
  // Read until EOF rather than relying on st_size: /proc metadata files report
  // zero length, and the MongoDB handshake reads that metadata on Linux.
  std::vector<std::uint8_t> out;
  std::uint8_t bytes[65536];
  for (;;) {
    const ssize_t count = ::read(fd, bytes, sizeof(bytes));
    if (count > 0) out.insert(out.end(), bytes, bytes + count);
    else if (count == 0) break;
    else if (errno != EINTR) {
      const int error = errno;
      ::close(fd);
      byteOperationError("Error", std::string("read '") + path + "': " + std::strerror(error));
      return {};
    }
  }
  ::close(fd);
  return out;
}

inline std::vector<std::uint8_t> crypto_random_bytes(double requested_size) { return randomByteVector(requested_size); }
inline std::vector<std::uint8_t> read_file(const std::string &path) { return readFileByteVector(path); }

}  // namespace gea::node

// ---- node:cluster ----------------------------------------------------------
// Node's cluster forks WORKER PROCESSES that re-run the program from the top
// with `cluster.isPrimary === false`, and the primary hears of each worker's
// exit. This is that shape without an IPC channel:
//
//  - `fork` re-executes THIS binary (posix_spawn of the executable path) with
//    `GEA_CLUSTER_WORKER_ID` in the environment -- the worker starts at the
//    top of the program exactly as Node's does, not at the fork call.
//  - worker exits reach the primary as SIGCHLD -> self-pipe -> reactor watcher
//    -> waitpid, so 'exit' fires from the event loop like every other event.
//    The watcher is referenced only while a worker is alive, so a primary
//    with nothing else to do exits when its last worker has.
//  - a liveness pipe whose ONLY write end is the primary's (CLOEXEC) stands in
//    for the channel: when the primary dies, every worker reads EOF and exits,
//    which is what Node's worker does on an unexpected 'disconnect'.
//
// Connection distribution is the kernel's: each worker's listener sets
// SO_REUSEPORT (makeListener; net listeners inherit it below), i.e. Node's
// SCHED_NONE, not the primary-side round robin of SCHED_RR. No IPC means no
// `worker.send`; runtime/node/cluster.ts refuses those loudly.
namespace gea::node::cluster {

struct ExitEvent {
  double pid = 0;
  double code = -1;    // -1 encodes Node's `null` (the worker was killed by a signal)
  std::string signal;  // empty encodes Node's `null` (the worker exited on its own)
};

struct State {
  std::deque<ExitEvent> exits;
  ExitEvent last;
  std::function<void()> notify;
  std::vector<std::string> arguments;
  std::string spawnError;
  int channelRead = -1;
  int channelWrite = -1;
  int signalPipe[2] = {-1, -1};
  int liveChildren = 0;
  bool watcherInstalled = false;
};

inline State &state() {
  static State instance;
  return instance;
}

inline const char *signalName(int number) {
  switch (number) {
    case SIGHUP: return "SIGHUP";
    case SIGINT: return "SIGINT";
    case SIGQUIT: return "SIGQUIT";
    case SIGABRT: return "SIGABRT";
    case SIGKILL: return "SIGKILL";
    case SIGSEGV: return "SIGSEGV";
    case SIGPIPE: return "SIGPIPE";
    case SIGALRM: return "SIGALRM";
    case SIGTERM: return "SIGTERM";
    case SIGUSR1: return "SIGUSR1";
    case SIGUSR2: return "SIGUSR2";
    case SIGSTOP: return "SIGSTOP";
    case SIGCONT: return "SIGCONT";
    default: return "";
  }
}

inline int signalNumber(const std::string &name) {
  static const std::pair<const char *, int> table[] = {
      {"SIGHUP", SIGHUP},   {"SIGINT", SIGINT},   {"SIGQUIT", SIGQUIT}, {"SIGABRT", SIGABRT}, {"SIGKILL", SIGKILL},
      {"SIGSEGV", SIGSEGV}, {"SIGPIPE", SIGPIPE}, {"SIGALRM", SIGALRM}, {"SIGTERM", SIGTERM}, {"SIGUSR1", SIGUSR1},
      {"SIGUSR2", SIGUSR2}, {"SIGSTOP", SIGSTOP}, {"SIGCONT", SIGCONT}};
  for (const auto &entry : table)
    if (name == entry.first) return entry.second;
  if (!name.empty() && std::all_of(name.begin(), name.end(), [](unsigned char c) { return std::isdigit(c) != 0; }))
    return std::atoi(name.c_str());
  return -1;
}

// Async-signal-safe: one byte into the self-pipe, nothing else.
static void onSigChld(int) {
  const int fd = state().signalPipe[1];
  if (fd < 0) return;
  const int saved = errno;
  const char byte = 1;
  (void)::write(fd, &byte, 1);
  errno = saved;
}

inline void reap() {
  State &s = state();
  bool any = false;
  while (true) {
    int status = 0;
    const pid_t pid = ::waitpid(-1, &status, WNOHANG);
    if (pid <= 0) break;
    ExitEvent event;
    event.pid = static_cast<double>(pid);
    if (WIFEXITED(status)) event.code = static_cast<double>(WEXITSTATUS(status));
    else if (WIFSIGNALED(status)) event.signal = signalName(WTERMSIG(status));
    s.exits.push_back(std::move(event));
    if (s.liveChildren > 0) --s.liveChildren;
    any = true;
  }
  if (any && s.notify) s.notify();
}

class ChildWatcher final : public IoWatcher {
public:
  int fd() const noexcept override { return state().signalPipe[0]; }
  short interestedEvents() const noexcept override { return POLLIN; }
  bool isReferenced() const noexcept override { return state().liveChildren > 0; }
  void onReady(short) override {
    char buffer[64];
    while (::read(state().signalPipe[0], buffer, sizeof buffer) > 0) {
    }
    reap();
  }
};

inline bool ensureWatcher() {
  State &s = state();
  if (s.watcherInstalled) return true;
  if (::pipe(s.signalPipe) != 0) {
    s.spawnError = std::strerror(errno);
    return false;
  }
  for (const int fd : s.signalPipe) {
    (void)::fcntl(fd, F_SETFL, ::fcntl(fd, F_GETFL) | O_NONBLOCK);
    (void)::fcntl(fd, F_SETFD, FD_CLOEXEC);
  }
  struct sigaction action {};
  action.sa_handler = onSigChld;
  sigemptyset(&action.sa_mask);  // a macro on macOS, so no `::`
  action.sa_flags = SA_RESTART | SA_NOCLDSTOP;
  (void)::sigaction(SIGCHLD, &action, nullptr);
  static ChildWatcher watcher;
  clientEventLoop().addBorrowed(&watcher);
  s.watcherInstalled = true;
  return true;
}

inline bool ensureChannel() {
  State &s = state();
  if (s.channelWrite >= 0) return true;
  int fds[2] = {-1, -1};
  if (::pipe(fds) != 0) {
    s.spawnError = std::strerror(errno);
    return false;
  }
  s.channelRead = fds[0];
  s.channelWrite = fds[1];
  // The write end must die with the primary and with nothing else: CLOEXEC
  // keeps it out of every worker. The read end is inherited on purpose.
  (void)::fcntl(s.channelWrite, F_SETFD, FD_CLOEXEC);
  return true;
}

inline std::string executablePath() {
#if defined(__APPLE__)
  std::uint32_t size = 0;
  (void)_NSGetExecutablePath(nullptr, &size);
  std::string path(size, '\0');
  if (_NSGetExecutablePath(path.data(), &size) != 0) return "";
  path.resize(std::strlen(path.c_str()));
  return path;
#else
  char buffer[PATH_MAX];
  const ssize_t length = ::readlink("/proc/self/exe", buffer, sizeof buffer - 1);
  if (length <= 0) return "";
  buffer[length] = '\0';
  return std::string(buffer);
#endif
}

// `envPairs` is the caller's `fork(env)` as "k=v" entries separated by 0x1f.
inline double spawn(double id, const std::string &envPairs) {
  State &s = state();
  if (!ensureChannel() || !ensureWatcher()) return 0;
  const std::string exe = executablePath();
  if (exe.empty()) {
    s.spawnError = "cannot resolve the executable path of this process";
    return 0;
  }
  const auto isReserved = [](std::string_view entry) {
    for (const std::string_view key : {"GEA_CLUSTER_WORKER_ID=", "NODE_UNIQUE_ID=", "GEA_CLUSTER_CHANNEL_FD=", "GEA_WORKERS="})
      if (entry.substr(0, key.size()) == key) return true;
    return false;
  };
  std::vector<std::string> env;
  for (char **entry = environ; entry != nullptr && *entry != nullptr; ++entry)
    if (!isReserved(*entry)) env.emplace_back(*entry);
  std::size_t start = 0;
  while (start < envPairs.size()) {
    std::size_t end = envPairs.find('\x1f', start);
    if (end == std::string::npos) end = envPairs.size();
    std::string pair = envPairs.substr(start, end - start);
    start = end + 1;
    const std::size_t equals = pair.find('=');
    if (pair.empty() || equals == std::string::npos) continue;
    const std::string key = pair.substr(0, equals + 1);
    if (isReserved(key)) continue;
    std::erase_if(env, [&key](const std::string &existing) { return existing.compare(0, key.size(), key) == 0; });
    env.push_back(std::move(pair));
  }
  const std::string idText = std::to_string(static_cast<long long>(id));
  env.push_back("GEA_CLUSTER_WORKER_ID=" + idText);
  env.push_back("NODE_UNIQUE_ID=" + idText);
  env.push_back("GEA_CLUSTER_CHANNEL_FD=" + std::to_string(s.channelRead));
  std::vector<char *> envp;
  envp.reserve(env.size() + 1);
  for (std::string &entry : env) envp.push_back(entry.data());
  envp.push_back(nullptr);
  std::vector<std::string> args = s.arguments.empty() ? std::vector<std::string>{exe} : s.arguments;
  std::vector<char *> argv;
  argv.reserve(args.size() + 1);
  for (std::string &arg : args) argv.push_back(arg.data());
  argv.push_back(nullptr);
  pid_t pid = 0;
  const int rc = ::posix_spawn(&pid, exe.c_str(), nullptr, nullptr, argv.data(), envp.data());
  if (rc != 0) {
    s.spawnError = std::strerror(rc);
    return 0;
  }
  ++s.liveChildren;
  return static_cast<double>(pid);
}

// Worker side: EOF on the inherited liveness pipe means the primary is gone.
class ChannelWatcher final : public IoWatcher {
public:
  ChannelWatcher(int fd, std::function<void()> onDisconnect) : fd_(fd), onDisconnect_(std::move(onDisconnect)) {}
  int fd() const noexcept override { return fd_; }
  short interestedEvents() const noexcept override { return POLLIN; }
  // Unreferenced: a worker with nothing to serve exits, as under Node.
  bool isReferenced() const noexcept override { return false; }
  void onReady(short revents) override {
    char buffer[16];
    const ssize_t n = ::read(fd_, buffer, sizeof buffer);
    const bool closed = n == 0 || (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) ||
                        (revents & (POLLHUP | POLLERR)) != 0;
    if (!closed) return;
    clientEventLoop().close(this);
    if (onDisconnect_) onDisconnect_();
  }

private:
  int fd_;
  std::function<void()> onDisconnect_;
};

inline void watchChannel(std::function<void()> onDisconnect) {
  const char *env = std::getenv("GEA_CLUSTER_CHANNEL_FD");
  if (env == nullptr) return;
  const int fd = std::atoi(env);
  if (fd < 0) return;
  (void)::fcntl(fd, F_SETFL, ::fcntl(fd, F_GETFL) | O_NONBLOCK);
  clientEventLoop().adopt(std::make_unique<ChannelWatcher>(fd, std::move(onDisconnect)));
}

}  // namespace gea::node::cluster

namespace gea::node {

inline void cluster_set_notify_native(std::function<void()> notify) { cluster::state().notify = std::move(notify); }
inline void cluster_watch_channel_native(std::function<void()> onDisconnect) { cluster::watchChannel(std::move(onDisconnect)); }
inline void set_process_arguments(int argc, char **argv) {
  std::vector<std::string> &arguments = cluster::state().arguments;
  arguments.clear();
  for (int index = 0; index < argc; ++index) arguments.emplace_back(argv[index]);
}

}  // namespace gea::node

inline double __gea_node_cluster_worker_id() {
  const char *env = std::getenv("GEA_CLUSTER_WORKER_ID");
  return env == nullptr ? 0.0 : std::atof(env);
}
inline double __gea_node_cluster_fork(double id, std::string env) { return gea::node::cluster::spawn(id, env); }
inline std::string __gea_node_cluster_spawn_error() { return gea::node::cluster::state().spawnError; }
inline double __gea_node_cluster_next_exit() {
  gea::node::cluster::State &s = gea::node::cluster::state();
  if (s.exits.empty()) return 0;
  s.last = std::move(s.exits.front());
  s.exits.pop_front();
  return s.last.pid;
}
inline double __gea_node_cluster_exit_code() { return gea::node::cluster::state().last.code; }
inline std::string __gea_node_cluster_exit_signal() { return gea::node::cluster::state().last.signal; }
inline bool __gea_node_cluster_kill(double pid, std::string signal) {
  const int number = gea::node::cluster::signalNumber(signal);
  if (number < 0) return false;
  return ::kill(static_cast<pid_t>(pid), number) == 0;
}
inline double __gea_node_process_pid() { return static_cast<double>(::getpid()); }
inline double __gea_node_process_ppid() { return static_cast<double>(::getppid()); }
inline void __gea_node_process_exit(double code) {
  std::fflush(nullptr);
  ::_exit(static_cast<int>(code));
}
inline double __gea_node_os_available_parallelism() {
  const long count = ::sysconf(_SC_NPROCESSORS_ONLN);
  return count > 0 ? static_cast<double>(count) : 1.0;
}

// ---- intrinsics exposed to geatsc-generated code --------------------------
// Registered by the node-compat plugin as `embeddedHostFunctions`, so a call in
// the compiled TypeScript lowers to a direct call of these C++ symbols.

inline double __gea_answer() { return 42.0; }

inline void __gea_serve_hello(double port) {
  gea::node::serve(static_cast<int>(port),
                   [](double connId, double, const std::string &, const std::string &path, const std::string &,
                      const std::string &, const std::string &) {
                     auto *conn = gea::node::findConnection(connId);
                     if (!conn) return;
                     conn->enqueueResponseBytes(
                         path == "/json" ? gea::node::makeResponse("application/json; charset=utf-8", "{\"hello\":\"world\"}")
                                         : gea::node::makeResponse("text/plain; charset=utf-8", "Hello, World!"));
                     conn->responseComplete(true);
                   });
}

// Per-request dispatch into a geatsc-compiled closure. `onRequest` is the
// TYPED lambda geatsc emits for the TS request-dispatch arrow — the template
// deduces its concrete closure type, so the per-request call is a direct
// (inlinable) invocation: no boxing of the callable or its arguments, no
// std::function type erasure. There is deliberately no boxed overload.
template <typename OnRequest>
inline void __gea_http_serve(double port, OnRequest &&onRequest) {
  gea::node::serve(static_cast<int>(port), std::forward<OnRequest>(onRequest));
}

// There is no `gea_cpp_value` fallback: the dispatch arrow is emitted as a
// typed lambda, which the template above takes directly. A program that somehow
// reached this boundary boxed fails to compile rather than silently boxing
// every request.

inline void __gea_http_write(double connId, std::string data) {
  if (auto *conn = gea::node::findConnection(connId)) conn->enqueueResponseBytes(data);
}

// The same enqueue for a response delivered as two pieces -- in practice the
// serialized header block and the first body chunk.
//
// `ServerResponse.emitPayload` used to hand those over as `head + body`, which
// built a third string holding a copy of both just so the boundary could take
// one argument. Both parts are appended into the connection's own buffer here
// instead, so that intermediate string is never built. Taking each part by
// reference matters as much as the arity: by value, `head` is an lvalue at the
// call site and would be copied to form the argument, reintroducing the
// allocation this removes.
inline void __gea_http_write2(double connId, const std::string &head, const std::string &body) {
  auto *conn = gea::node::findConnection(connId);
  if (!conn) return;
  conn->enqueueResponseParts(head, body);
}

// The header block, serialized into the connection buffer piece by piece --
// see `HttpConnectionBase::headBegin`. Every string crosses by reference: by
// value, a field read at the call site would be copied to form the argument.
inline void __gea_http_head_begin(double connId, double status, const std::string &message) {
  if (auto *conn = gea::node::findConnection(connId)) conn->headBegin(static_cast<int>(status), message);
}

inline void __gea_http_head_field(double connId, const std::string &name, const std::string &value) {
  if (auto *conn = gea::node::findConnection(connId)) conn->headField(name, value);
}

inline void __gea_http_head_raw(double connId, const std::string &text) {
  if (auto *conn = gea::node::findConnection(connId)) conn->headRaw(text);
}

inline double __gea_http_head_end(double connId, double flags, double autoContentLength) {
  auto *conn = gea::node::findConnection(connId);
  // A dead connection frames nothing; "not chunked, not kept alive" keeps the
  // caller from building chunk framing for bytes that have nowhere to go.
  return conn ? static_cast<double>(conn->headEnd(static_cast<int>(flags), autoContentLength)) : 0.0;
}

// Body bytes by reference. `__gea_http_write` takes its string BY VALUE, so an
// lvalue body is copied to form the argument before it is copied again into
// the connection buffer.
inline void __gea_http_body(double connId, const std::string &data) {
  if (auto *conn = gea::node::findConnection(connId)) conn->enqueueResponseBytes(data);
}

// A string is UTF-8 here, so its length on the wire is its size.
inline double __gea_http_text_bytes(const std::string &text) { return static_cast<double>(text.size()); }

// `end(text)` on a chunked response: size line, text, and terminator appended
// in place. The caller used to build `hex + CRLF + text + CRLF + "0" CRLF CRLF`
// as one string first -- an allocation and a full copy of the body, to feed a
// buffer that could have taken the four pieces directly.
inline void __gea_http_final_chunk(double connId, const std::string &data) {
  if (auto *conn = gea::node::findConnection(connId)) conn->enqueueFinalChunk(data);
}

// The same enqueue, reached with OCTETS instead of text.
//
// `__gea_http_write` above is the only way a response body ever left this
// runtime, and its parameter is a TypeScript `string`: an application handing
// `res.end(uint8Array)` a PNG, a protobuf frame or any other non-UTF-8 payload
// had no path that preserved its bytes, so `ServerResponse.end` could only
// declare `string` and hono's `outgoing.end(body)` (body: `Uint8Array`) was a
// checker error rather than a wrong answer. This is the missing half: the
// carrier is `gea::TypedArray<std::uint8_t>`, the same one `net_write` already
// takes for `node:net`, so a `Uint8Array`/`Buffer` arrives as its own storage
// with no conversion on either side.
//
// Header blocks, chunk-size lines and the terminating `0\r\n\r\n` stay on the
// string call -- they are ASCII by construction -- so a chunked byte body is
// three appends into the one connection buffer rather than one.
inline void __gea_http_write_bytes(double connId, const gea::TypedArray<std::uint8_t> &data) {
  auto *conn = gea::node::findConnection(connId);
  if (!conn) return;
  const auto *bytes = data.data();
  if (!bytes) return;
  // A view, not a string. This used to copy the whole body into a temporary
  // `std::string` purely to match the old owning parameter -- an allocation
  // and a full copy of every byte response, on top of the copy into the
  // connection buffer that follows. `enqueueResponseBytes` takes a
  // `string_view` now, so the bytes go straight from the TypedArray's own
  // storage into the buffer. This is hono's response path.
  conn->enqueueResponseBytes(std::string_view(reinterpret_cast<const char *>(bytes), data.size()));
}

// The inbound mirror of `__gea_http_write_bytes`: the reactor hands a request
// body over as a `std::string` of raw octets, and every string-to-Buffer
// encoding in `gea_node_buffer.hpp` decodes its input as UTF-8 first, so a
// body byte like 0xff came out as U+FFFD. This copies the octets as they are.
inline gea::Ref<gea::TypedArray<std::uint8_t>> __gea_http_body_bytes(const std::string &body) {
  return gea::node::buffer::detail::bufferResult(std::vector<std::uint8_t>(body.begin(), body.end()));
}

inline void __gea_http_done(double connId, bool keepAlive) {
  if (auto *conn = gea::node::findConnection(connId)) conn->responseComplete(keepAlive);
}

inline void __gea_http_destroy(double connId) {
  if (auto *conn = gea::node::findConnection(connId)) conn->hardDestroy();
}

inline std::string __gea_http_peer(double connId) {
  if (auto *conn = gea::node::findConnection(connId)) return conn->peerName();
  return std::string();
}

inline const std::string &__gea_http_date() { return gea::node::cachedHttpDate(); }

inline double __gea_http_date_second() { return static_cast<double>(gea::node::cachedHttpDateSecond()); }

inline void __gea_http_stop() {
  if (gea::node::listenerCloser()) gea::node::listenerCloser()();
}

// Real delayed timers (plugin maps global setTimeout/setInterval/clearTimeout/
// clearInterval to these — the runtime's standalone gea::host fallback would
// otherwise degrade a delay to an immediate microtask).
inline double __gea_node_set_timeout(std::function<void()> callback, double delayMs) {
  if (!callback) return 0;
  return gea::node::timers::add(std::move(callback), delayMs, false);
}

inline double __gea_node_set_interval(std::function<void()> callback, double delayMs) {
  if (!callback) return 0;
  return gea::node::timers::add(std::move(callback), delayMs, true);
}

inline void __gea_node_clear_timer(double id) { gea::node::timers::remove(id); }

inline void __gea_node_timer_unref(double id) { gea::node::timers::unref(id); }

inline void __gea_node_run_pending() { gea::node::clientEventLoop().run(); }

inline bool __gea_node_pump_until(const std::function<bool()> &done) {
  return gea::node::clientEventLoop().runUntil(done);
}

inline std::string __gea_node_version() { return "v20.0.0-gea"; }

inline std::string __gea_node_platform() {
#if defined(__APPLE__)
  return "darwin";
#elif defined(__linux__)
  return "linux";
#elif defined(_WIN32)
  return "win32";
#else
  return "unknown";
#endif
}

static struct utsname __gea_node_uname() {
  struct utsname value {};
  (void)::uname(&value);
  return value;
}

inline std::string __gea_node_os_arch() {
  const std::string machine = __gea_node_uname().machine;
  if (machine == "aarch64" || machine == "arm64") return "arm64";
  if (machine == "x86_64" || machine == "amd64") return "x64";
  return machine;
}

inline std::string __gea_node_os_release() { return __gea_node_uname().release; }

inline std::string __gea_node_os_type() {
#if defined(__APPLE__)
  return "Darwin";
#elif defined(__linux__)
  return "Linux";
#elif defined(_WIN32)
  return "Windows_NT";
#else
  return __gea_node_uname().sysname;
#endif
}

inline void __gea_node_stdio_write(double fd, std::string data) {
  FILE *stream = static_cast<int>(fd) == 2 ? stderr : stdout;
  if (!data.empty()) (void)::fwrite(data.data(), 1, data.size(), stream);
  (void)::fflush(stream);
}

inline bool __gea_node_fs_access(std::string path, double mode) {
  return ::access(path.c_str(), static_cast<int>(mode)) == 0;
}

// The same refusal under both runtimes, raised the way each one raises: v1
// writes its global thrown slot and sets the flag, v2 throws a real C++
// exception carrying the identical `gea::Value` payload -- which is also what
// the request path above catches to isolate a handler throw to its request.
inline void __gea_node_not_implemented(std::string moduleName, std::string memberName) {
  const std::string target = "node@24";
  const std::string message = std::string("ERR_GEA_NODE_NOT_IMPLEMENTED: ") + moduleName + "." + memberName +
      " is not implemented for geastack target " + target;
  throw gea::Value::box(gea::Value::Tag::String, std::string("NodeNotImplementedError: ") + message);
}

#endif  // GEA_NODE_RUNTIME_INCLUDED

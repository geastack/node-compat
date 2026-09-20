#pragma once

// node-compat's native layer, as geatsc reaches it.
//
// geatsc emits one translation unit and includes `gea_runtime.h` from the
// compiler package, so this file is the seam between that unit and the native
// layer: carriers first, then the reactor, then the process entry helper.
//
// The reactor is INCLUDED here rather than linked as its own object because
// `__gea_http_serve` is a TEMPLATE: it deduces the concrete closure type of the
// dispatch lambda the unit emits, which is what keeps the per-request call a
// direct inlinable invocation instead of a boxed one, and a template has to be
// visible where it is called. `scripts/build.mjs` therefore does not pass
// `gea_node.cpp` as a separate source -- doing both would define every reactor
// symbol twice.

#include "gea_runtime.h"

// node's `Buffer`, over `gea::TypedArray<std::uint8_t>` -- the carrier the
// compiler already gives every `Uint8Array`, and therefore `Buffer` too (see
// that header, and `runtime/node/buffer-types.ts`). Included here rather than
// from the reactor because the generated unit reaches it through the same
// `hostPreambles` include this file already is.
#include "gea_node_buffer.hpp"
#include "gea_node_net.hpp"
#include "gea_node_cluster.hpp"

#include <cstdlib>
#include <cstdio>
#include <array>
#include <cstdint>
#include <functional>
#include <string>
#include <utility>
#ifdef __APPLE__
#include <crt_externs.h>
#endif

// The microtask queue, declared before the reactor because the reactor's own
// loop drains it.
//
// The compiler's runtime owns no microtask queue -- a deliberate absence, since
// a microtask queue is a host's concern rather than the language's -- so the
// queue the reactor already needs for its own deferred work is the one to
// publish, and `plugin/index.mjs` points the program's
// `queueMicrotask` at exactly this symbol. Defined in `gea_node.cpp` beside the
// loop that drains it.
namespace gea::node {
void queue_microtask(std::function<void()> callback);
void drain_microtasks();
void queue_next_tick(std::function<void()> callback);
void drain_next_ticks();
}  // namespace gea::node

#include "gea_node.cpp"

/** The process environment as the typed dictionary declared by node:process. */
inline gea::Ref<gea::Dictionary<gea::Optional<std::string>>> gea_cpp_process_env() {
  auto result = gea::makeRef<gea::Dictionary<gea::Optional<std::string>>>();
#ifdef __APPLE__
  char **entries = *_NSGetEnviron();
#else
  extern char **environ;
  char **entries = environ;
#endif
  for (char **entry = entries; entry && *entry; ++entry) {
    const std::string item(*entry);
    const std::size_t separator = item.find('=');
    if (separator == std::string::npos) continue;
    (*result)[item.substr(0, separator)] = gea::Optional<std::string>(item.substr(separator + 1));
  }
  return result;
}

// Process is a singleton host object. Its mutable `env` dictionary is loaded
// once and returned by reference, so reads, writes, deletes and identity all
// share one JavaScript-visible object. It deliberately models the process
// environment visible to compiled code; no unclaimed host operation reaches
// through it to mutate the embedding process's POSIX environment.
namespace gea::node {

struct Process {};
struct ProcessVersions {};
struct ProcessWriteStream {
  int fd;
};
struct ProcessHrTime {};

namespace process {

inline Process process{};
inline const ProcessVersions versions{};
inline const ProcessWriteStream stdout{1};
inline const ProcessWriteStream stderr{2};
inline const ProcessHrTime hrtime_facade{};

inline gea::Ref<gea::Dictionary<gea::Optional<std::string>>> env() {
  static const gea::Ref<gea::Dictionary<gea::Optional<std::string>>> value = gea_cpp_process_env();
  return value;
}

inline gea::Ref<gea::ArrayObject<std::string>> argv() {
  static const gea::Ref<gea::ArrayObject<std::string>> value = [] {
    auto result = gea::makeRef<gea::ArrayObject<std::string>>();
    for (const std::string& argument : cluster::state().arguments) result->push(argument);
    return result;
  }();
  return value;
}

inline gea::Ref<gea::ArrayObject<std::string>> exec_argv() {
  static const gea::Ref<gea::ArrayObject<std::string>> value = gea::makeRef<gea::ArrayObject<std::string>>();
  return value;
}

inline gea::Value get_builtin_module(const std::string& name) { return gea::commonjs::getBuiltinModule(name); }

inline std::string cwd() {
  char path[PATH_MAX];
  if (::getcwd(path, sizeof(path)) == nullptr) {
    throw gea::Value::box(gea::Value::Tag::String, std::string("process.cwd failed: ") + std::strerror(errno));
  }
  return path;
}

inline std::array<double, 2> hrtime() {
  const auto elapsed = std::chrono::steady_clock::now().time_since_epoch();
  const auto seconds = std::chrono::duration_cast<std::chrono::seconds>(elapsed);
  const auto nanos = std::chrono::duration_cast<std::chrono::nanoseconds>(elapsed - seconds);
  return {static_cast<double>(seconds.count()), static_cast<double>(nanos.count())};
}

inline gea::BigInt hrtime_bigint() {
  const auto nanos = std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
  return gea::BigInt::parse(std::to_string(nanos));
}

inline gea::BigInt hrtime_bigint_invoke(void*) { return hrtime_bigint(); }
inline const gea::CallableObject<gea::BigInt()> hrtime_bigint_callable{&hrtime_bigint_invoke, nullptr};

inline std::string version_node() { return "20.0.0-gea"; }

inline gea::Value next_tick_value(const gea::Value& value) { return value; }
inline gea::Value next_tick_value(std::nullptr_t) { return gea::Value::box(gea::Value::Tag::Null, nullptr); }
inline gea::Value next_tick_value(double value) { return gea::Value::box(gea::Value::Tag::Number, value); }
inline gea::Value next_tick_value(bool value) { return gea::Value::box(gea::Value::Tag::Boolean, value); }
inline gea::Value next_tick_value(const std::string& value) { return gea::Value::box(gea::Value::Tag::String, value); }
inline gea::Value next_tick_value(const gea::BigInt& value) { return gea::Value::box(gea::Value::Tag::BigInt, value); }

template <typename T>
inline gea::Value next_tick_value(const gea::Optional<T>& value) {
  return value.has_value() ? next_tick_value(*value) : gea::Value{};
}

template <typename T>
inline gea::Value next_tick_value(const gea::Ref<T>& value) {
  return gea::Value::box(gea::Value::Tag::Object, value);
}

template <typename Callback, typename... Arguments>
inline void next_tick(Callback callback, Arguments... arguments) {
  if constexpr (requires { callback(arguments...); }) {
    queue_next_tick([callback = std::move(callback), ... arguments = std::move(arguments)]() mutable { callback(arguments...); });
  } else {
    const gea::Value held = gea::Value::box(gea::Value::Tag::Function, callback);
    std::vector<gea::Value> values{next_tick_value(arguments)...};
    queue_next_tick([held, values = std::move(values)]() mutable { held.callAsFunction(values); });
  }
}

inline std::vector<gea::CallableObject<void(double)>>& exit_listeners() {
  static std::vector<gea::CallableObject<void(double)>> value;
  return value;
}

template <typename Listener>
inline Process on(const std::string& event, Listener listener) {
  if (event != "exit") throw gea::Value::box(gea::Value::Tag::String, "process event is not implemented");
  exit_listeners().emplace_back(listener);
  return process;
}

template <typename Listener>
inline Process remove_listener(const std::string& event, const Listener& listener) {
  if (event != "exit") throw gea::Value::box(gea::Value::Tag::String, "process event is not implemented");
  const gea::CallableObject<void(double)> held(listener);
  std::erase(exit_listeners(), held);
  return process;
}

inline int exit_status(double code) { return static_cast<int>(gea::toInt32(code)); }

inline void emit_exit(int status) {
  // EventEmitter dispatch observes a snapshot: additions/removals during one
  // listener cannot invalidate iteration or alter this emission's listener set.
  const auto listeners = exit_listeners();
  for (const auto& listener : listeners) listener.call(static_cast<double>(status));
}

[[noreturn]] inline void exit(double code = 0) {
  const int status = exit_status(code);
  emit_exit(status);
  std::fflush(nullptr);
  ::_exit(status);
}

}  // namespace process
}  // namespace gea::node

// `performance`, as the ONE member of it any of this target's libraries reads.
//
// mongodb calls `performance.now()` and nothing else -- in `utils.ts`,
// `timeout.ts` and `cmap/connect.ts`, always immediately differenced against
// an earlier reading -- so the surface this host owes is a single monotonic
// millisecond clock, which the reactor's timer wheel already keeps
// (`gea::node::timers::nowMs`, `steady_clock`).
//
// The origin is subtracted rather than passed through, because node's
// `performance.now()` is defined relative to `timeOrigin` and returns a small
// number early in a process's life. `steady_clock`'s epoch is unspecified and
// on Linux is boot time, so a raw reading is a machine-uptime figure in the
// millions. Every caller here differences two readings and would not notice --
// but a program that logs one, or stores one in a `float`, would, and matching
// the language's own definition costs one subtraction.
namespace gea::node {

struct PerformanceFacade {};
inline constexpr PerformanceFacade performance_facade{};

namespace performance {

inline double origin() {
  static const double captured = gea::node::timers::nowMs();
  return captured;
}

inline double now() { return gea::node::timers::nowMs() - origin(); }

}  // namespace performance
}  // namespace gea::node

// Hand the thread to the reactor and return when no watcher and no timer is
// left. `gea_node.cpp` defines it; the generated program entry below calls it.
void __gea_node_run_pending();

namespace gea::node {

inline int run_compiled_program(int argc, char **argv, void (*entry)()) {
  set_process_arguments(argc, argv);
  std::setvbuf(stdout, nullptr, _IOLBF, 0);
  gea::setPromiseWaitPump(::__gea_node_pump_until);
  gea::detail::setNextTickDrain(&drain_next_ticks);
  // Promise jobs share the microtask queue this reactor drains; the language
  // runtime's own `promiseJobs()` is drained by nothing here.
  gea::detail::setPromiseJobSink(+[](std::function<void()>&& job) { queue_microtask(std::move(job)); });
  // Trial deletion re-traces every live object reachable from the buffered
  // candidates, and a request's objects reach the server, the app and its
  // router. At the runtime default of 64 candidates hono-hello collected 1.8
  // times per request and traced 400 nodes for 44 it freed: 21% of CPU on
  // the bench box. A larger buffer amortizes the live re-trace over more
  // garbage; the knob is here so a box run can sweep it.
  if (const char* candidates = std::getenv("GEA_CYCLE_CANDIDATES")) {
    if (const auto count = std::strtoull(candidates, nullptr, 10); count != 0)
      gea::configureAutomaticCycleCollection(std::chrono::milliseconds{0}, 0, static_cast<std::size_t>(count));
  }
  entry();
  drain_microtasks();
  ::__gea_node_run_pending();
  drain_microtasks();
  return 0;
}

}  // namespace gea::node

// The reactor has consumed the POSIX access macros. Do not leak them into
// generated TypeScript records: node:fs constants are ordinary fields, and
// the C preprocessor would otherwise expand e.g. constants.R_OK into tokens.
#undef F_OK
#undef R_OK
#undef W_OK
#undef X_OK

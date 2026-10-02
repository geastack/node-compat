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
#include <algorithm>
#include <array>
#include <cstdint>
#include <functional>
#include <string>
#include <utility>
#include <vector>
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
void queue_microtask(gea::detail::PromiseJob callback);
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

// `process.execPath`: the absolute, symlink-resolved path of this binary, as
// node's `uv_exepath` answers it. Falls back to the raw `argv[0]` only when
// the OS will not say (no /proc, a deleted image).
inline std::string exec_path() {
  static const std::string value = [] {
    std::string path = cluster::executablePath();
    if (!path.empty()) {
      char resolved[PATH_MAX];
      if (::realpath(path.c_str(), resolved) != nullptr) return std::string(resolved);
      return path;
    }
    const std::vector<std::string>& raw = cluster::state().arguments;
    return raw.empty() ? std::string() : raw.front();
  }();
  return value;
}

// `process.argv0`: the original `argv[0]`, exactly as the process was invoked.
inline std::string argv0() {
  const std::vector<std::string>& raw = cluster::state().arguments;
  return raw.empty() ? exec_path() : raw.front();
}

// `process.argv` in node's shape, `[execPath, script, ...userArgs]`, so user
// arguments start at index 2. A compiled program has no separate script, so
// slot 1 is the binary's absolute path too -- what `pkg` and node's
// single-executable applications put there (node SEA's `FixupArgsForSEA`
// repeats argv[0] in slot 1; we repeat the resolved path, which is the value
// node's own `path.resolve(argv[1])` expansion gives a script). The raw
// arguments stay untouched in `cluster::state().arguments`: a forked worker
// re-executes with exactly those.
inline gea::Ref<gea::ArrayObject<std::string>> argv() {
  static const gea::Ref<gea::ArrayObject<std::string>> value = [] {
    auto result = gea::makeRef<gea::ArrayObject<std::string>>();
    const std::string executable = exec_path();
    result->push(executable);
    result->push(executable);
    const std::vector<std::string>& raw = cluster::state().arguments;
    for (std::size_t index = 1; index < raw.size(); ++index) result->push(raw[index]);
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

// `listener` is taken by CONST REFERENCE and identified in place, not by
// value. `CallableObject::operator==` compares `functionObjectIdentity()`,
// which a plain copy never mints (see that method's header: "a copy mints
// nothing"), so two independent copies of the same never-identified callable
// mint two DIFFERENT identities and never compare equal. Taking `listener` by
// value here would copy the caller's callable before minting anything, so the
// identity minted on that local copy could never reach a later
// `remove_listener` call on the caller's own variable. Calling `.identified()`
// on the reference mutates the caller's object directly (`functionObject` is
// `mutable`, exactly so a `const` identity read can cache), so a later
// `remove_listener("exit", listener)` on that SAME variable copies the
// already-shared identity instead of minting a fresh one, and the two
// compare equal.
template <typename Listener>
inline Process on(const std::string& event, const Listener& listener) {
  if (event != "exit") throw gea::Value::box(gea::Value::Tag::String, "process event is not implemented");
  exit_listeners().emplace_back(listener.identified());
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

// `process.exitCode`: `undefined` until a program sets it, and then the status
// a natural exit (`run_compiled_program`) and an argument-less `exit()` use.
inline gea::Optional<double>& exit_code_cell() {
  static gea::Optional<double> cell;
  return cell;
}
inline gea::Optional<double> exit_code() { return exit_code_cell(); }
inline void set_exit_code(const gea::Optional<double>& code) { exit_code_cell() = code; }
inline void set_exit_code(gea::Undefined) { exit_code_cell() = gea::Optional<double>(); }
// The status a process ends with when nothing names one: `exitCode ?? 0`.
inline int default_exit_status() {
  const gea::Optional<double>& code = exit_code_cell();
  return code.has_value() ? exit_status(*code) : 0;
}

[[noreturn]] inline void exit(double code) {
  const int status = exit_status(code);
  emit_exit(status);
  std::fflush(nullptr);
  ::_exit(status);
}
[[noreturn]] inline void exit() { exit(static_cast<double>(default_exit_status())); }

}  // namespace process
}  // namespace gea::node

// `node:process`'s module-level `exit()` asks this for `exitCode ?? 0`.
inline double __gea_node_process_default_exit_status() { return static_cast<double>(gea::node::process::default_exit_status()); }

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
  // Pushed straight from the reference: `queue_microtask` takes its job by value,
  // which relocated every Promise job once more on its way into the queue.
  gea::detail::setPromiseJobSink(+[](gea::detail::PromiseJob&& job) { microtasks().push_back(std::move(job)); });
  // Trial deletion re-traces every live object reachable from the buffered
  // candidates, and a request's objects reach the server, the app and its
  // router. At the runtime default of 64 candidates hono-hello collected 1.8
  // times per request and traced 400 nodes for 44 it freed: 21% of CPU on
  // the bench box. A larger buffer amortizes the live re-trace over more
  // garbage; the knob is here so a box run can sweep it.
  //
  // The reactor now collects at its quiescent point instead (`runPoll`,
  // `gea::collectCyclesAtQuiescence`), where a request's garbage is dead and
  // its live state small. The threshold is then only the bound for a stretch
  // that never reaches the loop, so it sits well above what one request
  // buffers (~400 on the mongodb driver) -- at 64 the safepoint still fired
  // five times per operation and the quiescent pass found nothing left.
  {
    std::size_t candidates = 4096;
    if (const char* configured = std::getenv("GEA_CYCLE_CANDIDATES")) {
      if (const auto count = std::strtoull(configured, nullptr, 10); count != 0) candidates = static_cast<std::size_t>(count);
    }
    // Filtered well before a collection is due: see `CycleState::filterInterval`.
    std::size_t filter = 1024;
    if (const char* configured = std::getenv("GEA_CYCLE_FILTER")) {
      if (const auto count = std::strtoull(configured, nullptr, 10); count != 0) filter = static_cast<std::size_t>(count);
    }
    gea::detail::cycleState().filterInterval = filter;
    gea::configureAutomaticCycleCollection(std::chrono::milliseconds{0}, 0, candidates);
  }
  // An exception nothing caught ends the process the way node's does: the
  // error's `stack` (or its string form) on stderr and exit status 1, rather
  // than `std::terminate` on an unhandled C++ exception -- which says only
  // that *some* `gea::Value` escaped and drops the message that names it.
#if defined(GEA_PROFILE_ALLOCATIONS)
  // What the collector did over the whole run, on stderr at exit: how often it
  // ran, how many candidates it was handed, how many nodes and edges each
  // trace covered and how much of that it freed. A profile can say the
  // collector is 20% of CPU; only these counts say whether that is many
  // cheap collections or a few that re-trace a large live graph -- and those
  // two findings have opposite fixes.
  ::atexit(+[] {
    const auto& profile = gea::detail::allocationProfile();
    std::fprintf(stderr,
                 "gea-cycle-collector: collections=%llu full=%llu candidates=%llu visited=%llu edges=%llu retained=%llu "
                 "unreachable=%llu matureSkipped=%llu deferrals=%llu created=%llu destroyed=%llu cycleDestroyed=%llu "
                 "edgelessCandidates=%llu untracedDips=%llu selfLoopReclaims=%llu buffered=%llu deadCandidates=%llu forgottenCandidates=%llu\n",
                 static_cast<unsigned long long>(profile.collections), static_cast<unsigned long long>(profile.fullCollections),
                 static_cast<unsigned long long>(profile.candidates), static_cast<unsigned long long>(profile.visited),
                 static_cast<unsigned long long>(profile.edges), static_cast<unsigned long long>(profile.retained),
                 static_cast<unsigned long long>(profile.unreachable), static_cast<unsigned long long>(profile.matureSkipped),
                 static_cast<unsigned long long>(profile.deferrals), static_cast<unsigned long long>(profile.created),
                 static_cast<unsigned long long>(profile.destroyed), static_cast<unsigned long long>(profile.cycleDestroyed),
                 static_cast<unsigned long long>(profile.edgelessCandidates),
                 static_cast<unsigned long long>(profile.untracedDips), static_cast<unsigned long long>(profile.selfLoopReclaims),
                 static_cast<unsigned long long>(profile.buffered), static_cast<unsigned long long>(profile.deadCandidates),
                 static_cast<unsigned long long>(profile.forgottenCandidates));
    // Per type, creations: `GEA_ALLOC_TOP=<n>` lists the n most-created types (name, created, bytes per block).
    if (const char* top = std::getenv("GEA_ALLOC_TOP")) {
      std::vector<const gea::detail::AllocationTypeProfile*> byCreated;
      for (const auto* type = profile.types; type != nullptr; type = type->next) byCreated.push_back(type);
      std::sort(byCreated.begin(), byCreated.end(), [](const auto* a, const auto* b) { return a->created > b->created; });
      const std::size_t limit = static_cast<std::size_t>(std::strtoull(top, nullptr, 10));
      for (std::size_t index = 0; index < byCreated.size() && index < limit; ++index) {
        const auto* type = byCreated[index];
        std::fprintf(stderr, "ALLOC created=%llu block=%zu %s\n", static_cast<unsigned long long>(type->created), type->blockBytes,
                     type->name == nullptr ? "?" : type->name);
      }
    }
    // Per type, the collector's input: which types are buffered most.
    std::vector<const gea::detail::AllocationTypeProfile*> types;
    for (const auto* type = profile.types; type != nullptr; type = type->next) types.push_back(type);
    std::sort(types.begin(), types.end(), [](const auto* a, const auto* b) { return a->buffered > b->buffered; });
    for (std::size_t index = 0; index < types.size() && index < 40; ++index) {
      const auto* type = types[index];
      std::fprintf(stderr, "  buffered=%llu candidates=%llu dead=%llu edgeless=%llu created=%llu cycleDestroyed=%llu %s\n",
                   static_cast<unsigned long long>(type->buffered), static_cast<unsigned long long>(type->candidates),
                   static_cast<unsigned long long>(type->deadCandidates), static_cast<unsigned long long>(type->edgelessCandidates),
                   static_cast<unsigned long long>(type->created), static_cast<unsigned long long>(type->cycleDestroyed),
                   type->name == nullptr ? "?" : type->name);
    }
  });
#endif
  try {
    entry();
    drain_microtasks();
    ::__gea_node_run_pending();
    drain_microtasks();
  } catch (const gea::Value& thrown) {
    std::string text;
    try {
      const gea::Value stack = thrown.tag() == gea::Value::Tag::Object
        ? thrown.getProperty(gea::PropertyKey::string("stack"))
        : gea::Value();
      if (stack.tag() == gea::Value::Tag::String) {
        text = gea::host::detail::toString(stack);
      } else if (thrown.tag() == gea::Value::Tag::Object) {
        // A native error class may not expose `stack`; its name and message
        // are what node's own report leads with.
        const gea::Value name = thrown.getProperty(gea::PropertyKey::string("name"));
        const gea::Value message = thrown.getProperty(gea::PropertyKey::string("message"));
        text = message.tag() == gea::Value::Tag::String
          ? (name.tag() == gea::Value::Tag::String ? gea::host::detail::toString(name) : std::string("Error")) + ": " +
              gea::host::detail::toString(message)
          : gea::host::detail::toString(thrown);
      } else {
        text = gea::host::detail::toString(thrown);
      }
    } catch (...) {
      text = "Uncaught exception (its string form threw)";
    }
    std::fflush(stdout);
    std::fprintf(stderr, "Uncaught %s\n", text.c_str());
    return 1;
  }
  return process::default_exit_status();
}

}  // namespace gea::node

// The reactor has consumed the POSIX access macros. Do not leak them into
// generated TypeScript records: node:fs constants are ordinary fields, and
// the C preprocessor would otherwise expand e.g. constants.R_OK into tokens.
#undef F_OK
#undef R_OK
#undef W_OK
#undef X_OK

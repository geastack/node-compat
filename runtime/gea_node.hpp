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
    // A callback that arrives boxed is already the function value; boxing
    // it again would hand the queue a Value whose payload is a Value.
    gea::Value held;
    if constexpr (std::is_same_v<std::decay_t<Callback>, gea::Value>) held = callback;
    else held = gea::Value::box(gea::Value::Tag::Function, callback);
    std::vector<gea::Value> values{next_tick_value(arguments)...};
    queue_next_tick([held, values = std::move(values)]() mutable { held.callAsFunction(values); });
  }
}

/** A warning's string-valued own property, or empty when it is absent or not a string. */
inline std::string warning_string_property(const gea::Value& warning, const char* name) {
  const gea::Value value = warning.getProperty(gea::PropertyKey::string(name), warning);
  return value.tag() == gea::Value::Tag::String ? gea::dynamicToString(value) : std::string();
}

/**
 * Node's default 'warning' listener (`lib/internal/process/warning.js`
 * `onWarning`), run one tick after the call as Node's `doEmitWarning` is:
 * `(node:<pid>) [<code>] <warning.toString()>`, the detail on its own line,
 * and the trace hint after the first warning only.
 */
inline void write_warning(const std::string& text, const std::string& code, const std::string& detail, bool deprecation) {
  static bool trace_hint_shown = false;
  std::string message = "(node:" + std::to_string(::getpid()) + ") ";
  if (!code.empty()) message += "[" + code + "] ";
  message += text;
  if (!detail.empty()) message += "\n" + detail;
  if (!trace_hint_shown) {
    const std::vector<std::string>& arguments = cluster::state().arguments;
    std::string argv0 = arguments.empty() ? std::string("node") : arguments.front();
    if (const auto slash = argv0.find_last_of('/'); slash != std::string::npos) argv0 = argv0.substr(slash + 1);
    message += "\n(Use `" + argv0 + (deprecation ? " --trace-deprecation" : " --trace-warnings") +
               " ...` to show where the warning was created)";
    trace_hint_shown = true;
  }
  message += "\n";
  std::fwrite(message.data(), 1, message.size(), ::stderr);
  std::fflush(::stderr);
}

/**
 * `process.emitWarning(warning[, type[, code]])` and
 * `process.emitWarning(warning[, options])`: a string warning is an Error
 * named `type` (default `Warning`) whose message it is; an Error-like object
 * is used as it is, with its own `name`, `message`, `code` and `detail`.
 */
inline void emit_warning_values(const std::vector<gea::Value>& arguments) {
  const gea::Value warning = arguments.empty() ? gea::Value() : arguments[0];
  const gea::Value second = arguments.size() > 1 ? arguments[1] : gea::Value();
  std::string type = "Warning";
  std::string code;
  std::string detail;
  if (second.tag() == gea::Value::Tag::Object) {
    if (const std::string stated = warning_string_property(second, "type"); !stated.empty()) type = stated;
    code = warning_string_property(second, "code");
    detail = warning_string_property(second, "detail");
  } else if (second.tag() == gea::Value::Tag::String) {
    type = gea::dynamicToString(second);
    if (arguments.size() > 2 && arguments[2].tag() == gea::Value::Tag::String) code = gea::dynamicToString(arguments[2]);
  }
  std::string name = type;
  std::string message;
  if (warning.tag() == gea::Value::Tag::String) {
    message = gea::dynamicToString(warning);
  } else if (warning.tag() == gea::Value::Tag::Object) {
    const gea::Value stated = warning.getProperty(gea::PropertyKey::string("name"), warning);
    name = stated.tag() == gea::Value::Tag::Undefined ? std::string("Error") : gea::dynamicToString(stated);
    const gea::Value text = warning.getProperty(gea::PropertyKey::string("message"), warning);
    message = text.tag() == gea::Value::Tag::Undefined ? std::string() : gea::dynamicToString(text);
    code = warning_string_property(warning, "code");
    detail = warning_string_property(warning, "detail");
  } else {
    gea::host::throwRuntimeError("TypeError", "The \"warning\" argument must be of type string or an instance of Error");
  }
  // Error.prototype.toString (ECMA-262 20.5.3.4).
  const std::string text = name.empty() ? message : message.empty() ? name : name + ": " + message;
  const bool deprecation = name == "DeprecationWarning";
  queue_next_tick([text, code, detail, deprecation] { write_warning(text, code, detail, deprecation); });
}

template <typename... Arguments>
inline void emit_warning(const Arguments&... arguments) {
  emit_warning_values(std::vector<gea::Value>{next_tick_value(arguments)...});
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
// A listener held as the `void(double)` exit callback, sharing the caller's
// function identity so `remove_listener` finds what `on` added. One declared
// with no parameter ignores the exit code; an absent one (on-exit-leak-free's
// `functions[event]`, a table read) is Node's ERR_INVALID_ARG_TYPE.
template <typename Listener>
inline gea::CallableObject<void(double)> exit_listener_of(const Listener& listener) {
  if constexpr (gea::is_optional_v<Listener>) {
    if (!listener.has_value()) gea::host::throwRuntimeError("TypeError", "The \"listener\" argument must be of type function");
    return exit_listener_of(*listener);
  } else if constexpr (std::is_same_v<std::decay_t<decltype(listener.identified())>, gea::CallableObject<void(double)>>) {
    return listener.identified();
  } else {
    using Source = std::decay_t<decltype(listener.identified())>;
    return gea::CallableObject<void(double)>::adaptSource(listener.identified(), [](void* environment, double code) {
      const auto& source = *static_cast<const Source*>(environment);
      if constexpr (std::is_invocable_v<const Source&, double>) {
        source(code);
      } else {
        source();
      }
    });
  }
}

template <typename Listener>
inline Process on(const std::string& event, const Listener& listener) {
  if (event != "exit") throw gea::Value::box(gea::Value::Tag::String, "process event is not implemented");
  exit_listeners().emplace_back(exit_listener_of(listener));
  return process;
}

template <typename Listener>
inline Process remove_listener(const std::string& event, const Listener& listener) {
  if (event != "exit") throw gea::Value::box(gea::Value::Tag::String, "process event is not implemented");
  const gea::CallableObject<void(double)> held = exit_listener_of(listener);
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
double __gea_node_set_timeout(std::function<void()> callback, double delayMs);
void __gea_node_timer_unref(double id);

namespace gea::node {

/**
 * Node installs a default `Error.prepareStackTrace` (Node 21 on), which formats
 * an error and its call sites. This target records no frames, so the default
 * formats the header alone -- the text `Error.captureStackTrace` installs.
 */
inline gea::Value default_prepare_stack_trace() {
  return gea::Value::box(
      gea::Value::Tag::Function,
      gea::CallableObject<gea::Value(gea::Value, gea::Value)>(
          +[](void *, gea::Value error, gea::Value) -> gea::Value {
            return gea::Value::box(gea::Value::Tag::String, gea::host::ErrorConstructor::stackHeaderOf(error));
          },
          nullptr));
}

inline int run_compiled_program(int argc, char **argv, void (*entry)()) {
  set_process_arguments(argc, argv);
  gea::host::ErrorConstructor::prepareStackTrace = default_prepare_stack_trace();
  // `Atomics.waitAsync`'s timeout fires through the reactor's own timers,
  // unreferenced: as in Node, a pending waitAsync keeps no process alive.
  gea::runtime::atomics::asyncTimeoutScheduler() = +[](std::function<void()> callback, double delayMs) {
    ::__gea_node_timer_unref(::__gea_node_set_timeout(std::move(callback), delayMs));
  };
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
  // An exception nothing catches ends the process the way Node's does: the
  // error is reported on stderr, `exit` listeners run with code 1, and the
  // process exits 1 -- never `std::terminate`'s abort.
  try {
    entry();
    drain_microtasks();
    ::__gea_node_run_pending();
    drain_microtasks();
  } catch (const gea::Value& thrown) {
    std::fflush(stdout);
    std::string text;
    try {
      text = gea::host::detail::toString(thrown);
    } catch (...) {
      text = "uncaught exception";
    }
    std::fprintf(stderr, "%s\n", text.c_str());
    process::exit(1);
  }
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

// SPDX-License-Identifier: Apache-2.0
#pragma once

// `gea_node_platform.hpp` on Linux and macOS: the BSD socket API, poll(2), a
// pipe as the wake channel, pthreads, posix_spawn + waitpid with a SIGCHLD
// self-pipe, and the kernel's random source. These are the calls the reactor
// made directly before the interface existed, unchanged.

#include <cerrno>
#include <climits>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <string>
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
#include <pthread.h>
#include <signal.h>
#include <spawn.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#if defined(__APPLE__)
#include <crt_externs.h>
#include <mach-o/dyld.h>
#include <sys/mman.h>
#endif
#include <unistd.h>
#ifdef __linux__
#include <sys/random.h>
#endif

extern char **environ;

namespace gea::node::platform {

using Fd = int;
inline constexpr Fd kInvalidFd = -1;
inline bool valid(Fd fd) noexcept { return fd >= 0; }
using ssize = ::ssize_t;

// ---- process start ---------------------------------------------------------

inline void startProcess() { std::setvbuf(stdout, nullptr, _IOLBF, 0); }

// A write to a socket the peer closed raises SIGPIPE, whose default action
// kills the process; every socket path ignores it before its first socket.
inline void ensureSockets() { ::signal(SIGPIPE, SIG_IGN); }

// ---- sockets ---------------------------------------------------------------

inline Fd openSocket(int family, int type, int protocol) { return ::socket(family, type, protocol); }
inline void closeSocket(Fd fd) { ::close(fd); }

inline void setNonBlocking(Fd fd) {
  const int flags = ::fcntl(fd, F_GETFL, 0);
  if (flags >= 0) (void)::fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

inline int bindSocket(Fd fd, const sockaddr *address, socklen_t length) { return ::bind(fd, address, length); }
inline int listenSocket(Fd fd, int backlog) { return ::listen(fd, backlog); }
inline int connectSocket(Fd fd, const sockaddr *address, socklen_t length) { return ::connect(fd, address, length); }
inline Fd acceptSocket(Fd fd, sockaddr *address, socklen_t *length) { return ::accept(fd, address, length); }

inline ssize sendBytes(Fd fd, const void *data, std::size_t size) {
#ifdef MSG_NOSIGNAL
  return ::send(fd, data, size, MSG_NOSIGNAL);
#else
  return ::send(fd, data, size, 0);
#endif
}

inline ssize recvBytes(Fd fd, void *data, std::size_t size) { return ::recv(fd, data, size, 0); }

inline void shutdownWrite(Fd fd) { (void)::shutdown(fd, SHUT_WR); }

inline void setIntOption(Fd fd, int level, int name, int value) {
  (void)::setsockopt(fd, level, name, &value, sizeof(value));
}

// SO_ERROR. False when the option itself could not be read (errno says why).
inline bool readSocketError(Fd fd, int &error) {
  socklen_t length = sizeof(error);
  return ::getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) == 0;
}

// Close with RST instead of FIN (node's `resetAndDestroy`).
inline void setLingerReset(Fd fd) {
  linger reset{1, 0};
  (void)::setsockopt(fd, SOL_SOCKET, SO_LINGER, &reset, sizeof(reset));
}

inline void setKeepAlive(Fd fd, bool enabled, int initialDelayMs) {
  setIntOption(fd, SOL_SOCKET, SO_KEEPALIVE, enabled ? 1 : 0);
  if (!enabled || initialDelayMs <= 0) return;
  const int seconds = initialDelayMs / 1000 > 1 ? initialDelayMs / 1000 : 1;
#if defined(__APPLE__) && defined(TCP_KEEPALIVE)
  setIntOption(fd, IPPROTO_TCP, TCP_KEEPALIVE, seconds);
#elif defined(TCP_KEEPIDLE)
  setIntOption(fd, IPPROTO_TCP, TCP_KEEPIDLE, seconds);
#else
  (void)seconds;
#endif
}

// A listening socket: rebinding a port in TIME_WAIT always, and with
// `sharePort` the kernel's SO_REUSEPORT distribution across processes (the
// cluster deployment shape).
inline void configureListener(Fd fd, bool sharePort) {
  setIntOption(fd, SOL_SOCKET, SO_REUSEADDR, 1);
#if defined(SO_REUSEPORT)
  if (sharePort) setIntOption(fd, SOL_SOCKET, SO_REUSEPORT, 1);
#else
  (void)sharePort;
#endif
}

// Only Windows cluster workers share the primary's listener; here every
// process binds its own (SO_REUSEPORT lets the kernel distribute a cluster's
// connections), so the caller always does.
inline bool sharedClusterListener(const sockaddr *, socklen_t, int, bool, Fd &) { return false; }

// Every connected stream socket the reactor owns. macOS has no MSG_NOSIGNAL,
// so the socket itself is told not to raise SIGPIPE.
inline void configureStream(Fd fd) {
#if defined(__APPLE__) && defined(SO_NOSIGPIPE)
  if (fd >= 0) setIntOption(fd, SOL_SOCKET, SO_NOSIGPIPE, 1);
#else
  (void)fd;
#endif
}

inline int poll(pollfd *fds, std::size_t count, int timeoutMs) {
  return ::poll(fds, static_cast<nfds_t>(count), timeoutMs);
}

inline const char *errorText(int error) { return std::strerror(error); }

// The magnitude of libuv's code for a POSIX errno, which node reports negated
// as `error.errno`: on every unix libuv's codes are the negated errnos.
inline int uvErrorNumber(int error) { return error; }

// ---- wake pipes ------------------------------------------------------------

inline bool openWakePipe(Fd fds[2]) {
  if (::pipe(fds) != 0) return false;
  for (int index = 0; index < 2; ++index) {
    (void)::fcntl(fds[index], F_SETFL, ::fcntl(fds[index], F_GETFL) | O_NONBLOCK);
    (void)::fcntl(fds[index], F_SETFD, FD_CLOEXEC);
  }
  return true;
}

inline ssize wakeRead(Fd fd, void *data, std::size_t size) { return ::read(fd, data, size); }

// Async-signal-safe: one byte, errno preserved.
inline void wakeWrite(Fd fd) {
  if (fd < 0) return;
  const int saved = errno;
  const char byte = 1;
  while (::write(fd, &byte, 1) < 0 && errno == EINTR) {
  }
  errno = saved;
}

inline void closeWake(Fd fd) {
  if (fd >= 0) ::close(fd);
}

// ---- threads ---------------------------------------------------------------

// A detached thread running `Entry(argument)`. pthread rather than std::thread
// so a failed start is a return value, not an exception, and so nothing is
// allocated through `operator new` for the thread itself.
template <void (*Entry)(void *)>
inline bool startThread(void *argument) {
  struct Trampoline {
    static void *run(void *value) {
      Entry(value);
      return nullptr;
    }
  };
  pthread_t thread;
  if (::pthread_create(&thread, nullptr, &Trampoline::run, argument) != 0) return false;
  ::pthread_detach(thread);
  return true;
}

// ---- clocks ----------------------------------------------------------------

inline void utcTime(std::time_t seconds, std::tm &out) { ::gmtime_r(&seconds, &out); }

// ---- files -----------------------------------------------------------------

inline bool canAccess(const std::string &path, int mode) { return ::access(path.c_str(), mode) == 0; }

inline double fileTimeMs(const struct timespec &time) {
  return static_cast<double>(time.tv_sec) * 1000.0 + static_cast<double>(time.tv_nsec) / 1000000.0;
}

inline int statFile(const std::string &path, bool followSymlinks, FileStatus &out) {
  struct stat st;
  const int rc = followSymlinks ? ::stat(path.c_str(), &st) : ::lstat(path.c_str(), &st);
  if (rc != 0) return uvErrorNumber(errno);
  const auto widen = [](auto value) { return static_cast<double>(static_cast<std::uint64_t>(value)); };
  out.dev = widen(st.st_dev);
  out.ino = widen(st.st_ino);
  out.mode = widen(st.st_mode);
  out.nlink = widen(st.st_nlink);
  out.uid = widen(st.st_uid);
  out.gid = widen(st.st_gid);
  out.rdev = widen(st.st_rdev);
  out.size = widen(st.st_size);
  out.blksize = widen(st.st_blksize);
  out.blocks = widen(st.st_blocks);
#if defined(__APPLE__)
  out.atimeMs = fileTimeMs(st.st_atimespec);
  out.mtimeMs = fileTimeMs(st.st_mtimespec);
  out.ctimeMs = fileTimeMs(st.st_ctimespec);
  out.birthtimeMs = fileTimeMs(st.st_birthtimespec);
#else
  out.atimeMs = fileTimeMs(st.st_atim);
  out.mtimeMs = fileTimeMs(st.st_mtim);
  out.ctimeMs = fileTimeMs(st.st_ctim);
  out.birthtimeMs = out.ctimeMs;
#if defined(__linux__) && defined(STATX_BTIME)
  struct statx stx;
  const int flags = followSymlinks ? 0 : AT_SYMLINK_NOFOLLOW;
  if (::statx(AT_FDCWD, path.c_str(), flags, STATX_BTIME, &stx) == 0 && (stx.stx_mask & STATX_BTIME) != 0) {
    out.birthtimeMs = static_cast<double>(stx.stx_btime.tv_sec) * 1000.0 + static_cast<double>(stx.stx_btime.tv_nsec) / 1000000.0;
  }
#endif
#endif
  return 0;
}

inline bool readWholeFile(const std::string &path, std::vector<std::uint8_t> &out, std::string &failure) {
  const int fd = ::open(path.c_str(), O_RDONLY);
  if (fd < 0) {
    failure = std::string("open '") + path + "': " + std::strerror(errno);
    return false;
  }
  // Read until EOF rather than relying on st_size: /proc metadata files report
  // zero length, and a database driver's handshake reads that metadata on Linux.
  std::uint8_t bytes[65536];
  for (;;) {
    const ssize_t count = ::read(fd, bytes, sizeof(bytes));
    if (count > 0) out.insert(out.end(), bytes, bytes + count);
    else if (count == 0) break;
    else if (errno != EINTR) {
      const int error = errno;
      ::close(fd);
      failure = std::string("read '") + path + "': " + std::strerror(error);
      return false;
    }
  }
  ::close(fd);
  return true;
}

inline bool fillRandom(std::uint8_t *data, std::size_t size) {
  std::size_t offset = 0;
#ifdef __linux__
  while (offset < size) {
    const ssize_t count = ::getrandom(data + offset, size - offset, 0);
    if (count > 0) {
      offset += static_cast<std::size_t>(count);
      continue;
    }
    if (count < 0 && errno == EINTR) continue;
    break;
  }
#elif defined(__APPLE__)
  ::arc4random_buf(data, size);
  offset = size;
#endif
  // Portable fallback for hosts without getrandom/arc4random, or for a short
  // kernel read. /dev/urandom is the same OS CSPRNG Node ultimately relies on.
  if (offset < size) {
    const int fd = ::open("/dev/urandom", O_RDONLY);
    if (fd >= 0) {
      while (offset < size) {
        const ssize_t count = ::read(fd, data + offset, size - offset);
        if (count > 0) offset += static_cast<std::size_t>(count);
        else if (count < 0 && errno == EINTR) continue;
        else break;
      }
      ::close(fd);
    }
  }
  return offset == size;
}

// ---- process ---------------------------------------------------------------

inline std::vector<std::string> arguments(int argc, char **argv) {
  std::vector<std::string> result;
  for (int index = 0; index < argc; ++index) result.emplace_back(argv[index]);
  return result;
}

// The environment as `KEY=value` entries.
inline std::vector<std::string> environmentEntries() {
#ifdef __APPLE__
  char **entries = *_NSGetEnviron();
#else
  char **entries = environ;
#endif
  std::vector<std::string> result;
  for (char **entry = entries; entry && *entry; ++entry) result.emplace_back(*entry);
  return result;
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

// The absolute, symlink-resolved spelling of `path`, or `path` itself.
inline std::string canonicalPath(const std::string &path) {
  char resolved[PATH_MAX];
  if (::realpath(path.c_str(), resolved) != nullptr) return std::string(resolved);
  return path;
}

inline bool currentDirectory(std::string &out, int &error) {
  char path[PATH_MAX];
  if (::getcwd(path, sizeof(path)) == nullptr) {
    error = errno;
    return false;
  }
  out = path;
  return true;
}

inline double processId() { return static_cast<double>(::getpid()); }
inline double parentProcessId() { return static_cast<double>(::getppid()); }

[[noreturn]] inline void exitImmediately(int status) { ::_exit(status); }

inline int onlineProcessors() {
  const long count = ::sysconf(_SC_NPROCESSORS_ONLN);
  return count > 0 ? static_cast<int>(count) : 1;
}

inline struct utsname unameOf() {
  struct utsname value {};
  (void)::uname(&value);
  return value;
}

inline std::string machineArch() {
  const std::string machine = unameOf().machine;
  if (machine == "aarch64" || machine == "arm64") return "arm64";
  if (machine == "x86_64" || machine == "amd64") return "x64";
  return machine;
}

inline std::string kernelRelease() { return unameOf().release; }

inline std::string systemName() { return unameOf().sysname; }

// GEA_WORKERS=N: fork N-1 copies of this process; true in the parent.
inline bool forkWorkers(int &workers) {
  bool isParent = true;
  if (workers > 1) {
    ::signal(SIGCHLD, SIG_IGN);  // auto-reap workers that exit
    for (int i = 1; i < workers && isParent; ++i) {
      const pid_t pid = ::fork();
      if (pid == 0) isParent = false;
      else if (pid < 0) std::fprintf(stderr, "gea-node: fork failed for worker %d: %s\n", i, std::strerror(errno));
    }
  }
  return isParent;
}

// ---- diagnostics -----------------------------------------------------------

inline int captureStack(void **frames, int count) { return ::backtrace(frames, count); }

inline std::uintptr_t imageBaseOf(const void *address) {
  Dl_info info{};
  if (::dladdr(address, &info) && info.dli_fbase) return reinterpret_cast<std::uintptr_t>(info.dli_fbase);
  return 0;
}

// Run `handler` (which must end the process) on SIGTERM and SIGINT.
inline void onTermination(void (*handler)(int)) {
  ::signal(SIGTERM, handler);
  ::signal(SIGINT, handler);
}

// ---- memory ----------------------------------------------------------------

// `size` bytes aligned to `size`, carved out of memory the system allocator
// has never owned on macOS (see `registerPoolZone` in gea_node.cpp).
inline void *reserveAlignedChunk(std::size_t size) {
#ifdef __APPLE__
  void *raw = ::mmap(nullptr, size * 2, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  if (raw == MAP_FAILED) return nullptr;
  const std::uintptr_t start = reinterpret_cast<std::uintptr_t>(raw);
  const std::uintptr_t aligned = (start + size - 1) & ~(size - 1);
  if (aligned > start) ::munmap(raw, aligned - start);
  const std::uintptr_t tail = aligned + size;
  if (tail < start + size * 2) ::munmap(reinterpret_cast<void *>(tail), start + size * 2 - tail);
  return reinterpret_cast<void *>(aligned);
#else
  void *chunk = nullptr;
  if (posix_memalign(&chunk, size, size) != 0) return nullptr;
  return chunk;
#endif
}

inline void releaseAlignedChunk(void *chunk, std::size_t size) {
#ifdef __APPLE__
  ::munmap(chunk, size);
#else
  (void)size;
  std::free(chunk);
#endif
}

// ---- child processes (node:cluster) ----------------------------------------

inline Fd &childExitWriteFd() {
  static Fd fd = kInvalidFd;
  return fd;
}

// Async-signal-safe: one byte into the self-pipe, nothing else.
inline void onChildSignal(int) { wakeWrite(childExitWriteFd()); }

// A descriptor that turns readable whenever a child may have exited.
inline bool installChildExitNotifier(Fd &readFd, std::string &error) {
  Fd fds[2] = {kInvalidFd, kInvalidFd};
  if (!openWakePipe(fds)) {
    error = std::strerror(errno);
    return false;
  }
  readFd = fds[0];
  childExitWriteFd() = fds[1];
  struct sigaction action {};
  action.sa_handler = &onChildSignal;
  sigemptyset(&action.sa_mask);  // a macro on macOS, so no `::`
  action.sa_flags = SA_RESTART | SA_NOCLDSTOP;
  (void)::sigaction(SIGCHLD, &action, nullptr);
  return true;
}

inline void drainChildExitNotifier(Fd readFd) {
  char buffer[64];
  while (::read(readFd, buffer, sizeof buffer) > 0) {
  }
}

// Every child that has exited, as `onExit(pid, code, signal)`: `code` is -1
// when a signal ended it, `signal` 0 when it exited on its own.
template <typename OnExit>
inline void reapExitedChildren(OnExit &&onExit) {
  while (true) {
    int status = 0;
    const pid_t pid = ::waitpid(-1, &status, WNOHANG);
    if (pid <= 0) break;
    if (WIFEXITED(status)) onExit(static_cast<double>(pid), static_cast<double>(WEXITSTATUS(status)), 0);
    else if (WIFSIGNALED(status)) onExit(static_cast<double>(pid), -1.0, WTERMSIG(status));
    else onExit(static_cast<double>(pid), -1.0, 0);
  }
}

// Start `executable` with `args` (argv, argv[0] included) and `env`
// (`KEY=value`); the pid, or 0 with `error` set.
inline double spawnChild(const std::string &executable, std::vector<std::string> args, std::vector<std::string> env,
                         std::string &error) {
  std::vector<char *> envp;
  envp.reserve(env.size() + 1);
  for (std::string &entry : env) envp.push_back(entry.data());
  envp.push_back(nullptr);
  std::vector<char *> argv;
  argv.reserve(args.size() + 1);
  for (std::string &arg : args) argv.push_back(arg.data());
  argv.push_back(nullptr);
  pid_t pid = 0;
  const int rc = ::posix_spawn(&pid, executable.c_str(), nullptr, nullptr, argv.data(), envp.data());
  if (rc != 0) {
    error = std::strerror(rc);
    return 0;
  }
  return static_cast<double>(pid);
}

inline bool signalProcess(double pid, int signal) { return ::kill(static_cast<pid_t>(pid), signal) == 0; }

// The primary's half of the cluster liveness channel: a pipe whose ONLY write
// end is the primary's (CLOEXEC keeps it out of every worker) and whose read
// end every worker inherits. `childValue` is what a worker is told to watch.
inline bool createLivenessChannel(std::string &childValue, std::string &error) {
  static Fd readEnd = kInvalidFd;
  if (readEnd < 0) {
    int fds[2] = {-1, -1};
    if (::pipe(fds) != 0) {
      error = std::strerror(errno);
      return false;
    }
    readEnd = fds[0];
    (void)::fcntl(fds[1], F_SETFD, FD_CLOEXEC);
  }
  childValue = std::to_string(readEnd);
  return true;
}

// The worker's half: a descriptor that reads EOF once the primary is gone.
inline Fd openLivenessChannel(const char *value) {
  const int fd = std::atoi(value);
  if (fd < 0) return kInvalidFd;
  setNonBlocking(fd);
  return fd;
}

}  // namespace gea::node::platform

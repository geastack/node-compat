// SPDX-License-Identifier: Apache-2.0
#pragma once

// `gea_node_platform.hpp` on Windows.
//
// The reactor stays a readiness loop, exactly as on Linux and macOS: Winsock
// sockets in non-blocking mode, polled level-triggered with WSAPoll. Anything
// that is not a socket and still has to wake the loop -- a finished DNS
// lookup, a cluster worker's exit, a cluster primary's death -- is turned into
// a socket event: the helper thread (or the thread pool's wait callback)
// writes one byte to, or closes, the write end of a loopback socket pair whose
// read end the loop watches. That keeps one wait primitive for everything,
// and no helper thread ever touches a runtime object or allocates through
// `operator new` (the pool allocator's free lists belong to the loop thread).
//
// Errors cross this boundary as POSIX `errno` values (the UCRT defines the
// socket ones, EWOULDBLOCK..., beside the classic ones), so the reactor's
// `errno == EAGAIN` / `ECONNREFUSED` tests read the same on every platform.
// Text crosses as UTF-8 and is converted to UTF-16 only where a Win32 call
// takes it.

#include "gea_node_windows.hpp"

#include <algorithm>
#include <cerrno>
#include <climits>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <cwchar>
#include <string>
#include <vector>

// libuv's numbering for the signals the UCRT does not define, so cluster
// signal names and numbers agree with node on Windows.
#ifndef SIGHUP
#define SIGHUP 1
#endif
#ifndef SIGQUIT
#define SIGQUIT 3
#endif
#ifndef SIGKILL
#define SIGKILL 9
#endif
#ifndef SIGUSR1
#define SIGUSR1 10
#endif
#ifndef SIGUSR2
#define SIGUSR2 12
#endif
#ifndef SIGPIPE
#define SIGPIPE 13
#endif
#ifndef SIGALRM
#define SIGALRM 14
#endif
#ifndef SIGCONT
#define SIGCONT 18
#endif
#ifndef SIGSTOP
#define SIGSTOP 19
#endif

namespace gea::node::platform {

using Fd = SOCKET;
inline constexpr Fd kInvalidFd = INVALID_SOCKET;
inline bool valid(Fd fd) noexcept { return fd != INVALID_SOCKET; }
using ssize = std::ptrdiff_t;

// ---- text ------------------------------------------------------------------

inline std::wstring wide(const std::string &text) {
  if (text.empty()) return std::wstring();
  const int length = ::MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0);
  std::wstring result(static_cast<std::size_t>(length > 0 ? length : 0), L'\0');
  if (length > 0) ::MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), result.data(), length);
  return result;
}

inline std::string narrow(const wchar_t *text, std::size_t size) {
  if (size == 0) return std::string();
  const int length = ::WideCharToMultiByte(CP_UTF8, 0, text, static_cast<int>(size), nullptr, 0, nullptr, nullptr);
  std::string result(static_cast<std::size_t>(length > 0 ? length : 0), '\0');
  if (length > 0) ::WideCharToMultiByte(CP_UTF8, 0, text, static_cast<int>(size), result.data(), length, nullptr, nullptr);
  return result;
}

inline std::string narrow(const std::wstring &text) { return narrow(text.data(), text.size()); }

// ---- errors ----------------------------------------------------------------

inline int errnoFromWinsock(int error) {
  switch (error) {
    case 0: return 0;
    case WSAEWOULDBLOCK: return EAGAIN;
    case WSAEINPROGRESS: return EINPROGRESS;
    case WSAEALREADY: return EALREADY;
    case WSAENOTSOCK: return ENOTSOCK;
    case WSAEDESTADDRREQ: return EDESTADDRREQ;
    case WSAEMSGSIZE: return EMSGSIZE;
    case WSAEPROTOTYPE: return EPROTOTYPE;
    case WSAENOPROTOOPT: return ENOPROTOOPT;
    case WSAEPROTONOSUPPORT:
    case WSAESOCKTNOSUPPORT: return EPROTONOSUPPORT;
    case WSAEOPNOTSUPP: return EOPNOTSUPP;
    case WSAEPFNOSUPPORT:
    case WSAEAFNOSUPPORT: return EAFNOSUPPORT;
    case WSAEADDRINUSE: return EADDRINUSE;
    case WSAEADDRNOTAVAIL: return EADDRNOTAVAIL;
    case WSAENETDOWN: return ENETDOWN;
    case WSAENETUNREACH: return ENETUNREACH;
    case WSAENETRESET: return ENETRESET;
    case WSAECONNABORTED: return ECONNABORTED;
    case WSAECONNRESET: return ECONNRESET;
    case WSAENOBUFS: return ENOBUFS;
    case WSAEISCONN: return EISCONN;
    case WSAENOTCONN: return ENOTCONN;
    case WSAESHUTDOWN: return EPIPE;
    case WSAETIMEDOUT: return ETIMEDOUT;
    case WSAECONNREFUSED: return ECONNREFUSED;
    case WSAEHOSTDOWN:
    case WSAEHOSTUNREACH: return EHOSTUNREACH;
    case WSAEMFILE: return EMFILE;
    case WSAEINVAL: return EINVAL;
    case WSAEFAULT: return EFAULT;
    case WSAEACCES: return EACCES;
    case WSAEINTR: return EINTR;
    case WSAEBADF:
    case WSA_INVALID_HANDLE: return EBADF;
    case WSAENAMETOOLONG: return ENAMETOOLONG;
    case WSA_NOT_ENOUGH_MEMORY: return ENOMEM;
    case WSAECANCELLED:
    case WSA_OPERATION_ABORTED: return ECANCELED;
    default: return EIO;
  }
}

inline int errnoFromWin32(DWORD error) {
  switch (error) {
    case ERROR_SUCCESS: return 0;
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND:
    case ERROR_INVALID_NAME:
    case ERROR_INVALID_DRIVE:
    case ERROR_BAD_NETPATH:
    case ERROR_BAD_PATHNAME:
    case ERROR_DIRECTORY:
    case ERROR_MOD_NOT_FOUND: return ENOENT;
    case ERROR_ACCESS_DENIED:
    case ERROR_PRIVILEGE_NOT_HELD: return EACCES;
    case ERROR_SHARING_VIOLATION:
    case ERROR_LOCK_VIOLATION:
    case ERROR_BUSY: return EBUSY;
    case ERROR_TOO_MANY_OPEN_FILES: return EMFILE;
    case ERROR_FILENAME_EXCED_RANGE: return ENAMETOOLONG;
    case ERROR_NOT_ENOUGH_MEMORY:
    case ERROR_OUTOFMEMORY: return ENOMEM;
    case ERROR_ALREADY_EXISTS:
    case ERROR_FILE_EXISTS: return EEXIST;
    case ERROR_DISK_FULL:
    case ERROR_HANDLE_DISK_FULL: return ENOSPC;
    case ERROR_WRITE_PROTECT: return EROFS;
    case ERROR_INVALID_PARAMETER: return EINVAL;
    case ERROR_BROKEN_PIPE:
    case ERROR_NO_DATA: return EPIPE;
    case ERROR_INVALID_HANDLE: return EBADF;
    case ERROR_NOT_SUPPORTED: return ENOTSUP;
    default: return EIO;
  }
}

inline void setErrnoFromWinsock() { errno = errnoFromWinsock(::WSAGetLastError()); }

// The magnitude of libuv's code for a POSIX errno, which node reports
// negated as `error.errno`. On Windows libuv numbers errors itself
// (`ECONNREFUSED` is -4078), so node's errno there is not the C runtime's.
inline int uvErrorNumber(int error) {
  switch (error) {
    case EACCES: return 4092;
    case EADDRINUSE: return 4091;
    case EADDRNOTAVAIL: return 4090;
    case EAFNOSUPPORT: return 4089;
    case EAGAIN: return 4088;
    case EWOULDBLOCK: return 4088;
    case EALREADY: return 4084;
    case EBADF: return 4083;
    case EBUSY: return 4082;
    case ECANCELED: return 4081;
    case ECONNABORTED: return 4079;
    case ECONNREFUSED: return 4078;
    case ECONNRESET: return 4077;
    case ENETRESET: return 4077;
    case EDESTADDRREQ: return 4076;
    case EEXIST: return 4075;
    case EFAULT: return 4074;
    case EHOSTUNREACH: return 4073;
    case EINTR: return 4072;
    case EINVAL: return 4071;
    case EIO: return 4070;
    case EISCONN: return 4069;
    case EISDIR: return 4068;
    case EMFILE: return 4066;
    case EMSGSIZE: return 4065;
    case ENAMETOOLONG: return 4064;
    case ENETDOWN: return 4063;
    case ENETUNREACH: return 4062;
    case ENFILE: return 4061;
    case ENOBUFS: return 4060;
    case ENOENT: return 4058;
    case ENOMEM: return 4057;
    case ENOSPC: return 4055;
    case ENOTCONN: return 4053;
    case ENOTDIR: return 4052;
    case ENOTSOCK: return 4050;
    case ENOTSUP: return 4049;
    case EOPNOTSUPP: return 4049;
    case EPERM: return 4048;
    case EPIPE: return 4047;
    case EPROTO: return 4046;
    case EPROTONOSUPPORT: return 4045;
    case EPROTOTYPE: return 4044;
    case EROFS: return 4043;
    case ETIMEDOUT: return 4039;
    case ENOPROTOOPT: return 4035;
    default: return error;
  }
}

// The glibc text for each errno, so an error message reads the same as on
// Linux (the UCRT's own strerror has no text for the socket errnos).
inline const char *errorText(int error) {
  switch (error) {
    case 0: return "Success";
    case EPERM: return "Operation not permitted";
    case ENOENT: return "No such file or directory";
    case EINTR: return "Interrupted system call";
    case EIO: return "Input/output error";
    case EBADF: return "Bad file descriptor";
    case EAGAIN: return "Resource temporarily unavailable";
    case ENOMEM: return "Cannot allocate memory";
    case EACCES: return "Permission denied";
    case EFAULT: return "Bad address";
    case EBUSY: return "Device or resource busy";
    case EEXIST: return "File exists";
    case ENOTDIR: return "Not a directory";
    case EISDIR: return "Is a directory";
    case EINVAL: return "Invalid argument";
    case ENFILE: return "Too many open files in system";
    case EMFILE: return "Too many open files";
    case ENOSPC: return "No space left on device";
    case EROFS: return "Read-only file system";
    case EPIPE: return "Broken pipe";
    case ENAMETOOLONG: return "File name too long";
    case ENOTSUP: return "Operation not supported";
    case EADDRINUSE: return "Address already in use";
    case EADDRNOTAVAIL: return "Cannot assign requested address";
    case EAFNOSUPPORT: return "Address family not supported by protocol";
    case EALREADY: return "Operation already in progress";
    case ECANCELED: return "Operation canceled";
    case ECONNABORTED: return "Software caused connection abort";
    case ECONNREFUSED: return "Connection refused";
    case ECONNRESET: return "Connection reset by peer";
    case EDESTADDRREQ: return "Destination address required";
    case EHOSTUNREACH: return "No route to host";
    case EINPROGRESS: return "Operation now in progress";
    case EISCONN: return "Transport endpoint is already connected";
    case EMSGSIZE: return "Message too long";
    case ENETDOWN: return "Network is down";
    case ENETRESET: return "Network dropped connection on reset";
    case ENETUNREACH: return "Network is unreachable";
    case ENOBUFS: return "No buffer space available";
    case ENOPROTOOPT: return "Protocol not available";
    case ENOTCONN: return "Transport endpoint is not connected";
    case ENOTSOCK: return "Socket operation on non-socket";
    case EOPNOTSUPP: return "Operation not supported";
    case EPROTO: return "Protocol error";
    case EPROTONOSUPPORT: return "Protocol not supported";
    case EPROTOTYPE: return "Protocol wrong type for socket";
    case ETIMEDOUT: return "Connection timed out";
    case EWOULDBLOCK: return "Resource temporarily unavailable";
    default: {
      static thread_local char text[32];
      std::snprintf(text, sizeof(text), "Unknown error %d", error);
      return text;
    }
  }
}

// ---- process start ---------------------------------------------------------

inline void ensureSockets() {
  static const bool started = [] {
    WSADATA data;
    return ::WSAStartup(MAKEWORD(2, 2), &data) == 0;
  }();
  (void)started;
}

inline UINT &savedConsoleOutputCodePage() {
  static UINT page = 0;
  return page;
}

inline void restoreConsoleOutputCodePage() {
  if (savedConsoleOutputCodePage() != 0) ::SetConsoleOutputCP(savedConsoleOutputCodePage());
}

// stdout and stderr carry the program's bytes unchanged, as on Linux: binary
// mode (no `\n` -> `\r\n` rewriting into a pipe or file) and unbuffered, since
// the UCRT has no line buffering (`_IOLBF` is full buffering there) and a
// server's "listening" line must reach a parent that is waiting for it. A
// console is told the bytes are UTF-8 for the life of the process.
inline void startProcess() {
  ensureSockets();
  for (FILE *stream : {stdout, stderr}) {
    (void)::_setmode(::_fileno(stream), _O_BINARY);
    std::setvbuf(stream, nullptr, _IONBF, 0);
  }
  DWORD mode = 0;
  const bool console = ::GetConsoleMode(::GetStdHandle(STD_OUTPUT_HANDLE), &mode) ||
                       ::GetConsoleMode(::GetStdHandle(STD_ERROR_HANDLE), &mode);
  if (console && ::GetConsoleOutputCP() != CP_UTF8) {
    savedConsoleOutputCodePage() = ::GetConsoleOutputCP();
    ::SetConsoleOutputCP(CP_UTF8);
    std::atexit(&restoreConsoleOutputCodePage);
  }
}

// ---- sockets ---------------------------------------------------------------

// Not inherited by child processes: a cluster worker must not keep the
// primary's listener (or a wake pipe) alive.
inline Fd openSocket(int family, int type, int protocol) {
  ensureSockets();
  const SOCKET fd = ::WSASocketW(family, type, protocol, nullptr, 0, WSA_FLAG_OVERLAPPED | WSA_FLAG_NO_HANDLE_INHERIT);
  if (fd == INVALID_SOCKET) setErrnoFromWinsock();
  return fd;
}

inline void closeSocket(Fd fd) {
  if (fd != INVALID_SOCKET) ::closesocket(fd);
}

inline void setNonBlocking(Fd fd) {
  u_long enabled = 1;
  (void)::ioctlsocket(fd, FIONBIO, &enabled);
}

inline int bindSocket(Fd fd, const sockaddr *address, socklen_t length) {
  if (::bind(fd, address, length) == 0) return 0;
  setErrnoFromWinsock();
  return -1;
}

inline int listenSocket(Fd fd, int backlog) {
  if (::listen(fd, backlog) == 0) return 0;
  setErrnoFromWinsock();
  return -1;
}

inline bool isLoopback(const sockaddr *address) {
  if (address->sa_family == AF_INET)
    return (ntohl(reinterpret_cast<const sockaddr_in *>(address)->sin_addr.s_addr) >> 24) == 127;
  if (address->sa_family == AF_INET6) return IN6_IS_ADDR_LOOPBACK(&reinterpret_cast<const sockaddr_in6 *>(address)->sin6_addr);
  return false;
}

// A non-blocking connect that has started reports EINPROGRESS, as on POSIX
// (Winsock says WSAEWOULDBLOCK).
//
// Windows answers a RST to a SYN by retransmitting the SYN, so a refused
// connection to a local port takes two seconds to fail where Linux fails it at
// once. For a loopback peer that retry can never succeed, and libuv turns it
// off the same way (no SYN retransmissions), which is what node does here.
inline int connectSocket(Fd fd, const sockaddr *address, socklen_t length) {
  if (isLoopback(address)) {
    TCP_INITIAL_RTO_PARAMETERS parameters{};
    parameters.Rtt = TCP_INITIAL_RTO_UNSPECIFIED_RTT;
    parameters.MaxSynRetransmissions = TCP_INITIAL_RTO_NO_SYN_RETRANSMISSIONS;
    DWORD returned = 0;
    (void)::WSAIoctl(fd, SIO_TCP_INITIAL_RTO, &parameters, sizeof(parameters), nullptr, 0, &returned, nullptr, nullptr);
  }
  if (::connect(fd, address, length) == 0) return 0;
  const int error = ::WSAGetLastError();
  errno = error == WSAEWOULDBLOCK ? EINPROGRESS : errnoFromWinsock(error);
  return -1;
}

inline Fd acceptSocket(Fd fd, sockaddr *address, socklen_t *length) {
  const SOCKET accepted = ::accept(fd, address, length);
  if (accepted == INVALID_SOCKET) {
    setErrnoFromWinsock();
    return INVALID_SOCKET;
  }
  (void)::SetHandleInformation(reinterpret_cast<HANDLE>(accepted), HANDLE_FLAG_INHERIT, 0);
  return accepted;
}

inline ssize sendBytes(Fd fd, const void *data, std::size_t size) {
  const int count = ::send(fd, static_cast<const char *>(data), static_cast<int>(std::min<std::size_t>(size, INT_MAX)), 0);
  if (count == SOCKET_ERROR) {
    setErrnoFromWinsock();
    return -1;
  }
  return count;
}

inline ssize recvBytes(Fd fd, void *data, std::size_t size) {
  const int count = ::recv(fd, static_cast<char *>(data), static_cast<int>(std::min<std::size_t>(size, INT_MAX)), 0);
  if (count == SOCKET_ERROR) {
    setErrnoFromWinsock();
    return -1;
  }
  return count;
}

inline void shutdownWrite(Fd fd) { (void)::shutdown(fd, SD_SEND); }

inline void setIntOption(Fd fd, int level, int name, int value) {
  (void)::setsockopt(fd, level, name, reinterpret_cast<const char *>(&value), sizeof(value));
}

inline bool readSocketError(Fd fd, int &error) {
  int raw = 0;
  int length = sizeof(raw);
  if (::getsockopt(fd, SOL_SOCKET, SO_ERROR, reinterpret_cast<char *>(&raw), &length) != 0) {
    setErrnoFromWinsock();
    return false;
  }
  error = errnoFromWinsock(raw);
  return true;
}

inline void setLingerReset(Fd fd) {
  linger reset{};
  reset.l_onoff = 1;
  reset.l_linger = 0;
  (void)::setsockopt(fd, SOL_SOCKET, SO_LINGER, reinterpret_cast<const char *>(&reset), sizeof(reset));
}

inline void setKeepAlive(Fd fd, bool enabled, int initialDelayMs) {
  setIntOption(fd, SOL_SOCKET, SO_KEEPALIVE, enabled ? 1 : 0);
  if (!enabled || initialDelayMs <= 0) return;
  const int seconds = initialDelayMs / 1000 > 1 ? initialDelayMs / 1000 : 1;
#ifdef TCP_KEEPIDLE
  setIntOption(fd, IPPROTO_TCP, TCP_KEEPIDLE, seconds);
#else
  (void)seconds;
#endif
}

// Windows rebinds a port in TIME_WAIT without being asked, and its
// SO_REUSEADDR means something else entirely: any later socket may bind -- and
// steal -- a port that is already listening. So a listener never sets it; a
// second server on the same port fails with EADDRINUSE exactly as on Linux.
// Cluster workers do not bind at all: they share the primary's listener
// (`sharedClusterListener`), which is node's own Windows design.
inline void configureListener(Fd, bool) {}

inline void configureStream(Fd) {}

// poll(2) over WSAPoll, with the two places WSAPoll differs from it ironed
// out here rather than in the reactor:
//  - WSAPoll rejects an empty set. With no socket to wait on the wait is a
//    plain sleep (the loop only asks when a timer is pending).
//  - WSAPoll reports POLLHUP as soon as the peer has shut down its side
//    (FIN), where Linux reports a readable end-of-file and saves POLLHUP for a
//    connection closed both ways. A watcher reading the socket gets POLLIN, so
//    its recv() sees the EOF and closes exactly as it would on Linux; one that
//    is not reading (paused) is not told, as on Linux. An entry that asks for
//    nothing is left out, or its standing POLLHUP would wake every pass.
inline int poll(pollfd *fds, std::size_t count, int timeoutMs) {
  static std::vector<WSAPOLLFD> active;
  static std::vector<std::size_t> origin;
  active.clear();
  origin.clear();
  for (std::size_t index = 0; index < count; ++index) {
    fds[index].revents = 0;
    if (fds[index].events == 0) continue;
    WSAPOLLFD entry{};
    entry.fd = fds[index].fd;
    entry.events = fds[index].events;
    active.push_back(entry);
    origin.push_back(index);
  }
  if (active.empty()) {
    ::Sleep(timeoutMs < 0 ? INFINITE : static_cast<DWORD>(timeoutMs));
    return 0;
  }
  const int result = ::WSAPoll(active.data(), static_cast<ULONG>(active.size()), timeoutMs);
  if (result == SOCKET_ERROR) {
    setErrnoFromWinsock();
    return -1;
  }
  int ready = 0;
  for (std::size_t slot = 0; slot < active.size(); ++slot) {
    short revents = active[slot].revents;
    const short wanted = active[slot].events;
    if ((revents & POLLHUP) != 0 && (revents & POLLERR) == 0) {
      revents = static_cast<short>(revents & ~POLLHUP);
      if (wanted & POLLIN) revents = static_cast<short>(revents | POLLRDNORM);
    } else if ((revents & POLLERR) != 0 && (wanted & POLLIN) != 0) {
      // A reset: Linux reports it readable too, and the read names the error.
      revents = static_cast<short>(revents | POLLRDNORM);
    }
    fds[origin[slot]].revents = revents;
    if (revents != 0) ++ready;
  }
  return ready;
}

// ---- wake pipes ------------------------------------------------------------

// A connected loopback TCP pair: [0] the end the loop reads, [1] the end
// another thread writes (or closes). Windows has no anonymous pipe WSAPoll can
// wait on, and a socket pair is what every Windows event loop uses for this.
inline bool openWakePipe(Fd fds[2]) {
  fds[0] = fds[1] = INVALID_SOCKET;
  const Fd listener = openSocket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (listener == INVALID_SOCKET) return false;
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = 0;
  int length = sizeof(address);
  Fd writer = INVALID_SOCKET;
  Fd reader = INVALID_SOCKET;
  bool ok = ::bind(listener, reinterpret_cast<const sockaddr *>(&address), sizeof(address)) == 0 &&
            ::listen(listener, 1) == 0 &&
            ::getsockname(listener, reinterpret_cast<sockaddr *>(&address), &length) == 0;
  if (ok) {
    writer = openSocket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    ok = writer != INVALID_SOCKET && ::connect(writer, reinterpret_cast<const sockaddr *>(&address), sizeof(address)) == 0;
  }
  if (ok) {
    sockaddr_in peer{};
    int peerLength = sizeof(peer);
    reader = acceptSocket(listener, reinterpret_cast<sockaddr *>(&peer), &peerLength);
    // Make sure the accepted connection is our own writer and not a stranger
    // that raced it to the ephemeral port.
    sockaddr_in local{};
    int localLength = sizeof(local);
    ok = reader != INVALID_SOCKET && ::getsockname(writer, reinterpret_cast<sockaddr *>(&local), &localLength) == 0 &&
         local.sin_port == peer.sin_port && local.sin_addr.s_addr == peer.sin_addr.s_addr;
  }
  if (!ok) setErrnoFromWinsock();
  ::closesocket(listener);
  if (!ok) {
    closeSocket(reader);
    closeSocket(writer);
    return false;
  }
  setIntOption(writer, IPPROTO_TCP, TCP_NODELAY, 1);
  setNonBlocking(reader);
  setNonBlocking(writer);
  fds[0] = reader;
  fds[1] = writer;
  return true;
}

inline ssize wakeRead(Fd fd, void *data, std::size_t size) { return recvBytes(fd, data, size); }

// Callable from any thread: one byte, and the caller's error state untouched.
inline void wakeWrite(Fd fd) {
  if (fd == INVALID_SOCKET) return;
  const int savedErrno = errno;
  const int savedWinsock = ::WSAGetLastError();
  const char byte = 1;
  (void)::send(fd, &byte, 1, 0);
  ::WSASetLastError(savedWinsock);
  errno = savedErrno;
}

inline void closeWake(Fd fd) { closeSocket(fd); }

// ---- threads ---------------------------------------------------------------

template <void (*Entry)(void *)>
inline bool startThread(void *argument) {
  struct Trampoline {
    static unsigned __stdcall run(void *value) {
      Entry(value);
      return 0;
    }
  };
  const std::uintptr_t handle = ::_beginthreadex(nullptr, 0, &Trampoline::run, argument, 0, nullptr);
  if (handle == 0) return false;
  ::CloseHandle(reinterpret_cast<HANDLE>(handle));
  return true;
}

// ---- clocks ----------------------------------------------------------------

inline void utcTime(std::time_t seconds, std::tm &out) { (void)::gmtime_s(&out, &seconds); }

// ---- files -----------------------------------------------------------------

// libuv's access(2) on Windows: the file must exist; W_OK fails on a
// read-only file (not on a directory, whose read-only bit means something
// else); R_OK and X_OK ask nothing more.
inline bool canAccess(const std::string &path, int mode) {
  const DWORD attributes = ::GetFileAttributesW(wide(path).c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES) return false;
  if ((mode & 2) != 0 && (attributes & FILE_ATTRIBUTE_READONLY) != 0 && (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0)
    return false;
  return true;
}

inline bool readWholeFile(const std::string &path, std::vector<std::uint8_t> &out, std::string &failure) {
  const std::wstring name = wide(path);
  const DWORD attributes = ::GetFileAttributesW(name.c_str());
  if (attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
    // Linux opens a directory and then fails to read it.
    failure = std::string("read '") + path + "': " + errorText(EISDIR);
    return false;
  }
  const HANDLE file = ::CreateFileW(name.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                    nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) {
    failure = std::string("open '") + path + "': " + errorText(errnoFromWin32(::GetLastError()));
    return false;
  }
  std::uint8_t bytes[65536];
  for (;;) {
    DWORD count = 0;
    if (!::ReadFile(file, bytes, sizeof(bytes), &count, nullptr)) {
      const DWORD error = ::GetLastError();
      ::CloseHandle(file);
      failure = std::string("read '") + path + "': " + errorText(errnoFromWin32(error));
      return false;
    }
    if (count == 0) break;
    out.insert(out.end(), bytes, bytes + count);
  }
  ::CloseHandle(file);
  return true;
}

inline bool fillRandom(std::uint8_t *data, std::size_t size) {
  while (size > 0) {
    const ULONG chunk = static_cast<ULONG>(std::min<std::size_t>(size, 0x10000000u));
    if (::BCryptGenRandom(nullptr, data, chunk, BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) return false;
    data += chunk;
    size -= chunk;
  }
  return true;
}

// ---- process ---------------------------------------------------------------

// The UTF-16 command line, not the ANSI `argv` the C runtime derived from it
// (which has already lost every character outside the code page).
inline std::vector<std::string> arguments(int argc, char **argv) {
  std::vector<std::string> result;
  int count = 0;
  if (LPWSTR *values = ::CommandLineToArgvW(::GetCommandLineW(), &count)) {
    for (int index = 0; index < count; ++index) result.push_back(narrow(values[index], std::wcslen(values[index])));
    ::LocalFree(values);
    return result;
  }
  for (int index = 0; index < argc; ++index) result.emplace_back(argv[index]);
  return result;
}

// `KEY=value` entries, without the per-drive `=C:=C:\...` cwd entries cmd.exe
// keeps in the block (node leaves those out of process.env as well).
inline std::vector<std::string> environmentEntries() {
  std::vector<std::string> result;
  wchar_t *block = ::GetEnvironmentStringsW();
  if (block == nullptr) return result;
  for (const wchar_t *entry = block; *entry != L'\0'; entry += std::wcslen(entry) + 1) {
    if (entry[0] == L'=') continue;
    result.push_back(narrow(entry, std::wcslen(entry)));
  }
  ::FreeEnvironmentStringsW(block);
  return result;
}

inline std::string executablePath() {
  std::wstring buffer(MAX_PATH, L'\0');
  for (;;) {
    const DWORD length = ::GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (length == 0) return "";
    if (length < buffer.size()) return narrow(buffer.data(), length);
    buffer.resize(buffer.size() * 2);
  }
}

// node's `process.execPath` on Windows is the module path as the system
// reports it; there is no symlink to resolve.
inline std::string canonicalPath(const std::string &path) { return path; }

inline bool currentDirectory(std::string &out, int &error) {
  const DWORD length = ::GetCurrentDirectoryW(0, nullptr);
  if (length == 0) {
    error = errnoFromWin32(::GetLastError());
    return false;
  }
  std::wstring buffer(length, L'\0');
  const DWORD written = ::GetCurrentDirectoryW(length, buffer.data());
  if (written == 0 || written >= length) {
    error = errnoFromWin32(::GetLastError());
    return false;
  }
  out = narrow(buffer.data(), written);
  return true;
}

inline double processId() { return static_cast<double>(::GetCurrentProcessId()); }

inline double parentProcessId() {
  const DWORD self = ::GetCurrentProcessId();
  double parent = 0;
  const HANDLE snapshot = ::CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return 0;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  for (BOOL more = ::Process32FirstW(snapshot, &entry); more; more = ::Process32NextW(snapshot, &entry)) {
    if (entry.th32ProcessID == self) {
      parent = static_cast<double>(entry.th32ParentProcessID);
      break;
    }
  }
  ::CloseHandle(snapshot);
  return parent;
}

[[noreturn]] inline void exitImmediately(int status) { ::_exit(status); }

inline int onlineProcessors() {
  const DWORD count = ::GetActiveProcessorCount(ALL_PROCESSOR_GROUPS);
  return count > 0 ? static_cast<int>(count) : 1;
}

// node answers `os.arch()` with the architecture it was BUILT for.
inline std::string machineArch() {
#if defined(_M_ARM64) || defined(__aarch64__)
  return "arm64";
#elif defined(_M_X64) || defined(__x86_64__)
  return "x64";
#elif defined(_M_IX86) || defined(__i386__)
  return "ia32";
#else
  return "unknown";
#endif
}

// `major.minor.build`, as node's `os.release()` reports it. RtlGetVersion,
// because GetVersionEx answers what the executable's manifest claims.
inline std::string kernelRelease() {
  struct VersionInfo {
    ULONG size;
    ULONG major;
    ULONG minor;
    ULONG build;
    ULONG platform;
    WCHAR servicePack[128];
  } info{};
  info.size = sizeof(info);
  using RtlGetVersion = LONG(WINAPI *)(VersionInfo *);
  if (const HMODULE ntdll = ::GetModuleHandleW(L"ntdll.dll")) {
    if (const auto get = reinterpret_cast<RtlGetVersion>(reinterpret_cast<void *>(::GetProcAddress(ntdll, "RtlGetVersion")))) {
      if (get(&info) == 0)
        return std::to_string(info.major) + "." + std::to_string(info.minor) + "." + std::to_string(info.build);
    }
  }
  return "";
}

inline std::string systemName() { return "Windows_NT"; }

// GEA_WORKERS forks the reactor after the program has built its world; there
// is no fork on Windows, so the parent serves alone.
inline bool forkWorkers(int &workers) {
  if (workers > 1) {
    char line[128];
    std::snprintf(line, sizeof(line), "gea-node: GEA_WORKERS=%d is not supported on Windows (no fork); serving with one worker\n", workers);
    std::fputs(line, stderr);
  }
  workers = 1;
  return true;
}

// ---- diagnostics -----------------------------------------------------------

inline int captureStack(void **frames, int count) {
  return static_cast<int>(::RtlCaptureStackBackTrace(0, static_cast<DWORD>(count), frames, nullptr));
}

inline std::uintptr_t imageBaseOf(const void *address) {
  HMODULE module = nullptr;
  if (::GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                           static_cast<LPCWSTR>(address), &module))
    return reinterpret_cast<std::uintptr_t>(module);
  return 0;
}

inline void (*&terminationHandler())(int) {
  static void (*handler)(int) = nullptr;
  return handler;
}

// Ctrl+C, Ctrl+Break and closing the console are Windows' SIGINT/SIGTERM.
inline void onTermination(void (*handler)(int)) {
  terminationHandler() = handler;
  struct Console {
    static BOOL WINAPI onEvent(DWORD event) {
      if (terminationHandler() == nullptr) return FALSE;
      terminationHandler()(event == CTRL_C_EVENT ? SIGINT : SIGTERM);
      return TRUE;
    }
  };
  (void)::SetConsoleCtrlHandler(&Console::onEvent, TRUE);
}

// ---- memory ----------------------------------------------------------------

// VirtualAlloc reserves at 64 KB granularity, so a `size`-aligned block is
// found by reserving twice the size, releasing it, and claiming the aligned
// address inside it (retried if another thread took it in between).
inline void *reserveAlignedChunk(std::size_t size) {
  for (int attempt = 0; attempt < 16; ++attempt) {
    void *probe = ::VirtualAlloc(nullptr, size * 2, MEM_RESERVE, PAGE_NOACCESS);
    if (probe == nullptr) return nullptr;
    const std::uintptr_t start = reinterpret_cast<std::uintptr_t>(probe);
    const std::uintptr_t aligned = (start + size - 1) & ~(size - 1);
    ::VirtualFree(probe, 0, MEM_RELEASE);
    if (void *chunk = ::VirtualAlloc(reinterpret_cast<void *>(aligned), size, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE))
      return chunk;
  }
  return nullptr;
}

inline void releaseAlignedChunk(void *chunk, std::size_t) { ::VirtualFree(chunk, 0, MEM_RELEASE); }

// ---- child processes (node:cluster) ----------------------------------------

struct ChildRecord {
  DWORD pid = 0;
  HANDLE process = nullptr;
  HANDLE wait = nullptr;
  int killedWith = 0;  // the signal `signalProcess` ended it with, else 0
};

inline std::vector<ChildRecord> &children() {
  static std::vector<ChildRecord> value;
  return value;
}

inline Fd &childExitWriteFd() {
  static Fd fd = INVALID_SOCKET;
  return fd;
}

inline void forgetClusterChild(DWORD pid);

// A thread-pool callback: one byte to the loop, nothing else.
inline void CALLBACK onChildExited(void *context, BOOLEAN) {
  wakeWrite(static_cast<Fd>(reinterpret_cast<std::uintptr_t>(context)));
}

inline bool installChildExitNotifier(Fd &readFd, std::string &error) {
  Fd fds[2];
  if (!openWakePipe(fds)) {
    error = errorText(errno);
    return false;
  }
  readFd = fds[0];
  childExitWriteFd() = fds[1];
  return true;
}

inline void drainChildExitNotifier(Fd readFd) {
  char buffer[64];
  while (::recv(readFd, buffer, sizeof buffer, 0) > 0) {
  }
}

template <typename OnExit>
inline void reapExitedChildren(OnExit &&onExit) {
  std::vector<ChildRecord> &all = children();
  for (std::size_t index = 0; index < all.size();) {
    ChildRecord &child = all[index];
    if (::WaitForSingleObject(child.process, 0) != WAIT_OBJECT_0) {
      ++index;
      continue;
    }
    DWORD code = 0;
    (void)::GetExitCodeProcess(child.process, &code);
    if (child.wait != nullptr) (void)::UnregisterWaitEx(child.wait, INVALID_HANDLE_VALUE);
    ::CloseHandle(child.process);
    forgetClusterChild(child.pid);
    const double pid = static_cast<double>(child.pid);
    const int killedWith = child.killedWith;
    all.erase(all.begin() + static_cast<std::ptrdiff_t>(index));
    // The exit code is a DWORD: TerminateProcess(-1) is 4294967295, as node reports it.
    if (killedWith != 0) onExit(pid, -1.0, killedWith);
    else onExit(pid, static_cast<double>(code), 0);
  }
}

// One argument quoted for CommandLineToArgvW / the UCRT's own parser (the
// rules libuv's `quote_cmd_arg` implements).
inline void appendQuotedArgument(std::wstring &line, const std::wstring &argument) {
  if (!line.empty()) line.push_back(L' ');
  if (!argument.empty() && argument.find_first_of(L" \t\n\v\"") == std::wstring::npos) {
    line.append(argument);
    return;
  }
  line.push_back(L'"');
  std::size_t backslashes = 0;
  for (const wchar_t character : argument) {
    if (character == L'\\') {
      ++backslashes;
      continue;
    }
    if (character == L'"') line.append(backslashes * 2 + 1, L'\\');
    else line.append(backslashes, L'\\');
    backslashes = 0;
    line.push_back(character);
  }
  line.append(backslashes * 2, L'\\');
  line.push_back(L'"');
}

// ---- cluster listeners: node's Windows design -------------------------------
//
// Windows has no SO_REUSEPORT, and SO_REUSEADDR there lets any process steal
// a listening port, so workers must not each bind it. As in node (whose
// default scheduling on Windows is SCHED_NONE), the PRIMARY owns the one
// listening socket -- bound with SO_EXCLUSIVEADDRUSE, so nothing else can take
// the port while the cluster runs -- and hands every worker that asks a
// duplicate of it (WSADuplicateSocketW); the workers accept from the shared
// queue. The request travels over a named pipe the primary serves from a
// helper thread: a worker sends the address it wants, the primary binds it
// once per address and answers with the protocol info of a duplicate made for
// that worker's process. Only processes this primary started are answered.
//
// The helper thread uses fixed-size state only and allocates nothing through
// `operator new` (the pool allocator's free lists belong to the loop thread).

struct ClusterListenRequest {
  std::uint32_t magic;
  std::int32_t backlog;
  std::int32_t ipv6Only;
  std::int32_t addressLength;
  sockaddr_storage address;
};

struct ClusterListenReply {
  std::int32_t error;  // a POSIX errno, 0 on success
  WSAPROTOCOL_INFOW info;
};

inline constexpr std::uint32_t kClusterListenMagic = 0x6765614cu;  // "geaL"

struct ClusterListenerSlot {
  sockaddr_storage address;
  int addressLength;
  SOCKET socket;
};

struct ClusterListenerService {
  CRITICAL_SECTION lock;
  DWORD children[256];
  int childCount = 0;
  ClusterListenerSlot slots[64];
  int slotCount = 0;
  wchar_t pipeName[64] = {};
  bool started = false;
};

inline ClusterListenerService &clusterListenerService() {
  static ClusterListenerService *service = [] {
    static ClusterListenerService value;
    ::InitializeCriticalSection(&value.lock);
    return &value;
  }();
  return *service;
}

inline void registerClusterChild(DWORD pid) {
  ClusterListenerService &service = clusterListenerService();
  ::EnterCriticalSection(&service.lock);
  int free = -1;
  for (int index = 0; index < service.childCount; ++index)
    if (service.children[index] == 0) free = index;
  if (free >= 0) service.children[free] = pid;
  else if (service.childCount < 256) service.children[service.childCount++] = pid;
  ::LeaveCriticalSection(&service.lock);
}

inline void forgetClusterChild(DWORD pid) {
  ClusterListenerService &service = clusterListenerService();
  ::EnterCriticalSection(&service.lock);
  for (int index = 0; index < service.childCount; ++index)
    if (service.children[index] == pid) service.children[index] = 0;
  ::LeaveCriticalSection(&service.lock);
}

// One request, on the helper thread: the reply for `request` from `pid`.
inline ClusterListenReply answerClusterListen(const ClusterListenRequest &request, DWORD pid) {
  ClusterListenReply reply{};
  ClusterListenerService &service = clusterListenerService();
  if (request.magic != kClusterListenMagic || request.addressLength <= 0 ||
      request.addressLength > static_cast<int>(sizeof(sockaddr_storage))) {
    reply.error = EINVAL;
    return reply;
  }
  ::EnterCriticalSection(&service.lock);
  bool known = false;
  for (int index = 0; index < service.childCount; ++index)
    if (service.children[index] == pid) known = true;
  SOCKET listener = INVALID_SOCKET;
  if (!known) {
    reply.error = EACCES;
  } else {
    for (int index = 0; index < service.slotCount; ++index) {
      const ClusterListenerSlot &slot = service.slots[index];
      if (slot.addressLength == request.addressLength &&
          std::memcmp(&slot.address, &request.address, static_cast<std::size_t>(request.addressLength)) == 0)
        listener = slot.socket;
    }
    if (listener == INVALID_SOCKET) {
      const int family = request.address.ss_family;
      listener = ::WSASocketW(family, SOCK_STREAM, IPPROTO_TCP, nullptr, 0, WSA_FLAG_OVERLAPPED | WSA_FLAG_NO_HANDLE_INHERIT);
      bool ok = listener != INVALID_SOCKET;
      if (ok) {
        setIntOption(listener, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, 1);
        if (family == AF_INET6) setIntOption(listener, IPPROTO_IPV6, IPV6_V6ONLY, request.ipv6Only != 0 ? 1 : 0);
        ok = ::bind(listener, reinterpret_cast<const sockaddr *>(&request.address), request.addressLength) == 0 &&
             ::listen(listener, request.backlog > 0 ? request.backlog : SOMAXCONN) == 0;
      }
      if (!ok) {
        reply.error = errnoFromWinsock(::WSAGetLastError());
        if (listener != INVALID_SOCKET) ::closesocket(listener);
        listener = INVALID_SOCKET;
      } else if (service.slotCount < 64) {
        ClusterListenerSlot &slot = service.slots[service.slotCount++];
        std::memcpy(&slot.address, &request.address, static_cast<std::size_t>(request.addressLength));
        slot.addressLength = request.addressLength;
        slot.socket = listener;
      }
    }
    if (listener != INVALID_SOCKET && ::WSADuplicateSocketW(listener, pid, &reply.info) != 0)
      reply.error = errnoFromWinsock(::WSAGetLastError());
  }
  ::LeaveCriticalSection(&service.lock);
  return reply;
}

inline void serveClusterListens(void *) {
  ClusterListenerService &service = clusterListenerService();
  for (;;) {
    const HANDLE pipe = ::CreateNamedPipeW(service.pipeName, PIPE_ACCESS_DUPLEX,
                                           PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                                           PIPE_UNLIMITED_INSTANCES, sizeof(ClusterListenReply), sizeof(ClusterListenRequest), 0,
                                           nullptr);
    if (pipe == INVALID_HANDLE_VALUE) return;
    if (::ConnectNamedPipe(pipe, nullptr) || ::GetLastError() == ERROR_PIPE_CONNECTED) {
      ClusterListenRequest request{};
      DWORD read = 0;
      ULONG pid = 0;
      if (::ReadFile(pipe, &request, sizeof(request), &read, nullptr) && read == sizeof(request) &&
          ::GetNamedPipeClientProcessId(pipe, &pid)) {
        const ClusterListenReply reply = answerClusterListen(request, pid);
        DWORD written = 0;
        (void)::WriteFile(pipe, &reply, sizeof(reply), &written, nullptr);
        (void)::FlushFileBuffers(pipe);
      }
    }
    ::DisconnectNamedPipe(pipe);
    ::CloseHandle(pipe);
  }
}

// The pipe name a worker is told (`GEA_CLUSTER_LISTEN_PIPE`), the service
// started on first use.
inline std::string clusterListenPipe() {
  ClusterListenerService &service = clusterListenerService();
  if (!service.started) {
    std::swprintf(service.pipeName, 64, L"\\\\.\\pipe\\gea-cluster-%lu", static_cast<unsigned long>(::GetCurrentProcessId()));
    service.started = startThread<&serveClusterListens>(nullptr);
  }
  return narrow(service.pipeName, std::wcslen(service.pipeName));
}

// In a cluster worker: the primary's shared listener for `address`, as a
// non-blocking socket of this process (true; `out` invalid with errno set on
// failure). Everywhere else false, and the caller binds its own socket.
inline bool sharedClusterListener(const sockaddr *address, socklen_t length, int backlog, bool ipv6Only, Fd &out) {
  const char *pipeName = std::getenv("GEA_CLUSTER_LISTEN_PIPE");
  if (pipeName == nullptr || std::getenv("GEA_CLUSTER_WORKER_ID") == nullptr) return false;
  out = INVALID_SOCKET;
  ensureSockets();
  ClusterListenRequest request{};
  request.magic = kClusterListenMagic;
  request.backlog = backlog;
  request.ipv6Only = ipv6Only ? 1 : 0;
  request.addressLength = static_cast<std::int32_t>(std::min<std::size_t>(static_cast<std::size_t>(length), sizeof(sockaddr_storage)));
  std::memcpy(&request.address, address, static_cast<std::size_t>(request.addressLength));
  ClusterListenReply reply{};
  DWORD received = 0;
  const std::wstring name = wide(pipeName);
  if (!::CallNamedPipeW(name.c_str(), &request, sizeof(request), &reply, sizeof(reply), &received, 5000) ||
      received != sizeof(reply)) {
    errno = errnoFromWin32(::GetLastError());
    return true;
  }
  if (reply.error != 0) {
    errno = reply.error;
    return true;
  }
  out = ::WSASocketW(FROM_PROTOCOL_INFO, FROM_PROTOCOL_INFO, FROM_PROTOCOL_INFO, &reply.info, 0,
                     WSA_FLAG_OVERLAPPED | WSA_FLAG_NO_HANDLE_INHERIT);
  if (out == INVALID_SOCKET) {
    setErrnoFromWinsock();
    return true;
  }
  setNonBlocking(out);
  return true;
}

inline double spawnChild(const std::string &executable, std::vector<std::string> args, std::vector<std::string> env,
                         std::string &error) {
  // Workers ask this process for their listening sockets.
  const std::string listenPipeKey = "GEA_CLUSTER_LISTEN_PIPE=";
  std::erase_if(env, [&](const std::string &entry) { return entry.compare(0, listenPipeKey.size(), listenPipeKey) == 0; });
  env.push_back(listenPipeKey + clusterListenPipe());
  std::wstring commandLine;
  for (const std::string &arg : args) appendQuotedArgument(commandLine, wide(arg));
  // CreateProcessW wants the block sorted by name, case-insensitively.
  std::vector<std::wstring> entries;
  entries.reserve(env.size());
  for (const std::string &entry : env) entries.push_back(wide(entry));
  std::sort(entries.begin(), entries.end(), [](const std::wstring &left, const std::wstring &right) {
    const std::wstring a = left.substr(0, left.find(L'='));
    const std::wstring b = right.substr(0, right.find(L'='));
    return ::CompareStringOrdinal(a.c_str(), static_cast<int>(a.size()), b.c_str(), static_cast<int>(b.size()), TRUE) ==
           CSTR_LESS_THAN;
  });
  std::wstring block;
  for (const std::wstring &entry : entries) {
    block.append(entry);
    block.push_back(L'\0');
  }
  block.push_back(L'\0');
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION info{};
  const std::wstring program = wide(executable);
  // Handles are inherited so the worker gets the liveness handle and the
  // standard streams; every socket this runtime opens is non-inheritable.
  // Started suspended so it is known to the listener service before it can ask.
  if (!::CreateProcessW(program.c_str(), commandLine.data(), nullptr, nullptr, TRUE,
                        CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED, block.data(), nullptr, &startup, &info)) {
    error = errorText(errnoFromWin32(::GetLastError()));
    return 0;
  }
  registerClusterChild(info.dwProcessId);
  ::ResumeThread(info.hThread);
  ::CloseHandle(info.hThread);
  ChildRecord record;
  record.pid = info.dwProcessId;
  record.process = info.hProcess;
  const Fd notify = childExitWriteFd();
  (void)::RegisterWaitForSingleObject(&record.wait, info.hProcess, &onChildExited,
                                      reinterpret_cast<void *>(static_cast<std::uintptr_t>(notify)), INFINITE,
                                      WT_EXECUTEONLYONCE);
  children().push_back(record);
  return static_cast<double>(info.dwProcessId);
}

// libuv's kill on Windows: 0 asks whether the process is alive; SIGTERM,
// SIGKILL, SIGINT, SIGQUIT and SIGHUP end it (TerminateProcess) and are what
// its 'exit' then reports; anything else is unsupported.
inline bool signalProcess(double pidValue, int signal) {
  const DWORD pid = static_cast<DWORD>(pidValue);
  ChildRecord *child = nullptr;
  for (ChildRecord &record : children())
    if (record.pid == pid) child = &record;
  const bool terminate = signal == SIGTERM || signal == SIGKILL || signal == SIGINT || signal == SIGQUIT || signal == SIGHUP;
  if (signal != 0 && !terminate) return false;
  HANDLE process = child != nullptr ? child->process
                                    : ::OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr) return false;
  bool ok;
  DWORD code = 0;
  if (signal == 0) {
    ok = ::GetExitCodeProcess(process, &code) && code == STILL_ACTIVE;
  } else {
    ok = ::GetExitCodeProcess(process, &code) && code == STILL_ACTIVE && ::TerminateProcess(process, 1);
    if (ok && child != nullptr && child->killedWith == 0) child->killedWith = signal;
  }
  if (child == nullptr) ::CloseHandle(process);
  return ok;
}

// The primary's half of the cluster liveness channel: an inheritable handle
// to the primary itself, which every worker waits on.
inline bool createLivenessChannel(std::string &childValue, std::string &error) {
  static HANDLE self = nullptr;
  if (self == nullptr &&
      !::DuplicateHandle(::GetCurrentProcess(), ::GetCurrentProcess(), ::GetCurrentProcess(), &self, SYNCHRONIZE, TRUE, 0)) {
    error = errorText(errnoFromWin32(::GetLastError()));
    self = nullptr;
    return false;
  }
  childValue = std::to_string(reinterpret_cast<std::uintptr_t>(self));
  return true;
}

// The thread pool closes the write end when the primary exits, which the loop
// reads as end-of-file -- the same signal a worker gets on POSIX.
inline void CALLBACK onPrimaryExited(void *context, BOOLEAN) {
  ::closesocket(static_cast<Fd>(reinterpret_cast<std::uintptr_t>(context)));
}

inline Fd openLivenessChannel(const char *value) {
  const HANDLE primary = reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(std::strtoull(value, nullptr, 10)));
  if (primary == nullptr) return INVALID_SOCKET;
  Fd fds[2];
  if (!openWakePipe(fds)) return INVALID_SOCKET;
  HANDLE wait = nullptr;
  if (!::RegisterWaitForSingleObject(&wait, primary, &onPrimaryExited,
                                     reinterpret_cast<void *>(static_cast<std::uintptr_t>(fds[1])), INFINITE,
                                     WT_EXECUTEONLYONCE)) {
    closeSocket(fds[0]);
    closeSocket(fds[1]);
    return INVALID_SOCKET;
  }
  return fds[0];
}

}  // namespace gea::node::platform

#include "gea_node_windows_cleanup.hpp"

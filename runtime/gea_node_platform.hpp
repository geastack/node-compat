// SPDX-License-Identifier: Apache-2.0
#pragma once

// The operating system, as node-compat's reactor reaches it.
//
// `gea_node.cpp` is written against this one interface and never names a
// system call itself: sockets, readiness polling, the self-pipe that wakes the
// loop from another thread, detached threads, process and file metadata, the
// OS random source, aligned memory for the pool allocator, and the child
// processes `node:cluster` starts. Each platform answers it in its own header:
//
//  - `gea_node_platform_posix.hpp`: Linux and macOS (BSD sockets, poll/epoll/
//    kqueue, pipes, pthreads, posix_spawn + waitpid, SIGCHLD).
//  - `gea_node_platform_win32.hpp`: Windows (Winsock 2 and WSAPoll, loopback
//    socket pairs as wake pipes, Win32 threads, CreateProcessW with a wait
//    registration per child, BCryptGenRandom, UTF-16 file and process APIs
//    converted to UTF-8 at this boundary).
//
// The interface, in `gea::node::platform`:
//
//   Fd, kInvalidFd, valid(fd)          a socket or wake-pipe descriptor
//   ssize                              a signed byte count
//   startProcess()                     once, before the program runs: stdio, sockets
//   ensureSockets()                    idempotent; before the first socket call
//   openSocket / closeSocket / setNonBlocking / bindSocket / listenSocket /
//   connectSocket / acceptSocket / sendBytes / recvBytes / shutdownWrite /
//   setIntOption / pendingSocketError / setLingerReset / setKeepAlive /
//   configureListener / configureStream
//                                      BSD socket calls; failures return -1 (or
//                                      kInvalidFd) with a POSIX `errno`
//   poll(fds, count, timeoutMs)        level-triggered readiness, poll(2) bits
//   errorText(errno)                   the POSIX (glibc) text for an errno
//   openWakePipe / wakeRead / wakeWrite / closeWake
//                                      a byte channel another thread (or a
//                                      signal handler) writes to wake the loop
//   startThread(entry, argument)       a detached thread; false when none starts
//   utcTime(seconds, tm)               gmtime
//   canAccess / readWholeFile / statFile / fillRandom
//   arguments / environmentEntries / executablePath / canonicalPath /
//   currentDirectory / processId / parentProcessId / exitImmediately /
//   onlineProcessors / machineArch / kernelRelease
//   captureStack / imageBaseOf / onTermination
//                                      diagnostics (allocation census)
//   reserveAlignedChunk / releaseAlignedChunk
//                                      size-aligned memory for the pool
//   installChildExitNotifier / drainChildExitNotifier / reapExitedChildren /
//   spawnChild / signalProcess / createLivenessChannel / openLivenessChannel /
//   sharedClusterListener              node:cluster's process management, and
//                                      on Windows the primary-owned listener
//                                      its workers share (node's design there)
//
// Everything here is inline: the reactor is compiled into the program's own
// translation unit (see `gea_node.hpp`), and so is this.

namespace gea::node::platform {
struct FileStatus {
  double dev = 0;
  double ino = 0;
  double mode = 0;
  double nlink = 0;
  double uid = 0;
  double gid = 0;
  double rdev = 0;
  double size = 0;
  double blksize = 0;
  double blocks = 0;
  double atimeMs = 0;
  double mtimeMs = 0;
  double ctimeMs = 0;
  double birthtimeMs = 0;
};
}  // namespace gea::node::platform

#if defined(_WIN32)
#include "gea_node_platform_win32.hpp"
#else
#include "gea_node_platform_posix.hpp"
#endif

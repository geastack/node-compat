// SPDX-License-Identifier: Apache-2.0
#pragma once

// The Windows SDK headers, included the one way node-compat includes them.
//
// Winsock 2 must come before <windows.h> (which otherwise drags in the
// incompatible Winsock 1 header), and <windows.h> is cut down to what the
// runtime calls: no GDI, USER, COM or min/max macros. The headers still
// define object-like macros with ordinary names (`DELETE`, `IN`, `OUT`,
// `OPTIONAL`, `interface`, ...) that a compiled program's field names can
// collide with, so every header that includes this one ends by including
// `gea_node_windows_cleanup.hpp`, which removes them again.

#if !defined(_WIN32)
#error "gea_node_windows.hpp is the Windows host's header"
#endif

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef NOGDI
#define NOGDI
#endif
#ifndef NOUSER
#define NOUSER
#endif
#ifndef NOSERVICE
#define NOSERVICE
#endif
#ifndef NOMCX
#define NOMCX
#endif
#ifndef NOIME
#define NOIME
#endif
#ifndef NOHELP
#define NOHELP
#endif
#ifndef NOCOMM
#define NOCOMM
#endif
#ifndef NOKANJI
#define NOKANJI
#endif
#ifndef NOSOUND
#define NOSOUND
#endif

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
// Every other SDK header the runtime needs, here and not later: once the
// cleanup header has run, an SDK header included afterwards would miss the
// annotation macros it was written against.
#include <bcrypt.h>
#include <mstcpip.h>
#include <shellapi.h>
#include <tlhelp32.h>

#include <fcntl.h>
#include <io.h>
#include <process.h>

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "kernel32.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "shell32.lib")

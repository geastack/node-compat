// SPDX-License-Identifier: Apache-2.0
// No include guard: every header that includes `gea_node_windows.hpp` ends by
// including this one, so the macros are gone again whichever header came first.
//
// The Windows SDK defines these as object-like or function-like macros with
// ordinary names. A compiled program keeps TypeScript field and method names
// as C++ member names, so a field called `DELETE`, `IN` or `GetObject` would
// otherwise be rewritten by the preprocessor. node-compat's own Windows code
// is complete before this point and does not use any of them afterwards.
#if defined(_WIN32)
#undef DELETE
#undef IN
#undef OUT
#undef OPTIONAL
#undef CONST
#undef VOID
#undef interface
#undef small
#undef hyper
#undef near
#undef far
#undef NEAR
#undef FAR
#undef PASCAL
#undef CALLBACK
#undef IGNORE
#undef INFINITE
#undef ERROR
#undef TRUE
#undef FALSE
#undef BOOLEAN
#undef Yield
#undef GetObject
#undef GetMessage
#undef SendMessage
#undef PostMessage
#undef GetCurrentTime
#undef CreateFile
#undef DeleteFile
#undef CopyFile
#undef MoveFile
#undef CreateDirectory
#undef RemoveDirectory
#undef GetCurrentDirectory
#undef SetCurrentDirectory
#undef GetFileAttributes
#undef CreateProcess
#undef CreateEvent
#undef CreateMutex
#undef CreateSemaphore
#undef OpenEvent
#undef GetCommandLine
#undef GetEnvironmentVariable
#undef SetEnvironmentVariable
#undef GetModuleFileName
#undef GetModuleHandle
#undef LoadLibrary
#undef FormatMessage
#undef OutputDebugString
#undef GetUserName
#undef GetComputerName
#undef LookupAccountName
#undef ReportEvent
#undef RegisterClass
#undef UnregisterClass
#undef FindResource
#undef LoadResource
#undef EnumResourceTypes
#undef GetTempPath
#undef GetFullPathName
#undef GetLongPathName
#undef GetShortPathName
#undef SearchPath
#undef CreateHardLink
#undef CreateSymbolicLink
#undef GetVersion
#undef GetVersionEx
#undef GetBinaryType
#undef SetVolumeLabel
#undef ReplaceFile
#undef EncryptFile
#undef DecryptFile
#undef AddAtom
#undef FindAtom
#undef DeleteAtom
#undef GetAtomName
#endif

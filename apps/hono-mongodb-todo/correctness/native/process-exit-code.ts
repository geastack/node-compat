// `process.exitCode`: readable and writable, and the status a process ends
// with when nothing names one -- a natural exit once the event loop drains, and
// an argument-less `process.exit()`. The mode is the first argument so one
// source covers every exit path; node's run is the oracle for the native one.
const mode = process.argv[2] ?? 'natural'
console.log(`initial=${String(process.exitCode)}`)
if (mode === 'natural') {
  process.exitCode = 3
  console.log(`set=${String(process.exitCode)}`)
  // The loop still has work after the assignment; the status is read when it drains.
  setTimeout(() => console.log('timer ran'), 1)
} else if (mode === 'exit') {
  process.exitCode = 2
  console.log(`set=${String(process.exitCode)}`)
  process.exit()
  console.log('unreachable')
} else {
  process.exitCode = 5
  process.exitCode = undefined
  console.log(`reset=${String(process.exitCode)}`)
}

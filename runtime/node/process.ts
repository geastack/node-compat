// Minimal typed node:process surface used by the official MongoDB driver's
// connection-string, handshake metadata, and logger paths.

declare function __gea_node_process_env(): { [key: string]: string | undefined }
/** @gea-host-inert */
declare function __gea_node_version(): string
/** @gea-host-inert */
declare function __gea_node_platform(): string
/** @gea-host-inert */
declare function __gea_node_stdio_write(fd: number, data: string): void
/** @gea-host-inert */
declare function __gea_node_process_pid(): number
/** @gea-host-inert */
declare function __gea_node_process_ppid(): number
/** @gea-host-inert */
declare function __gea_node_process_exit(code: number): void

export interface ProcessEnv {
  [key: string]: string | undefined
}

// Real Node's `process.versions` carries an entry per bundled component (v8,
// uv, zlib, openssl, ...). Only `node` has a genuine source on this target --
// it is `process.version` with the leading `v` stripped, exactly how Node
// itself derives it. Fabricating the others (there is no bundled V8, libuv,
// or OpenSSL here to version) would be a lie dressed as data, so the
// interface only states the field this runtime can actually answer.
export interface ProcessVersions {
  readonly node: string
}

export type WriteStreamCallback = (error?: Error | null) => void

export class WriteStream {
  private fd_: number

  constructor(fd: number) {
    this.fd_ = fd
  }

  write(data: string): boolean
  write(data: string, encoding: string): boolean
  write(data: string, encoding: string, callback: WriteStreamCallback): boolean
  write(
    data: string,
    encoding: string = 'utf8',
    callback: WriteStreamCallback = () => {}
  ): boolean {
    __gea_node_stdio_write(this.fd_, data)
    callback(null)
    return true
  }
}

const nodeProcessEnv: ProcessEnv = __gea_node_process_env()
const nodeProcessVersion: string = __gea_node_version()
const nodeProcessVersions: ProcessVersions = { node: nodeProcessVersion.replace(/^v/, '') }
const nodeProcessPlatform: string = __gea_node_platform()
const nodeProcessPid: number = __gea_node_process_pid()
const nodeProcessPpid: number = __gea_node_process_ppid()
const nodeProcessStdout = new WriteStream(1)
const nodeProcessStderr = new WriteStream(2)

function nodeProcessEmitWarning(message: string, options?: { code?: string }): void {
  const code = options?.code
  // Call the host primitive directly here. The pinned declaration program's
  // NodeJS.WriteStream method symbol is intentionally richer than this small
  // runtime overlay class and must not rename the overlay's own method body.
  __gea_node_stdio_write(2, (code === undefined ? '' : `[${code}] `) + message + '\n')
}

// `process.exit` ends the process now: stdio is flushed and nothing after the
// call runs. There are no 'exit' listeners to run first on this target.
function nodeProcessExit(code: number = 0): never {
  __gea_node_process_exit(code)
  throw new Error('process.exit returned')
}

// Keep the public Node names as aliases. This is idiomatic source and also
// exercises geatsc's concrete bare-builtin re-export resolution.
export {
  nodeProcessEnv as env,
  nodeProcessVersion as version,
  nodeProcessPlatform as platform,
  nodeProcessPid as pid,
  nodeProcessPpid as ppid,
  nodeProcessExit as exit,
  nodeProcessStdout as stdout,
  nodeProcessStderr as stderr,
  nodeProcessEmitWarning as emitWarning,
  nodeProcessVersions as versions
}

// Synchronous host OS metadata used in the MongoDB handshake document.

/** @gea-host-inert */
declare function __gea_node_platform(): string
/** @gea-host-inert */
declare function __gea_node_os_arch(): string
/** @gea-host-inert */
declare function __gea_node_os_release(): string
/** @gea-host-inert */
declare function __gea_node_os_type(): string
/** @gea-host-inert */
declare function __gea_node_os_available_parallelism(): number

function nodeOsPlatform(): string {
  return __gea_node_platform()
}

function nodeOsArch(): string {
  return __gea_node_os_arch()
}

function nodeOsRelease(): string {
  return __gea_node_os_release()
}

function nodeOsType(): string {
  return __gea_node_os_type()
}

function nodeOsEndianness(): 'LE' | 'BE' {
  // geatsc's supported native targets are currently little-endian.
  return 'LE'
}

function nodeOsAvailableParallelism(): number {
  return __gea_node_os_available_parallelism()
}

export interface CpuTimes {
  user: number
  nice: number
  sys: number
  idle: number
  irq: number
}

export interface CpuInfo {
  model: string
  speed: number
  times: CpuTimes
}

// One entry per online logical CPU. The per-CPU model, clock and time
// counters are not read on this target; `cpus().length` is the fact programs
// reach for (a worker count), and that one is real.
function nodeOsCpus(): CpuInfo[] {
  const count = __gea_node_os_available_parallelism()
  const cpus: CpuInfo[] = []
  for (let index = 0; index < count; index += 1) {
    cpus.push({ model: '', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } })
  }
  return cpus
}

export {
  nodeOsAvailableParallelism as availableParallelism,
  nodeOsCpus as cpus,
  nodeOsPlatform as platform,
  nodeOsArch as arch,
  nodeOsRelease as release,
  nodeOsType as type,
  nodeOsEndianness as endianness
}

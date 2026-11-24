// The build's shape when the caller states none: one translation unit with
// full LTO (the smallest, fastest executable) where the machine can afford it,
// per-file units and a parallel or no-LTO link where it cannot.
//
// Measured on a database driver server (2.2 MB of reachable package source,
// 45 MB of emitted C++ in 220 per-file units): a full-LTO link peaked at
// 24.5 GB against 7.2 GB for ThinLTO, and a per-file build with no LTO at
// 5.4 GB. One unit of the same program costs what the full-LTO link does,
// since it is the same single optimizer run over the whole program. So the
// one-unit default could not build that server on a 16-20 GB machine at all,
// while an HTTP framework's hello world (0.15 MB of reachable source) is
// unaffected either way. The coefficients below are those measurements; they
// only need to be right to within the gap between the two populations.

const MB = 1e6
const GB = 1e9

/** Reachable package source at or above this is a large program whatever the machine. */
export const LARGE_PROGRAM_SOURCE_BYTES = 1.5 * MB
/** Peak memory of a one-unit (or full-LTO) build per byte of reachable source: 24.5 GB / 2.2 MB. */
export const ONE_UNIT_PEAK_BYTES_PER_SOURCE_BYTE = 11_000
/** Peak memory of a full-LTO link per byte of emitted C++: 24.5 GB / 45 MB. */
export const FULL_LTO_PEAK_BYTES_PER_EMITTED_BYTE = 550
/** The share of physical memory a build may plan to use. */
export const MEMORY_BUDGET_FRACTION = 0.8

const gigabytes = (bytes) => `${(bytes / GB).toFixed(1)} GB`
const megabytes = (bytes) => `${(bytes / MB).toFixed(1)} MB`

/**
 * The translation-unit layout. An explicit `--translation-units` always wins;
 * otherwise a large program, or one whose single unit would not fit in memory,
 * is split per file. `reason` is null when the default stands.
 */
export function chooseTranslationUnits({ requested, reachableSourceBytes, totalMemoryBytes }) {
  if (requested !== null && requested !== undefined) return { layout: requested, reason: null }
  const estimate = reachableSourceBytes * ONE_UNIT_PEAK_BYTES_PER_SOURCE_BYTE
  const budget = totalMemoryBytes * MEMORY_BUDGET_FRACTION
  if (reachableSourceBytes >= LARGE_PROGRAM_SOURCE_BYTES)
    return {
      layout: 'per-file',
      reason: `${megabytes(reachableSourceBytes)} of reachable package source is a large program (>= ${megabytes(LARGE_PROGRAM_SOURCE_BYTES)}): per-file translation units (--translation-units single overrides)`
    }
  if (estimate > budget)
    return {
      layout: 'per-file',
      reason: `one unit of ${megabytes(reachableSourceBytes)} of reachable package source needs about ${gigabytes(estimate)}, more than ${gigabytes(budget)} of this machine's ${gigabytes(totalMemoryBytes)}: per-file translation units (--translation-units single overrides)`
    }
  return { layout: 'single', reason: null }
}

/**
 * The LTO of a split (per-file) build when GEA_LTO is unset. Full LTO stays the
 * default while its single-threaded link fits in memory; past that, ThinLTO
 * (clang: parallel backends, about a quarter of the memory) or none (gcc,
 * whose LTO is full only). `lto` is undefined when the default stands.
 */
export function chooseSplitLto({ emittedBytes, totalMemoryBytes, cxxIsClang }) {
  const estimate = emittedBytes * FULL_LTO_PEAK_BYTES_PER_EMITTED_BYTE
  const budget = totalMemoryBytes * MEMORY_BUDGET_FRACTION
  if (estimate <= budget) return { lto: undefined, reason: null }
  const lto = cxxIsClang ? 'thin' : null
  return {
    lto,
    reason: `a full-LTO link of ${megabytes(emittedBytes)} of C++ needs about ${gigabytes(estimate)}, more than ${gigabytes(budget)} of this machine's ${gigabytes(totalMemoryBytes)}: ${lto === 'thin' ? 'ThinLTO' : 'no LTO'} (GEA_LTO=full overrides)`
  }
}

/** Peak memory of one concurrent compile job of a split build: a driver server's grouped unit peaked near 5 GB. */
export const COMPILE_JOB_PEAK_BYTES = 5 * GB

/**
 * How many unit compiles run at once. GEA_JOBS always wins; otherwise every
 * core, capped by memory: the budget is the planning share of physical memory
 * or what is available now, whichever is smaller, at COMPILE_JOB_PEAK_BYTES a
 * job. Six jobs of a driver server (about 5 GB each) were OOM-killed under a
 * 17 GB limit; the cap gives three there. `reason` is null unless memory capped it.
 */
export function chooseCompileJobs({ requested, cores, totalMemoryBytes, availableMemoryBytes }) {
  const explicit = Number.parseInt(requested ?? '', 10)
  if (explicit > 0) return { jobs: explicit, reason: null }
  const budget = Math.min(totalMemoryBytes * MEMORY_BUDGET_FRACTION, availableMemoryBytes ?? Infinity)
  const byMemory = Math.max(1, Math.floor(budget / COMPILE_JOB_PEAK_BYTES))
  const coreCount = Math.max(1, cores)
  if (byMemory >= coreCount) return { jobs: coreCount, reason: null }
  return {
    jobs: byMemory,
    reason: `${gigabytes(budget)} of memory to plan with at about ${gigabytes(COMPILE_JOB_PEAK_BYTES)} a compile job: ${byMemory} at a time, not ${coreCount} (GEA_JOBS overrides)`
  }
}

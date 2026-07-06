// Tiny Mach-O header reader: enough to tell which CPU architecture a binary was built for.
// Used to diagnose the recurring field failure where a cross-arch `electron-builder --x64` run
// clobbers node-pty's `spawn-helper` in node_modules with an x86_64 build, after which every
// pty spawn on an arm64 app fails with an opaque "posix_spawnp failed.".

const MH_MAGIC_64 = 0xfeedfacf // little-endian on-disk bytes: cf fa ed fe
const FAT_MAGIC = 0xcafebabe // universal (fat) binary, big-endian header
const CPU_TYPE_X86_64 = 0x01000007
const CPU_TYPE_ARM64 = 0x0100000c

export type MachOArch = 'arm64' | 'x86_64' | 'universal' | 'unknown'

/** Architecture of a Mach-O binary from its first 8 bytes. 'universal' = fat binary (any arch). */
export function machOArch(header: Buffer): MachOArch {
  if (header.length < 8) return 'unknown'
  if (header.readUInt32BE(0) === FAT_MAGIC) return 'universal'
  if (header.readUInt32LE(0) !== MH_MAGIC_64) return 'unknown'
  const cpuType = header.readUInt32LE(4)
  if (cpuType === CPU_TYPE_ARM64) return 'arm64'
  if (cpuType === CPU_TYPE_X86_64) return 'x86_64'
  return 'unknown'
}

/**
 * True when a binary of `arch` cannot run natively in this process's architecture — i.e. the
 * spawn-helper was clobbered by a cross-arch build. Universal/unknown never flag (fail open).
 */
export function archMismatch(arch: MachOArch, processArch: NodeJS.Architecture): boolean {
  if (arch === 'arm64') return processArch !== 'arm64'
  if (arch === 'x86_64') return processArch !== 'x64'
  return false
}

import type { TailIdentity } from '../sessionlog/tail.js'

/** The tail cursor for one beacon file: where the next read starts, and which inode it belongs to. */
export interface BeaconTailedFile {
  offset: number
  identity?: TailIdentity
}

/** Keyed by the beacon file's basename inside the beacon directory — never a path. */
export interface BeaconSnapshot {
  disabled: boolean
  files: Record<string, BeaconTailedFile>
}

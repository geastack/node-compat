import { Buffer } from 'buffer'

// TypeScript permits this augmentation, but the Node host did not declare or
// implement the added overload. geatsc must reject the merged method symbol
// instead of authenticating only the host-owned declaration in its overload
// set.
declare module '../../runtime/node/buffer-types' {
  interface Buffer {
    write(value: number): number
  }
}

Buffer.alloc(4).write(123)

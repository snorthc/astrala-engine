import { mkdir, open, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Writes that can't corrupt each other: one queue, and each write lands atomically (temp file, fsync, rename).
 * Overlapping saves of the vault used to interleave and could leave it unreadable.
 */
export function queuedWriter() {
  let chain: Promise<void> = Promise.resolve()
  return (path: string, data: string, mode = 0o600): Promise<void> => {
    const job = chain.then(async () => {
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.${process.pid}.tmp`
      const fh = await open(tmp, 'w', mode)
      try { await fh.writeFile(data); await fh.sync() } finally { await fh.close() }
      await rename(tmp, path)
    })
    chain = job.catch(() => {})
    return job
  }
}

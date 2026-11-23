import { describe, expect, it } from 'vitest'
import { hangDuring } from '../src/main/safe-graphics'

describe('safe graphics: was there a display hang during the last run?', () => {
  const run = { start: 1_000_000, alive: 1_600_000 }
  const r = (name: string, mtimeMs: number) => ({ name, mtimeMs })
  it('yes, for a WindowServer watchdog or crash report written while Astrala ran (or within 2 min of its last heartbeat)', () => {
    expect(hangDuring(run, [r('WindowServer_2026-11-09-160943_mac.userspace_watchdog_timeout.spin', 1_200_000)])).toBe(true)
    expect(hangDuring(run, [r('WindowServer-2026-11-09-160938.ips', 1_700_000)])).toBe(true)
  })
  it('no, for reports from before or long after, other processes, or no heartbeat', () => {
    expect(hangDuring(run, [r('WindowServer-2026-11-09-150000.ips', 900_000)])).toBe(false)
    expect(hangDuring(run, [r('WindowServer-2026-11-09-170000.ips', 1_800_000)])).toBe(false)
    expect(hangDuring(run, [r('Spotify_2026-11-09.diag', 1_200_000)])).toBe(false)
    expect(hangDuring(null, [r('WindowServer-x.ips', 1_200_000)])).toBe(false)
    expect(hangDuring({ start: 5, alive: 1 }, [r('WindowServer-x.ips', 3)])).toBe(false)
  })
})

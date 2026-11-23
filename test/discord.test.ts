import { describe, expect, it } from 'vitest'
import { frame, unframe, line } from '../src/main/discord'

describe('discord socket framing', () => {
  it('round-trips messages, including two in one chunk and one split across chunks', () => {
    const a = frame(1, { cmd: 'SET_ACTIVITY' }), b = frame(3, { n: 1 })
    expect(a.readInt32LE(0)).toBe(1)
    expect(a.readInt32LE(4)).toBe(a.length - 8)
    const both = unframe(Buffer.concat([a, b]))
    expect(both.msgs).toEqual([{ op: 1, body: { cmd: 'SET_ACTIVITY' } }, { op: 3, body: { n: 1 } }])
    const part = unframe(a.subarray(0, 10))
    expect(part.msgs).toEqual([])
    expect(unframe(Buffer.concat([part.rest, a.subarray(10)])).msgs).toEqual([{ op: 1, body: { cmd: 'SET_ACTIVITY' } }])
  })
  it('drops a stream that is not Discord', () => {
    const junk = Buffer.alloc(12); junk.writeInt32LE(1, 0); junk.writeInt32LE(-5, 4)
    expect(unframe(junk)).toEqual({ msgs: [], rest: Buffer.alloc(0) })
  })
  it('keeps a status line within what Discord accepts', () => {
    expect(line('  Received   £543 ')).toBe('Received £543')
    expect(line('x')).toBeUndefined()
    expect(line('y'.repeat(300))).toHaveLength(128)
  })
})

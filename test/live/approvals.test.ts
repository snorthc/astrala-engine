// Read-only: lists the token approvals vitalik.eth has granted, through the real public RPCs. Nothing is signed or sent.
import { it, expect } from 'vitest'
import { scanApprovals, SCAN_BLOCKS } from '../../src/core/approvals'

const VITALIK = process.env.APPROVAL_OWNER ?? '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' // APPROVAL_OWNER=0x… checks any other address

it('scans approvals for vitalik.eth on every EVM network', async () => {
  const t0 = Date.now()
  const r = await scanApprovals(VITALIK)
  console.log(`scan took ${((Date.now() - t0) / 1000).toFixed(1)} s, log window ${SCAN_BLOCKS} blocks`)
  for (const n of r.networks) console.log(`  ${n.network.padEnd(10)} ${n.ok ? 'ok ' : 'ERR'} logs ${n.logsFrom ?? '-'}..${n.logsTo ?? '-'} ${n.error ?? ''}`)
  for (const a of r.approvals) console.log(`  ${a.network.padEnd(10)} ${a.symbol.padEnd(8)} ${a.known ? '' : '(unlisted) '}→ ${a.spenderName ?? a.spender} ${a.unlimited ? 'Unlimited' : a.amount}`)
  expect(r.networks.length).toBe(7)
  expect(r.networks.filter((n) => n.logsTo != null).length).toBeGreaterThanOrEqual(5) // most public nodes answered
  for (const a of r.approvals) expect(BigInt(a.allowance)).toBeGreaterThan(0n)
}, 240_000)

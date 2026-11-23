import { it, expect } from 'vitest'
import { stakeAccounts, validators, stakeMinimum, stake } from '../../src/core/stake'
import { newMnemonic, deriveAccount, signingKey } from '../../src/core/derive'

it('reads stake state, validators and builds a signed delegation (dry run)', async () => {
  const m = newMnemonic()
  const sol = deriveAccount(m).find((a) => a.chain === 'sol')!.address
  const s = await stakeAccounts(sol)
  expect(s.accounts).toEqual([])
  expect(s.epoch).toBeGreaterThan(500)
  const v = await validators()
  console.log('validators', v.slice(0, 3), 'min', await stakeMinimum())
  expect(v.length).toBeGreaterThan(3)
  const r = await stake(signingKey(m, 'sol').priv, sol, 1, v[0].vote, true)
  console.log(r)
  expect(r.txid.startsWith('dry:')).toBe(true)
}, 90000)

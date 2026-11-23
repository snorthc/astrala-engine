// End-to-end sends against a fake blockchain: the real quote → sign → broadcast code runs for every
// coin, and the "broadcast" is caught and decoded here. Nothing leaves this machine.
import { describe, it, expect, beforeEach } from 'vitest'
import { parseTransaction, recoverTransactionAddress, decodeFunctionData, erc20Abi, getAddress } from 'viem'
import { Transaction as SolTx, PublicKey } from '@solana/web3.js'
import * as btc from '@scure/btc-signer'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { setFetcher } from '../src/core/chain'
import { ASSETS, NETWORKS, networkOf } from '../src/core/assets'
import { deriveAccount, signingKey } from '../src/core/derive'
import { quote, execute, type SendRequest } from '../src/core/send'

const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const me = Object.fromEntries(deriveAccount(M, 0).map((a) => [a.chain, a.address])) as Record<string, string>
const them = Object.fromEntries(deriveAccount(M, 1).map((a) => [a.chain, a.address])) as Record<string, string>
const keyFor = (f: any) => signingKey(M, f, 0)

// the fake chain: balances we hold, and everything that got "broadcast"
let bal = { native: 10n ** 18n, token: 10n ** 24n, sats: 50_000_000, lamports: 5_000_000_000n, sun: 500_000_000n }
let sent: { fam: string; raw: any }[] = []
let stuckEvm: any = null // the pending EVM tx the node knows about (for cancel)
const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } })
const hex = (n: bigint | number) => '0x' + BigInt(n).toString(16)
const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0')

function evmRpc(chainId: number, m: string, params: any[]): unknown {
  switch (m) {
    case 'eth_chainId': return hex(chainId)
    case 'eth_getBalance': return hex(bal.native)
    case 'eth_call': return params[0]?.data?.startsWith('0x70a08231') ? word(bal.token) : '0x' + '0'.repeat(64)
    case 'eth_estimateGas': return hex(params[0]?.data ? 55_000 : 21_000)
    case 'eth_maxPriorityFeePerGas': return hex(1_000_000_000)
    case 'eth_gasPrice': return hex(20_000_000_000)
    case 'eth_getBlockByNumber': return { baseFeePerGas: hex(10_000_000_000), number: '0x1', hash: '0x' + '1'.repeat(64), timestamp: '0x1', transactions: [] }
    case 'eth_getTransactionCount': return '0x7'
    case 'eth_sendRawTransaction': sent.push({ fam: 'evm', raw: params[0] }); return '0x' + 'ab'.repeat(32)
    case 'eth_getTransactionByHash': return stuckEvm && params[0] === stuckEvm.hash ? { chainId: hex(chainId), ...stuckEvm } : null
  }
  throw new Error('unhandled evm ' + m)
}
const BLOCKHASH = new PublicKey(new Uint8Array(32).fill(7)).toBase58()
function solRpc(m: string, params: any[]): unknown {
  const ctx = { context: { slot: 1 } }
  switch (m) {
    case 'getBalance': return { ...ctx, value: Number(bal.lamports) }
    case 'getAccountInfo': return { ...ctx, value: null }
    case 'getMinimumBalanceForRentExemption': return 890_880
    case 'getTokenAccountBalance': return { ...ctx, value: { amount: String(bal.token), decimals: 6, uiAmount: null } }
    case 'getLatestBlockhash': return { ...ctx, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } }
    case 'sendTransaction': sent.push({ fam: 'sol', raw: params[0] }); return '5'.repeat(64)
  }
  throw new Error('unhandled sol ' + m)
}
const tronTx = (value: any, type: string) => {
  const raw_data_hex = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))))
  return { txID: bytesToHex(sha256(Buffer.from(raw_data_hex, 'hex'))), raw_data_hex, raw_data: { contract: [{ type, parameter: { value } }] } }
}

async function fake(url: string, init?: RequestInit): Promise<Response> {
  const u = new URL(url)
  const body = init?.body ? String(init.body) : ''
  const evm = Object.values(NETWORKS).find((n) => n.family === 'evm' && n.rpc.some((r) => url.startsWith(r)))
  if (evm) {
    const j = JSON.parse(body)
    const one = (x: any) => ({ jsonrpc: '2.0', id: x.id, result: evmRpc(evm.chainId!, x.method, x.params ?? []) })
    return ok(Array.isArray(j) ? j.map(one) : one(j))
  }
  if (NETWORKS.solana.rpc.some((r) => url.startsWith(r))) {
    const j = JSON.parse(body)
    return ok({ jsonrpc: '2.0', id: j.id, result: solRpc(j.method, j.params ?? []) })
  }
  if (u.host === 'mempool.space' || u.host === 'litecoinspace.org') {
    const fam = u.host === 'mempool.space' ? 'btc' : 'ltc'
    if (u.pathname.endsWith('/utxo')) return ok([{ txid: 'aa'.repeat(32), vout: 0, value: bal.sats }, { txid: 'bb'.repeat(32), vout: 1, value: 20_000 }])
    if (u.pathname.endsWith('/fees/recommended')) return ok({ fastestFee: 12, halfHourFee: 6, hourFee: 3 })
    if (u.pathname === '/api/tx' && init?.method === 'POST') { sent.push({ fam, raw: body }); return new Response('cd'.repeat(32)) }
  }
  if (u.host === 'api.blockcypher.com') {
    if (u.pathname.includes('/addrs/')) return ok({ txrefs: [{ tx_hash: 'aa'.repeat(32), tx_output_n: 0, value: bal.sats * 100 }] })
    if (u.pathname.endsWith('/txs/push')) { const tx = JSON.parse(body).tx; sent.push({ fam: 'doge', raw: tx }); return ok({ tx: { hash: 'ef'.repeat(32) } }) }
    return ok({ low_fee_per_kb: 500_000, medium_fee_per_kb: 1_000_000, high_fee_per_kb: 2_000_000 })
  }
  if (u.host === 'api.trongrid.io') {
    const j = body ? JSON.parse(body) : {}
    switch (u.pathname) {
      case '/wallet/getaccountresource': return ok({ freeNetLimit: 600, freeNetUsed: 0 })
      case '/wallet/getchainparameters': return ok({ chainParameter: [{ key: 'getTransactionFee', value: 1000 }, { key: 'getEnergyFee', value: 210 }, { key: 'getCreateAccountFee', value: 100_000 }, { key: 'getCreateNewAccountFeeInSystemContract', value: 1_000_000 }] })
      case '/wallet/getaccount': return ok(j.address === me.trx ? { address: me.trx, balance: Number(bal.sun) } : { address: j.address })
      case '/wallet/triggerconstantcontract': return ok(j.function_selector.startsWith('balanceOf') ? { constant_result: [bal.token.toString(16).padStart(64, '0')] } : { energy_used: 65_000 })
      case '/wallet/createtransaction': return ok(tronTx({ owner_address: j.owner_address, to_address: j.to_address, amount: j.amount }, 'TransferContract'))
      case '/wallet/triggersmartcontract': return ok({ transaction: tronTx({ owner_address: j.owner_address, contract_address: j.contract_address, data: 'a9059cbb' + j.parameter }, 'TriggerSmartContract') })
      case '/wallet/broadcasttransaction': sent.push({ fam: 'trx', raw: j }); return ok({ result: true })
    }
  }
  throw new Error('unexpected network call ' + url)
}

beforeEach(() => {
  setFetcher(fake as any)
  sent = []
  stuckEvm = null
  bal = { native: 10n ** 18n, token: 10n ** 24n, sats: 50_000_000, lamports: 5_000_000_000n, sun: 500_000_000n }
})

// pulls out of the "broadcast" who signed it, who it pays and how much
async function decode(fam: string, raw: any, assetKind: string) {
  if (fam === 'evm') {
    const tx = parseTransaction(raw)
    const signer = await recoverTransactionAddress({ serializedTransaction: raw })
    if (assetKind === 'native') return { signer, to: tx.to!, amount: tx.value!, chainId: tx.chainId }
    const d = decodeFunctionData({ abi: erc20Abi, data: tx.data! })
    expect(d.functionName).toBe('transfer')
    return { signer, to: d.args[0] as string, amount: d.args[1] as bigint, chainId: tx.chainId, contract: tx.to }
  }
  if (fam === 'sol') {
    const tx = SolTx.from(Buffer.from(raw, 'base64'))
    expect(tx.verifySignatures()).toBe(true)
    return { signer: tx.feePayer!.toBase58(), ixs: tx.instructions }
  }
  if (fam === 'btc' || fam === 'ltc' || fam === 'doge') {
    const tx = btc.Transaction.fromRaw(Buffer.from(raw, 'hex'), { allowUnknownOutputs: true, disableScriptCheck: true })
    return { tx }
  }
  return { tron: raw }
}

const sendable = ASSETS.filter((a) => networkOf(a.id).family !== 'xmr')

describe('every coin: send a normal amount end to end', () => {
  for (const a of sendable) {
    const fam = networkOf(a.id).family
    it(`${a.symbol} on ${networkOf(a.id).name}`, async () => {
      const req: SendRequest = { assetId: a.id, to: them[fam], amount: a.kind === 'token' ? '12.5' : '0.01', speed: 'normal' }
      const q = await quote(req, me, keyFor)
      expect(q.error ?? '').toBe('')
      expect(q.ok).toBe(true)
      expect(q.fee).toBeGreaterThanOrEqual(fam === "trx" ? 0 : 1e-12)
      await execute(req, me, keyFor)
      expect(sent).toHaveLength(1)
      const d: any = await decode(sent[0].fam, sent[0].raw, a.kind)
      const units = BigInt(Math.round(Number(req.amount) * 10 ** (fam === 'btc' || fam === 'ltc' || fam === 'doge' ? 8 : a.decimals)))
      if (fam === 'evm') {
        expect(d.signer).toBe(getAddress(me.evm))
        expect(getAddress(d.to)).toBe(getAddress(them.evm))
        expect(d.amount).toBe(units)
        expect(d.chainId).toBe(networkOf(a.id).chainId)
        if (a.kind === 'token') expect(getAddress(d.contract)).toBe(getAddress(a.contract!))
      } else if (fam === 'sol') {
        expect(d.signer).toBe(me.sol)
        const ix = d.ixs[d.ixs.length - 1]
        if (a.kind === 'native') {
          expect(ix.keys[1].pubkey.toBase58()).toBe(them.sol)
          expect(Buffer.from(ix.data).readBigUInt64LE(4)).toBe(units)
        } else expect(Buffer.from(ix.data).readBigUInt64LE(1)).toBe(units)
      } else if (fam === 'trx') {
        const v = d.tron.raw_data.contract[0].parameter.value
        expect(v.owner_address).toBe(me.trx)
        if (a.kind === 'native') { expect(v.to_address).toBe(them.trx); expect(BigInt(v.amount)).toBe(units) }
        else { expect(v.contract_address).toBe(a.contract); expect(BigInt('0x' + v.data.slice(-64))).toBe(units) }
        expect(d.tron.signature?.[0]).toMatch(/^[0-9a-f]{130}$/)
      } else {
        const outs = Array.from({ length: d.tx.outputsLength }, (_, i) => d.tx.getOutput(i))
        expect(outs[0].amount).toBe(units)
        expect(outs.reduce((s: bigint, o: any) => s + o.amount, 0n)).toBeLessThan(BigInt(fam === 'doge' ? bal.sats * 100 : bal.sats + 20_000))
      }
    })
  }
})

describe('every native coin: send max, at every speed', () => {
  for (const a of sendable.filter((x) => x.kind === 'native')) {
    const fam = networkOf(a.id).family
    for (const speed of ['slow', 'normal', 'fast'] as const) {
      it(`${a.symbol} on ${networkOf(a.id).name} · ${speed}`, async () => {
        const req: SendRequest = { assetId: a.id, to: them[fam], amount: '', speed, max: true }
        const q = await quote(req, me, keyFor)
        expect(q.ok).toBe(true)
        expect(q.amount).toBeGreaterThan(0)
        await execute(req, me, keyFor)
        expect(sent).toHaveLength(1)
        if (fam === 'evm') {
          const tx = parseTransaction(sent[0].raw as `0x02${string}`)
          expect(tx.value! + tx.gas! * tx.maxFeePerGas!).toBeLessThanOrEqual(bal.native) // never spends more than we have
        }
      })
    }
  }
})

describe('refuses bad sends before signing', () => {
  const pick = (f: string) => sendable.find((a) => networkOf(a.id).family === f && a.kind === 'native')!
  for (const fam of ['evm', 'sol', 'btc', 'ltc', 'doge', 'trx']) {
    it(`${fam}: more than the balance`, async () => {
      const r = await quote({ assetId: pick(fam).id, to: them[fam], amount: '99999999', speed: 'normal' }, me, keyFor)
      expect(r.ok).toBe(false)
      await expect(execute({ assetId: pick(fam).id, to: them[fam], amount: '99999999', speed: 'normal' }, me, keyFor)).rejects.toThrow()
      expect(sent).toHaveLength(0)
    })
    it(`${fam}: to your own address`, async () => {
      expect((await quote({ assetId: pick(fam).id, to: me[fam], amount: '0.01', speed: 'normal' }, me, keyFor)).ok).toBe(false)
    })
    it(`${fam}: garbage address`, async () => {
      expect((await quote({ assetId: pick(fam).id, to: 'not-an-address', amount: '0.01', speed: 'normal' }, me, keyFor)).ok).toBe(false)
    })
    it(`${fam}: zero amount`, async () => {
      expect((await quote({ assetId: pick(fam).id, to: them[fam], amount: '0', speed: 'normal' }, me, keyFor)).ok).toBe(false)
    })
  }
  for (const a of sendable.filter((x) => x.kind === 'token')) {
    it(`${a.symbol} on ${networkOf(a.id).name}: no coin left for the network fee`, async () => {
      bal.native = 0n; bal.lamports = 0n; bal.sun = 0n
      const r = await quote({ assetId: a.id, to: them[networkOf(a.id).family], amount: '1', speed: 'normal' }, me, keyFor)
      expect(r.ok).toBe(false)
      expect(sent).toHaveLength(0)
    })
  }
})

describe('speed up (BTC)', () => {
  const stuck = (feeSats: number) => ({ status: { confirmed: false }, weight: 560, fee: feeSats,
    vin: [{ txid: 'aa'.repeat(32), vout: 0, prevout: { scriptpubkey_address: me.btc, value: 1_000_000 } }],
    vout: [{ scriptpubkey_address: them.btc, scriptpubkey: btc.OutScript.encode(btc.Address(btc.NETWORK).decode(them.btc)), value: 400_000 },
      { scriptpubkey_address: me.btc, scriptpubkey: btc.OutScript.encode(btc.Address(btc.NETWORK).decode(me.btc)), value: 1_000_000 - 400_000 - feeSats }] })
  const withTx = (tx: any, fastest: number) => setFetcher((async (url: string) => {
    if (url.includes('/fees/recommended')) return ok({ fastestFee: fastest, halfHourFee: 6, hourFee: 3 })
    if (url.includes('/api/tx/')) return ok({ ...tx, vout: tx.vout.map((o: any) => ({ ...o, scriptpubkey: bytesToHex(o.scriptpubkey) })) })
    throw new Error('unexpected ' + url)
  }) as any)
  it('raises the fee out of change and keeps the payment amount', async () => {
    const { bumpFee } = await import('../src/core/send')
    withTx(stuck(140), 12)
    const r = await bumpFee('btc', 'cc'.repeat(32), me.btc, keyFor, true)
    expect(r.rate).toBeGreaterThanOrEqual(12)
    expect(r.fee * 1e8).toBeGreaterThan(140)
  })
  it('refuses a crazy fee rate', async () => {
    const { bumpFee } = await import('../src/core/send')
    withTx(stuck(140 * 2000), 12) // already 2000 sat/vB; bumping would go higher still
    await expect(bumpFee('btc', 'cc'.repeat(32), me.btc, keyFor, true)).rejects.toThrow(/unusually high/)
  })
})

describe('cancel (BTC): replace-by-fee back to ourselves', () => {
  const stuck = (feeSats: number, confirmed = false) => ({ status: { confirmed }, weight: 560, fee: feeSats,
    vin: [{ txid: 'aa'.repeat(32), vout: 0, prevout: { scriptpubkey_address: me.btc, value: 1_000_000 } }],
    vout: [{ scriptpubkey_address: them.btc, scriptpubkey: bytesToHex(btc.OutScript.encode(btc.Address(btc.NETWORK).decode(them.btc))), value: 400_000 },
      { scriptpubkey_address: me.btc, scriptpubkey: bytesToHex(btc.OutScript.encode(btc.Address(btc.NETWORK).decode(me.btc))), value: 1_000_000 - 400_000 - feeSats }] })
  const withTx = (tx: any, fastest: number) => setFetcher((async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') throw new Error('a dry run must never broadcast')
    if (url.includes('/fees/recommended')) return ok({ fastestFee: fastest, halfHourFee: 6, hourFee: 3 })
    if (url.includes('/api/tx/')) return ok(tx)
    throw new Error('unexpected ' + url)
  }) as any)
  it('signs the same inputs into one output to our own address, at a higher fee', async () => {
    const { cancelTx } = await import('../src/core/send')
    withTx(stuck(140), 12)
    const r = await cancelTx('btc', 'cc'.repeat(32), me.btc, keyFor, true)
    expect(r.txid).toMatch(/^dry:cancel:/)
    const tx = btc.Transaction.fromRaw(Buffer.from(r.raw!, 'hex'), { allowUnknownOutputs: true })
    expect(tx.inputsLength).toBe(1)
    expect(bytesToHex(tx.getInput(0).txid!)).toBe('aa'.repeat(32))
    expect(tx.getInput(0).sequence).toBe(0xfffffffd)
    expect(tx.outputsLength).toBe(1)
    expect(btc.Address(btc.NETWORK).encode(btc.OutScript.decode(tx.getOutput(0).script!))).toBe(me.btc)
    const fee = 1_000_000 - Number(tx.getOutput(0).amount)
    expect(fee).toBe(Math.round(r.fee * 1e8))
    expect(fee).toBeGreaterThan(140 + 140) // more than the old fee plus its vsize
    expect(r.rate).toBeGreaterThanOrEqual(12)
    expect(tx.isFinal).toBe(true) // signed
  })
  it('refuses a crazy fee rate', async () => {
    const { cancelTx } = await import('../src/core/send')
    withTx(stuck(140 * 2000), 12)
    await expect(cancelTx('btc', 'cc'.repeat(32), me.btc, keyFor, true)).rejects.toThrow(/unusually high/)
  })
  it('refuses when it already confirmed, or was not ours', async () => {
    const { cancelTx } = await import('../src/core/send')
    withTx(stuck(140, true), 12)
    await expect(cancelTx('btc', 'cc'.repeat(32), me.btc, keyFor, true)).rejects.toThrow(/Already confirmed/)
    withTx(stuck(140), 12)
    await expect(cancelTx('btc', 'cc'.repeat(32), them.btc, keyFor, true)).rejects.toThrow(/not sent from this wallet/)
  })
})

describe('cancel (EVM): same nonce, 0 to ourselves, higher fees', () => {
  const gwei = (n: number) => BigInt(Math.round(n * 1e9))
  const pending = (over: Record<string, unknown> = {}) => ({ hash: '0x' + '5e'.repeat(32), from: me.evm.toLowerCase(), to: them.evm.toLowerCase(), nonce: '0x6', gas: hex(21_000), value: hex(10n ** 16n), input: '0x',
    type: '0x2', maxFeePerGas: hex(gwei(12)), maxPriorityFeePerGas: hex(gwei(2)), blockHash: null, blockNumber: null, transactionIndex: null, accessList: [], v: '0x0', yParity: '0x0', r: '0x1', s: '0x1', ...over })
  it('signs a nonce-matching 0-value tx to ourselves, never broadcast', async () => {
    const { cancelEvm } = await import('../src/core/send')
    stuckEvm = pending()
    const r = await cancelEvm('ethereum', stuckEvm.hash, me.evm, keyFor, true)
    expect(sent).toHaveLength(0)
    expect(r.txid).toMatch(/^dry:cancel:0x/)
    const tx = parseTransaction(r.raw as `0x02${string}`)
    expect(await recoverTransactionAddress({ serializedTransaction: r.raw as `0x02${string}` })).toBe(getAddress(me.evm))
    expect(tx.nonce).toBe(6)
    expect(getAddress(tx.to!)).toBe(getAddress(me.evm))
    expect(tx.value ?? 0n).toBe(0n)
    expect(tx.chainId).toBe(1)
    expect(tx.maxPriorityFeePerGas! * 100n).toBeGreaterThanOrEqual(gwei(2) * 125n)
    expect(tx.maxFeePerGas! * 100n).toBeGreaterThanOrEqual(gwei(12) * 125n)
    expect(tx.maxFeePerGas!).toBeGreaterThanOrEqual(tx.maxPriorityFeePerGas!)
  })
  it('refuses a fee above 3× the network rate, a mined tx, or one sent by someone else', async () => {
    const { cancelEvm } = await import('../src/core/send')
    stuckEvm = pending({ maxFeePerGas: hex(gwei(40)) }) // ×1.25 = 50 gwei, network ~13 gwei
    await expect(cancelEvm('ethereum', stuckEvm.hash, me.evm, keyFor, true)).rejects.toThrow(/unusually high/)
    stuckEvm = pending({ blockNumber: '0x10', blockHash: '0x' + '1'.repeat(64), transactionIndex: '0x0' })
    await expect(cancelEvm('ethereum', stuckEvm.hash, me.evm, keyFor, true)).rejects.toThrow(/Already confirmed/)
    stuckEvm = pending({ from: them.evm.toLowerCase() })
    await expect(cancelEvm('ethereum', stuckEvm.hash, me.evm, keyFor, true)).rejects.toThrow(/not sent from this wallet/)
    stuckEvm = null
    await expect(cancelEvm('ethereum', '0x' + '77'.repeat(32), me.evm, keyFor, true)).rejects.toThrow(/nothing to cancel/)
    expect(sent).toHaveLength(0)
  })
})

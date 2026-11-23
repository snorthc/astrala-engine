// What a website can ask Astrala to sign: the checks, the plain-words description, and the signatures themselves.
// The chain is faked and transactions are signed dry (never broadcast).
import { describe, it, expect, beforeEach } from 'vitest'
import { encodeFunctionData, erc20Abi, parseAbi, parseTransaction, recoverTransactionAddress, verifyMessage, verifyTypedData, getAddress } from 'viem'
import { setFetcher } from '../src/core/chain'
import { ASSETS } from '../src/core/assets'
import { deriveAccount, signingKey } from '../src/core/derive'
import { parseDappRequest, describeDapp, signDappMessage, signDappTyped, sendDappTx, planDappTx, DappError, hostOf, drainBlock, lookalikeSite } from '../src/core/dapp'

const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const me = deriveAccount(M, 0).find((a) => a.chain === 'evm')!.address
const other = deriveAccount(M, 1).find((a) => a.chain === 'evm')!.address
const keyFor = (f: any) => signingKey(M, f, 0)
const usdc = ASSETS.find((a) => a.network === 'ethereum' && a.kind === 'token' && a.symbol === 'USDC')!
const ctx = { origin: 'https://app.example', network: 'ethereum' }
const SPENDER = getAddress('0x000000000022d473030f116ddee9f6b43ac78ba3')
const hexText = (t: string) => '0x' + Buffer.from(t).toString('hex')

let revert = false, balance = 10n ** 18n, broadcast: string[] = []
beforeEach(() => {
  revert = false; balance = 10n ** 18n; broadcast = []
  setFetcher((async (_url: string, init: any) => {
    const body = JSON.parse(init.body), one = (r: any) => {
      const hex = (n: bigint | number) => '0x' + BigInt(n).toString(16)
      switch (r.method) {
        case 'eth_chainId': return hex(1)
        case 'eth_getBalance': return hex(balance)
        case 'eth_estimateGas': if (revert) throw new Error('execution reverted'); return hex(60_000)
        case 'eth_maxPriorityFeePerGas': return hex(1_000_000_000)
        case 'eth_gasPrice': return hex(20_000_000_000)
        case 'eth_getBlockByNumber': return { baseFeePerGas: hex(10_000_000_000), number: '0x1', hash: '0x' + '1'.repeat(64), timestamp: '0x1', transactions: [] }
        case 'eth_getTransactionCount': return '0x7'
        case 'eth_sendRawTransaction': broadcast.push(r.params[0]); return '0x' + 'ab'.repeat(32)
      }
      throw new Error('unhandled ' + r.method)
    }
    const answer = (r: any) => { try { return { jsonrpc: '2.0', id: r.id, result: one(r) } } catch (e: any) { return { jsonrpc: '2.0', id: r.id, error: { code: 3, message: e.message } } } }
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as any)
})

describe('what a site may ask for', () => {
  it('only for the connected address and network, never a deployment or a raw hash', () => {
    expect(() => parseDappRequest('personal_sign', [hexText('hi'), other], me, 1)).toThrow(DappError)
    expect(() => parseDappRequest('eth_sendTransaction', [{ from: other, to: me, value: '0x1' }], me, 1)).toThrow(/different address/)
    expect(() => parseDappRequest('eth_sendTransaction', [{ from: me, to: other, value: '0x1', chainId: '0x89' }], me, 1)).toThrow(/different network/)
    expect(() => parseDappRequest('eth_sendTransaction', [{ from: me, data: '0x6080' }], me, 1)).toThrow(/deploy/)
    expect(() => parseDappRequest('eth_sign', [me, '0x' + '11'.repeat(32)], me, 1)).toThrow(DappError)
    expect(() => parseDappRequest('eth_signTypedData_v4', [me, JSON.stringify({ domain: { chainId: 137 }, types: { A: [] }, primaryType: 'A', message: {} })], me, 1)).toThrow(/different network/)
    // both argument orders of personal_sign
    expect(parseDappRequest('personal_sign', [hexText('hi'), me], me, 1)).toMatchObject({ kind: 'message', text: 'hi' })
    expect(parseDappRequest('personal_sign', [me, 'hi'], me, 1)).toMatchObject({ kind: 'message', text: 'hi' })
  })
  it('keeps a crafted origin out of the prompt', () => {
    expect(hostOf('https://app.example')).toBe('app.example')
    expect(hostOf('not a url')).toBe('an unknown site')
  })
})

describe('what the person is told', () => {
  it('flags a sign-in for another site, and unreadable 32-byte data', () => {
    const phish = parseDappRequest('personal_sign', [hexText('uniswap.org wants you to sign in with your Ethereum account:\n' + me), me], me, 1)
    expect(describeDapp(phish, ctx).warnings[0]).toMatchObject({ level: 'danger' })
    const honest = parseDappRequest('personal_sign', [hexText('app.example wants you to sign in with your Ethereum account:\n' + me), me], me, 1)
    expect(describeDapp(honest, ctx).warnings).toEqual([])
    const blob = parseDappRequest('personal_sign', ['0x' + 'fe'.repeat(32), me], me, 1)
    expect(describeDapp(blob, ctx).warnings[0].level).toBe('danger')
  })
  it('calls a permit a spending permission, not a sign-in', () => {
    const typed = { domain: { name: 'USD Coin', chainId: 1, verifyingContract: usdc.contract }, primaryType: 'Permit', types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] }, message: { owner: me, spender: SPENDER, value: '1000000', nonce: 0, deadline: 9999999999 } }
    const v = describeDapp(parseDappRequest('eth_signTypedData_v4', [me, JSON.stringify(typed)], me, 1), ctx)
    expect(v.title).toBe('Sign a spending permission')
    expect(v.warnings[0]).toMatchObject({ level: 'danger' })
    expect(v.lines.find((l) => l.label === 'spender')?.value).toBe(SPENDER)
  })
  it('shows what is signed, not decoy keys, and flags a list too long to show', () => {
    const D = { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }] }
    // 50 decoy keys before the real one: they aren't in the types, so they aren't signed and aren't shown
    const decoys = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`note${i}`, 'harmless']))
    const padded = { domain: { name: 'X', chainId: 1 }, primaryType: 'Order', types: { ...D, Order: [{ name: 'spender', type: 'address' }] }, message: { ...decoys, spender: SPENDER } }
    const a = describeDapp(parseDappRequest('eth_signTypedData_v4', [me, JSON.stringify(padded)], me, 1), ctx)
    expect(a.lines.find((l) => l.label === 'spender')?.value).toBe(SPENDER)
    expect(a.lines.some((l) => l.label.startsWith('note'))).toBe(false)
    expect(a.warnings.some((w) => /isn't part of what you sign/.test(w.text))).toBe(true)
    // 80 real signed fields: more than fit, so the review says so in red
    const many = Array.from({ length: 80 }, (_, i) => ({ name: `f${i}`, type: 'uint256' }))
    const long = { domain: { name: 'X', chainId: 1 }, primaryType: 'Big', types: { ...D, Big: many }, message: Object.fromEntries(many.map((f, i) => [f.name, i])) }
    const b = describeDapp(parseDappRequest('eth_signTypedData_v4', [me, JSON.stringify(long)], me, 1), ctx)
    expect(b.warnings.some((w) => w.level === 'danger' && /80 fields/.test(w.text))).toBe(true)
  })
  it('reads transfers and approvals, and says so when it cannot read a call', () => {
    const tx = (data: string, value = '0x0', to = usdc.contract!) => describeDapp(parseDappRequest('eth_sendTransaction', [{ from: me, to, data, value }], me, 1), ctx)
    const send = tx(encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [other as `0x${string}`, 12_500_000n] }))
    expect(send.summary).toContain('Send 12.5 USDC')
    expect(send.spend).toEqual({ assetId: usdc.id, amount: 12.5, to: other })
    const unlimited = tx(encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [SPENDER, 2n ** 256n - 1n] }))
    expect(unlimited.warnings[0]).toMatchObject({ level: 'danger' })
    expect(unlimited.lines.find((l) => l.label === 'Up to')?.value).toBe('Unlimited USDC')
    expect(unlimited.spend).toBeUndefined() // an approval moves nothing now
    const all = tx(encodeFunctionData({ abi: parseAbi(['function setApprovalForAll(address operator, bool approved)']), functionName: 'setApprovalForAll', args: [SPENDER, true] }))
    expect(all.warnings[0].level).toBe('danger')
    const unknown = tx('0xdeadbeef00', '0x' + (10n ** 17n).toString(16), other)
    expect(unknown.title).toBe('Call a contract')
    expect(unknown.warnings[0].level).toBe('warn')
    expect(unknown.spend).toEqual({ assetId: 'eth', amount: 0.1, to: other })
    const plain = describeDapp(parseDappRequest('eth_sendTransaction', [{ from: me, to: other, value: '0x' + (5n * 10n ** 17n).toString(16) }], me, 1), ctx)
    expect(plain.summary).toContain('Send 0.5 ETH')
  })
})

describe('drain guard', () => {
  const known = (sp: string) => sp.toLowerCase() === SPENDER.toLowerCase()
  const THIEF = getAddress('0x00000000000000000000000000000000deadbeef')
  const approve = (spender: string, amount: bigint) => describeDapp(parseDappRequest('eth_sendTransaction', [{ from: me, to: usdc.contract, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender as `0x${string}`, amount] }) }], me, 1), ctx)
  const permit = (spender: string) => describeDapp(parseDappRequest('eth_signTypedData_v4', [me, { domain: { name: 'USD Coin', chainId: 1, verifyingContract: usdc.contract }, primaryType: 'Permit', types: { EIP712Domain: [], Permit: [{ name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }] }, message: { spender, value: '1' } }], me, 1), ctx)
  it('blocks the ways wallets get emptied, to contracts it does not know', () => {
    expect(drainBlock(approve(THIEF, 2n ** 256n - 1n), known)).toMatch(/unlimited USDC/)
    // unlimited in practice counts too: 2^254, 1e40
    expect(drainBlock(approve(THIEF, 2n ** 254n), known)).toMatch(/unlimited USDC/)
    expect(drainBlock(approve(THIEF, 10n ** 40n), known)).toMatch(/unlimited USDC/)
    expect(drainBlock(permit(THIEF), known)).toMatch(/take your USD Coin later/)
    const all = describeDapp(parseDappRequest('eth_sendTransaction', [{ from: me, to: other, data: encodeFunctionData({ abi: parseAbi(['function setApprovalForAll(address operator, bool approved)']), functionName: 'setApprovalForAll', args: [THIEF, true] }) }], me, 1), ctx)
    expect(drainBlock(all, known)).toMatch(/every NFT/)
    expect(drainBlock(describeDapp(parseDappRequest('personal_sign', ['0x' + 'fe'.repeat(32), me], me, 1), ctx), known)).toMatch(/unreadable/)
    expect(drainBlock(describeDapp(parseDappRequest('personal_sign', [hexText('uniswap.org wants you to sign in with your Ethereum account:\n' + me), me], me, 1), ctx), known)).toMatch(/different website/)
  })
  it('lets ordinary things through: a known router, a limited approval, a plain send, an honest sign-in', () => {
    expect(drainBlock(approve(SPENDER, 2n ** 256n - 1n), known)).toBeNull()
    expect(drainBlock(permit(SPENDER), known)).toBeNull()
    expect(drainBlock(approve(THIEF, 5_000_000n), known)).toBeNull() // shown with a warning, not blocked
    expect(drainBlock(describeDapp(parseDappRequest('eth_sendTransaction', [{ from: me, to: other, value: '0x1' }], me, 1), ctx), known)).toBeNull()
    expect(drainBlock(describeDapp(parseDappRequest('personal_sign', [hexText('app.example wants you to sign in with your Ethereum account:\n' + me), me], me, 1), ctx), known)).toBeNull()
  })
  it('spots a site dressed up as a well-known one, and leaves real and unrelated sites alone', () => {
    for (const fake of ['unlswap.org', 'uniswap.xyz', 'app.uniswap-claim.org', 'uniswap.rewards.io', 'opensea.io.airdrop-site.com'.replace('opensea.io.', 'opensea.'), 'xn--unswap-9ua.org', 'pancakeswap.com'])
      expect(lookalikeSite(fake), fake).not.toBeNull()
    for (const fake of ['unisvvap.org', 'rnetamask.io']) expect(lookalikeSite(fake), fake).not.toBeNull() // two letters off a long name
    for (const fine of ['app.uniswap.org', 'opensea.io', 'app.example', 'localhost:5199', '127.0.0.1:8080', 'my-own-dapp.dev', 'curve.fi', 'news.ycombinator.com', 'phantom.com', 'metamask.github.io', 'uniswap.eth.limo'])
      expect(lookalikeSite(fine), fine).toBeNull()
    expect(lookalikeSite('unlswap.org')).toBe('uniswap.org')
  })
})

describe('signing', () => {
  it('signs a message and typed data with the connected account\'s key, verifiably', async () => {
    const msg = parseDappRequest('personal_sign', [hexText('hello astrala'), me], me, 1) as any
    const sig = await signDappMessage(msg, me, keyFor)
    expect(await verifyMessage({ address: me as `0x${string}`, message: 'hello astrala', signature: sig })).toBe(true)
    const typed = { domain: { name: 'Test', version: '1', chainId: 1, verifyingContract: SPENDER }, primaryType: 'Mail', types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], Mail: [{ name: 'to', type: 'address' }, { name: 'contents', type: 'string' }] }, message: { to: other, contents: 'hi' } }
    const req = parseDappRequest('eth_signTypedData_v4', [me, typed], me, 1) as any
    const tsig = await signDappTyped(req, me, keyFor)
    expect(await verifyTypedData({ address: me as `0x${string}`, domain: typed.domain as any, types: { Mail: typed.types.Mail }, primaryType: 'Mail', message: typed.message as any, signature: tsig })).toBe(true)
    // the key must belong to the address the site is connected to
    await expect(signDappMessage(msg, other, keyFor)).rejects.toThrow(/Key mismatch/)
  })
  it('signs exactly the reviewed transaction (dry), and refuses one that would fail or can\'t be paid for', async () => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [other as `0x${string}`, 1_000_000n] })
    const req = parseDappRequest('eth_sendTransaction', [{ from: me, to: usdc.contract, data, gas: '0x1', nonce: '0x999', gasPrice: '0x1' }], me, 1) as any
    const r = await sendDappTx('ethereum', me, req, keyFor, true)
    expect(r.txid.startsWith('dry:dapp:')).toBe(true)
    expect(broadcast).toEqual([]) // dry: nothing was sent
    const tx = parseTransaction(r.raw as any)
    expect(await recoverTransactionAddress({ serializedTransaction: r.raw as any })).toBe(getAddress(me))
    expect({ to: getAddress(tx.to!), data: tx.data, value: tx.value ?? 0n, chainId: tx.chainId, nonce: tx.nonce }).toEqual({ to: getAddress(usdc.contract!), data, value: 0n, chainId: 1, nonce: 7 }) // our nonce and gas, not the site's
    expect(tx.gas).toBe(78_000n)

    revert = true
    expect((await planDappTx('ethereum', me, req)).fails).toBeTruthy()
    await expect(sendDappTx('ethereum', me, req, keyFor, true)).rejects.toThrow(/would fail/)
    revert = false; balance = 1000n
    await expect(sendDappTx('ethereum', me, req, keyFor, true)).rejects.toThrow(/Not enough ETH/)
  })
})

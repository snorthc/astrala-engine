// Pins our SPL helpers to the official @solana/spl-token output (captured from v0.4.15 before it was removed).
import { describe, it, expect } from 'vitest'
import { PublicKey } from '@solana/web3.js'
import * as spl from '../src/core/spl'

const mint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') // USDC
const owner = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')
const other = new PublicKey('7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2')

const OFFICIAL = {"ata": "FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B", "t": [12, 32, 188, 190, 0, 0, 0, 0, 0, 6], "tk": [["9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", false, true], ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", false, false], ["7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2", false, true], ["9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", true, false]], "c": [1], "ck": [["9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", true, true], ["GxJZkAYCqWF6iaTE9HXKUBvW4ni6mSdePMG23TGwDLNi", false, true], ["7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2", false, false], ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", false, false], ["11111111111111111111111111111111", false, false], ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", false, false]]}
const keys = (ix: any) => ix.keys.map((k: any) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])

describe('SPL helpers', () => {
  it('match spl-token byte for byte', () => {
    const t = spl.createTransferCheckedInstruction(owner, mint, other, owner, 12_500_000n, 6)
    const c = spl.createAssociatedTokenAccountIdempotentInstruction(owner, spl.getAssociatedTokenAddressSync(mint, other), other, mint)
    expect([...t.data]).toEqual(OFFICIAL.t); expect(keys(t)).toEqual(OFFICIAL.tk)
    expect([...c.data]).toEqual(OFFICIAL.c); expect(keys(c)).toEqual(OFFICIAL.ck)
  })
  it('derive the same associated token address as spl-token', () => {
    expect(spl.getAssociatedTokenAddressSync(mint, owner).toBase58()).toBe('FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B')
  })
  it('encode TransferChecked as instruction 12, u64 LE amount, decimals', () => {
    const ix = spl.createTransferCheckedInstruction(owner, mint, other, owner, 12_500_000n, 6)
    expect([...ix.data]).toEqual([12, 0x20, 0xbc, 0xbe, 0, 0, 0, 0, 0, 6])
    expect(ix.keys.map((k) => [k.isSigner, k.isWritable])).toEqual([[false, true], [false, false], [false, true], [true, false]])
    expect(() => spl.createTransferCheckedInstruction(owner, mint, other, owner, 1n << 64n, 6)).toThrow()
  })
  it('encode CreateIdempotent as instruction 1 with six accounts', () => {
    const ix = spl.createAssociatedTokenAccountIdempotentInstruction(owner, spl.getAssociatedTokenAddressSync(mint, other), other, mint)
    expect([...ix.data]).toEqual([1])
    expect(ix.keys).toHaveLength(6)
    expect(ix.programId.toBase58()).toBe('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
  })
})

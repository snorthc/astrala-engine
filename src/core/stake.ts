// Native SOL staking. Your SOL never leaves your control: it moves into stake accounts that only your
// key can withdraw from, delegated to a validator you pick. Accounts are derived from your address with
// a fixed seed ("astrala-0", "astrala-1", …), so Astrala finds them again without any index service.
import { PublicKey, StakeProgram, Authorized, Keypair, Transaction, ComputeBudgetProgram, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { solConn } from './send'

const SEEDS = 12
const seed = (i: number) => `astrala-${i}`
const U64_MAX = '18446744073709551615'

export interface StakeAccount { seed: number; address: string; sol: number; state: 'activating' | 'active' | 'deactivating' | 'inactive' | 'empty'; validator?: string; withdrawable: boolean }
export interface Validator { vote: string; commission: number; stakeSol: number; skipRate?: number }

export async function stakeAccounts(owner: string): Promise<{ accounts: StakeAccount[]; epoch: number; epochProgress: number }> {
  const conn = solConn()
  const base = new PublicKey(owner)
  const addrs = await Promise.all(Array.from({ length: SEEDS }, (_, i) => PublicKey.createWithSeed(base, seed(i), StakeProgram.programId)))
  const [infos, ep] = await Promise.all([conn.getMultipleParsedAccounts(addrs), conn.getEpochInfo()])
  const accounts: StakeAccount[] = []
  infos.value.forEach((acc, i) => {
    if (!acc) return
    const data: any = (acc.data as any)?.parsed
    const d = data?.info?.stake?.delegation
    let state: StakeAccount['state'] = 'inactive'
    if (d) {
      const act = Number(d.activationEpoch), deact = d.deactivationEpoch === U64_MAX ? Infinity : Number(d.deactivationEpoch)
      state = deact <= ep.epoch ? 'inactive' : deact !== Infinity ? 'deactivating' : act >= ep.epoch ? 'activating' : 'active'
    }
    accounts.push({ seed: i, address: addrs[i].toBase58(), sol: acc.lamports / LAMPORTS_PER_SOL, state, validator: d?.voter, withdrawable: state === 'inactive' })
  })
  return { accounts, epoch: ep.epoch, epochProgress: ep.slotIndex / ep.slotsInEpoch }
}

/** Healthy, low-commission validators outside the top third by stake, so your SOL helps decentralise the network. */
export async function validators(): Promise<Validator[]> {
  const v = await solConn().getVoteAccounts()
  const live = v.current.filter((x) => x.commission <= 7 && x.epochVoteAccount)
  const sorted = [...live].sort((a, b) => b.activatedStake - a.activatedStake)
  const total = sorted.reduce((s, x) => s + x.activatedStake, 0)
  let acc = 0
  const outsideSuperminority = sorted.filter((x) => { acc += x.activatedStake; return acc > total / 3 })
  const credits = (x: (typeof live)[number]) => { const e = x.epochCredits.slice(-3); return e.reduce((s, [, c, p]) => s + (c - p), 0) }
  return outsideSuperminority
    .filter((x) => x.activatedStake > 50_000 * LAMPORTS_PER_SOL)
    .sort((a, b) => credits(b) - credits(a) || a.commission - b.commission)
    .slice(0, 12)
    .map((x) => ({ vote: x.votePubkey, commission: x.commission, stakeSol: Math.round(x.activatedStake / LAMPORTS_PER_SOL) }))
}

async function nextFreeSeed(base: PublicKey) {
  const conn = solConn()
  const addrs = await Promise.all(Array.from({ length: SEEDS }, (_, i) => PublicKey.createWithSeed(base, seed(i), StakeProgram.programId)))
  const infos = await conn.getMultipleAccountsInfo(addrs)
  const i = infos.findIndex((x) => !x)
  if (i < 0) throw new Error('All 12 stake slots are in use. Withdraw an inactive one first.')
  return { i, addr: addrs[i] }
}

async function sendTx(kp: Keypair, tx: Transaction, dry: boolean) {
  const conn = solConn()
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash()
  tx.recentBlockhash = blockhash
  tx.lastValidBlockHeight = lastValidBlockHeight
  tx.feePayer = kp.publicKey
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }))
  tx.sign(kp)
  if (dry) return `dry:${tx.instructions.length}:${Buffer.from(tx.serialize()).toString('base64').slice(0, 60)}`
  return conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 })
}

export async function stakeMinimum() {
  const conn = solConn()
  const [rent, min] = await Promise.all([conn.getMinimumBalanceForRentExemption(StakeProgram.space), conn.getStakeMinimumDelegation().then((r) => r.value).catch(() => LAMPORTS_PER_SOL / 100)])
  return { rentSol: rent / LAMPORTS_PER_SOL, minDelegationSol: min / LAMPORTS_PER_SOL }
}

export async function stake(priv: Uint8Array, owner: string, amountSol: number, vote: string, dry = false) {
  const kp = Keypair.fromSeed(priv)
  if (kp.publicKey.toBase58() !== owner) throw new Error('Key mismatch')
  const { rentSol, minDelegationSol } = await stakeMinimum()
  if (amountSol < Math.max(minDelegationSol, 0.01)) throw new Error(`Stake at least ${Math.max(minDelegationSol, 0.01)} SOL`)
  const { i, addr } = await nextFreeSeed(kp.publicKey)
  const lamports = Math.round((amountSol + rentSol) * LAMPORTS_PER_SOL)
  const tx = new Transaction()
    .add(StakeProgram.createAccountWithSeed({ fromPubkey: kp.publicKey, stakePubkey: addr, basePubkey: kp.publicKey, seed: seed(i), authorized: new Authorized(kp.publicKey, kp.publicKey), lamports }))
    .add(StakeProgram.delegate({ stakePubkey: addr, authorizedPubkey: kp.publicKey, votePubkey: new PublicKey(vote) }))
  return { txid: await sendTx(kp, tx, dry), stakeAccount: addr.toBase58() }
}

export async function unstake(priv: Uint8Array, owner: string, stakeAddr: string, dry = false) {
  const kp = Keypair.fromSeed(priv)
  if (kp.publicKey.toBase58() !== owner) throw new Error('Key mismatch')
  return sendTx(kp, StakeProgram.deactivate({ stakePubkey: new PublicKey(stakeAddr), authorizedPubkey: kp.publicKey }), dry)
}

export async function withdrawStake(priv: Uint8Array, owner: string, stakeAddr: string, dry = false) {
  const kp = Keypair.fromSeed(priv)
  if (kp.publicKey.toBase58() !== owner) throw new Error('Key mismatch')
  const lamports = await solConn().getBalance(new PublicKey(stakeAddr))
  return sendTx(kp, StakeProgram.withdraw({ stakePubkey: new PublicKey(stakeAddr), authorizedPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports }), dry)
}

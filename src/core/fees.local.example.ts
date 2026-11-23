// Copy this file to fees.local.ts (same folder) and paste your PUBLIC keys. fees.local.ts is gitignored and never
// exported, so your fee wallets stay out of the repo and out of the app's screens. Never paste a seed phrase or a
// private key (xprv/zprv): Astrala refuses private keys, and fees only need the public side.
//
// Where to find each: in your wallet's account details, "extended public key" / "xpub" / "zpub".
//   btc  m/84'/0'/0'   (zpub from Sparrow, Electrum, Ledger, Trezor…)
//   ltc  m/84'/2'/0'
//   evm  m/44'/60'/0'  (one key covers Ethereum, Arbitrum, Base, BNB… — same addresses on all)
//   doge m/44'/3'/0'
//   trx  m/44'/195'/0'
// Solana and Monero can't be derived from a public key, so they take one fixed address. Any other chain can also take
// a fixed address instead of an xpub (then its fee always lands in that one address rather than rotating daily).
import type { FeeWallets } from './fee-wallets'

const wallets: FeeWallets = {
  xpub: { btc: '', ltc: '', evm: '', doge: '', trx: '' },
  fixed: { sol: '', xmr: '' },
  pool: 20 // the address changes daily and cycles through the first 20 of each account
}
export default wallets

// Registry of every network and asset Astrala supports. Pure data, shared by main process and UI.
export type Family = 'xmr' | 'evm' | 'sol' | 'ltc' | 'btc' | 'doge' | 'trx'

export interface Network {
  id: string
  name: string
  family: Family
  chainId?: number
  rpc: string[]
  native: string // asset id of the gas coin
  explorerTx: string // {tx}
}

export interface Asset {
  id: string
  symbol: string
  name: string
  network: string
  kind: 'native' | 'token'
  contract?: string
  decimals: number
  cg: string // coingecko id, or `ct:<network>:<contract>` for an unlisted token (priced by contract)
  rank: number // display order when balances are equal
  custom?: boolean // added by the user
  logo?: string // data: URL (custom tokens only; fetched once through the routed network, never from the UI)
  verified?: boolean // listed on CoinGecko / Jupiter verified; false = pasted address with no listing
}

/** A token the user added. Stored inside the encrypted vault; decimals always read on-chain at add time. */
export interface CustomToken { network: string; contract: string; symbol: string; name: string; decimals: number; cg?: string; logo?: string; verified: boolean; added: number }
export const TOKEN_NETWORKS = ['ethereum', 'arbitrum', 'base', 'optimism', 'polygon', 'bsc', 'avalanche', 'solana', 'tron']

export const NETWORKS: Record<string, Network> = {
  monero: { id: 'monero', name: 'Monero', family: 'xmr', rpc: [], native: 'xmr', explorerTx: 'https://xmrchain.net/tx/{tx}' },
  bitcoin: { id: 'bitcoin', name: 'Bitcoin', family: 'btc', rpc: ['https://mempool.space'], native: 'btc', explorerTx: 'https://mempool.space/tx/{tx}' },
  litecoin: { id: 'litecoin', name: 'Litecoin', family: 'ltc', rpc: ['https://litecoinspace.org'], native: 'ltc', explorerTx: 'https://litecoinspace.org/tx/{tx}' },
  dogecoin: { id: 'dogecoin', name: 'Dogecoin', family: 'doge', rpc: ['https://api.blockcypher.com/v1/doge/main'], native: 'doge', explorerTx: 'https://blockchair.com/dogecoin/transaction/{tx}' },
  solana: { id: 'solana', name: 'Solana', family: 'sol', rpc: ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'], native: 'sol', explorerTx: 'https://solscan.io/tx/{tx}' },
  tron: { id: 'tron', name: 'Tron', family: 'trx', rpc: ['https://api.trongrid.io'], native: 'trx', explorerTx: 'https://tronscan.org/#/transaction/{tx}' },
  ethereum: { id: 'ethereum', name: 'Ethereum', family: 'evm', chainId: 1, rpc: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com'], native: 'eth', explorerTx: 'https://etherscan.io/tx/{tx}' },
  arbitrum: { id: 'arbitrum', name: 'Arbitrum', family: 'evm', chainId: 42161, rpc: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'], native: 'eth-arbitrum', explorerTx: 'https://arbiscan.io/tx/{tx}' },
  base: { id: 'base', name: 'Base', family: 'evm', chainId: 8453, rpc: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'], native: 'eth-base', explorerTx: 'https://basescan.org/tx/{tx}' },
  optimism: { id: 'optimism', name: 'Optimism', family: 'evm', chainId: 10, rpc: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'], native: 'eth-optimism', explorerTx: 'https://optimistic.etherscan.io/tx/{tx}' },
  polygon: { id: 'polygon', name: 'Polygon', family: 'evm', chainId: 137, rpc: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'], native: 'pol', explorerTx: 'https://polygonscan.com/tx/{tx}' },
  bsc: { id: 'bsc', name: 'BNB Chain', family: 'evm', chainId: 56, rpc: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org'], native: 'bnb', explorerTx: 'https://bscscan.com/tx/{tx}' },
  avalanche: { id: 'avalanche', name: 'Avalanche', family: 'evm', chainId: 43114, rpc: ['https://avalanche-c-chain-rpc.publicnode.com', 'https://api.avax.network/ext/bc/C/rpc'], native: 'avax', explorerTx: 'https://snowtrace.io/tx/{tx}' }
}

const n = (id: string, symbol: string, name: string, network: string, decimals: number, cg: string, rank: number): Asset => ({ id, symbol, name, network, kind: 'native', decimals, cg, rank })
const t = (symbol: 'USDT' | 'USDC', network: string, contract: string, decimals: number, rank: number): Asset => ({
  id: `${symbol.toLowerCase()}-${network}`, symbol, name: symbol === 'USDT' ? 'Tether' : 'USD Coin', network, kind: 'token', contract, decimals, cg: symbol === 'USDT' ? 'tether' : 'usd-coin', rank
})

export const ASSETS: Asset[] = [
  n('xmr', 'XMR', 'Monero', 'monero', 12, 'monero', 9),
  n('eth', 'ETH', 'Ethereum', 'ethereum', 18, 'ethereum', 1),
  n('sol', 'SOL', 'Solana', 'solana', 9, 'solana', 3),
  n('ltc', 'LTC', 'Litecoin', 'litecoin', 8, 'litecoin', 4),
  n('btc', 'BTC', 'Bitcoin', 'bitcoin', 8, 'bitcoin', 2),
  t('USDT', 'tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 6, 6),
  t('USDT', 'ethereum', '0xdAC17F958D2ee523a2206206994597C13D831ec7', 6, 7),
  t('USDC', 'ethereum', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6, 8),
  t('USDC', 'solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6, 9),
  t('USDT', 'solana', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 6, 10),
  n('trx', 'TRX', 'Tron', 'tron', 6, 'tron', 11),
  n('bnb', 'BNB', 'BNB', 'bsc', 18, 'binancecoin', 12),
  n('doge', 'DOGE', 'Dogecoin', 'dogecoin', 8, 'dogecoin', 13),
  n('eth-arbitrum', 'ETH', 'Ethereum', 'arbitrum', 18, 'ethereum', 14),
  n('eth-base', 'ETH', 'Ethereum', 'base', 18, 'ethereum', 15),
  n('eth-optimism', 'ETH', 'Ethereum', 'optimism', 18, 'ethereum', 16),
  n('pol', 'POL', 'Polygon', 'polygon', 18, 'polygon-ecosystem-token', 17),
  n('avax', 'AVAX', 'Avalanche', 'avalanche', 18, 'avalanche-2', 18),
  t('USDC', 'base', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6, 19),
  t('USDC', 'arbitrum', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6, 20),
  t('USDT', 'arbitrum', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6, 21),
  t('USDT', 'bsc', '0x55d398326f99059fF775485246999027B3197955', 18, 22),
  t('USDC', 'bsc', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18, 23),
  t('USDT', 'polygon', '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 6, 24),
  t('USDC', 'polygon', '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 6, 25),
  t('USDC', 'optimism', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 6, 26),
  t('USDT', 'optimism', '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 6, 27),
  t('USDC', 'avalanche', '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', 6, 28),
  t('USDT', 'avalanche', '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', 6, 29)
]

export const ASSET = Object.fromEntries(ASSETS.map((a) => [a.id, a])) as Record<string, Asset>
export const familyOf = (assetId: string): Family => NETWORKS[ASSET[assetId].network].family
export const networkOf = (assetId: string): Network => NETWORKS[ASSET[assetId].network]
export const coingeckoIds = () => [...new Set(ASSETS.map((a) => a.cg).filter((c) => !c.startsWith('ct:')))]

// EVM addresses are case-insensitive; Solana/Tron base58 is not.
export const tokenId = (network: string, contract: string) => `tok-${network}-${NETWORKS[network]?.family === 'evm' ? contract.toLowerCase() : contract}`
/** Find an asset (built-in or custom) by network + contract. */
export const assetByContract = (network: string, contract: string) =>
  ASSETS.find((a) => a.network === network && a.kind === 'token' && (NETWORKS[network].family === 'evm' ? a.contract!.toLowerCase() === contract.toLowerCase() : a.contract === contract))

/** Replace the user's custom tokens in the shared registry (ASSETS/ASSET are mutated in place so every importer sees them). */
export function registerTokens(list: CustomToken[]): Asset[] {
  for (let i = ASSETS.length - 1; i >= 0; i--) if (ASSETS[i].custom) { delete ASSET[ASSETS[i].id]; ASSETS.splice(i, 1) }
  const added: Asset[] = []
  list.forEach((t, i) => {
    if (!TOKEN_NETWORKS.includes(t.network) || assetByContract(t.network, t.contract)) return // built-ins win
    const a: Asset = { id: tokenId(t.network, t.contract), symbol: t.symbol, name: t.name, network: t.network, kind: 'token', contract: t.contract, decimals: t.decimals, cg: t.cg || `ct:${t.network}:${t.contract}`, rank: 100 + i, custom: true, logo: t.logo, verified: t.verified }
    if (ASSET[a.id]) return
    ASSETS.push(a); ASSET[a.id] = a; added.push(a)
  })
  return added
}

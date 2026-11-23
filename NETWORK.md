# Every server Astrala talks to

All of these are public services, run by others, except the one in "Astrala's notice file" below. All traffic goes through your chosen route (Direct, Tor, Mullvad or your own proxy). With the kill switch on, nothing leaves if the route drops.

Watch it yourself with [LuLu](https://objective-see.org/products/lulu.html) (free) or Little Snitch. You should see only the hosts below.

## Balances, history and broadcasting transactions

| Network | Hosts |
|---|---|
| Bitcoin | mempool.space |
| Litecoin | litecoinspace.org |
| Dogecoin | api.blockcypher.com |
| Ethereum | ethereum-rpc.publicnode.com, eth.llamarpc.com |
| Arbitrum | arbitrum-one-rpc.publicnode.com, arb1.arbitrum.io |
| Base | base-rpc.publicnode.com, mainnet.base.org |
| Optimism | optimism-rpc.publicnode.com, mainnet.optimism.io |
| Polygon | polygon-bor-rpc.publicnode.com, polygon-rpc.com |
| BNB Chain | bsc-rpc.publicnode.com, bsc-dataseed.bnbchain.org |
| Avalanche | avalanche-c-chain-rpc.publicnode.com, api.avax.network |
| EVM history | api.routescan.io |
| Solana | solana-rpc.publicnode.com, api.mainnet-beta.solana.com |
| Tron | api.trongrid.io |
| Monero | node.sethforprivacy.com, xmr-node.cakewallet.com, node.monerodevs.org, xmr.cryptostorm.is, or your own node |

These servers see your public addresses. That's how every light wallet works. Use Tor or Mullvad so they don't also see your IP address. For Monero, the node never sees your keys; scanning happens on your Mac.

## Prices and token info

| Purpose | Host |
|---|---|
| Prices | api.coingecko.com |
| Token search (Solana) | lite-api.jup.ag |

Price requests ask for coins, never for addresses.

## Swaps (only when you ask for a quote or swap)

| Protocol | Host |
|---|---|
| Jupiter (Solana) | lite-api.jup.ag |
| KyberSwap | aggregator-api.kyberswap.com |
| ParaSwap | api.paraswap.io |
| THORChain | thornode.ninerealms.com, gateway.liquify.com |
| Maya | mayanode.mayachain.info |
| LI.FI (on-chain bridges only) | li.quest |
| NEAR Intents | 1click.chaindefuser.com |

Address lookups use the same explorers and RPCs listed above, for the address you typed.

## Astrala's notice file (on launch, every 10 minutes, and when you switch back to the app)

| Purpose | Host |
|---|---|
| Latest versions, notices, and Swap/Split/Route fee rates (capped by `src/core/fees.ts`) | Astrala's own service, set at build time in `ops/hq-url.ts` (not in this repository) |

A plain download: nothing about you or your wallet is sent. A build from this repository has no address here and never makes this request.

## Updates (on launch and when you press Check now)

| Purpose | Host |
|---|---|
| Latest release, its SHA256SUMS and the .dmg | api.github.com, github.com, objects.githubusercontent.com |

## The route itself

| Purpose | Host |
|---|---|
| Download Tor, once, verified by SHA-256 | archive.torproject.org, dist.torproject.org |
| Check you're on Tor | check.torproject.org |
| Check you're on Mullvad | am.i.mullvad.net |

## Links that open in your browser

When you click "view on explorer", your browser (not Astrala) opens mempool.space, etherscan.io, solscan.io and similar. The interface can't open any other link. See `externalAllowed` in `src/main/index.ts`.

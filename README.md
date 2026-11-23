# Astrala Wallet: the engine

Astrala is a free, self-custody wallet for macOS. Your keys are made on your Mac and stay on your Mac. They never reach any server, ours included.

This repository is the part of Astrala you need to trust: everything that touches your keys, your money or the network. The interface (the look, the animations, the screens) is kept private. Here is exactly where that line is, and how the code enforces it.

## What's in here

| Folder | What it does |
|---|---|
| `src/core/` | Key derivation, the encrypted vault, signing, sends, swaps, balances, history, Monero, staking |
| `src/main/` | The app's main process: every network request, the Tor/Mullvad route and kill switch, duress PIN, screenshot blocking |
| `src/preload/` | The **only** bridge between the interface and this engine |
| `src/shared/api.ts` | The full list of what the interface is allowed to ask for |
| `src/web/` | The engine of the browser extension and the web wallet, when there's no app on the computer: the same vault format, PIN rules and payment approvals, with storage in the browser |
| `test/` | The offline test suite, plus live tests that build and sign real transactions without ever broadcasting them |

## What's not in here, and why that's safe

The interface lives in its own sandboxed window. This code, not the interface, decides what that window can do:

- **No internet.** `src/main/index.ts` cancels every request the window makes except loading its own bundled files. Balances, prices and swaps are fetched here in the main process, through your route.
- **No disk.** The window runs in a memory-only session (`astrala-ui`), so it can't store anything between launches.
- **No keys.** Private keys never leave the main process. The window gets addresses, balances and prices. It sees your recovery phrase only when you create a wallet or choose to reveal it, so it can show it to you, and it has no way to send it anywhere.
- **No smuggled links.** The window can open a link in your browser only for a block-explorer page or Mullvad's download page, and never with extra data attached.
- **No permissions.** Camera, microphone, location, notifications from the page: all refused.

To see everything the interface can possibly ask for, read `src/preload/index.ts`. It's short.

## No tracking

There's no analytics and no crash reporter. Apart from your coins' own traffic, the app makes two kinds of request:

- **Astrala's notice file.** On launch, every 10 minutes and when you switch back to the app, it downloads a small public file (`live.json`) with the latest version numbers, any notice we post, and the current Swap, Split and Route fee rates. Nothing about you or your wallet is sent. Fee rates from it can never go above the ceiling in `src/core/fees.ts` (1% swap, 10% Split, 3% Route). A build from this repository has no service address, so it never makes this request.
- **Updates.** The app checks this repository's releases on GitHub. An update is installed only when you choose to, and only if its SHA-256 matches the release's SHA256SUMS.

`src/core/heartbeat.ts` also contains an install heartbeat (a random id, the version and the platform). It is off by default.

No other code is downloaded at runtime, except the official Tor binary, which is checked against a pinned SHA-256 and thrown away if it doesn't match. Every server Astrala talks to is listed, with the reason, in [NETWORK.md](NETWORK.md).

## Swaps

Swaps go only to decentralized protocols: Jupiter, KyberSwap, ParaSwap, THORChain, Maya, LI.FI (on-chain bridges only) and NEAR Intents. There are no centralized exchanges, no accounts and no KYC.

ERC-20 approvals are for the exact amount of the swap, never unlimited, and an old approval is reset to zero first.

## Verify it yourself

See [VERIFY.md](VERIFY.md). In short: run the tests, build the engine from this repo, and compare it with the engine files inside the app you downloaded.

## Status

Public beta. Start with a fresh wallet and small amounts. Don't import the seed that holds your savings yet.

## Security

See [SECURITY.md](SECURITY.md). We will never DM you, and we will never ask for your recovery phrase.

## Licence

This is source-available, not open source. [PolyForm Strict 1.0.0](LICENSE.md). You may read, run, build and test this code for any noncommercial purpose. You may not redistribute it, modify it, or ship it in another product. It's published so you can check it, not so it can be rebranded.

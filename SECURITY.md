# Security

## We will never

- DM you first, on any platform.
- Ask for your recovery phrase, private keys, password or PIN. Not in support, not "to verify your wallet", not ever.
- Run a "support" account, a "recovery service", or a website where you "connect" or "sync" your wallet.
- Release Astrala anywhere except this repository's Releases page.

Anyone doing any of the above is impersonating us. Report them, and don't reply.

## Reporting a vulnerability

Use **Security → Report a vulnerability** on this repository. That opens a private report that only the maintainers can see. Please don't open a public issue for anything that could put funds at risk.

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a reply within a few days. Fixes ship first and get disclosed afterwards, with credit to you if you want it.

## In scope

Anything in this repository: key generation and storage, signing, sends and swaps, the route and kill switch, the duress PIN, and the boundary between the interface window and the engine (network wall, memory-only session, the preload bridge).

## Out of scope

- Phishing sites and fake apps. Report those, but they aren't bugs in Astrala.
- Bugs in the third-party protocols Astrala uses (THORChain, Jupiter and so on). Report those to the protocol.
- A Mac that is already compromised. If malware has your user account, no wallet can protect you.

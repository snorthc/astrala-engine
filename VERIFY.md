# Verify Astrala yourself

You don't have to trust us. Here's how to check that the app you downloaded runs exactly the code in this repository.

## 1. Check the download

Every release lists a SHA-256 for each file. In Terminal:

```sh
shasum -a 256 ~/Downloads/Astrala-Wallet-*.dmg
```

It must match the hash on the Releases page. If it doesn't, delete the file.

## 2. Run the tests

You need Node.js 22 or newer.

```sh
git clone <this repository>
cd astrala-engine
npm ci
npm test              # offline: key derivation, vault, signing, PIN rules, address-poisoning checks
npm run test:live     # optional: real quotes and signed transactions against public nodes, never broadcast
```

## 3. Rebuild the engine and compare it with the app

Run `./verify-engine.sh`. It builds the engine from this repository, pulls the same files out of the app you installed, and compares them.

The preload (`out/preload/index.cjs`) matches byte-for-byte. The main engine (`out/main/index.js`) matches byte-for-byte except for one settings block this repository leaves out: the operator settings (the addresses Astrala's own fees are paid to, and the service address the app checks for fee-rate updates). `verify-normalize.mjs` checks that this block holds only plain values (strings and numbers, no code), sets it aside, and then the rest must hash identically. Change one character of code anywhere else and the check fails.

To do it by hand, build it from this repository:

```sh
git checkout v<version you downloaded>
npm ci
npm run build
shasum -a 256 out/main/index.js out/preload/index.cjs
```

Then pull the same two files out of the app you installed:

```sh
npx @electron/asar extract "/Applications/Astrala Wallet.app/Contents/Resources/app.asar" /tmp/astrala-app
shasum -a 256 /tmp/astrala-app/out/main/index.js /tmp/astrala-app/out/preload/index.cjs
```

Compare the app's `out/main/index.js` after `node verify-normalize.mjs <app file> out/main/index.js /tmp/astrala-main.js`. The hashes must then be identical. If they are, the code holding your keys and making every network request is exactly what's published here.

## 4. Watch the network

Install [LuLu](https://objective-see.org/products/lulu.html) (free) or Little Snitch, open Astrala, and use it. Every connection should be to a host listed in [NETWORK.md](NETWORK.md). With Tor or Mullvad on, you'll see only the tunnel.

## What this proves, and what it doesn't

It proves that the engine in your app (keys, signing, the network, the boundary around the interface) is this code.

The interface itself isn't published. It runs in a sandbox this code controls: it has no network access, no disk and no keys. You can confirm that in `src/main/index.ts` (search for `uiRequestAllowed` and `UI_PARTITION`) and `src/preload/index.ts`.

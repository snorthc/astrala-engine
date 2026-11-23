// The engine of the hosted web wallet (no extension, nothing to install): the same engine the extension runs
// (src/web/engine.ts), hosted in a dedicated Web Worker that only the wallet's host page (web-wallet/host.js)
// created and can talk to. Built into website/wallet/engine-worker.js by tools/web-wallet.mjs.
//
// Storage mirrors the extension: the sealed vault in IndexedDB (chrome.storage.local there); the unlocked key in
// this worker's memory only (chrome.storage.session there), so it is never on disk and is gone when the tab closes
// or reloads.
import './globals'
import { createEngine } from './engine'
import { idbKV, memKV, serve } from './web-kv'

declare const self: { postMessage(m: unknown): void; addEventListener(t: 'message', f: (e: { data: unknown }) => void): void }

const engine = createEngine({ local: idbKV(), session: memKV(), emit: (channel, data) => self.postMessage({ t: 'event', channel, data }) })
const handle = serve(engine, (m) => self.postMessage(m))
self.addEventListener('message', (e) => handle(e.data))

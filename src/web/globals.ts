// Runs before anything else in the extension's background worker: src/core expects Node's Buffer as a global.
import { Buffer } from 'buffer'
;(globalThis as any).Buffer ??= Buffer
;(globalThis as any).global ??= globalThis
;(globalThis as any).process ??= { env: {}, version: '', versions: {}, nextTick: (f: () => void) => Promise.resolve().then(f), browser: true }

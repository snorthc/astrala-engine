// Used by verify-engine.sh. The app's engine is this code plus one settings block that is not published:
// the operator's settings (where Astrala's own fees are paid, and the service address the app checks for
// fee-rate updates). This script removes exactly that block from the app's engine, after checking it holds
// plain values only (strings and numbers, no code), so the rest can be compared byte-for-byte with your build.
//   node verify-normalize.mjs <app out/main/index.js> <your out/main/index.js> <write normalized app file here>
import { readFileSync, writeFileSync } from 'node:fs'

const [appFile, srcFile, outFile] = process.argv.slice(2)
let app = readFileSync(appFile, 'utf8')
const src = readFileSync(srcFile, 'utf8')
const fail = (m) => { console.error(`NOT VERIFIED: ${m}`); process.exit(1) }
const STR = `("[^"\\\\]*"|'[^'\\\\]*')`
// lines a settings object may contain: keys holding strings, numbers or nested objects, and closing braces
const DATA = new RegExp(`^\\s*(var \\w+ = \\{|[\\w$]+: \\{\\},?|[\\w$]+: \\{|[\\w$]+: (${STR}|\\d+),?|\\},?|\\};)$`)

// 1. the fee settings module: one object of plain values
const feeStart = app.indexOf('// src/core/fees.local.ts\n')
if (feeStart >= 0) {
  const l = app.slice(feeStart).split('\n')
  if (!/^var fees_local_exports = \/\* @__PURE__ \*\/ __exportAll\(\{ default: \(\) => wallets \}\);$/.test(l[1])) fail('unexpected shape of the settings block')
  let n = 2
  for (; n < l.length; n++) { if (!DATA.test(l[n])) fail(`the settings block holds something other than plain values: ${l[n].slice(0, 60)}`); if (l[n] === '};') break }
  app = app.replace(l.slice(0, n + 1).join('\n') + '\n', '')
  const glob = 'Object.assign({ "./fees.local.ts": fees_local_exports })'
  if (!app.includes(glob)) fail('could not find where the settings block is used')
  app = app.replace(glob, 'Object.assign({})')
}
// 2. the service address: a single string
const hqStart = app.indexOf('// ops/hq-url.ts\n')
if (hqStart >= 0) {
  const l = app.slice(hqStart).split('\n')
  if (!/^var hq_url_exports = \/\* @__PURE__ \*\/ __exportAll\(\{ HQ_URL: \(\) => HQ_URL\$1 \}\);$/.test(l[1]) || !new RegExp(`^var HQ_URL\\$1 = ${STR};$`).test(l[2])) fail('unexpected shape of the service address')
  app = app.replace(l.slice(0, 3).join('\n') + '\n', '')
  const glob = 'Object.assign({ "../../ops/hq-url.ts": hq_url_exports })'
  if (!app.includes(glob)) fail('could not find where the service address is used')
  app = app.replace(glob, 'Object.assign({})')
}
// 3. the bundler adds a small helper only when such a block exists; drop it if your build has none
const RT = '// \\0rolldown/runtime.js\n'
if (!src.includes('var __exportAll =') && app.includes(RT)) {
  const l = app.slice(app.indexOf(RT)).split('\n')
  const end = l.findIndex((x, i) => i > 0 && x === '};')
  const helper = l.slice(0, end + 1).join('\n') + '\n'
  if (/fetch|require|import|eval|Function\(/.test(helper) || end > 12) fail('unexpected bundler helper')
  app = app.replace(helper, '')
}
writeFileSync(outFile, app)
console.log(feeStart >= 0 || hqStart >= 0 ? 'Set aside the operator settings (plain values only, no code).' : 'No operator settings in this app.')

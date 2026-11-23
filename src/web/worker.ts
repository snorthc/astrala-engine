// The browser wallet's engine, hosted in the extension's background worker (loaded by extension/background.js).
// Only the extension's own pages can reach it: a website's content script has the site's URL as its sender, and is
// refused here, so no page on the web can ask this wallet for anything.
import './globals'
import { createEngine, type KV } from './engine'

declare const chrome: any
const kv = (area: any): KV => ({ get: async (k) => (await area.get(k))[k], set: (k, v) => area.set({ [k]: v }), remove: (k) => area.remove(k) })
const ports = new Set<any>()
const engine = createEngine({
  local: kv(chrome.storage.local), session: kv(chrome.storage.session),
  emit: (channel, data) => { for (const p of ports) { try { p.postMessage({ channel, data }) } catch { ports.delete(p) } } }
})
const own = (sender: any) => sender?.id === chrome.runtime.id && String(sender.url || '').startsWith(chrome.runtime.getURL(''))

chrome.runtime.onConnect.addListener((port: any) => {
  if (port.name !== 'astrala-ui' || !own(port.sender)) { port.disconnect(); return }
  ports.add(port)
  port.onDisconnect.addListener(() => ports.delete(port))
})
chrome.runtime.onMessage.addListener((msg: any, sender: any, reply: (r: unknown) => void) => {
  if (!msg || msg.type !== 'engine') return
  if (!own(sender)) { reply({ error: 'refused' }); return }
  engine.call(String(msg.name), Array.isArray(msg.args) ? msg.args : []).then((result) => reply({ result }), (e) => reply({ error: String(e?.message ?? e).slice(0, 200) }))
  return true // the answer comes later
})

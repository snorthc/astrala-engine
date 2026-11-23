// Screen protection helper: notice when the user takes a screenshot while Astrala hides itself from captures,
// so we can tell them why the window came out black (macOS and Windows; Linux can't hide windows from captures). macOS has no "screenshot taken" API for apps, so we watch the
// folder macOS saves screenshots into (System Settings → Screenshot options can move it; `defaults` tells us where).
import { execFile } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

let watcher: FSWatcher | null = null
let last = 0

// Linux has no way to hide a window from captures (setContentProtection does nothing there), so there's nothing to explain.
const watched = () => process.platform === 'darwin' || process.platform === 'win32'

const shotDir = () => new Promise<string>((res) => {
  // Windows (Win+PrtScn, Snipping Tool): Pictures\Screenshots
  if (process.platform === 'win32') return res(join(homedir(), 'Pictures', 'Screenshots'))
  if (process.platform !== 'darwin') return res('')
  execFile('/usr/bin/defaults', ['read', 'com.apple.screencapture', 'location'], { timeout: 3000 }, (err, out) => {
    const p = !err && out.trim() ? out.trim().replace(/^~(?=\/|$)/, homedir()) : join(homedir(), 'Desktop')
    res(p)
  })
})

export const SHOT_NAME = /^(Screenshot|Screen Shot|Screen Recording|Skjermbilde|Bildschirmfoto|Capture d)/i

export async function startShotWatch(onShot: () => void) {
  if (watcher || !watched()) return
  const dir = await shotDir()
  if (!dir || watcher) return
  try {
    watcher = watch(dir, { persistent: false }, async (_ev, name) => {
      const file = name?.toString() ?? ''
      // macOS writes a hidden ".Screenshot…" temp file first, then renames it; react to the real one once
      if (!SHOT_NAME.test(file) || Date.now() - last < 4000) return
      try { const s = await stat(join(dir, file)); if (Date.now() - s.birthtimeMs > 15_000) return } catch { return }
      last = Date.now()
      onShot()
    })
    watcher.on('error', () => stopShotWatch())
  } catch { watcher = null }
}

export function stopShotWatch() { watcher?.close(); watcher = null }

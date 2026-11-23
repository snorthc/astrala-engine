// Menu bar (macOS) / notification area (Windows) / tray (Linux): icon only. The dropdown shows your total and top coins (masked in stealth mode), plus quick actions.
import { Tray, Menu, nativeImage, globalShortcut, app, type BrowserWindow } from 'electron'

const ICON_1X = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA60lEQVR4AdyRvwpBYRyGMRFnMYii3ICUrMzIppS4AiWTcgNGG2VyAZKN7HILSllM5wIMMvG89Z3h47AYFL3P9/vj9eZ8JxT48vPHAR2u5gJ3g/om/Yv87qCNawQVCBtq1DG0wJJfwAxHFfZwM+yo2k2olhTgsClDH1YQgyQ8K8EiDkuQt0R1FKAf5BgUUqBKcw4Xrgb12jEGihzy5qkxBejLKUMDsnAG/d0UNWJQX6c/gTzy6nFcBbCz1GVaQxo8ZWi061Et+QVscAzhCN5rPNAPYAuW/AJkWHBEIWjQRWvHaOtdgO36MP0+4AEAAP//5PARcgAAAAZJREFUAwBtySYhbud6BQAAAABJRU5ErkJggg=='
const ICON_2X = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAChUlEQVR4AeyVu2tUQRSH10fS+Ch8IIKIKL4RBbES7dRGxUoLsfCFFgraCIqFf4GCIqL4aES0FhG0TpU0CeRJioQkkKRIICEJJOTxfcsO3GX37s5NCGlu+H1zzpyZe+Zkdube9YU1/ssLyHcg34Hl7MA6bu5euACPS+gbo5tNWQvYR/pm6Id/8LaEvrEW+s7BxClLATdI2QanIagbRzBFOdaKdx2iFFvAVbL9hC0wDXdgKxwpoX8P3zH9X/hXoK5iCthBli+gemhc9Bt2EoL0nXOMQC+orzTboaZiCvhOBouYxV6EAUiT58AD6Vyf+Zw2McTrFbCLiZdAPadxAUxN9TH6CtQ1mpq7kFaAcbfzEQmCdgcnwiYXNYe5zFnxqMFGoqfAg/UO2wQT0A4vIWhzcCLspsQcd8Nc5jS3a9xm3DUbLaCBzmE4C+fhBCQT0C3qIe1iJM5lapnMaW7XOMeIazZYwBQdr81d7EnwGm3EhquHW5SHzzs+Ss9CMGUy5pjvCueGwR845jKnuV3D3XbNKQtgvELzRH7DTZgD5W1w2zyY7toegmdK6BtzzAVMzlBhhuYWmMucuOVKKyDMWsD5AOoZzQFQJhvC8dUr+sYIFfbTPAXls+bQr0q9AnzoBc0gbIC/cBTS5Gn/z6BzvbLJQ0y4UjEFeEbCoTpIig54Ax4iv4zi2/E1MU+7O4BbuE/jT4BJV0wBPv2HxoM0jFVPaLrArR/BdkLYdudcpu9OYGortgCzeJD8rz/SGQfly2mnDozBezgEFoyprywFmM2XiT/HNjrH4QF4ffV9+/nW88NEOE5ZC0hm9Sx8IuBXTx83u1ZSQPbVqjyRF5DvwKrvQJVzVxZaAgAA//9+pqBPAAAABklEQVQDAH0sdkFm3gPdAAAAAElFTkSuQmCC'

// Windows and Linux have no template images, so they get the same glyph in the app's light text colour
const LIGHT_1X = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAy0lEQVR42u3TIUvDYRDH8c/fDQTZQCaIQePaFpShzdX5BizabIJ9b2BvY1HLwKSsjlUZJkUwLK0NxL/FIK5cGH8eUFgxeHDw3Jffc9zx47L3+cwqsWbF+LsNzpHjOzLHaUpYTrAz9NDBQ7BDXKOEm2VxlnAhxxGeCryBEbaKE1SxH9lGBTuJBtuoYYAxJngsx4cmjnEQ4j7WsRn1Gz7j3UKGL7ymVpjiBM+JFW5R/8mFS9xhd4ntBbv6jQv36OIFG8E+cIFhUZz934IFYLwqFV0rE30AAAAASUVORK5CYII='
const LIGHT_2X = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAB6klEQVR42u3Xu2sUURQG8N9uVpvVgBhRQfGBmjUgorHT0gcIUQtRsRQFi2CjjVbpLATFwkKxFFGwC1r5B9ioKBiNQUgMaEATQYiK+GrOwBB23Z2dhG3mwGEud87M991z7vnuTOnr9AedtLIOW0GgINBxApU2nilhLXpRi7k3GMX7hSawHg/Q3+D+UxzF+EKU4DhezgEfDU+sHy9wbL4JHMI9LMU3nEJ3lKAW49Nxrxv3MdBSPVuQ4h68jutb7MVkg9h1eIxN+BzkpvNm4E6A/8T+/4DDBPZFbA9u5y3BShyI8cUAaGbjGIrxESxvh0AZfRhMza3OsGHToIPxrnKjNlwcATuxI67bUZ0TuyQDgfSzQ+Gz0SHPwp9jpIJFISq7sQsb6oDD2fB2rYptsZBqdMxYoy7owkGcxImYm8RMlGJFKGLa/uITprAs1BLuRgs/wu+sbVjGj8jSZVxKEVyV2hcfAzgBuIIL+B4r/pNHB67jXLy8F++axG8MvejCVZzPK0TVOGzWYAyHQ5jqWR+Gg8QEtkYWcgnRbGrzbcYIrkU2SuG1WO2rAIczzcBbzUBiA7gVtZeqfSU2ZWJTcS48nO/TcDhWfRNfUuKUgM/gBra0Cp41A/XqvQe/8CRKk/3rpvgxKQgUBDpN4B9p8XIXytgSBAAAAABJRU5ErkJggg=='

export interface TraySummary { locked: boolean; stealth: boolean; total: string; lines: { label: string; value: string }[] }

let tray: Tray | null = null
let summary: TraySummary = { locked: true, stealth: false, total: '', lines: [] }
let getWin: () => BrowserWindow | null = () => null
let actions: { lock: () => void; go: (page: string) => void } = { lock: () => {}, go: () => {} }

function icon() {
  const mac = process.platform === 'darwin'
  const img = nativeImage.createFromDataURL(mac ? ICON_1X : LIGHT_1X)
  img.addRepresentation({ scaleFactor: 2, dataURL: mac ? ICON_2X : LIGHT_2X })
  if (mac) img.setTemplateImage(true) // macOS tints it for light/dark menu bars
  return img
}

export function showWindow() {
  const w = getWin()
  if (!w) return
  if (w.isMinimized()) w.restore()
  w.show(); w.focus()
  if (process.platform === 'darwin') app.focus({ steal: true })
}

function toggleWindow() {
  const w = getWin()
  if (w && w.isVisible() && w.isFocused()) w.hide()
  else showWindow()
}

function rebuild() {
  if (!tray) return
  const s = summary
  const head: Electron.MenuItemConstructorOptions[] = s.locked
    ? [{ label: 'Astrala is locked', enabled: false }]
    : [
        { label: s.stealth ? 'Total  ••••••' : `Total  ${s.total}`, enabled: false },
        ...s.lines.slice(0, 6).map((l) => ({ label: s.stealth ? `${l.label}  ••••` : `${l.label}  ${l.value}`, enabled: false }))
      ]
  const menu = Menu.buildFromTemplate([
    ...head,
    { type: 'separator' },
    { label: 'Open Astrala', accelerator: 'Control+Alt+Space', click: showWindow },
    ...(s.locked ? [] : [
      { label: 'Send…', click: () => { showWindow(); actions.go('send') } },
      { label: 'Receive…', click: () => { showWindow(); actions.go('wallet') } },
      { label: 'Swap…', click: () => { showWindow(); actions.go('swap') } },
      { type: 'separator' as const },
      { label: 'Lock now', click: () => actions.lock() }
    ]),
    { type: 'separator' },
    { label: 'Quit Astrala', role: 'quit' }
  ])
  tray.setContextMenu(menu)
  tray.setToolTip('Astrala Wallet')
}

export function initTray(win: () => BrowserWindow | null, a: typeof actions) {
  getWin = win
  actions = a
  if (!tray) {
    tray = new Tray(icon())
    // macOS opens the menu on click; on Windows a left click brings the window, right click opens the menu
    if (process.platform === 'win32') tray.on('click', showWindow)
    rebuild()
  }
  // ⌃⌥Space (Ctrl+Alt+Space on Windows/Linux) from anywhere: bring Astrala forward, or tuck it away
  try { globalShortcut.register('Control+Alt+Space', toggleWindow) } catch { /* taken by another app */ }
}

export function setTraySummary(s: TraySummary) {
  summary = s
  rebuild()
}

export function destroyTray() {
  globalShortcut.unregisterAll()
  tray?.destroy(); tray = null
}

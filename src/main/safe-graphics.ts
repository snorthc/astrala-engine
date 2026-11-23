// Did the display server hang while Astrala last ran? Pure, so it can be tested without Electron.
/** run: the heartbeat file ({ start, alive } in ms). reports: files in /Library/Logs/DiagnosticReports. */
export function hangDuring(run: { start?: number; alive?: number } | null, reports: { name: string; mtimeMs: number }[]): boolean {
  if (!run || !(Number(run.start) > 0) || !(Number(run.alive) >= Number(run.start))) return false
  return reports.some((r) => /^WindowServer.*(watchdog|\.ips$)/.test(r.name) && r.mtimeMs >= run.start! && r.mtimeMs <= run.alive! + 120_000)
}

// Account names: one star each (Vega, Orion…). No personal labels by default, and nothing invented or double-barrelled.
const STARS = ['Orion', 'Lyra', 'Vega', 'Altair', 'Rigel', 'Sirius', 'Cygnus', 'Draco', 'Aquila', 'Carina', 'Polaris', 'Andromeda', 'Cassiopeia', 'Perseus', 'Pegasus', 'Hydra', 'Phoenix', 'Corvus', 'Auriga', 'Deneb', 'Antares', 'Capella', 'Mira', 'Electra', 'Nova', 'Halcyon', 'Rhea', 'Selene']

/** A star name none of your accounts uses yet. With every star taken, a number goes on the end. */
export function randomAccountName(taken: string[] = []): string {
  const r = (n: number) => crypto.getRandomValues(new Uint32Array(1))[0] % n
  const used = new Set(taken.map((t) => t.toLowerCase()))
  const free = STARS.filter((s) => !used.has(s.toLowerCase()))
  if (free.length) return free[r(free.length)]
  const base = STARS[r(STARS.length)]
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
}

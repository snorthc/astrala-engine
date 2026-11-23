/**
 * Route minimums come back from the providers as a floor on ONE leg's share of the split, phrased in the
 * source coin ("at least 0.00289 ETH"). To act on that the user has to raise the whole split, so work back
 * from the leg's percentage — and from Astrala's cut, which is taken before anything is routed.
 */
export function minTotalFor(error: string | undefined, pct: number, feeBps: number): number | null {
  const m = /at least\s+([\d.]+)/i.exec(error ?? '')
  if (!m || !pct) return null
  const need = Number(m[1])
  if (!isFinite(need) || need <= 0) return null
  const afterFee = 1 - feeBps / 10_000
  if (afterFee <= 0) return null
  return (need / (afterFee * (pct / 100))) * 1.02 // 2% headroom so the next quote isn't borderline
}

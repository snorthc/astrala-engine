// Account types: what an account is for. Labels and light defaults only; none of them can hold funds back.
// Pure, so main, the interface and tests share one list.

export type AccountType = 'vault' | 'spending' | 'trading' | 'stealth'

export const ACCOUNT_TYPES: { id: AccountType; name: string; line: string }[] = [
  { id: 'vault', name: 'Vault', line: 'Long-term holdings with a cold storage feel.' },
  { id: 'spending', name: 'Spending', line: 'Everyday sends and payments.' },
  { id: 'trading', name: 'Trading', line: 'Swaps, splits, coins on the move.' },
  { id: 'stealth', name: 'Stealth', line: 'Privacy first. Monero leads.' }
]

const IDS = new Set<string>(ACCOUNT_TYPES.map((t) => t.id))

/** A stored or requested type, or Spending for anything missing or unknown (older vaults have none). */
export const accountType = (t: unknown): AccountType => (typeof t === 'string' && IDS.has(t) ? (t as AccountType) : 'spending')
export const isAccountType = (t: unknown): t is AccountType => typeof t === 'string' && IDS.has(t)
export const typeName = (t: unknown) => ACCOUNT_TYPES.find((x) => x.id === accountType(t))!.name

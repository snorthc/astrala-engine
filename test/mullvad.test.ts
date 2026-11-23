import { describe, expect, it } from 'vitest'
import { parseStatus, parseRelays } from '../src/main/mullvad'

describe('mullvad status parser', () => {
  it('reads the verbose text format', () => {
    const s = parseStatus(`Connected
    Relay:                  se-got-wg-001
    Features:               Quantum Resistance
    Visible location:       Sweden, Gothenburg. IPv4: 185.213.154.68
`)
    expect(s).toMatchObject({ state: 'connected', relay: 'se-got-wg-001', country: 'Sweden', city: 'Gothenburg', ip: '185.213.154.68' })
  })
  it('reads the one-line format', () => {
    expect(parseStatus('Connected to ch-zrh-wg-005 in Zurich, Switzerland')).toMatchObject({ state: 'connected', relay: 'ch-zrh-wg-005', city: 'Zurich', country: 'Switzerland' })
    expect(parseStatus('Disconnected').state).toBe('disconnected')
    expect(parseStatus('Connecting to se-sto-wg-003...').state).toBe('connecting')
    expect(parseStatus('Blocked: Unable to start the tunnel').state).toBe('blocked')
  })
  it('reads the JSON format', () => {
    const j = JSON.stringify({ state: 'connected', details: { location: { country: 'Germany', city: 'Frankfurt', hostname: 'de-fra-wg-101', ipv4: '146.70.117.2' } } })
    expect(parseStatus(j)).toMatchObject({ state: 'connected', relay: 'de-fra-wg-101', country: 'Germany', city: 'Frankfurt', ip: '146.70.117.2' })
    expect(parseStatus('{"state":"disconnected"}').state).toBe('disconnected')
    expect(parseStatus('{"state":"connecting"}').state).toBe('connecting')
  })
})

describe('mullvad relay list parser', () => {
  it('groups countries, cities and relays', () => {
    const out = [
      'Albania (al)',
      '\tTirana (tia) @ 41.32795°N, 19.81902°W',
      '\t\tal-tia-wg-001 (31.171.153.66, 2a04:27c0:0:3::f001) - WireGuard, hosted by iRegister (rented)',
      '',
      'Sweden (se)',
      '\tGothenburg (got) @ 57.70887°N, 11.97456°W',
      '\t\tse-got-wg-001 (185.213.154.68, 2a03:1b20:5:f011::a01f) - WireGuard, hosted by 31173 (Mullvad-owned)',
      '\t\tse-got-wg-002 (185.213.154.69, 2a03:1b20:5:f011::a02f) - WireGuard, hosted by 31173 (Mullvad-owned)',
      '\tStockholm (sto) @ 59.32938°N, 18.06871°W',
      '\t\tse-sto-wg-001 (193.138.218.220, 2a03:1b20:3:f011::a01f) - WireGuard, hosted by 31173 (Mullvad-owned)'
    ].join('\n')
    const r = parseRelays(out)
    expect(r.map((c) => c.code)).toEqual(['al', 'se'])
    expect(r[1].cities).toEqual([{ code: 'got', name: 'Gothenburg', relays: 2 }, { code: 'sto', name: 'Stockholm', relays: 1 }])
  })
})

import { describe, it, expect } from 'vitest'
import { usableHqUrl, cmpVersion } from '../src/core/heartbeat'

describe('HQ address', () => {
  it('accepts only https on a public host', () => {
    expect(usableHqUrl('https://hq.example.com')).toBe('https://hq.example.com')
    expect(usableHqUrl('https://hq.example.com/')).toBe('https://hq.example.com')
  })
  it('treats dev, plain-http and odd addresses as no HQ', () => {
    for (const bad of ['http://127.0.0.1:4747', 'https://127.0.0.1:4747', 'https://localhost:4747', 'https://app.localhost', 'https://[::1]:4747',
      'http://hq.example.com', 'https://user:pw@hq.example.com', 'ftp://hq.example.com', '', undefined, 'not a url']) {
      expect(usableHqUrl(bad)).toBe('')
    }
  })
  it('still compares versions', () => { expect(cmpVersion('1.1.0', '1.0.9')).toBe(1) })
})

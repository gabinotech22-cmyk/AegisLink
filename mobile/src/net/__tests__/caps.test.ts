import { sanitizeCaps, contactHasCap, sameCaps, OWN_CAPS, CAP_SEALED_CALLS, CAP_SEALED_FIRST_CONTACT } from '../caps';

describe('caps', () => {
  it('this client announces sealed calls and sealed first contact', () => {
    expect(OWN_CAPS).toEqual([CAP_SEALED_CALLS, CAP_SEALED_FIRST_CONTACT]);
  });

  it('sanitizeCaps: only short lowercase tokens, de-duplicated, capped at 16; non-array → null', () => {
    expect(sanitizeCaps(['sealed-calls', 'Sealed-Calls', 42, '', 'x'.repeat(40), 'a b', 'future-cap', 'sealed-calls'])).toEqual(['sealed-calls', 'future-cap']);
    expect(sanitizeCaps(Array.from({ length: 30 }, (_, i) => `c${i}`))).toHaveLength(16);
    expect(sanitizeCaps('sealed-calls')).toBeNull();
    expect(sanitizeCaps(undefined)).toBeNull();
    expect(sanitizeCaps([])).toEqual([]);
  });

  it('contactHasCap / sameCaps', () => {
    expect(contactHasCap({ caps: ['sealed-calls'] }, 'sealed-calls')).toBe(true);
    expect(contactHasCap({ caps: [] }, 'sealed-calls')).toBe(false);
    expect(contactHasCap({}, 'sealed-calls')).toBe(false);
    expect(contactHasCap(undefined, 'sealed-calls')).toBe(false);
    expect(sameCaps(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameCaps(null, [])).toBe(true);
    expect(sameCaps(['a'], ['a', 'b'])).toBe(false);
  });
});

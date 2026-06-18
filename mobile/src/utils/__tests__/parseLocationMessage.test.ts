import { parseLocationMessage } from '../parseLocationMessage';

/**
 * The composer (Location.tsx) builds the text via i18n, so the wording is
 * locale-dependent while the "(Lat:, Lon:)" suffix is not. These tests pin the
 * parser to the language-INVARIANT structure so every supported locale renders
 * the map card (regression: the old regex only matched Spanish).
 */

describe('parseLocationMessage — locale independence', () => {
  it('parses the Spanish format', () => {
    const r = parseLocationMessage(
      '📍 Ubicación compartida (Exacta, durante 1 hora): Calle Mayor 1 (Lat: 47.3769, Lon: 8.5417)',
    );
    expect(r).not.toBeNull();
    expect(r!.precision).toBe('Exacta');
    expect(r!.duration).toBe('1 hora');
    expect(r!.address).toBe('Calle Mayor 1');
    expect(r!.latitude).toBeCloseTo(47.3769);
    expect(r!.longitude).toBeCloseTo(8.5417);
  });

  it('parses the English format', () => {
    const r = parseLocationMessage(
      '📍 Shared location (Exact, for 1 hour): 5th Avenue (Lat: 40.7128, Lon: -74.0060)',
    );
    expect(r).not.toBeNull();
    expect(r!.precision).toBe('Exact');
    expect(r!.duration).toBe('1 hour');
    expect(r!.address).toBe('5th Avenue');
    expect(r!.latitude).toBeCloseTo(40.7128);
    expect(r!.longitude).toBeCloseTo(-74.006);
  });

  it('parses the Italian format', () => {
    const r = parseLocationMessage(
      '📍 Posizione condivisa (Esatta, per 1 ora): Via Roma 2 (Lat: 41.9028, Lon: 12.4964)',
    );
    expect(r).not.toBeNull();
    expect(r!.precision).toBe('Esatta');
    expect(r!.duration).toBe('1 ora');
    expect(r!.address).toBe('Via Roma 2');
    expect(r!.latitude).toBeCloseTo(41.9028);
    expect(r!.longitude).toBeCloseTo(12.4964);
  });

  it('parses an approximate location whose address has multiple words', () => {
    const r = parseLocationMessage(
      '📍 Shared location (Approximate, for 8 hours): Area of Central Park (Lat: 40.785, Lon: -73.968)',
    );
    expect(r).not.toBeNull();
    expect(r!.address).toBe('Area of Central Park');
    expect(r!.duration).toBe('8 hours');
  });

  it('tolerates a missing coordinate suffix (coords null)', () => {
    const r = parseLocationMessage('📍 Shared location (Exact, for 1 hour): Somewhere');
    expect(r).not.toBeNull();
    expect(r!.address).toBe('Somewhere');
    expect(r!.latitude).toBeNull();
    expect(r!.longitude).toBeNull();
  });

  it('returns null for non-location messages', () => {
    expect(parseLocationMessage('hello world')).toBeNull();
    expect(parseLocationMessage('📍 just a pin emoji with no structure')).toBeNull();
  });
});

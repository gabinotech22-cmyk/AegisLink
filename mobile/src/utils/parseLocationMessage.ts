/**
 * Parse a shared-location chat message back into its parts so the chat can
 * render the map card instead of raw text.
 *
 * The message is composed via i18n (`location.sharedMsgFormat`), so its words
 * differ per locale — e.g.
 *   ES: "📍 Ubicación compartida (Exacta, durante 1 hora): Calle X (Lat: .., Lon: ..)"
 *   EN: "📍 Shared location (Exact, for 1 hour): Street X (Lat: .., Lon: ..)"
 *   IT: "📍 Posizione condivisa (Esatta, per 1 ora): Via X (Lat: .., Lon: ..)"
 *
 * The previous regex hard-coded the Spanish wording, so non-Spanish locales
 * never matched and the card silently fell back to plain text. We now key off
 * the language-INVARIANT structure only:
 *   📍 <localized prefix> ( <precision> , <connector> <duration> ) : <address> [ (Lat: X, Lon: Y) ]
 * The "(Lat:, Lon:)" suffix is emitted untranslated by Location.tsx, so the
 * coordinates always parse regardless of locale.
 */
export function parseLocationMessage(body: string) {
  if (!body.startsWith('📍')) return null;

  const regex =
    /^📍[^(]*\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)\s*:\s*(.+?)(?:\s*\(Lat:\s*([-\d.]+)\s*,\s*Lon:\s*([-\d.]+)\s*\))?$/iu;
  const match = body.match(regex);
  if (!match) return null;

  // The duration group is "<connector> <duration>" (e.g. "for 1 hour",
  // "durante 1 hora", "per 1 ora"). Drop the single leading connector word so
  // the chip shows just the duration; keep as-is if there is no connector.
  const durationRaw = match[2].trim();
  const tokens = durationRaw.split(/\s+/);
  const duration = tokens.length > 1 ? tokens.slice(1).join(' ') : durationRaw;

  return {
    precision: match[1].trim(),
    duration,
    address: match[3].trim(),
    latitude: match[4] ? parseFloat(match[4]) : null,
    longitude: match[5] ? parseFloat(match[5]) : null,
  };
}

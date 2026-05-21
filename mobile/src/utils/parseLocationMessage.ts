export function parseLocationMessage(body: string) {
  if (!body.startsWith('📍')) return null;
  const regex = /📍 Ubicación compartida \(([^,]+), durante ([^)]+)\):\s*([^(]+?)(?:\s*\(Lat:\s*([-\d.]+),\s*Lon:\s*([-\d.]+)\))?$/i;
  const match = body.match(regex);
  if (!match) return null;
  return {
    precision: match[1],
    duration: match[2],
    address: match[3].trim(),
    latitude: match[4] ? parseFloat(match[4]) : null,
    longitude: match[5] ? parseFloat(match[5]) : null,
  };
}

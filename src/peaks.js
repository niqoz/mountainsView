// Chargement des sommets de montagne via Overpass API (OpenStreetMap)
// et résolution des altitudes manquantes via OpenTopoData.

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const TOPO_URL     = 'https://api.opentopodata.org/v1/srtm30m';
const CACHE_KEY    = 'mv_peaks';

/**
 * Retourne les sommets à moins de radiusM mètres de (lat, lon).
 * Résultat mis en cache dans sessionStorage (invalide à la fermeture de l'onglet).
 */
export async function fetchNearbyPeaks(lat, lon, radiusM = 50_000) {
  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const query = `[out:json][timeout:25];node["natural"="peak"](around:${radiusM},${lat},${lon});out body;`;
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: `data=${encodeURIComponent(query)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  const { elements } = await res.json();

  const peaks = elements
    .filter((el) => el.tags?.name)
    .map((el) => ({
      name: el.tags.name,
      lat:  el.lat,
      lon:  el.lon,
      ele:  el.tags?.ele ? +el.tags.ele : null,
    }));

  // Résoudre les altitudes manquantes par lots (max 100 par requête)
  const missing = peaks.filter((p) => p.ele === null).slice(0, 100);
  if (missing.length) {
    try {
      const locs = missing.map((p) => `${p.lat},${p.lon}`).join('|');
      const tr = await fetch(`${TOPO_URL}?locations=${locs}`);
      if (tr.ok) {
        const { results } = await tr.json();
        missing.forEach((p, i) => { p.ele = results[i]?.elevation ?? 0; });
      }
    } catch { /* élévation reste null → ignoré à l'affichage */ }
  }

  sessionStorage.setItem(CACHE_KEY, JSON.stringify(peaks));
  return peaks;
}

/**
 * Altitude du point GPS (lat, lon) via OpenTopoData (SRTM 30m).
 * Utilisé pour l'altitude de l'utilisateur quand Geolocation.altitude est null.
 */
export async function getUserAltitude(lat, lon) {
  try {
    const res = await fetch(`${TOPO_URL}?locations=${lat},${lon}`);
    if (!res.ok) return 0;
    const { results } = await res.json();
    return results?.[0]?.elevation ?? 0;
  } catch { return 0; }
}

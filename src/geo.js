// Calculs géographiques : azimut, distance, angle d'élévation.

const R   = 6_371_000; // rayon terrestre moyen (mètres)
const RAD = Math.PI / 180;

/**
 * Azimut vrai de (lat1,lon1) vers (lat2,lon2), en degrés [0, 360[.
 */
export function bearing(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * RAD, φ2 = lat2 * RAD;
  const Δλ = (lon2 - lon1) * RAD;
  const x = Math.sin(Δλ) * Math.cos(φ2);
  const y = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(x, y) / RAD) + 360) % 360;
}

/**
 * Distance grande-cercle entre deux points GPS, en mètres.
 */
export function distance(lat1, lon1, lat2, lon2) {
  const Δφ = (lat2 - lat1) * RAD;
  const Δλ = (lon2 - lon1) * RAD;
  const φ1 = lat1 * RAD, φ2 = lat2 * RAD;
  const a  = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Angle d'élévation vertical (degrés) depuis l'observateur jusqu'au sommet.
 * Positif si le sommet est au-dessus de l'horizon, négatif en-dessous.
 */
export function elevationAngle(userAlt, peakAlt, distM) {
  if (distM < 1) return 0;
  return Math.atan2(peakAlt - userAlt, distM) / RAD;
}

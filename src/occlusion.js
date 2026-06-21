// Occlusion par modèle numérique de terrain (approche légère).
//
// Pour chaque sommet, on échantillonne l'altitude du terrain le long du rayon
// observateur → sommet via OpenTopoData. Si un point intermédiaire du terrain
// "dépasse" la ligne de visée (angle d'élévation supérieur à celui du sommet),
// le sommet est masqué par un relief plus proche → on ne l'affiche pas.

import { elevationAngle } from './geo.js';

const TOPO_URL  = 'https://api.opentopodata.org/v1/srtm30m';
const BATCH     = 100;    // max locations par requête OpenTopoData
const RATE_MS   = 1100;   // ~1 req/s : limite de l'instance publique
const STEP_M    = 600;    // espacement cible entre échantillons (m)
const MAX_SMP   = 10;     // plafond d'échantillons par rayon (perf)
const MARGIN    = 0.3;    // marge anti-bruit (degrés) avant de déclarer masqué

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Distances d'échantillonnage le long du rayon, en s'arrêtant avant le sommet
// (buffer proportionnel) pour ne pas déclencher d'auto-occlusion par sa propre pente.
function sampleDistances(distM) {
  const buffer = clamp(distM * 0.1, 500, 2500);
  const end = distM - buffer;
  if (end < STEP_M) return []; // sommet trop proche → pas de test d'occlusion
  const span = end - STEP_M;
  const n = Math.min(MAX_SMP, Math.max(1, Math.round(span / STEP_M) + 1));
  const ds = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    ds.push(STEP_M + span * t);
  }
  return ds;
}

/**
 * Calcule l'occlusion de chaque sommet et pose p.occluded = true|false.
 * Mute les objets en place (pris en compte au prochain rendu).
 * @param {Array} peaks  sommets { lat, lon, elevation, distKm, ... }
 * @param {{lat:number, lon:number}} user
 * @param {number} userAlt  altitude observateur (m)
 * @param {(done:number,total:number)=>void} [onProgress]
 */
export async function computeOcclusion(peaks, user, userAlt, onProgress) {
  // Construire tous les points à interroger (interpolation lat/lon linéaire,
  // suffisante aux distances < 50 km).
  const samples = []; // { peakIdx, distM, lat, lon, terrain }
  peaks.forEach((p, idx) => {
    p.occluded = false;
    const distM = p.distKm * 1000;
    for (const d of sampleDistances(distM)) {
      const t = d / distM;
      samples.push({
        peakIdx: idx,
        distM:   d,
        lat: user.lat + (p.lat - user.lat) * t,
        lon: user.lon + (p.lon - user.lon) * t,
        terrain: null,
      });
    }
  });

  if (!samples.length) { onProgress?.(0, 0); return; }

  // Récupérer les altitudes du terrain par lots, en respectant le débit de l'API.
  for (let i = 0; i < samples.length; i += BATCH) {
    const chunk = samples.slice(i, i + BATCH);
    const locs = chunk.map((s) => `${s.lat},${s.lon}`).join('|');
    try {
      const res = await fetch(`${TOPO_URL}?locations=${locs}`);
      if (res.ok) {
        const { results } = await res.json();
        chunk.forEach((s, k) => { s.terrain = results[k]?.elevation ?? null; });
      }
    } catch { /* lot ignoré → ces échantillons n'occulteront pas */ }
    onProgress?.(Math.min(i + BATCH, samples.length), samples.length);
    if (i + BATCH < samples.length) await sleep(RATE_MS);
  }

  // Angle de terrain maximal le long de chaque rayon.
  const maxAngle = new Array(peaks.length).fill(-Infinity);
  for (const s of samples) {
    if (s.terrain == null) continue;
    const ang = elevationAngle(userAlt, s.terrain, s.distM);
    if (ang > maxAngle[s.peakIdx]) maxAngle[s.peakIdx] = ang;
  }
  peaks.forEach((p, idx) => {
    p.occluded = maxAngle[idx] > p.elevation + MARGIN;
  });
}

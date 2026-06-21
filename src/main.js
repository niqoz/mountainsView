import { startCamera } from './camera.js';
import { startOrientation, getLocation } from './sensors.js';
import { Overlay } from './overlay.js';
import { fetchNearbyPeaks, getUserAltitude } from './peaks.js';
import { bearing, distance, elevationAngle } from './geo.js';
import { computeOcclusion } from './occlusion.js';

const $ = (id) => document.getElementById(id);

// --- État global ---

const DEFAULT_BASIS = { right: [1, 0, 0], up: [0, 0, 1], forward: [0, 1, 0] };
let rawPointing       = { azimuth: 0, elevation: 0, basis: DEFAULT_BASIS };
let orientationSource = '';
let dAz        = 0;      // offset boussole pour ancrer le zéro du gyroscope
let calibrated = false;

let location      = null;
let computedPeaks = []; // pré-calculés : { name, azimuth, elevation, distKm, altM }
let overlay       = null;
let lastHudUpdate = 0;

// --- Démarrage ---

$('btn-start').addEventListener('click', enterApp);

async function enterApp() {
  $('start-screen').classList.add('hidden');
  $('loading').classList.remove('hidden');
  setLoadingMsg('Démarrage des capteurs…');

  try {
    // Orientation AVANT la caméra : sur iOS, DeviceOrientationEvent.requestPermission()
    // doit être déclenché dans la continuité du geste utilisateur.
    await startOrientation((p) => {
      rawPointing       = p;
      orientationSource = p.source;
    });

    // Ancrage boussole automatique (une seule lecture, aucun geste requis)
    anchorGyroWithCompass();

    setLoadingMsg('Démarrage caméra…');
    await startCamera($('cam'));
  } catch (err) {
    $('loading').innerHTML =
      `<p style="color:#f87171;padding:24px;text-align:center">Erreur : ${err.message}</p>`;
    return;
  }

  overlay = new Overlay($('overlay'));
  $('loading').classList.add('hidden');

  // GPS + sommets en arrière-plan (n'attend pas pour afficher la caméra)
  acquireLocationAndPeaks();

  requestAnimationFrame(renderLoop);
}

// --- Calibration automatique boussole → gyroscope ---

function anchorGyroWithCompass() {
  const evtName = ('ondeviceorientationabsolute' in window)
    ? 'deviceorientationabsolute'
    : 'deviceorientation';

  const anchor = (e) => {
    if (calibrated) {
      window.removeEventListener(evtName, anchor, true);
      return;
    }
    // Boussole déjà référencée au nord → pas d'offset nécessaire
    if (orientationSource === 'compass') {
      calibrated = true;
      window.removeEventListener(evtName, anchor, true);
      return;
    }
    // Gyroscope : calcul de l'offset dAz par rapport au nord magnétique
    const compassAz = typeof e.webkitCompassHeading === 'number'
      ? e.webkitCompassHeading
      : ((360 - (e.alpha ?? 0)) + 360) % 360;
    dAz = ((compassAz - rawPointing.azimuth) + 360) % 360;
    calibrated = true;
    window.removeEventListener(evtName, anchor, true);
  };

  window.addEventListener(evtName, anchor, true);
}

// --- Azimut/élévation corrigés (nord-référencé) ---

function pointing() {
  if (orientationSource === 'compass') {
    return { azimuth: rawPointing.azimuth, elevation: rawPointing.elevation };
  }
  return {
    azimuth:   ((rawPointing.azimuth + dAz) % 360 + 360) % 360,
    elevation: rawPointing.elevation,
  };
}

// --- GPS et chargement des sommets ---

async function acquireLocationAndPeaks() {
  setGps('GPS en cours…');
  try {
    location = await getLocation();
    setGps(`${location.lat.toFixed(3)}, ${location.lon.toFixed(3)}  ±${location.accuracy.toFixed(0)} m`);
  } catch {
    setGps('GPS indisponible');
    return;
  }

  $('peaks-badge').classList.remove('hidden');
  setPeakBadge('Chargement sommets…');
  try {
    const [userAlt, rawPeaks] = await Promise.all([
      getUserAltitude(location.lat, location.lon),
      fetchNearbyPeaks(location.lat, location.lon),
    ]);
    computedPeaks = precompute(rawPeaks, userAlt);
    setPeakBadge(`${computedPeaks.length} sommets (50 km)`);

    // Occlusion par terrain en arrière-plan : les sommets masqués par un relief
    // plus proche disparaissent au fil des résultats (mutation in place).
    computeOcclusion(computedPeaks, location, userAlt, (done, total) => {
      if (total) setPeakBadge(`Relief… ${Math.round((done / total) * 100)} %`);
    }).then(() => {
      const visible = computedPeaks.filter((p) => !p.occluded).length;
      setPeakBadge(`${visible} sommets visibles`);
    }).catch((err) => console.error('Occlusion:', err));
  } catch (err) {
    setPeakBadge('Erreur sommets');
    console.error(err);
  }
}

function precompute(peaks, userAlt) {
  return peaks
    .filter((p) => p.ele !== null && p.ele >= 200) // ignorer les points OSM sans altitude significative
    .map((p) => {
      const distM = distance(location.lat, location.lon, p.lat, p.lon);
      return {
        name:      p.name,
        lat:       p.lat,
        lon:       p.lon,
        azimuth:   bearing(location.lat, location.lon, p.lat, p.lon),
        elevation: elevationAngle(userAlt, p.ele, distM),
        distKm:    distM / 1000,
        altM:      p.ele,
        occluded:  false,
      };
    });
}

// --- Boucle de rendu ---

function renderLoop() {
  if (!overlay) { requestAnimationFrame(renderLoop); return; }

  const pt = pointing();
  const b  = rawPointing.basis;
  const view = {
    right:   b.right,
    up:      b.up,
    forward: b.forward,
    dAz:     orientationSource === 'compass' ? 0 : dAz,
    dEl:     0,
  };

  overlay.draw(view, computedPeaks);

  // Mise à jour HUD throttlée à 250 ms pour limiter les reflows DOM
  const now = Date.now();
  if (now - lastHudUpdate > 250) {
    lastHudUpdate = now;
    updateSensorBadge(pt);
  }

  requestAnimationFrame(renderLoop);
}

// --- HUD ---

function setLoadingMsg(t) { const el = $('loading-msg'); if (el) el.textContent = t; }
function setGps(t)        { const el = $('gps');         if (el) el.textContent = t; }
function setPeakBadge(t)  { const el = $('peaks-badge'); if (el) el.textContent = t; }

function updateSensorBadge(pt) {
  const el = $('sensor-badge');
  if (!el) return;
  const src = orientationSource === 'gyro'
    ? (calibrated ? 'Gyro+Boussole' : 'Gyro…')
    : 'Boussole';
  el.textContent = `${src}  Az ${pt.azimuth.toFixed(0)}°  El ${pt.elevation.toFixed(0)}°`;
}

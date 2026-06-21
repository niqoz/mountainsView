// Lecture des capteurs : orientation et géolocalisation.
//
// Deux capteurs complémentaires (Generic Sensor API) :
//   • RelativeOrientationSensor : gyro + accéléro SANS magnétomètre → orientation
//     LISSE, immunisée contre la distorsion magnétique, mais lacet (yaw) arbitraire.
//   • AbsoluteOrientationSensor : inclut le magnétomètre → lacet référencé au nord,
//     mais bruité. Avantage décisif vs DeviceOrientation : sortie en QUATERNION
//     (pas d'angles d'Euler), donc AUCUNE dégénérescence (gimbal lock) quand le
//     téléphone est tenu à la verticale — précisément le cas où la boussole
//     DeviceOrientation devient « complètement fausse ».
//
// On extrait l'azimut de visée (axe optique −Z tourné en monde) de CHAQUE capteur,
// puis on cale le yaw du gyro sur le yaw absolu via un FILTRE COMPLÉMENTAIRE à
// faible gain : les pics magnétiques transitoires sont rejetés (gyro lisse), le
// biais persistant est corrigé (référence nord). Le bouton « Recalibrer » force
// un recalage immédiat.
//
// Repli : DeviceOrientation (boussole) pour les navigateurs sans Generic Sensor API
// (Safari/iOS), avec reconstruction correcte du repère via matrice de rotation.

const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;

export async function startOrientation(onUpdate) {
  if ('RelativeOrientationSensor' in window) {
    try {
      return await startFusedOrientation(onUpdate);
    } catch (err) {
      console.warn('Capteurs de mouvement indisponibles, repli boussole :', err);
    }
  }
  return startCompassOrientation(onUpdate);
}

// --- Permissions (Generic Sensor API) ---

async function ensureMotionPermission() {
  if (!navigator.permissions?.query) return;
  const need = ['accelerometer', 'gyroscope'];
  const states = await Promise.all(need.map((n) =>
    navigator.permissions.query({ name: n }).then((r) => r.state).catch(() => 'unknown')));
  if (states.some((s) => s === 'denied')) {
    throw new Error('Permission capteurs de mouvement refusée');
  }
}

// --- Orientation fusionnée (gyro lisse + nord magnétique) ---

async function startFusedOrientation(onUpdate) {
  await ensureMotionPermission();

  const GAIN    = 0.08; // gain du filtre complémentaire sur le yaw
  const ERR_EMA = 0.05; // lissage de l'indicateur de bruit magnétique

  let relAz = 0;            // azimut de visée (gyro, repère à yaw arbitraire)
  let dAz = 0;              // offset yaw → nord
  let calibrated = false;   // un calage absolu a déjà eu lieu
  let magErr = 0;           // erreur magnétique lissée (degrés)
  let snap = true;          // forcer un calage immédiat (démarrage / bouton)

  // Capteur lisse : fournit le repère caméra et le rendu haute fréquence.
  const rel = new RelativeOrientationSensor({ frequency: 60, referenceFrame: 'device' });
  rel.addEventListener('reading', () => {
    const q = rel.quaternion;
    if (!q) return;
    const forward = rotateVectorByQuat(q, [0, 0, -1]);
    const right   = rotateVectorByQuat(q, [1, 0, 0]);
    const up      = rotateVectorByQuat(q, [0, 1, 0]);
    relAz = normalizeDeg(Math.atan2(forward[0], forward[1]) * R2D);
    const elevation = Math.asin(clamp(forward[2], -1, 1)) * R2D;

    onUpdate({
      azimuth: normalizeDeg(relAz + dAz),
      elevation,
      basis: { right, up, forward },
      source: 'gyro',
      dAz,
      calibrated,
      magReliable: magErr < 8,
    });
  });

  // Consomme un azimut absolu (nord) et cale dAz dessus.
  const consumeAbsAz = (absAz) => {
    const target = normalizeDeg(absAz - relAz); // offset à appliquer à relAz
    if (snap || !calibrated) {
      dAz = target;
      calibrated = true;
      snap = false;
      magErr = 0;
    } else {
      const err = shortestDiff(target, dAz); // [-180, 180]
      dAz = normalizeDeg(dAz + GAIN * err);
      magErr += ERR_EMA * (Math.abs(err) - magErr);
    }
  };

  // Source du nord : AbsoluteOrientationSensor (quaternion, robuste à l'inclinaison),
  // sinon repli DeviceOrientation.
  let stopAbs = () => {};
  if ('AbsoluteOrientationSensor' in window) {
    const abs = new AbsoluteOrientationSensor({ frequency: 30, referenceFrame: 'device' });
    abs.addEventListener('reading', () => {
      const q = abs.quaternion;
      if (!q) return;
      const f = rotateVectorByQuat(q, [0, 0, -1]);
      consumeAbsAz(normalizeDeg(Math.atan2(f[0], f[1]) * R2D));
    });
    abs.addEventListener('error', (e) => {
      console.warn('AbsoluteOrientationSensor erreur, repli DeviceOrientation :', e.error);
      stopAbs = startDeviceOrientationAzimuth(consumeAbsAz);
    });
    abs.start();
    stopAbs = () => abs.stop();
  } else {
    stopAbs = startDeviceOrientationAzimuth(consumeAbsAz);
  }

  rel.start();

  return {
    stop() { rel.stop(); stopAbs(); },
    recalibrate() { snap = true; },
  };
}

// Fournit un azimut absolu (cap caméra) depuis DeviceOrientation, reconstruit via
// matrice de rotation (correct quelle que soit l'inclinaison, hors gimbal lock).
function startDeviceOrientationAzimuth(onAzimuth) {
  const handler = (e) => {
    let alpha = e.alpha;
    if (typeof e.webkitCompassHeading === 'number') alpha = 360 - e.webkitCompassHeading;
    if (alpha == null) return;
    const { forward } = eulerToBasis(alpha, e.beta, e.gamma);
    onAzimuth(normalizeDeg(Math.atan2(forward[0], forward[1]) * R2D));
  };
  const evt = ('ondeviceorientationabsolute' in window) ? 'deviceorientationabsolute' : 'deviceorientation';
  window.addEventListener(evt, handler, true);
  return () => window.removeEventListener(evt, handler, true);
}

// --- Repli boussole pur (sans Generic Sensor API : Safari/iOS) ---

async function startCompassOrientation(onUpdate) {
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    const res = await DeviceOrientationEvent.requestPermission();
    if (res !== 'granted') throw new Error('Permission orientation refusée');
  }

  const handler = (e) => {
    let alpha = e.alpha;
    if (typeof e.webkitCompassHeading === 'number') alpha = 360 - e.webkitCompassHeading;
    const basis = eulerToBasis(alpha, e.beta, e.gamma);
    const azimuth   = normalizeDeg(Math.atan2(basis.forward[0], basis.forward[1]) * R2D);
    const elevation = clamp(Math.asin(clamp(basis.forward[2], -1, 1)) * R2D, -90, 90);
    onUpdate({ azimuth, elevation, basis, source: 'compass', dAz: 0, calibrated: true, magReliable: true });
  };

  const evt = ('ondeviceorientationabsolute' in window) ? 'deviceorientationabsolute' : 'deviceorientation';
  window.addEventListener(evt, handler, true);
  return {
    stop() { window.removeEventListener(evt, handler, true); },
    recalibrate() {},
  };
}

// --- Maths ---

// Repère caméra (droite/haut/avant) depuis les angles DeviceOrientation, via la
// matrice de rotation appareil→monde (convention W3C ZXY, monde ENU : X est, Y nord, Z haut).
function eulerToBasis(alphaDeg, betaDeg, gammaDeg) {
  const a = (alphaDeg || 0) * D2R; // Z (lacet)
  const b = (betaDeg  || 0) * D2R; // X (tangage)
  const g = (gammaDeg || 0) * D2R; // Y (roulis)
  const cA = Math.cos(a), sA = Math.sin(a);
  const cB = Math.cos(b), sB = Math.sin(b);
  const cG = Math.cos(g), sG = Math.sin(g);

  const m11 = cA * cG - sA * sB * sG;
  const m21 = cG * sA + cA * sB * sG;
  const m31 = -cB * sG;
  const m12 = -cB * sA;
  const m22 = cA * cB;
  const m32 = sB;
  const m13 = cG * sA * sB + cA * sG;
  const m23 = sA * sG - cA * cG * sB;
  const m33 = cB * cG;

  // Colonnes = images des axes appareil dans le monde.
  return {
    right:   [m11, m21, m31],     // +X appareil
    up:      [m12, m22, m32],     // +Y appareil
    forward: [-m13, -m23, -m33],  // −Z appareil (axe caméra)
  };
}

// Rotation d'un vecteur v par un quaternion q = [x,y,z,w]  (v' = q·v·q⁻¹).
function rotateVectorByQuat(q, v) {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

// --- Géolocalisation ---

export function getLocation() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Géolocalisation indisponible'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 300000 }
    );
  });
}

function normalizeDeg(d) { return ((d % 360) + 360) % 360; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
// Plus court écart angulaire signé a−b dans [−180, 180].
function shortestDiff(a, b) { return ((a - b + 540) % 360) - 180; }

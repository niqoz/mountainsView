// Lecture des capteurs : orientation et géolocalisation.
//
// Source d'orientation privilégiée : RelativeOrientationSensor (Generic Sensor API),
// qui FUSIONNE gyroscope + accéléromètre SANS magnétomètre → orientation lisse et
// immunisée contre la distorsion magnétique. Le lacet (yaw) a un zéro arbitraire
// et est ancré sur la boussole automatiquement au démarrage (voir main.js).
//
// Repli : DeviceOrientation (boussole) si le capteur gyro n'est pas disponible.
// Azimut déjà référencé au nord dans ce cas, aucun ancrage supplémentaire requis.

export async function startOrientation(onUpdate) {
  if ('RelativeOrientationSensor' in window) {
    try {
      return await startGyroOrientation(onUpdate);
    } catch (err) {
      console.warn('Gyro indisponible, repli sur la boussole :', err);
    }
  }
  return startCompassOrientation(onUpdate);
}

async function startGyroOrientation(onUpdate) {
  if (navigator.permissions?.query) {
    try {
      const results = await Promise.all([
        navigator.permissions.query({ name: 'accelerometer' }),
        navigator.permissions.query({ name: 'gyroscope' }),
      ]);
      if (results.some((r) => r.state === 'denied')) {
        throw new Error('Permission capteurs de mouvement refusée');
      }
    } catch { /* query non supportée : on tente quand même */ }
  }

  const sensor = new RelativeOrientationSensor({ frequency: 60, referenceFrame: 'device' });

  return await new Promise((resolve, reject) => {
    let resolved = false;

    sensor.addEventListener('error', (e) => {
      if (!resolved) reject(e.error || new Error('Erreur capteur orientation'));
    });

    sensor.addEventListener('reading', () => {
      const q = sensor.quaternion;
      if (!q) return;

      const forward = rotateVectorByQuat(q, [0, 0, -1]);
      const right   = rotateVectorByQuat(q, [1, 0, 0]);
      const up      = rotateVectorByQuat(q, [0, 1, 0]);

      const elevation = Math.asin(clamp(forward[2], -1, 1)) * (180 / Math.PI);
      const azimuth   = normalizeDeg(Math.atan2(forward[0], forward[1]) * (180 / Math.PI));

      onUpdate({ azimuth, elevation, basis: { right, up, forward }, source: 'gyro' });

      if (!resolved) { resolved = true; resolve(() => sensor.stop()); }
    });

    sensor.start();
  });
}

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

async function startCompassOrientation(onUpdate) {
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    const res = await DeviceOrientationEvent.requestPermission();
    if (res !== 'granted') throw new Error('Permission orientation refusée');
  }

  const handler = (e) => {
    const heading = (typeof e.webkitCompassHeading === 'number')
      ? e.webkitCompassHeading
      : normalizeDeg(360 - e.alpha);
    const azimuth   = normalizeDeg(heading);
    const elevation = clamp((e.beta ?? 90) - 90, -90, 90);

    const a = azimuth * (Math.PI / 180), el = elevation * (Math.PI / 180);
    const ce = Math.cos(el);
    const forward = [Math.sin(a) * ce, Math.cos(a) * ce, Math.sin(el)];
    const right   = [Math.cos(a), -Math.sin(a), 0];
    const up      = cross(right, forward);

    onUpdate({ azimuth, elevation, basis: { right, up, forward }, source: 'compass' });
  };

  const evtName = ('ondeviceorientationabsolute' in window)
    ? 'deviceorientationabsolute'
    : 'deviceorientation';
  window.addEventListener(evtName, handler, true);
  return () => window.removeEventListener(evtName, handler, true);
}

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
function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

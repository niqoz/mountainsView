// Rendu de l'overlay AR sur le canvas.
//
// Projection STÉNOPÉ 3D : chaque sommet (azimut, élévation absolus) est
// transformé dans le repère caméra (droite/haut/avant fournis par les capteurs)
// puis projeté en pixels — même modèle que SolaireDim, sans le dessin solaire.

const RAD = Math.PI / 180;

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

function azElToVec(azDeg, elDeg) {
  const a = azDeg * RAD, e = elDeg * RAD;
  const ce = Math.cos(e);
  return [Math.sin(a) * ce, Math.cos(a) * ce, Math.sin(e)];
}

// Axes écran calculés depuis la verticale monde, indépendamment de la rotation de l'écran.
// "Haut visuel" = composante de [0,0,1] (contre-gravité) perpendiculaire à l'axe optique.
// Cette approche élimine l'ambiguïté CW/CCW du paysage et fonctionne dans toutes orientations.
function screenAxes(view) {
  const fwd = view.forward;
  const wz  = [0, 0, 1];
  const d   = dot(wz, fwd);
  const ur  = [wz[0] - d*fwd[0], wz[1] - d*fwd[1], wz[2] - d*fwd[2]];
  const len = Math.sqrt(dot(ur, ur));
  if (len < 0.05) return { right: view.right, up: view.up }; // caméra vers zénith/nadir
  const up    = ur.map(v => v / len);
  const right = [fwd[1]*up[2] - fwd[2]*up[1],
                 fwd[2]*up[0] - fwd[0]*up[2],
                 fwd[0]*up[1] - fwd[1]*up[0]];
  return { right, up };
}

export class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.fovH = 69;   // champ horizontal effectif (degrés)
    this.fovV = 102;  // champ vertical effectif (degrés)
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width  = Math.round(this.canvas.clientWidth  * dpr);
    this.canvas.height = Math.round(this.canvas.clientHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  ensureSize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(this.canvas.clientWidth  * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (w && h && (this.canvas.width !== w || this.canvas.height !== h)) this.resize();
  }

  setFov(h, v) { this.fovH = h; this.fovV = v; }

  /**
   * Projette un point monde (azimut vrai, élévation vraie) en pixels écran.
   * @param {number} trueAz  Azimut absolu (degrés, nord = 0).
   * @param {number} trueEl  Élévation absolue (degrés).
   * @param {object} view    { right, up, forward, dAz, dEl }
   */
  project(trueAz, trueEl, view, w, h) {
    const V = azElToVec(trueAz - view.dAz, trueEl - view.dEl);

    const cz = dot(V, view.forward);
    if (cz <= 0.02) return { x: 0, y: 0, visible: false, cx: 0, cy: 0, cz };

    // Axes écran depuis la gravité — fonctionne dans toutes les orientations
    const axes = screenAxes(view);
    const cx = dot(V, axes.right);
    const cy = dot(V, axes.up);

    // FOV : portrait = 69°H × 102°V, paysage = 102°H × 69°V
    const landscape = w > h;
    const fovH = landscape ? 102 : 69;
    const fovV = landscape ? 69  : 102;
    const fx = (w / 2) / Math.tan((fovH / 2) * RAD);
    const fy = (h / 2) / Math.tan((fovV / 2) * RAD);
    const x = w / 2 + fx * (cx / cz);
    const y = h / 2 - fy * (cy / cz);

    const visible = x >= -80 && x <= w + 80 && y >= -80 && y <= h + 80;
    return { x, y, visible, cx, cy, cz };
  }

  /**
   * Dessine les sommets les plus proéminents dans le champ de vue.
   * @param {object} view   Repère caméra + calibration { right, up, forward, dAz, dEl }
   * @param {Array}  peaks  [{ name, azimuth, elevation, distKm, altM }]
   */
  draw(view, peaks) {
    this.ensureSize();
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    if (!peaks.length) return;

    // Projeter et retenir uniquement les sommets strictement dans l'écran
    const projected = [];
    for (const p of peaks) {
      if (p.occluded) continue; // masqué par un relief plus proche
      const pr = this.project(p.azimuth, p.elevation, view, w, h);
      if (pr.visible && pr.x >= 0 && pr.x <= w && pr.y >= 0 && pr.y <= h) {
        projected.push({ ...p, x: pr.x, y: pr.y });
      }
    }

    // Trier par angle d'élévation décroissant : les sommets qui "dépassent" le plus
    // au-dessus de l'horizon de l'observateur sont affichés en priorité (Monte Negrine
    // à 4 km / 850 m apparaît avant Monte Cinto à 48 km / 2700 m).
    projected.sort((a, b) => b.elevation - a.elevation);

    // Placer max 15 labels : skip si les badges se chevauchent en X ET en Y
    const placed = [];
    for (const p of projected) {
      if (placed.length >= 15) break;
      if (placed.some((q) => Math.abs(p.x - q.x) < 55 && Math.abs(p.y - q.y) < 32)) continue;
      placed.push(p);
    }

    for (const p of placed) {
      this._drawLabel(ctx, p.name, p.distKm, p.altM, p.x, p.y, w, h);
    }
  }

  _drawLabel(ctx, name, distKm, altM, x, y, w, h) {
    const tickTop = y - 20;

    // Trait vertical du point projeté vers le badge
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, tickTop + 4);
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.stroke();

    // Point au centre de projection
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fill();

    // Badge : nom + distance
    const label = `${name}  ${distKm.toFixed(0)} km`;
    ctx.font = '700 13px system-ui, sans-serif';
    const tw = ctx.measureText(label).width;
    const pad = 7, bh = 22;
    const bw = tw + pad * 2;
    const bx = Math.max(pad, Math.min(w - bw - pad, x - bw / 2));
    const by = tickTop - bh;

    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(bx, by, bw, bh, 5);
    } else {
      ctx.rect(bx, by, bw, bh);
    }
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + pad, by + bh / 2);

    // Altitude en sous-titre (petit, sous le badge)
    if (altM > 0) {
      const sub = `${altM} m`;
      ctx.font = '500 11px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(sub, bx + bw / 2, by + bh + 2);
    }
  }
}

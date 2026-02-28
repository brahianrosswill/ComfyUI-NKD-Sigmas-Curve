/**
 * NKD Sigma Curve – ComfyUI extension
 *
 * Dos modos de interpolación:
 *   smooth  – Spline Hermite Cardinal con pesos de tensión por punto
 *   linear  – Interpolación lineal
 *
 * Representación de tensiones por modo:
 *   smooth  → Handles tangenciales en cada punto de control
 *   linear  → Sin decoraciones adicionales
 *
 * Interacción:
 *   Clic izquierdo → añadir punto
 *   Drag           → mover punto
 *   Shift + clic   → eliminar punto (mínimo 2)
 */

import { app } from "../../scripts/app.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const NODE_NAME = "NKDSigmaCurve";
const EXT_NAME  = "NKD.SigmaCurve";

// Dimensiones lógicas del canvas (el buffer real se escala por DPR)
const CANVAS_W = 320;
const CANVAS_H = 200;
const PAD = { top: 16, right: 14, bottom: 22, left: 42 };
const IW  = CANVAS_W - PAD.left - PAD.right;
const IH  = CANVAS_H - PAD.top  - PAD.bottom;

const HIT_R = 10;
const PT_R  = { idle: 4.5, hover: 6, active: 7 };

// Handle tangencial: fracción de la distancia al vecino más cercano en x-canvas
const HANDLE_DIST_FRAC = 0.33;
const HANDLE_MAX_LEN   = 40;   // tope absoluto para segmentos muy largos

const COL = {
  bg:           "#111318",
  grid:         "rgba(255,255,255,0.06)",
  gridBorder:   "rgba(255,255,255,0.16)",
  curve:        "#4ab4ff",
  curveFade:    "rgba(74,180,255,0.15)",
  // Puntos de control
  point:        "#4ab4ff",
  pointHover:   "#ffd166",
  pointActive:  "#ff6b6b",
  pointStroke:  "rgba(0,0,0,0.65)",
  // Handles tangenciales (modo smooth)
  handleLine:   "rgba(74,180,255,0.25)",
  handleDot:    "rgba(74,180,255,0.55)",
  axisLabel:    "rgba(255,255,255,0.40)",
  axisLabelDim: "rgba(255,255,255,0.20)",
};

// ─── Hermite Cardinal (modo smooth) ──────────────────────────────────────────

/**
 * Calcula las pendientes tangenciales (dy/dx) usando parametrización Centripetal
 * Catmull-Rom (α=0.5): pondera las pendientes de los cordones adyacentes por la
 * distancia euclidiana elevada a 0.5 entre los puntos vecinos.
 *
 *   m_i = a_i × (slope_L × d_R + slope_R × d_L) / (d_L + d_R)
 *   d_k = ((Δx)² + (Δy)²)^0.25      (α = 0.5 centripetal)
 *   a_i = 1 - w_i  (peso por punto: w=0 → tangente completa, w=1 → tangente nula)
 *
 * @param {number[][]} pts     Puntos de control ordenados por x
 * @param {number[]}   weights Pesos por punto w_i ∈ [0,1]
 */
function computeTangents(pts, weights) {
  const n  = pts.length;
  const ts = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    const a = 1.0 - (weights[i] ?? 0.0);  // per-point scale

    if (i === 0) {
      // First point always has a horizontal tangent (ts[0] stays 0)
    } else if (i === n - 1) {
      // Last point: one-sided backward difference (no centripetal weighting needed)
      const dx = pts[n - 1][0] - pts[n - 2][0];
      if (dx > 0) ts[i] = a * (pts[n - 1][1] - pts[n - 2][1]) / dx;
    } else {
      const dx1 = pts[i][0]     - pts[i - 1][0];
      const dx2 = pts[i + 1][0] - pts[i][0];
      if (dx1 > 0 && dx2 > 0) {
        const dy1 = pts[i][1]     - pts[i - 1][1];
        const dy2 = pts[i + 1][1] - pts[i][1];
        const s1  = dy1 / dx1;
        const s2  = dy2 / dx2;
        // Centripetal weights: 2D chord length ^ alpha=0.5 = ((Δx²+Δy²)^0.5)^0.5
        const w1   = Math.pow(dx1 * dx1 + dy1 * dy1, 0.25);
        const w2   = Math.pow(dx2 * dx2 + dy2 * dy2, 0.25);
        const wSum = w1 + w2;
        ts[i] = wSum > 0 ? a * (s1 * w2 + s2 * w1) / wSum : 0;
      }
    }
  }
  return ts;
}

/** Extrae los pesos por punto (tercer elemento) de cada punto de control. */
function extractWeights(pts) {
  return pts.map(p => Math.max(0, Math.min(1, p[2] ?? 0.0)));
}

/** Interpolación Hermite cúbica en un segmento de anchura h. */
function hermiteSegment(y0, y1, m0, m1, h, t) {
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * y0
       + (t3 - 2 * t2 + t)     * h * m0
       + (-2 * t3 + 3 * t2)    * y1
       + (t3 - t2)              * h * m1;
}

// ─── Dispatcher principal ─────────────────────────────────────────────────────

/**
 * Muestrea la curva en t ∈ [0, 1] según el modo de interpolación.
 * @param {number[][]} pts   Puntos de control [x, y, w] ordenados por x
 * @param {number}     t
 * @param {"smooth"|"linear"} mode
 */
function sampleCurve(pts, t, mode) {
  const n = pts.length;
  if (n === 0) return 0;
  if (n === 1) return pts[0][1];

  t = Math.max(0, Math.min(1, t));
  if (t <= pts[0][0])     return pts[0][1];
  if (t >= pts[n - 1][0]) return pts[n - 1][1];

  let seg = 0;
  for (let i = 0; i < n - 1; i++) {
    if (pts[i][0] <= t && t <= pts[i + 1][0]) { seg = i; break; }
  }

  const [x0, y0] = pts[seg];
  const [x1, y1] = pts[seg + 1];
  if (x1 === x0) return y0;
  const lt   = (t - x0) / (x1 - x0);
  const yLin = y0 + lt * (y1 - y0);

  if (mode === "linear") return yLin;

  // Hermite Cardinal (modo "smooth") — usa pesos por punto
  const weights = extractWeights(pts);
  const tgts    = computeTangents(pts, weights);
  const h       = x1 - x0;
  return Math.max(0, Math.min(1, hermiteSegment(y0, y1, tgts[seg], tgts[seg + 1], h, lt)));
}

// ─── Helpers de coordenadas ───────────────────────────────────────────────────

const toCanvasX = nx => PAD.left + nx * IW;
const toCanvasY = ny => PAD.top  + (1 - ny) * IH;
const fromCX    = cx => Math.max(0, Math.min(1, (cx - PAD.left) / IW));
const fromCY    = cy => Math.max(0, Math.min(1, 1 - (cy - PAD.top) / IH));

/** Formatea un valor sigma de forma adaptativa según la magnitud. */
function fmtSigma(v) {
  const a = Math.abs(v);
  if (a === 0)  return "0";
  if (a < 0.01) return v.toExponential(1);
  if (a < 10)   return v.toFixed(3);
  if (a < 100)  return v.toFixed(2);
  if (a < 1000) return v.toFixed(1);
  return v.toFixed(0);
}

// ─── SigmaCurveEditor ────────────────────────────────────────────────────────

class SigmaCurveEditor {
  constructor(rootEl, onChange, widgetRefs = {}) {
    this.points        = [[0.0, 1.0, 0.0], [1.0, 0.0, 0.0]];
    this.interpolation = "smooth";
    this.tension       = 0.0;
    this.onChange      = onChange;

    this._stepsWidget    = widgetRefs.stepsWidget    ?? null;
    this._maxSigmaWidget = widgetRefs.maxSigmaWidget ?? null;

    this._dragIdx  = -1;
    this._hoverIdx = -1;
    this._dragging = false;
    this._ctx = null;
    this._dpr = 1;

    // Refs DOM dinámicos
    this._infoEl        = null;
    this._tensionRow    = null;
    this._tensionSlider = null;
    this._tensionValEl  = null;

    this._buildDOM(rootEl);
    this._bindEvents();
    this._draw();
  }

  get _maxSigma() { return +(this._maxSigmaWidget?.value ?? 1.0); }
  get _steps()    { return +(this._stepsWidget?.value    ?? 20);   }

  // ── Construcción DOM ───────────────────────────────────────────────────────

  _buildDOM(rootEl) {
    rootEl.style.cssText =
      "display:flex;flex-direction:column;gap:0;background:transparent;overflow:hidden;";

    // ── Barra de controles ─────────────────────────────────────────────────
    const bar = document.createElement("div");
    bar.style.cssText =
      "display:flex;flex-direction:column;background:#1a1c22;border-bottom:1px solid #2a2d36;";

    // Fila 1: controles
    const row1 = document.createElement("div");
    row1.style.cssText =
      "display:flex;align-items:center;gap:6px;padding:5px 7px 3px;overflow:hidden;";

    // Selector de modo
    this._interpSelect = this._makeSelect(
      [
        { value: "smooth", label: "Smooth" },
        { value: "linear", label: "Linear" },
      ],
      this.interpolation
    );
    this._interpSelect.addEventListener("change", () => {
      this.interpolation = this._interpSelect.value;
      this._updateModeUI();
      this._draw();
      this._emit();
    });
    row1.appendChild(this._styledLabel("Mode"));
    row1.appendChild(this._interpSelect);
    row1.appendChild(this._divider());

    // Slider de tensión (solo en modo smooth)
    const tensionGroup = document.createElement("div");
    tensionGroup.style.cssText = "display:flex;align-items:center;gap:5px;";
    this._tensionRow = tensionGroup;

    tensionGroup.appendChild(this._styledLabel("Tension"));
    this._tensionSlider = document.createElement("input");
    Object.assign(this._tensionSlider, { type:"range", min:0, max:1, step:0.01, value:0 });
    this._tensionSlider.style.cssText = "width:72px;height:4px;cursor:pointer;accent-color:#4ab4ff;";
    this._tensionSlider.addEventListener("input", () => {
      this.tension = parseFloat(this._tensionSlider.value);
      if (this._tensionValEl) this._tensionValEl.textContent = this.tension.toFixed(2);
      // Aplicar tensión a todos los puntos uniformemente
      this.points.forEach(p => { p[2] = this.tension; });
      this._draw();
      this._emit();
    });
    tensionGroup.appendChild(this._tensionSlider);

    this._tensionValEl = document.createElement("span");
    this._tensionValEl.textContent = "0.00";
    this._tensionValEl.style.cssText =
      "font-size:10px;font-family:monospace;color:#aac;min-width:28px;";
    tensionGroup.appendChild(this._tensionValEl);
    row1.appendChild(tensionGroup);

    // Fila 2: hint · spacer · reset · info
    const row2 = document.createElement("div");
    row2.style.cssText =
      "display:flex;align-items:center;gap:5px;padding:2px 7px 4px;min-width:0;";

    const hintEl = document.createElement("span");
    hintEl.style.cssText =
      "font-size:9.5px;color:rgba(255,255,255,0.22);white-space:nowrap;" +
      "overflow:hidden;text-overflow:ellipsis;min-width:0;flex-shrink:1;";
    hintEl.textContent = "Click=add · Drag=move · Shift+click=remove";
    row2.appendChild(hintEl);

    const spacer = document.createElement("div");
    spacer.style.cssText = "flex:1;min-width:4px;";
    row2.appendChild(spacer);

    const resetBtn = document.createElement("button");
    resetBtn.textContent = "↺";
    resetBtn.title = "Reset curve";
    resetBtn.style.cssText =
      "font-size:12px;background:#252830;border:1px solid #3a3d46;" +
      "color:rgba(255,255,255,0.55);border-radius:4px;padding:1px 7px;" +
      "cursor:pointer;line-height:1.4;flex-shrink:0;";
    resetBtn.addEventListener("mouseenter", () => {
      resetBtn.style.borderColor = "#4ab4ff";
      resetBtn.style.color = "rgba(255,255,255,0.85)";
    });
    resetBtn.addEventListener("mouseleave", () => {
      resetBtn.style.borderColor = "#3a3d46";
      resetBtn.style.color = "rgba(255,255,255,0.55)";
    });
    resetBtn.addEventListener("click", () => this._resetCurve());
    row2.appendChild(resetBtn);

    this._infoEl = document.createElement("span");
    this._infoEl.style.cssText =
      "font-size:10px;font-family:monospace;color:rgba(180,210,255,0.65);" +
      "white-space:nowrap;flex-shrink:0;";
    row2.appendChild(this._infoEl);

    bar.appendChild(row1);
    bar.appendChild(row2);
    rootEl.appendChild(bar);

    // ── Canvas con soporte HiDPI ───────────────────────────────────────────
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:relative;width:100%;";

    const dpr = Math.max(1, Math.ceil(window.devicePixelRatio || 1));
    this._dpr = dpr;

    this._canvas = document.createElement("canvas");
    this._canvas.width  = CANVAS_W * dpr;
    this._canvas.height = CANVAS_H * dpr;
    this._canvas.style.cssText =
      "display:block;width:100%;height:auto;cursor:crosshair;background:" + COL.bg + ";";

    this._ctx = this._canvas.getContext("2d");
    this._ctx.scale(dpr, dpr);  // escala permanente → coordenadas lógicas en todo el código

    wrap.appendChild(this._canvas);
    rootEl.appendChild(wrap);

    this._updateModeUI();
  }

  // ── Helpers DOM ────────────────────────────────────────────────────────────

  _styledLabel(text) {
    const el = document.createElement("span");
    el.textContent = text;
    el.style.cssText = "font-size:11px;color:rgba(255,255,255,0.45);white-space:nowrap;";
    return el;
  }

  _makeSelect(options, defaultVal) {
    const sel = document.createElement("select");
    sel.style.cssText =
      "font-size:11px;background:#252830;border:1px solid #3a3d46;" +
      "color:#c8d0e0;border-radius:4px;padding:2px 5px;cursor:pointer;outline:none;";
    options.forEach(({ value, label }) => {
      const opt = document.createElement("option");
      opt.value = value; opt.textContent = label;
      if (value === defaultVal) opt.selected = true;
      sel.appendChild(opt);
    });
    return sel;
  }

  _divider() {
    const d = document.createElement("div");
    d.style.cssText = "width:1px;height:14px;background:rgba(255,255,255,0.12);margin:0 1px;";
    return d;
  }

  /** Muestra/oculta controles según el modo activo. */
  _updateModeUI() {
    const hasTension = this.interpolation === "smooth";
    if (this._tensionRow) this._tensionRow.style.display = hasTension ? "flex" : "none";
  }

  // ── Eventos ────────────────────────────────────────────────────────────────

  _bindEvents() {
    const c = this._canvas;
    ["mousedown","mousemove","mouseup","mouseleave"].forEach(ev =>
      c.addEventListener(ev, e => { e.stopPropagation(); this["_on" + ev[0].toUpperCase() + ev.slice(1)](e); })
    );
    c.addEventListener("contextmenu", e => e.preventDefault());
  }

  _eventToLogical(e) {
    const rect = this._canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (CANVAS_W / rect.width),
      y: (e.clientY - rect.top)  * (CANVAS_H / rect.height),
    };
  }

  _hitTest(lx, ly) {
    let nearest = -1, minD = HIT_R;
    this.points.forEach((p, i) => {
      const d = Math.hypot(lx - toCanvasX(p[0]), ly - toCanvasY(p[1]));
      if (d < minD) { minD = d; nearest = i; }
    });
    return nearest;
  }

  _onMousedown(e) {
    const { x, y } = this._eventToLogical(e);
    const idx = this._hitTest(x, y);

    // Primer y último punto bloqueados: no se pueden arrastrar ni eliminar
    if (idx === 0 || idx === this.points.length - 1) return;

    if (e.shiftKey) {
      if (idx >= 0 && this.points.length > 2) {
        this.points.splice(idx, 1);
        this._hoverIdx = -1;
        this._draw(); this._emit();
      }
      return;
    }

    if (idx >= 0) {
      this._dragIdx  = idx;
      this._dragging = true;
      this._setCursor("grabbing");
    } else {
      const newPt = [fromCX(x), fromCY(y), this.tension];
      const at = this.points.findIndex(p => p[0] > newPt[0]);
      if (at === -1) {
        this.points.push(newPt);
        this._dragIdx = this.points.length - 1;
      } else {
        this.points.splice(at, 0, newPt);
        this._dragIdx = at;
      }
      this._dragging = true;
      this._setCursor("grabbing");
      this._draw(); this._emit();
    }
  }

  _onMousemove(e) {
    const { x, y } = this._eventToLogical(e);

    if (this._dragging && this._dragIdx >= 0) {
      const isFirst = this._dragIdx === 0;
      const isLast  = this._dragIdx === this.points.length - 1;
      const pt = this.points[this._dragIdx];
      pt[0] = isFirst ? 0 : isLast ? 1 : fromCX(x);
      pt[1] = fromCY(y);
      this.points.sort((a, b) => a[0] - b[0]);
      this._dragIdx = this.points.indexOf(pt);
      this._draw(); this._emit();
      return;
    }

    const nh = this._hitTest(x, y);
    if (nh !== this._hoverIdx) {
      this._hoverIdx = nh;
      // Primer y último punto bloqueados → cursor "no permitido"
      const isLockedHit = nh === 0 || nh === this.points.length - 1;
      const cursor = isLockedHit ? "not-allowed" : nh > 0 ? "grab" : "crosshair";
      this._setCursor(cursor);
      this._draw();
    }
  }

  _onMouseup()    { this._dragging = false; this._dragIdx = -1; this._setCursor(this._hoverIdx >= 0 ? "grab" : "crosshair"); }
  _onMouseleave() { this._dragging = false; this._dragIdx = -1; this._hoverIdx = -1; this._setCursor("crosshair"); this._draw(); }
  _setCursor(v)   { if (this._canvas) this._canvas.style.cursor = v; }

  // ── Punto de entrada pública ───────────────────────────────────────────────

  draw() { this._draw(); }

  // ── Renderizado ────────────────────────────────────────────────────────────

  _draw() {
    const ctx = this._ctx;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    this._updateInfo();
    this._drawBg(ctx);
    this._drawGrid(ctx);
    this._drawAxisLabels(ctx);

    this._drawCurveFill(ctx);
    this._drawCurve(ctx);

    // Decoraciones de modo (delante de la curva, detrás de los puntos)
    if (this.interpolation === "smooth") this._drawTangentHandles(ctx);

    this._drawPoints(ctx);
  }

  _updateInfo() {
    if (this._infoEl) {
      this._infoEl.textContent =
        `S: ${this._steps} | σmax: ${fmtSigma(this._maxSigma)}`;
    }
  }

  _drawBg(ctx) {
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = "rgba(255,255,255,0.012)";
    ctx.fillRect(PAD.left, PAD.top, IW, IH);
  }

  _drawGrid(ctx) {
    ctx.save();
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth   = 0.75;
    ctx.setLineDash([2.5, 5]);
    for (let i = 1; i < 4; i++) {
      const gx = PAD.left + (i / 4) * IW;
      const gy = PAD.top  + (i / 4) * IH;
      ctx.beginPath(); ctx.moveTo(gx, PAD.top);      ctx.lineTo(gx, PAD.top + IH);   ctx.stroke();
      ctx.beginPath(); ctx.moveTo(PAD.left, gy);     ctx.lineTo(PAD.left + IW, gy);  ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = COL.gridBorder;
    ctx.lineWidth   = 0.75;
    ctx.strokeRect(PAD.left + 0.5, PAD.top + 0.5, IW, IH);
    ctx.restore();
  }

  _drawAxisLabels(ctx) {
    const ms    = this._maxSigma;
    const steps = this._steps;

    ctx.save();
    ctx.font = "9px monospace";

    // Eje Y: valores reales de sigma
    ctx.textAlign    = "right";
    ctx.textBaseline = "middle";
    [0, 0.25, 0.5, 0.75, 1].forEach(v => {
      ctx.fillStyle = (v === 0 || v === 1) ? COL.axisLabel : COL.axisLabelDim;
      ctx.fillText((v * ms).toFixed(2), PAD.left - 4, toCanvasY(v));
    });

    // Eje X: número de pasos
    ctx.textAlign    = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle    = COL.axisLabel;
    ctx.fillText("0",            PAD.left,       PAD.top + IH + 4);
    ctx.fillText(String(steps),  PAD.left + IW,  PAD.top + IH + 4);
    ctx.fillStyle = COL.axisLabelDim;
    ctx.fillText(String(Math.round(steps / 2)), PAD.left + IW / 2, PAD.top + IH + 4);

    // Etiquetas de eje
    ctx.font      = "8px sans-serif";
    ctx.fillStyle = COL.axisLabelDim;
    ctx.textBaseline = "bottom";
    ctx.fillText("paso →", PAD.left + IW * 0.75, CANVAS_H - 1);
    ctx.save();
    ctx.translate(8, PAD.top + IH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("σ", 0, 0);
    ctx.restore();

    ctx.restore();
  }

  // ─── Decoración: handles tangenciales (Smooth) ────────────────────────────
  /**
   * Dibuja los vectores tangenciales en cada punto de control.
   *
   * Longitud del handle: HANDLE_DIST_FRAC × (distancia canvas-X al vecino más
   * cercano).  Esto hace que handles en segmentos cortos sean cortos y en
   * segmentos largos sean largos, independientemente de la pendiente.
   * La dirección sigue siendo la de la tangente real, y al aumentar la tensión
   * la tangente se acerca a 0, reduciendo visualmente el handle.
   */
  _drawTangentHandles(ctx) {
    const pts = this.points;
    const n   = pts.length;
    if (n < 2) return;

    const tangents = computeTangents(pts, extractWeights(pts));

    ctx.save();
    ctx.setLineDash([2, 3]);

    pts.forEach((pt, i) => {
      const m = tangents[i];
      if (Math.abs(m) < 1e-5) return; // tangente nula → sin handle

      const cx = toCanvasX(pt[0]);
      const cy = toCanvasY(pt[1]);

      // Distancia al vecino más cercano en píxeles canvas-X
      const dLeft  = i > 0     ? cx - toCanvasX(pts[i - 1][0]) : Infinity;
      const dRight = i < n - 1 ? toCanvasX(pts[i + 1][0]) - cx : Infinity;
      const dNear  = Math.min(dLeft, dRight);
      const dispLen = Math.max(4, Math.min(HANDLE_DIST_FRAC * dNear, HANDLE_MAX_LEN));

      // Vector unitario en espacio canvas (IW → +x, -IH*m → +y invertido)
      const vx   = IW, vy = -IH * m;
      const vlen = Math.sqrt(vx * vx + vy * vy);
      const ux   = (vx / vlen) * dispLen;
      const uy   = (vy / vlen) * dispLen;

      const isActive = i === this._dragIdx;
      const isHover  = i === this._hoverIdx && !this._dragging;
      const alpha = isActive ? 0.55 : isHover ? 0.45 : 0.25;

      // Línea del handle
      ctx.strokeStyle = `rgba(74,180,255,${alpha})`;
      ctx.lineWidth   = isActive ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(cx - ux, cy - uy);
      ctx.lineTo(cx + ux, cy + uy);
      ctx.stroke();

      // Puntos en los extremos del handle
      ctx.setLineDash([]);
      ctx.fillStyle = `rgba(74,180,255,${alpha + 0.2})`;
      [-1, 1].forEach(sign => {
        ctx.beginPath();
        ctx.arc(cx + sign * ux, cy + sign * uy, 2.5, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.setLineDash([2, 3]);
    });

    ctx.restore();
  }

  // ─── Curva ─────────────────────────────────────────────────────────────────

  _buildPath(ctx) {
    ctx.beginPath();
    const S = 150;
    for (let i = 0; i <= S; i++) {
      const t  = i / S;
      const y  = sampleCurve(this.points, t, this.interpolation);
      const cx = toCanvasX(t);
      const cy = toCanvasY(y);
      i === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy);
    }
  }

  _drawCurveFill(ctx) {
    ctx.save();
    this._buildPath(ctx);
    ctx.lineTo(toCanvasX(1), PAD.top + IH);
    ctx.lineTo(toCanvasX(0), PAD.top + IH);
    ctx.closePath();
    ctx.fillStyle = COL.curveFade;
    ctx.fill();
    ctx.restore();
  }

  _drawCurve(ctx) {
    ctx.save();
    this._buildPath(ctx);
    ctx.strokeStyle = COL.curve;
    ctx.lineWidth   = 2;
    ctx.lineJoin    = "round";
    ctx.lineCap     = "round";
    ctx.stroke();
    ctx.restore();
  }

  // ─── Puntos de control ────────────────────────────────────────────────────
  _drawPoints(ctx) {
    const n = this.points.length;

    this.points.forEach((pt, i) => {
      const isLocked = i === 0 || i === n - 1;
      const isActive = !isLocked && i === this._dragIdx;
      const isHover  = !isLocked && i === this._hoverIdx && !this._dragging;

      const r      = isActive ? PT_R.active : isHover ? PT_R.hover : PT_R.idle;
      const fill   = isActive ? COL.pointActive : isHover ? COL.pointHover : COL.point;
      const stroke = COL.pointStroke;

      const cx = toCanvasX(pt[0]);
      const cy = toCanvasY(pt[1]);

      ctx.save();
      ctx.shadowColor   = "rgba(0,0,0,0.55)";
      ctx.shadowBlur    = 5;
      ctx.shadowOffsetY = 1;

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle   = fill;
      ctx.fill();
      ctx.shadowBlur  = 0;
      ctx.strokeStyle = stroke;
      ctx.lineWidth   = 1.5;
      ctx.stroke();

      // Anillo de bloqueo para primer y último punto
      if (isLocked) {
        ctx.strokeStyle = "rgba(255,255,255,0.18)";
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, r + 3.5, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();
    });
  }

  // ─── Serialización ────────────────────────────────────────────────────────

  _emit() {
    if (this.onChange) this.onChange(this.serialise());
  }

  serialise() {
    return JSON.stringify({
      points:        this.points,
      interpolation: this.interpolation,
      tension:       this.tension,
    });
  }

  deserialise(json) {
    if (!json) return;
    try {
      const d = JSON.parse(json);

      if (Array.isArray(d.points) && d.points.length >= 2) {
        this.points = d.points.map(p => {
          const x = Math.max(0, Math.min(1, parseFloat(p[0])));
          const y = Math.max(0, Math.min(1, parseFloat(p[1])));
          const w = (p[2] !== undefined && p[2] !== null)
                    ? Math.max(0, Math.min(1, parseFloat(p[2])))
                    : 0.0;
          return [x, y, w];
        });
        this.points.sort((a, b) => a[0] - b[0]);
        // El primer punto siempre está bloqueado en (0, 1); el último en (1, 0)
        this.points[0][0] = 0; this.points[0][1] = 1;
        const last = this.points.length - 1;
        this.points[last][0] = 1; this.points[last][1] = 0;
      }

      // Aceptar "smooth"/"linear"; remap "bspline" → "smooth"
      if (d.interpolation === "bspline" || d.interpolation === "smooth") {
        this.interpolation = "smooth";
        if (this._interpSelect) this._interpSelect.value = "smooth";
        this._updateModeUI();
      } else if (d.interpolation === "linear") {
        this.interpolation = "linear";
        if (this._interpSelect) this._interpSelect.value = "linear";
        this._updateModeUI();
      }

      if (typeof d.tension === "number") {
        this.tension = Math.max(0, Math.min(1, d.tension));
        if (this._tensionSlider) this._tensionSlider.value      = this.tension;
        if (this._tensionValEl)  this._tensionValEl.textContent = this.tension.toFixed(2);
      }

      this._draw();
    } catch (_) { /* mantener estado actual */ }
  }

  _resetCurve() {
    this.points        = [[0.0, 1.0, 0.0], [1.0, 0.0, 0.0]];
    this.interpolation = "smooth";
    this.tension       = 0.0;
    if (this._interpSelect)  this._interpSelect.value      = "smooth";
    if (this._tensionSlider) this._tensionSlider.value     = 0;
    if (this._tensionValEl)  this._tensionValEl.textContent = "0.00";
    this._updateModeUI();
    this._draw();
    this._emit();
  }
}

// ─── Registro de la extensión ─────────────────────────────────────────────────

app.registerExtension({
  name: EXT_NAME,

  async beforeRegisterNodeDef(nodeType, nodeData, _app) {
    if (nodeData.name !== NODE_NAME) return;

    const origCreated = nodeType.prototype.onNodeCreated;

    nodeType.prototype.onNodeCreated = function () {
      const result = origCreated?.apply(this, arguments);

      // Ocultar el widget de texto curve_data
      const curveDataWidget = this.widgets?.find(w => w.name === "curve_data");
      if (curveDataWidget) {
        curveDataWidget.type           = "hidden";
        curveDataWidget.computedHeight = 0;
        curveDataWidget.computeSize    = () => [0, -4];
      }

      // Referencias a widgets externos para etiquetas de ejes en tiempo real
      const stepsWidget    = this.widgets?.find(w => w.name === "steps");
      const maxSigmaWidget = this.widgets?.find(w => w.name === "max_sigma");

      const container = document.createElement("div");
      container.style.cssText =
        "width:100%;box-sizing:border-box;overflow:hidden;" +
        "border-top:1px solid rgba(255,255,255,0.05);";

      let editor = null;

      const onCurveChange = json => {
        if (curveDataWidget) curveDataWidget.value = json;
        this.setDirtyCanvas(true);
      };

      const initEditor = () => {
        if (editor) return;
        editor = new SigmaCurveEditor(container, onCurveChange, {
          stepsWidget, maxSigmaWidget,
        });
        const saved = curveDataWidget?.value;
        if (saved) editor.deserialise(saved);
      };

      // Redibuja cuando el usuario cambia steps o max_sigma
      [stepsWidget, maxSigmaWidget].forEach(w => {
        if (!w) return;
        const orig = w.callback;
        w.callback = function (val) {
          orig?.call(this, val);
          editor?.draw();
        };
      });

      const domWidget = this.addDOMWidget(
        "sigma_curve_editor",
        "CURVE_EDITOR",
        container,
        {
          getValue:  ()    => { initEditor(); return editor?.serialise() ?? "{}"; },
          setValue:  val   => {
            initEditor();
            editor?.deserialise(val);
            if (curveDataWidget) curveDataWidget.value = val;
          },
          serialize: false,
        }
      );

      // canvas (200) + barra controles (≈60) = 260 px
      if (domWidget) domWidget.computeSize = () => [CANVAS_W, CANVAS_H + 60];

      setTimeout(initEditor, 0);
      return result;
    };
  },
});

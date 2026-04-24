<template>
  <div class="nkd-root">

    <!-- ── Controls bar – row 1 ──────────────────────────────────────────── -->
    <div class="nkd-bar">
      <div class="nkd-row nkd-row--controls">

        <!-- Interpolation mode -->
        <span class="nkd-label">Mode</span>
        <select v-model="interpolation" class="nkd-select" @change="onInterpChange">
          <option value="smooth">Smooth</option>
          <option value="linear">Linear</option>
        </select>

        <div class="nkd-divider" />

        <!-- Weight slider (smooth only) -->
        <div v-show="interpolation === 'smooth'" class="nkd-group">
          <span class="nkd-label">Weight</span>
          <input
            v-model.number="tension"
            type="range" min="1" max="10" step="0.1"
            class="nkd-slider"
            @input="onTensionInput"
          />
          <span class="nkd-mono">{{ tension.toFixed(1) }}</span>
        </div>

        <div class="nkd-spacer" />

        <!-- Endpoint lock/unlock toggle -->
        <button
          class="nkd-btn"
          :class="{ 'nkd-btn--active': !endpointsLocked }"
          :title="endpointsLocked ? 'Unlock endpoints' : 'Lock endpoints'"
          @click="toggleEndpointsLock"
        >{{ endpointsLocked ? '⊠' : '⊡' }}</button>

        <!-- Snap to steps toggle (only available when steps <= 15) -->
        <button
          class="nkd-btn"
          :class="{ 'nkd-btn--active': snapEnabled, 'nkd-btn--disabled': extSteps > 15 }"
          :disabled="extSteps > 15"
          :title="extSteps > 15 ? 'Snap available up to 15 steps' : snapEnabled ? 'Disable snap to steps' : 'Enable snap to steps'"
          @click="toggleSnap"
        >⊞</button>

        <!-- Reset button -->
        <button class="nkd-btn" title="Reset curve" @click="resetCurve">↺</button>

      </div>

      <!-- Row 2: reference controls (only when a reference input is connected) -->
      <div v-if="referenceConnected" class="nkd-row nkd-row--ref">
        <span class="nkd-label">Ref</span>
        <button
          class="nkd-btn nkd-btn--ref"
          :class="{ 'nkd-btn--active nkd-btn--ref-active': showReference, 'nkd-btn--disabled': !referenceSigmas }"
          :disabled="!referenceSigmas"
          :title="!referenceSigmas ? 'Run the node to load reference' : showReference ? 'Hide reference overlay' : 'Show reference overlay'"
          @click="toggleReference"
        >{{ showReference ? 'Hide' : 'Show' }}</button>
        <button
          class="nkd-btn nkd-btn--ref"
          :class="{ 'nkd-btn--disabled': !referenceSigmas }"
          :disabled="!referenceSigmas"
          :title="!referenceSigmas ? 'Run the node to load reference' : 'Match curve to reference shape'"
          @click="initFromReference"
        >Match</button>
      </div>

      <!-- Row 3: hint + live info -->
      <div class="nkd-row nkd-row--hint">
        <span class="nkd-info">S: {{ extSteps }} | σmax: {{ fmtSigma(extMaxSigma) }}</span>
        <div class="nkd-spacer" />
        <span class="nkd-hint">
          Click=add · Drag=move · Shift+click=delete<span v-if="!endpointsLocked"> · Endpoints unlocked</span>
        </span>
      </div>
    </div>

    <!-- ── Canvas ─────────────────────────────────────────────────────────── -->
    <canvas
      ref="canvasRef"
      class="nkd-canvas"
      @mousedown.stop.prevent="onDown"
      @mousemove.stop="onMove"
      @mouseup.stop="onUp"
      @mouseleave.stop="onLeave"
      @contextmenu.prevent
    />

  </div>
</template>

<script setup lang="ts">
/**
 * SigmaCurveWidget.vue
 *
 * Interactive Cardinal / Hermite spline editor rendered on a HiDPI <canvas>.
 *
 * Props:
 *   onChange      – called with JSON whenever the curve changes.
 *   stepsWidget   – reference to the ComfyUI "steps" widget object.
 *   maxSigmaWidget – reference to the ComfyUI "max_sigma" widget object.
 *
 * Exposed:
 *   serialise()   – returns current JSON string.
 *   deserialise() – loads state from JSON string.
 */

import { ref, computed, onMounted, watch } from "vue";
import { api } from "../../scripts/api.js";

// ── Layout constants ──────────────────────────────────────────────────────────

const CW = 400;
const CH = 200;

// Minimum internal render scale relative to logical dimensions.
// The canvas buffer is always at least CW×MIN_SCALE × CH×MIN_SCALE physical
// pixels so CSS must down-scale (sharp) rather than up-scale (blurry).
const MIN_RENDER_SCALE = 2;
const PAD = { top: 16, right: 14, bottom: 22, left: 42 } as const;
const IW  = CW - PAD.left - PAD.right;
const IH  = CH - PAD.top  - PAD.bottom;

const HIT_R = 10;
const PT_R  = { idle: 4.5, hover: 6, active: 7 } as const;

const C = {
  bg:           "#111318",
  grid:         "rgba(255,255,255,0.06)",
  gridBorder:   "rgba(255,255,255,0.16)",
  curve:        "#4ab4ff",
  curveFade:    "rgba(74,180,255,0.15)",
  pt:           "#4ab4ff",
  ptHover:      "#ffd166",
  ptActive:     "#ff6b6b",
  ptStroke:     "rgba(0,0,0,0.65)",
  axisLabel:    "rgba(255,255,255,0.40)",
  axisLabelDim: "rgba(255,255,255,0.20)",
  handle:       "rgba(74,180,255,0.50)",
  handleDot:    "rgba(74,180,255,0.75)",
} as const;

// ── Types ─────────────────────────────────────────────────────────────────────

type Point = [number, number, number];  // [x, y, w]

// ── Props ─────────────────────────────────────────────────────────────────────

const props = defineProps<{
  onChange?:          (json: string) => void;
  stepsWidget?:       { value: number } | null;
  maxSigmaWidget?:    { value: number } | null;
  refSigmasWidget?:   { value: number[] | null } | null;
  onFetchReference?:  () => void;
}>();

// ── State ─────────────────────────────────────────────────────────────────────

const canvasRef = ref<HTMLCanvasElement | null>(null);
let   ctx:            CanvasRenderingContext2D | null = null;
let   dpr             = 1;
let   resizeObserver: ResizeObserver | null = null;

const points        = ref<Point[]>([[0, 1, 1], [1, 0, 1]]);
const interpolation = ref<"smooth" | "linear">("smooth");
const tension       = ref(1.0);

const dragIdx         = ref(-1);
const hoverIdx        = ref(-1);
const dragging        = ref(false);
const progressT       = ref<number | null>(null);   // null = no active execution
const endpointsLocked = ref(true);                  // first/last points locked by default
const snapToSteps     = ref(false);                 // snap X to step positions

// Reference sigmas overlay
const referenceConnected = ref(false);           // true as soon as a link is wired
const referenceSigmas    = ref<number[] | null>(null);
const showReference      = ref(false);

// External widget values (live-read each draw)
const extSteps    = computed(() => +(props.stepsWidget?.value    ?? 20));
const extMaxSigma = computed(() => +(props.maxSigmaWidget?.value ?? 1.0));

// Snap is only active when explicitly enabled AND steps <= 15
const snapEnabled = computed(() => snapToSteps.value && extSteps.value <= 15);

// ── Label formatter ───────────────────────────────────────────────────────────

function fmtSigma(v: number): string {
  const a = Math.abs(v);
  if (a === 0)   return "0";
  if (a < 0.01)  return v.toExponential(1);
  if (a < 10)    return v.toFixed(3);
  if (a < 100)   return v.toFixed(2);
  if (a < 1000)  return v.toFixed(1);
  return v.toFixed(0);
}

// ── Coordinate helpers ────────────────────────────────────────────────────────

const toCanvasX  = (nx: number) => PAD.left + nx * IW;
const toCanvasY  = (ny: number) => PAD.top  + (1 - ny) * IH;
const fromCX     = (cx: number) => Math.max(0, Math.min(1, (cx - PAD.left) / IW));
const fromCY     = (cy: number) => Math.max(0, Math.min(1, 1 - (cy - PAD.top) / IH));
// Unclamped versions — needed to compute drag offsets correctly at canvas edges
const rawNX      = (cx: number) => (cx - PAD.left) / IW;
const rawNY      = (cy: number) => 1 - (cy - PAD.top) / IH;

function eventToLogical(e: MouseEvent): { x: number; y: number } {
  const rect = canvasRef.value!.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (CW / rect.width),
    y: (e.clientY - rect.top)  * (CH / rect.height),
  };
}

/** Snap a normalised X value to the nearest step boundary when snap is active. */
function snapX(x: number): number {
  const steps = extSteps.value;
  if (!snapEnabled.value || steps <= 0) return x;
  return Math.round(x * steps) / steps;
}

function hitTest(lx: number, ly: number): number {
  let nearest = -1, minD = HIT_R;
  points.value.forEach((p, i) => {
    const d = Math.hypot(lx - toCanvasX(p[0]), ly - toCanvasY(p[1]));
    if (d < minD) { minD = d; nearest = i; }
  });
  return nearest;
}

// ── NURBS cubic spline ────────────────────────────────────────────────────────

const NURBS_DEGREE = 3;
const NURBS_TABLE_SIZE = 500;

function nurbsKnotVector(nPts: number, degree: number): number[] {
  const order = degree + 1;
  const nKnots = nPts + order;
  if (nPts <= degree) return new Array(nKnots).fill(0);

  const knots: number[] = [];
  for (let i = 0; i < order; i++) knots.push(0);
  const nInterior = nPts - degree;
  for (let i = 1; i < nInterior; i++) knots.push(i / nInterior);
  for (let i = 0; i < order; i++) knots.push(1);
  return knots;
}

function nurbsBasis(knots: number[], nPts: number, degree: number, u: number): number[] {
  u = Math.max(knots[degree], Math.min(knots[nPts], u));
  if (u >= knots[nPts]) u = knots[nPts] - 1e-10;

  const len = knots.length - 1;
  let N = new Array(len).fill(0);
  for (let i = 0; i < len; i++) {
    if (knots[i] <= u && u < knots[i + 1]) N[i] = 1;
  }

  for (let p = 1; p <= degree; p++) {
    const Nnew = new Array(len).fill(0);
    for (let i = 0; i < len - p; i++) {
      const d1 = knots[i + p] - knots[i];
      const d2 = knots[i + p + 1] - knots[i + 1];
      const c1 = d1 > 0 ? (u - knots[i]) / d1 * N[i] : 0;
      const c2 = d2 > 0 ? (knots[i + p + 1] - u) / d2 * N[i + 1] : 0;
      Nnew[i] = c1 + c2;
    }
    N = Nnew;
  }
  return N.slice(0, nPts);
}

function nurbsEvaluate(
  pts: Point[], weights: number[], knots: number[], degree: number, u: number
): [number, number] {
  const nPts = pts.length;
  const N = nurbsBasis(knots, nPts, degree, u);
  let wx = 0, wy = 0, wSum = 0;
  for (let i = 0; i < nPts; i++) {
    const nw = N[i] * weights[i];
    wx += nw * pts[i][0];
    wy += nw * pts[i][1];
    wSum += nw;
  }
  if (wSum === 0) return [0, 0];
  return [wx / wSum, wy / wSum];
}

/** Pre-sample NURBS curve into a lookup table. */
let cachedTable: { xs: number[]; ys: number[] } | null = null;

function buildNurbsTableWithDegree(pts: Point[], weights: number[], degree: number): { xs: number[]; ys: number[] } {
  const knots = nurbsKnotVector(pts.length, degree);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i <= NURBS_TABLE_SIZE; i++) {
    const u = i / NURBS_TABLE_SIZE;
    const [x, y] = nurbsEvaluate(pts, weights, knots, degree, u);
    xs.push(x);
    ys.push(y);
  }
  return { xs, ys };
}

function buildNurbsTable(pts: Point[], weights: number[]): { xs: number[]; ys: number[] } {
  return buildNurbsTableWithDegree(pts, weights, NURBS_DEGREE);
}

function tableLookupY(xs: number[], ys: number[], targetX: number): number {
  const n = xs.length;
  if (n === 0) return 0;
  if (targetX <= xs[0]) return ys[0];
  if (targetX >= xs[n - 1]) return ys[n - 1];

  let lo = 0, hi = n - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= targetX) lo = mid; else hi = mid;
  }
  const dx = xs[hi] - xs[lo];
  if (dx === 0) return ys[lo];
  const t = (targetX - xs[lo]) / dx;
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

// ── Universal sampler ─────────────────────────────────────────────────────────

function sampleCurve(t: number): number {
  const pts = [...points.value].sort((a, b) => a[0] - b[0]);
  const n   = pts.length;
  if (n === 0) return 0;
  if (n === 1) return pts[0][1];

  t = Math.max(0, Math.min(1, t));
  if (t <= pts[0][0])     return pts[0][1];
  if (t >= pts[n - 1][0]) return pts[n - 1][1];

  // Linear mode
  if (interpolation.value === "linear") {
    let seg = 0;
    for (let i = 0; i < n - 1; i++) {
      if (pts[i][0] <= t && t <= pts[i + 1][0]) { seg = i; break; }
    }
    const [x0, y0] = pts[seg];
    const [x1, y1] = pts[seg + 1];
    if (x1 === x0) return y0;
    const lt = (t - x0) / (x1 - x0);
    return y0 + lt * (y1 - y0);
  }

  // NURBS smooth — use degree = min(3, n-1) so 3 points get quadratic, 4+ get cubic
  // Endpoints always w=1 so interior weights create a differential
  const degree = Math.min(NURBS_DEGREE, n - 1);
  const last = pts.length - 1;
  const weights = pts.map((p, i) => (i === 0 || i === last) ? 1 : Math.max(1, p[2] ?? 1));
  if (!cachedTable) cachedTable = buildNurbsTableWithDegree(pts, weights, degree);
  const result = tableLookupY(cachedTable.xs, cachedTable.ys, t);
  return Math.max(0, Math.min(1, result));
}

// ── Mouse handlers ────────────────────────────────────────────────────────────

// Offset (in normalised coords) between the grabbed point and the cursor at
// the moment of mousedown.  Applied in onMove so the point never jumps.
let dragOffsetX = 0;
let dragOffsetY = 0;

function invalidateCache(): void { cachedTable = null; }

function onDown(e: MouseEvent): void {
  const { x, y } = eventToLogical(e);
  const idx = hitTest(x, y);
  const isEndpoint = idx === 0 || idx === points.value.length - 1;

  // Endpoints can never be deleted (shift+click)
  if (isEndpoint && e.shiftKey) return;

  // When locked, endpoints are also not draggable
  if (endpointsLocked.value && isEndpoint) return;

  if (e.shiftKey) {
    if (idx >= 0 && points.value.length > 2) {
      points.value.splice(idx, 1);
      hoverIdx.value = -1;
      invalidateCache(); redraw(); emit();
    }
    return;
  }

  if (idx >= 0) {
    dragIdx.value  = idx;
    dragging.value = true;
    // Record the offset so the point moves relative to its original position
    const pt = points.value[idx];
    dragOffsetX = pt[0] - rawNX(x);
    dragOffsetY = pt[1] - rawNY(y);
    setCursor("grabbing");
  } else {
    dragOffsetX = 0;
    dragOffsetY = 0;
    const newPt: Point = [snapX(fromCX(x)), fromCY(y), tension.value];
    const at = points.value.findIndex(p => p[0] > newPt[0]);
    if (at === -1) { points.value.push(newPt); dragIdx.value = points.value.length - 1; }
    else           { points.value.splice(at, 0, newPt); dragIdx.value = at; }
    dragging.value = true;
    setCursor("grabbing");
    invalidateCache(); redraw(); emit();
  }
}

function onMove(e: MouseEvent): void {
  const { x, y } = eventToLogical(e);

  if (dragging.value && dragIdx.value >= 0) {
    const isFirst = dragIdx.value === 0;
    const isLast  = dragIdx.value === points.value.length - 1;
    const pt = points.value[dragIdx.value];
    pt[0] = isFirst ? 0 : isLast ? 1 : snapX(Math.max(0, Math.min(1, rawNX(x) + dragOffsetX)));
    pt[1] = Math.max(0, Math.min(1, rawNY(y) + dragOffsetY));
    points.value.sort((a, b) => a[0] - b[0]);
    dragIdx.value = points.value.indexOf(pt);
    invalidateCache(); redraw(); emit();
    return;
  }

  const nh = hitTest(x, y);
  if (nh !== hoverIdx.value) {
    hoverIdx.value = nh;
    const n = points.value.length;
    const cursor = (endpointsLocked.value && (nh === 0 || nh === n - 1))
      ? "not-allowed"
      : nh > 0 ? "grab" : "crosshair";
    setCursor(cursor);
    redraw();
  }
}

function onUp(_e: MouseEvent): void {
  dragging.value = false; dragIdx.value = -1;
  setCursor(hoverIdx.value >= 0 ? "grab" : "crosshair");
}

function onLeave(_e: MouseEvent): void {
  dragging.value = false; dragIdx.value = -1; hoverIdx.value = -1;
  setCursor("crosshair"); redraw();
}

function setCursor(val: string): void {
  if (canvasRef.value) canvasRef.value.style.cursor = val;
}

// ── Widget change handlers ────────────────────────────────────────────────────

function onInterpChange(): void { invalidateCache(); redraw(); emit(); }

function onTensionInput(): void {
  // Apply global weight to all points
  points.value.forEach(p => { p[2] = tension.value; });
  invalidateCache(); redraw(); emit();
}

// ── Canvas rendering ──────────────────────────────────────────────────────────

function drawProgressDot(): void {
  const t = progressT.value;
  if (t === null) return;

  const y  = sampleCurve(t);
  const cx = toCanvasX(t);
  const cy = toCanvasY(y);

  ctx!.save();
  // Outer halo
  ctx!.beginPath();
  ctx!.arc(cx, cy, 8, 0, Math.PI * 2);
  ctx!.fillStyle = "rgba(255,210,0,0.18)";
  ctx!.fill();
  // Core dot
  ctx!.beginPath();
  ctx!.arc(cx, cy, 4.5, 0, Math.PI * 2);
  ctx!.fillStyle = "#ffd166";
  ctx!.shadowColor = "rgba(255,200,0,0.7)";
  ctx!.shadowBlur  = 8;
  ctx!.fill();
  ctx!.restore();
}

function drawReferenceCurve(): void {
  const refs = referenceSigmas.value;
  if (!refs || refs.length < 2) return;

  // Normalise to [0, 1] relative to the reference's own max
  const refMax = Math.max(...refs);
  if (refMax === 0) return;

  ctx!.save();
  ctx!.strokeStyle = "rgba(255,180,60,0.55)";
  ctx!.lineWidth   = 1.5;
  ctx!.setLineDash([5, 4]);
  ctx!.lineJoin    = "round";
  ctx!.lineCap     = "round";
  ctx!.beginPath();
  const n = refs.length;
  for (let i = 0; i < n; i++) {
    const t  = i / (n - 1);
    const ny = Math.max(0, Math.min(1, refs[i] / refMax));
    const cx = toCanvasX(t);
    const cy = toCanvasY(ny);
    i === 0 ? ctx!.moveTo(cx, cy) : ctx!.lineTo(cx, cy);
  }
  ctx!.stroke();
  ctx!.restore();
}

function drawPointTooltip(): void {
  const idx = dragging.value ? dragIdx.value : hoverIdx.value;
  if (idx < 0 || idx >= points.value.length) return;

  const pt  = points.value[idx];
  const cx  = toCanvasX(pt[0]);
  const cy  = toCanvasY(pt[1]);
  const ms  = extMaxSigma.value;
  const steps = extSteps.value;

  const stepVal  = Math.round(pt[0] * steps);
  const sigmaVal = (pt[1] * ms).toFixed(3);
  const label    = `step ${stepVal}  σ ${sigmaVal}`;

  const PAD_X = 6, PAD_Y = 4;
  const FONT  = "10px monospace";
  ctx!.save();
  ctx!.font = FONT;
  const tw = ctx!.measureText(label).width;
  const bw = tw + PAD_X * 2;
  const bh = 14 + PAD_Y * 2;  // line-height + vertical padding

  // Position: above the point, flip to below near top edge
  let bx = cx - bw / 2;
  let by = cy - bh - 10;
  if (by < PAD.top) by = cy + 12;
  // Clamp horizontally
  bx = Math.max(PAD.left, Math.min(bx, PAD.left + IW - bw));

  // Background pill
  ctx!.fillStyle   = "rgba(15,18,26,0.88)";
  ctx!.strokeStyle = dragging.value ? "rgba(255,107,107,0.6)" : "rgba(74,180,255,0.5)";
  ctx!.lineWidth   = 1;
  ctx!.beginPath();
  ctx!.roundRect(bx, by, bw, bh, 4);
  ctx!.fill();
  ctx!.stroke();

  // Text
  ctx!.fillStyle   = "#e8eef8";
  ctx!.textAlign   = "left";
  ctx!.textBaseline = "middle";
  ctx!.fillText(label, bx + PAD_X, by + bh / 2);
  ctx!.restore();
}

function redraw(): void {
  if (!ctx) return;
  ctx.clearRect(0, 0, CW, CH);
  drawBg();
  drawGrid();
  drawSnapGrid();
  drawAxisLabels();
  if (showReference.value) drawReferenceCurve();
  drawFill();
  drawCurve();
  if (interpolation.value === "smooth") drawControlPolygon();
  drawPoints();
  drawProgressDot();
  drawPointTooltip();
}

function drawBg(): void {
  ctx!.fillStyle = C.bg;
  ctx!.fillRect(0, 0, CW, CH);
  ctx!.fillStyle = "rgba(255,255,255,0.012)";
  ctx!.fillRect(PAD.left, PAD.top, IW, IH);
}

// Smooth: draw control polygon (dashed lines between control points)
function drawControlPolygon(): void {
  const pts = [...points.value].sort((a, b) => a[0] - b[0]);
  const n   = pts.length;
  if (n < 2) return;

  ctx!.save();
  ctx!.setLineDash([3, 4]);
  ctx!.strokeStyle = "rgba(255,255,255,0.12)";
  ctx!.lineWidth   = 1;
  ctx!.beginPath();
  ctx!.moveTo(toCanvasX(pts[0][0]), toCanvasY(pts[0][1]));
  for (let i = 1; i < n; i++) {
    ctx!.lineTo(toCanvasX(pts[i][0]), toCanvasY(pts[i][1]));
  }
  ctx!.stroke();
  ctx!.restore();
}

function drawGrid(): void {
  ctx!.save();
  ctx!.strokeStyle = C.grid;
  ctx!.lineWidth   = 0.75;
  ctx!.setLineDash([2.5, 5]);
  for (let i = 1; i < 4; i++) {
    ctx!.beginPath(); ctx!.moveTo(PAD.left + (i/4)*IW, PAD.top); ctx!.lineTo(PAD.left + (i/4)*IW, PAD.top+IH); ctx!.stroke();
    ctx!.beginPath(); ctx!.moveTo(PAD.left, PAD.top + (i/4)*IH); ctx!.lineTo(PAD.left+IW, PAD.top + (i/4)*IH); ctx!.stroke();
  }
  ctx!.setLineDash([]);
  ctx!.strokeStyle = C.gridBorder;
  ctx!.lineWidth   = 0.75;
  ctx!.strokeRect(PAD.left + 0.5, PAD.top + 0.5, IW, IH);
  ctx!.restore();
}

/** Draw vertical snap lines at each step position (only when snap is active). */
function drawSnapGrid(): void {
  const steps = extSteps.value;
  if (!snapEnabled.value || steps <= 0) return;
  ctx!.save();
  ctx!.strokeStyle = "rgba(74,180,255,0.18)";
  ctx!.lineWidth   = 0.75;
  ctx!.setLineDash([2, 3]);
  for (let i = 0; i <= steps; i++) {
    const cx = toCanvasX(i / steps);
    ctx!.beginPath();
    ctx!.moveTo(cx, PAD.top);
    ctx!.lineTo(cx, PAD.top + IH);
    ctx!.stroke();
  }
  ctx!.restore();
}

function drawAxisLabels(): void {
  const ms    = extMaxSigma.value;
  const steps = extSteps.value;

  ctx!.save();
  ctx!.font = "9px monospace";

  // Y-axis (actual sigma values) — always 2 decimal places
  ctx!.textAlign    = "right";
  ctx!.textBaseline = "middle";
  [0, 0.25, 0.5, 0.75, 1].forEach(v => {
    ctx!.fillStyle = (v === 0 || v === 1) ? C.axisLabel : C.axisLabelDim;
    ctx!.fillText((v * ms).toFixed(3), PAD.left - 4, toCanvasY(v));
  });

  // X-axis (step numbers)
  ctx!.textAlign    = "center";
  ctx!.textBaseline = "top";
  ctx!.fillStyle    = C.axisLabel;
  ctx!.fillText("0",           PAD.left,        PAD.top + IH + 4);
  ctx!.fillText(String(steps), PAD.left + IW,   PAD.top + IH + 4);
  ctx!.fillStyle = C.axisLabelDim;
  ctx!.fillText(String(Math.round(steps / 2)), PAD.left + IW / 2, PAD.top + IH + 4);

  // Axis name labels
  ctx!.font      = "8px sans-serif";
  ctx!.fillStyle = C.axisLabelDim;
  ctx!.textBaseline = "bottom";
  ctx!.fillText("steps →", PAD.left + IW * 0.75, CH - 1);
  ctx!.save();
  ctx!.translate(8, PAD.top + IH / 2);
  ctx!.rotate(-Math.PI / 2);
  ctx!.textAlign = "center"; ctx!.textBaseline = "middle";
  ctx!.fillText("σ", 0, 0);
  ctx!.restore();

  ctx!.restore();
}

function buildPath(): void {
  ctx!.beginPath();
  const S = 300;
  for (let i = 0; i <= S; i++) {
    const t = i / S;
    const y = sampleCurve(t);
    i === 0 ? ctx!.moveTo(toCanvasX(t), toCanvasY(y))
            : ctx!.lineTo(toCanvasX(t), toCanvasY(y));
  }
}

function drawFill(): void {
  ctx!.save();
  buildPath();
  ctx!.lineTo(toCanvasX(1), PAD.top + IH);
  ctx!.lineTo(toCanvasX(0), PAD.top + IH);
  ctx!.closePath();
  ctx!.fillStyle = C.curveFade;
  ctx!.fill();
  ctx!.restore();
}

function drawCurve(): void {
  ctx!.save();
  buildPath();
  ctx!.strokeStyle = C.curve;
  ctx!.lineWidth   = 2;
  ctx!.lineJoin    = "round";
  ctx!.lineCap     = "round";
  ctx!.stroke();
  ctx!.restore();
}

function drawPoints(): void {
  const sorted  = [...points.value].sort((a, b) => a[0] - b[0]);
  const lastIdx = sorted.length - 1;

  sorted.forEach((pt, sortedI) => {
    const origI    = points.value.indexOf(pt);
    const isLocked = endpointsLocked.value && (sortedI === 0 || sortedI === lastIdx);
    const isActive = origI === dragIdx.value;
    const isHover  = origI === hoverIdx.value && !dragging.value;

    const cx    = toCanvasX(pt[0]);
    const cy    = toCanvasY(pt[1]);
    const r     = isActive ? PT_R.active : isHover ? PT_R.hover : PT_R.idle;
    const color = isActive ? C.ptActive  : isHover ? C.ptHover  : C.pt;

    ctx!.save();
    ctx!.shadowColor = "rgba(0,0,0,0.55)"; ctx!.shadowBlur = 5; ctx!.shadowOffsetY = 1;
    ctx!.beginPath();
    ctx!.arc(cx, cy, r, 0, Math.PI * 2);
    ctx!.fillStyle = color; ctx!.fill();
    ctx!.shadowBlur = 0;
    ctx!.strokeStyle = C.ptStroke; ctx!.lineWidth = 1.5; ctx!.stroke();

    // Lock ring for first and last points
    if (isLocked) {
      ctx!.strokeStyle = "rgba(255,255,255,0.18)";
      ctx!.lineWidth   = 1;
      ctx!.beginPath();
      ctx!.arc(cx, cy, r + 3.5, 0, Math.PI * 2);
      ctx!.stroke();
    }

    ctx!.restore();
  });
}

// ── Serialisation ─────────────────────────────────────────────────────────────

function serialise(): string {
  return JSON.stringify({
    points:          points.value,
    interpolation:   interpolation.value,
    tension:         tension.value,
    endpointsLocked: endpointsLocked.value,
    snapToSteps:     snapToSteps.value,
  });
}

function deserialise(json: string): void {
  if (!json) return;
  try {
    const d = JSON.parse(json);
    // Restore lock state first so endpoint clamping below is correct.
    if (typeof d.endpointsLocked === "boolean") {
      endpointsLocked.value = d.endpointsLocked;
    }
    if (typeof d.snapToSteps === "boolean") {
      snapToSteps.value = d.snapToSteps;
    }

    if (Array.isArray(d.points) && d.points.length >= 2) {
      points.value = d.points.map((p: unknown[]) => {
        const x = Math.max(0, Math.min(1, parseFloat(p[0] as string)));
        const y = Math.max(0, Math.min(1, parseFloat(p[1] as string)));
        let   w = (p[2] !== undefined && p[2] !== null)
                  ? parseFloat(p[2] as string)
                  : 1.0;
        // Legacy weights were in [0,1]; new weights are in [1,10]
        if (w < 1.0) w = 1.0;
        w = Math.min(10.0, w);
        return [x, y, w] as Point;
      });
      points.value.sort((a, b) => a[0] - b[0]);
      // X is always pinned. Y is only forced to default (1 / 0) when locked.
      points.value[0][0] = 0;
      const last = points.value.length - 1;
      points.value[last][0] = 1;
      if (endpointsLocked.value) {
        points.value[0][1]    = 1;
        points.value[last][1] = 0;
      }
    }
    // Remap legacy bspline → smooth
    if (d.interpolation === "bspline" || d.interpolation === "smooth") {
      interpolation.value = "smooth";
    } else if (d.interpolation === "linear") {
      interpolation.value = "linear";
    }
    if (typeof d.tension === "number") {
      // Legacy tension was [0,1]; new weight is [1,10]
      let t = d.tension;
      if (t < 1.0) t = 1.0;
      tension.value = Math.min(10.0, t);
    }
    invalidateCache(); redraw();
  } catch { /* keep current state */ }
}

function resetCurve(): void {
  points.value          = [[0, 1, 1], [1, 0, 1]];
  interpolation.value   = "smooth";
  tension.value         = 1.0;
  endpointsLocked.value = true;
  snapToSteps.value     = false;
  invalidateCache(); redraw(); emit();
}

function toggleEndpointsLock(): void {
  endpointsLocked.value = !endpointsLocked.value;
  redraw();
  emit();
}

function toggleSnap(): void {
  if (extSteps.value > 15) return;
  snapToSteps.value = !snapToSteps.value;
  redraw();
  emit();
}

function toggleReference(): void {
  showReference.value = !showReference.value;
  redraw();
}

function initFromReference(): void {
  const refs = referenceSigmas.value;
  if (!refs || refs.length < 2) return;

  const refMax = Math.max(...refs);
  if (refMax === 0) return;

  // Sample at 5 evenly-spaced positions from the reference
  const positions = [0, 1/6, 2/6, 3/6, 4/6, 5/6, 1.0];
  const newPts: Point[] = positions.map(t => {
    const idx = Math.round(t * (refs.length - 1));
    const ny  = Math.max(0, Math.min(1, refs[idx] / refMax));
    return [t, ny, tension.value] as Point;
  });

  points.value = newPts;
  invalidateCache(); redraw(); emit();
}

/** Called from main.ts when the reference link is connected/disconnected or data arrives. */
function setReferenceSigmas(values: number[] | null): void {
  referenceSigmas.value = values;
  showReference.value = values !== null;
  redraw();
}

function setReferenceConnected(connected: boolean): void {
  referenceConnected.value = connected;
  if (!connected) {
    referenceSigmas.value = null;
    showReference.value   = false;
    redraw();
  }
}

// ── Progress listeners ────────────────────────────────────────────────────────

function clearProgress(): void {
  progressT.value = null;
  redraw();
}

/** Universal step-progress event — works for samplers inside subgraphs. */
function onProgress(e: Event): void {
  const { value, max } = (e as CustomEvent).detail as { value: number; max: number };
  if (max > 0) {
    progressT.value = value / max;
    redraw();
  }
}

/** Finer-grained per-node progress state (not always emitted for subgraphs). */
function onProgressState(e: Event): void {
  type NodeProg = { value: number; max: number; state: string };
  const { nodes } = (e as CustomEvent).detail as { nodes: Record<string, NodeProg> };
  let running: NodeProg | null = null;
  for (const n of Object.values(nodes)) {
    if (n.state === "running" && n.max > 0) { running = n; break; }
  }
  progressT.value = running ? running.value / running.max : null;
  redraw();
}

function onExecuting(e: Event): void {
  // detail is null when the entire execution finishes
  if ((e as CustomEvent).detail === null) clearProgress();
}

function cleanup(): void {
  resizeObserver?.disconnect();
  resizeObserver = null;
  api.removeEventListener("progress",              onProgress);
  api.removeEventListener("progress_state",        onProgressState);
  api.removeEventListener("executing",             onExecuting);
  api.removeEventListener("execution_success",     clearProgress);
  api.removeEventListener("execution_error",       clearProgress);
  api.removeEventListener("execution_interrupted", clearProgress);
}

defineExpose({ serialise, deserialise, cleanup, forceResize, setReferenceSigmas, setReferenceConnected });

function emit(): void { props.onChange?.(serialise()); }

// Redraw when reactive state changes — also invalidate NURBS cache
watch([interpolation, tension], () => { invalidateCache(); redraw(); });
// Redraw when snap state changes
watch(snapEnabled, redraw);
// Redraw when external widget values change (live axis labels)
// Auto-disable snap if steps exceeds the maximum
watch(extSteps, (newSteps) => {
  if (newSteps > 15 && snapToSteps.value) {
    snapToSteps.value = false;
    emit();
  }
  redraw();
});
watch(extMaxSigma, redraw);

/**
 * Resize the canvas drawing buffer to match its current CSS display size × dpr.
 * Setting canvas.width/height resets all context state, so we re-apply the
 * transform that maps logical coordinates (0..CW × 0..CH) to physical pixels.
 * Called once by ResizeObserver whenever the element is resized.
 */
function syncCanvasSize(): boolean {
  const canvas = canvasRef.value;
  if (!canvas || !ctx) return false;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;

  // Take the larger of: exact device-pixel scale or the quality minimum.
  // When the node is small, MIN_RENDER_SCALE wins → buffer is larger than the
  // CSS display area → CSS down-scales → crisp.
  // When the node is large, the device-pixel scale wins → exact match → crisp.
  const sx = Math.max(rect.width  / CW * dpr, MIN_RENDER_SCALE);
  const sy = Math.max(rect.height / CH * dpr, MIN_RENDER_SCALE);
  const newW = Math.round(CW * sx);
  const newH = Math.round(CH * sy);
  if (canvas.width === newW && canvas.height === newH) return true;  // no change needed

  canvas.width  = newW;   // resets canvas context state
  canvas.height = newH;
  // Map logical coords (0..CW × 0..CH) to physical pixels
  ctx.setTransform(sx, 0, 0, sy, 0, 0);
  redraw();
  return true;
}

/** Called by main.ts to force a canvas resize measurement. Returns true when the
 *  canvas had a valid layout (width > 0), false when the DOM is not yet sized. */
function forceResize(): boolean { return syncCanvasSize(); }

onMounted(() => {
  const canvas = canvasRef.value!;
  dpr = Math.max(1, Math.ceil(window.devicePixelRatio || 1));
  // Fallback size until ResizeObserver fires with the actual CSS dimensions.
  // Use MIN_RENDER_SCALE so the first frame is already high-quality.
  const initScale = Math.max(dpr, MIN_RENDER_SCALE);
  canvas.width  = CW * initScale;
  canvas.height = CH * initScale;
  ctx = canvas.getContext("2d")!;
  ctx.scale(initScale, initScale);
  redraw();

  // ResizeObserver fires (async, before paint) with the real CSS size and
  // calls syncCanvasSize, which rebuilds the buffer at the correct resolution.
  resizeObserver = new ResizeObserver(syncCanvasSize);
  resizeObserver.observe(canvas);

  api.addEventListener("progress",              onProgress);
  api.addEventListener("progress_state",        onProgressState);
  api.addEventListener("executing",             onExecuting);
  api.addEventListener("execution_success",     clearProgress);
  api.addEventListener("execution_error",       clearProgress);
  api.addEventListener("execution_interrupted", clearProgress);
});
</script>

<style scoped>
.nkd-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: transparent;
  overflow: hidden;
  font-family: sans-serif;
  font-size: 11px;
  color: #c8d0e0;
  user-select: none;
}

/* Controls bar */
.nkd-bar {
  display: flex;
  flex-direction: column;
  background: #1a1c22;
  border-bottom: 1px solid #2a2d36;
}

.nkd-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: nowrap;
  overflow: hidden;
}

.nkd-row--controls { padding: 5px 7px 3px; }
.nkd-row--ref      { padding: 2px 7px 3px; border-top: 1px solid rgba(255,180,60,0.12); }
.nkd-row--hint     { padding: 2px 7px 4px; }

.nkd-label {
  font-size: 11px;
  color: rgba(255,255,255,0.45);
  white-space: nowrap;
}

.nkd-select {
  font-size: 11px;
  background: #252830;
  border: 1px solid #3a3d46;
  color: #c8d0e0;
  border-radius: 4px;
  padding: 2px 5px;
  cursor: pointer;
  outline: none;
}
.nkd-select:focus { border-color: #4ab4ff; }

.nkd-divider {
  width: 1px; height: 14px;
  background: rgba(255,255,255,0.12);
  margin: 0 1px;
}

.nkd-group {
  display: flex;
  align-items: center;
  gap: 5px;
}

.nkd-slider {
  width: 72px;
  height: 4px;
  cursor: pointer;
  accent-color: #4ab4ff;
}

.nkd-mono {
  font-size: 10px;
  font-family: monospace;
  color: #aac;
  min-width: 28px;
}

.nkd-spacer { flex: 1; min-width: 4px; }

/* ── Unified button base ── */
.nkd-btn {
  font-size: 11px;
  font-family: sans-serif;
  background: #252830;
  border: 1px solid #3a3d46;
  color: rgba(255,255,255,0.55);
  border-radius: 4px;
  padding: 1px 7px;
  cursor: pointer;
  line-height: 1.5;
  white-space: nowrap;
}
.nkd-btn:hover:not(:disabled) {
  border-color: #4ab4ff;
  color: rgba(255,255,255,0.85);
}
.nkd-btn--active {
  border-color: #4ab4ff;
  color: #4ab4ff;
}
.nkd-btn:disabled,
.nkd-btn--disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

/* Reference-row buttons use amber accent instead of blue */
.nkd-btn--ref:hover:not(:disabled) {
  border-color: #ffb43c;
  color: rgba(255,255,255,0.85);
}
.nkd-btn--ref-active {
  border-color: #ffb43c;
  color: #ffb43c;
}

.nkd-info {
  font-size: 10px;
  font-family: monospace;
  color: rgba(180,210,255,0.65);
  white-space: nowrap;
}

.nkd-hint {
  font-size: 9.5px;
  color: rgba(255,255,255,0.22);
}

/* Canvas */
.nkd-canvas {
  display: block;
  width: 100%;
  height: auto;
  cursor: crosshair;
  background: #111318;
}
</style>

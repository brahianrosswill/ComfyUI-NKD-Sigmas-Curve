"""
NKD Sigma Curve – ComfyUI custom node for interactive sigma schedule editing.

Allows controlling diffusion model sigma values through a visual spline curve
editor. The curve maps normalised step positions [0, 1] to normalised sigma
values [0, 1], which are then scaled by max_sigma.

Interpolation modes:
  "smooth"  – Cardinal / Hermite spline with per-point tension weights.
                w = 0 → Catmull-Rom-like tangents (maximum smoothness)
                w = 1 → zero tangents (flat at each control point)
  "linear"  – Piecewise linear between control points.
"""

from __future__ import annotations

import json
import torch

from comfy_api.latest import ComfyExtension, io
from typing_extensions import override


# ─── Hermite spline mathematics ──────────────────────────────────────────────

def _compute_tangents(
    points: list[list[float]],
    weights: list[float],
) -> list[float]:
    """
    Compute tangent slopes (dy/dx) for a Cardinal spline at every control point.

    Each point has an independent weight ``w_i`` ∈ [0, 1] that scales its
    tangent: ``a_i = 1 - w_i``.  Interior tangents use centripetal
    Catmull-Rom weighting; boundary points use a one-sided difference.

    Args:
        points:  Sorted list of [x, y, w] (or [x, y]) pairs with x, y ∈ [0, 1].
        weights: Per-point tension weights ∈ [0, 1].  w=0 → full tangent;
                 w=1 → zero tangent.

    Returns:
        List of tangent values (dy/dx), one per control point.
    """
    n = len(points)
    ts = [0.0] * n

    for i in range(n):
        wi = weights[i] if i < len(weights) else 0.0
        a  = 1.0 - wi  # per-point scale

        if i == 0:
            # First point always has a horizontal tangent (ts[0] stays 0)
            pass

        elif i == n - 1:
            # Backward difference at the last point
            dx = points[-1][0] - points[-2][0]
            if dx > 0:
                ts[i] = a * (points[-1][1] - points[-2][1]) / dx

        else:
            # Interior: centripetal Catmull-Rom weighted average
            dx1 = points[i][0]     - points[i - 1][0]
            dx2 = points[i + 1][0] - points[i][0]
            if dx1 > 0 and dx2 > 0:
                dy1 = points[i][1]     - points[i - 1][1]
                dy2 = points[i + 1][1] - points[i][1]
                s1  = dy1 / dx1
                s2  = dy2 / dx2
                w1  = (dx1 * dx1 + dy1 * dy1) ** 0.25  # chord length ^ alpha=0.5
                w2  = (dx2 * dx2 + dy2 * dy2) ** 0.25
                w_sum = w1 + w2
                if w_sum > 0:
                    ts[i] = a * (s1 * w2 + s2 * w1) / w_sum

    return ts


def _hermite_segment(
    y0: float, y1: float,
    m0: float, m1: float,
    h: float, t: float,
) -> float:
    """
    Cubic Hermite interpolation on a single segment of x-width ``h``.

    Args:
        y0, y1: Y values at segment start / end.
        m0, m1: Tangent slopes (dy/dx) at start / end.
        h:      Segment x-width (x1 - x0).
        t:      Local parameter ∈ [0, 1].

    Returns:
        Interpolated Y value (not clamped).
    """
    t2 = t * t
    t3 = t2 * t
    h00 = 2 * t3 - 3 * t2 + 1
    h10 = t3 - 2 * t2 + t
    h01 = -2 * t3 + 3 * t2
    h11 = t3 - t2
    return h00 * y0 + h10 * h * m0 + h01 * y1 + h11 * h * m1


# ─── Universal curve sampler ──────────────────────────────────────────────────

def _sample_curve(
    points: list[list[float]],
    t: float,
    interpolation: str,
    tension: float = 0.0,
) -> float:
    """
    Sample the curve at normalised position ``t`` ∈ [0, 1].

    Args:
        points:        Sorted list of [x, y, w] or [x, y] pairs (x, y ∈ [0, 1]).
                       The optional third element ``w`` is the per-point tension
                       weight used in smooth mode.
        t:             Horizontal position to query.
        interpolation: ``"smooth"`` → Hermite Cardinal spline;
                       ``"linear"`` → piecewise linear.
        tension:       Unused (kept for signature compatibility).

    Returns:
        Interpolated Y value clamped to [0, 1].
    """
    n = len(points)
    if n == 0:
        return 0.0
    if n == 1:
        return float(points[0][1])

    t = max(0.0, min(1.0, t))

    if t <= points[0][0]:
        return float(points[0][1])
    if t >= points[-1][0]:
        return float(points[-1][1])

    # Locate the enclosing segment
    seg = 0
    for i in range(n - 1):
        if points[i][0] <= t <= points[i + 1][0]:
            seg = i
            break

    x0, y0 = float(points[seg][0]),     float(points[seg][1])
    x1, y1 = float(points[seg + 1][0]), float(points[seg + 1][1])

    if x1 == x0:
        return y0

    local_t = (t - x0) / (x1 - x0)  # ∈ [0, 1] within the segment
    y_lin   = y0 + local_t * (y1 - y0)

    if interpolation == "linear":
        return float(y_lin)

    # Cardinal Hermite spline (default / "smooth")
    weights  = [float(p[2]) if len(p) > 2 else 0.0 for p in points]
    tangents = _compute_tangents(points, weights)
    h        = x1 - x0
    result   = _hermite_segment(
        y0, y1, tangents[seg], tangents[seg + 1], h, local_t
    )
    return float(max(0.0, min(1.0, result)))


# ─── Node definition ──────────────────────────────────────────────────────────

_DEFAULT_CURVE = json.dumps({
    "points":        [[0.0, 1.0, 0.0], [1.0, 0.0, 0.0]],
    "interpolation": "smooth",
    "tension":       0.0,
})


class NKDSigmaCurve(io.ComfyNode):
    """
    Interactive sigma curve editor.

    Outputs a SIGMAS tensor whose values are sampled from the user-drawn curve.
    The X-axis is the normalised step position (0 = first step, 1 = last step)
    and the Y-axis is the normalised sigma magnitude (y=1 → max_sigma, y=0 → 0).

    Two interpolation modes are available:
      "smooth"  – Cardinal / Hermite spline with per-point tension weights
      "linear"  – Piecewise linear between control points

    The final sigma is always 0 as required by ComfyUI samplers.
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="NKDSigmaCurve",
            display_name="NKD Sigmas Curve",
            category="sampling/custom_sampling/schedulers",
            description=(
                "Control sigma values interactively with a spline curve. "
                "Left-click to add points · Shift+click to remove · Drag to move."
            ),
            inputs=[
                io.String.Input(
                    "curve_data",
                    default=_DEFAULT_CURVE,
                    socketless=True,
                    tooltip="Serialised curve JSON (managed by the curve widget)",
                ),
                io.Int.Input(
                    "steps",
                    default=20,
                    min=1,
                    max=10000,
                    tooltip="Number of sigma steps to generate",
                ),
                io.Float.Input(
                    "max_sigma",
                    default=1.0,
                    min=0.001,
                    max=5000.0,
                    step=0.01,
                    round=False,
                    tooltip="Maximum sigma value — curve top (y=1) maps to this",
                ),
            ],
            outputs=[io.Sigmas.Output()],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs) -> float:
        """Always re-execute — curve state may change interactively."""
        return float("nan")

    @classmethod
    def execute(
        cls,
        curve_data: str,
        steps: int,
        max_sigma: float,
    ) -> io.NodeOutput:
        """
        Sample the curve and return a SIGMAS tensor of length ``steps + 1``.

        Args:
            curve_data: JSON produced by the JS widget with keys:
                        ``points``, ``interpolation``, ``tension``.
            steps:      Number of diffusion steps.
            max_sigma:  Scale for the Y-axis (curve y=1 → this value).

        Returns:
            NodeOutput wrapping a FloatTensor of shape ``(steps + 1,)``.
        """
        # ── Parse and validate curve JSON ──────────────────────────────────
        try:
            data = json.loads(curve_data)
            raw_points    = data.get("points", [[0.0, 1.0, 0.0], [1.0, 0.0, 0.0]])
            interpolation = str(data.get("interpolation", "smooth"))
            tension       = float(data.get("tension", 0.0))
        except (json.JSONDecodeError, ValueError, AttributeError):
            raw_points    = [[0.0, 1.0, 0.0], [1.0, 0.0, 0.0]]
            interpolation = "smooth"
            tension       = 0.0

        tension = max(0.0, min(1.0, tension))

        # Remap legacy bspline mode
        if interpolation == "bspline":
            interpolation = "smooth"

        # Sanitise each point
        points: list[list[float]] = []
        for p in raw_points:
            try:
                px = max(0.0, min(1.0, float(p[0])))
                py = max(0.0, min(1.0, float(p[1])))
                pw = max(0.0, min(1.0, float(p[2]))) if len(p) > 2 else 0.0
                points.append([px, py, pw])
            except (IndexError, TypeError, ValueError):
                continue

        if len(points) < 2:
            points = [[0.0, 1.0, 0.0], [1.0, 0.0, 0.0]]

        # Sort by X so segments are well-defined
        points.sort(key=lambda p: p[0])

        # ── Sample the curve at steps+1 positions ──────────────────────────
        sigma_values: list[float] = []
        for i in range(steps + 1):
            t = i / steps if steps > 0 else 0.0
            y = _sample_curve(points, t, interpolation, tension)
            sigma_values.append(y * max_sigma)

        # Guarantee last sigma == 0.0 (ComfyUI sampler requirement)
        sigma_values[-1] = 0.0

        sigmas = torch.FloatTensor(sigma_values)
        return io.NodeOutput(sigmas)


# ─── V3 Extension entrypoint ──────────────────────────────────────────────────

class NKDSigmaCurveExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [NKDSigmaCurve]


async def comfy_entrypoint() -> NKDSigmaCurveExtension:
    return NKDSigmaCurveExtension()


# ─── Legacy mappings ──────────────────────────────────────────────────────────

NODE_CLASS_MAPPINGS = {
    "NKDSigmaCurve": NKDSigmaCurve,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "NKDSigmaCurve": "NKD Sigmas Curve",
}

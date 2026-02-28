# NKD Sigmas Curve

A ComfyUI custom node that lets you design sigma schedules visually using an interactive spline curve editor.

![Node category: sampling/custom_sampling/schedulers]

## Features

- **Interactive curve editor** — click to add control points, drag to move them, Shift+click to remove
- **Two interpolation modes:**
  - **Smooth** — Cardinal/Hermite spline with per-point tension weights (w=0 → Catmull-Rom, w=1 → flat)
  - **Linear** — Piecewise linear between control points
- **Per-point tension** — adjust smoothness individually at each control point
- Outputs a standard `SIGMAS` tensor compatible with all ComfyUI samplers
- Always forces the last sigma to `0.0` as required by ComfyUI

## Installation

### Via ComfyUI Manager (recommended)

Search for **NKD Sigmas Curve** in the ComfyUI Manager.

### Manual

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/yourusername/ComfyUI-NKD-Sigmas-Curve
```

No additional Python dependencies are required beyond those already included in ComfyUI.

> **Note:** The JavaScript widget (`web/nkd_sigma_curve.js`) is pre-built and ready to use. If you want to modify the Vue source, see [Development](#development) below.

## Inputs

| Name | Type | Description |
|------|------|-------------|
| `steps` | INT | Number of sigma steps to generate (1–10000, default 20) |
| `max_sigma` | FLOAT | Maximum sigma value — curve top (y=1) maps to this (default 1.0) |

The curve itself is edited interactively via the embedded canvas widget.

## Output

| Name | Type | Description |
|------|------|-------------|
| `SIGMAS` | SIGMAS | Tensor of shape `(steps + 1,)`, last value is always `0.0` |

## How it works

The X-axis of the curve represents the normalised step position (0 = first step, 1 = last step).
The Y-axis represents the normalised sigma magnitude (1 = `max_sigma`, 0 = 0).

The node samples the curve at `steps + 1` evenly-spaced positions and scales the results by `max_sigma`.

## Development

The widget is written in Vue 3 + TypeScript and bundled with Vite.

```bash
cd custom_nodes/nkd_sigma_curve
npm install
npm run build   # outputs to web/nkd_sigma_curve.js
npm run dev     # watch mode
```

## Requirements

- ComfyUI (V3 API / Nodes 2.0 compatible)
- Python ≥ 3.10
- PyTorch (included with ComfyUI)

## License

MIT

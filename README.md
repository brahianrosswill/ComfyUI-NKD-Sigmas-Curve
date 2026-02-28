# ComfyUI NKD Sigmas Curve

>⚠️ **This is my first custom node, and I built the whole thing just vibecoding with Claude. To be honest, I have no clue what I'm doing. I'm just a monkey with a shotgun telling a robot to build what I want. Expect some bugs... or not. Who knows? It's a miracle this thing even works.**

---

A ComfyUI custom node that replaces trial-and-error sigma tuning with a visual, interactive spline editor. Design your diffusion noise schedule exactly the way you want it, then plug it straight into any sampler.

## Why this exists

It’s all about control. Standard schedulers (Karras, exponential, etc.) give you a fixed curve shape (nothing wrong with that) but once you unlock the power of custom sigmas, you can decide exactly how you want to denoise the image. That gives you fine-grained control over composition, details, and a bunch of nerdy stuff.

I’ve been using [Custom Sigma Editor](https://github.com/JoeNavark/comfyui_custom_sigma_editor.git) for months and I love it, but it’s not compatible with Nodes 2.0, so """I built""" (Claude did 🤫) my own version inspired by it.


https://github.com/user-attachments/assets/ee3e5b04-c5ab-4c67-9840-fa64a70db6cd



## Demo

https://github.com/user-attachments/assets/8b6d06e8-ce00-4119-9105-b4d228af56d9

## Features

- **Interactive canvas widget** embedded directly in the ComfyUI node, no external tools needed
- **Click** to add control points, **drag** to reposition, **Shift+click** to remove
- **Two interpolation modes:**
  - **Smooth** — Cardinal/Hermite spline with per-point tension weights (`w=0` = Catmull-Rom, `w=1` = flat/linear blend)
  - **Linear** — Piecewise linear between control points
- Outputs a standard `SIGMAS` tensor compatible with **all ComfyUI samplers**
- No extra Python dependencies beyond what ComfyUI already includes

## How it works

The node embeds a canvas editor directly in the ComfyUI graph:

- **X-axis** is the normalised step position (0 = first step, 1 = last step)
- **Y-axis** is the normalised sigma magnitude (1 = `max_sigma`, 0 = 0)

At generation time, the curve is sampled at `steps + 1` evenly-spaced positions and scaled by `max_sigma`, producing a standard `SIGMAS` tensor ready for any sampler node.

## Inputs

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `steps` | INT | 20 | Number of sigma steps to generate (1-10000) |
| `max_sigma` | FLOAT | 1.0 | Maximum sigma value, the top of the curve (y=1) maps to this |

The curve shape is set interactively via the embedded canvas widget in the node itself.

## Output

| Name | Type | Description |
|------|------|-------------|
| `SIGMAS` | SIGMAS | Tensor of shape `(steps + 1,)`, last value is always `0.0` |

## Installation

### Via ComfyUI Manager *(recommended)*

Search for **NKD Sigmas Curve** in the ComfyUI Manager and install with one click.

### Manual

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/Nekodificador/ComfyUI-NKD-Sigmas-Curve
```

No additional Python dependencies required. Restart ComfyUI after installing.

> **Note:** The JavaScript widget (`web/nkd_sigma_curve.js`) is pre-built and ready to use. If you want to modify the Vue source, see [Development](#development) below.

## Requirements

- ComfyUI (V3 API / Nodes 2.0 compatible)
- Python 3.10 or higher
- PyTorch (included with ComfyUI)

## Development

The widget is written in **Vue 3 + TypeScript** and bundled with Vite.

```bash
cd ComfyUI/custom_nodes/nkd_sigma_curve
npm install
npm run build   # outputs to web/nkd_sigma_curve.js
npm run dev     # watch mode
```

## License

MIT, use it, modify it, share it freely.

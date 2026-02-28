# ComfyUI NKD Sigmas Curve

>⚠️ **This is my first custom node, and I built the whole thing just vibecoding with Claude. To be honest, I have no clue what I'm doing. I'm just a monkey with a shotgun telling a robot to build what I want. Expect some bugs... or not. Who knows? It's a miracle this thing even works.**

---

A ComfyUI custom node that replaces trial-and-error sigma tuning with a visual, interactive spline editor. Design your diffusion noise schedule exactly the way you want it, then plug it straight into any sampler.

## Why this exists

It’s all about control. Standard schedulers (Karras, exponential, etc.) give you a fixed curve shape (nothing wrong with that) but once you unlock the power of custom sigmas, you can decide exactly how you want to denoise the image. That gives you fine-grained control over composition, details, and a bunch of nerdy stuff.

I’ve been using [Custom Sigma Editor](https://github.com/JoeNavark/comfyui_custom_sigma_editor.git) for months and I love it, but it’s not compatible with Nodes 2.0, so """I built""" (Claude did 🤫) my own version inspired by it.

https://github.com/user-attachments/assets/ee3e5b04-c5ab-4c67-9840-fa64a70db6cd



## My version 👇🏻

https://github.com/user-attachments/assets/281fa043-0900-4e7b-883d-1018953b01e0

This is all with a fixed seed. As you can see, specially in the las 2 generations. Tuning the sigma curve lets you nail the shapes and details at just the right moment during generation. For instance, I use it to swap out a bare chest for a T-shirt on the fly.


## How it works / How to use it

- I **strongly, highly, super recommend using it alongside the [RES4LYF](https://github.com/ClownsharkBatwing/RES4LYF.git)** node pack (and joining the bongmath cult), but technically you could plug it into any sigmas input, like with a _CustomSampler_. 
- The node overrides the scheduler and steps, so set the **Ksampler to 1.0 denoise control these from the Sigmas Curves node instead**.
- If you know nothing about sigmas, treat the _max_sigma_ value as your new "denoise" setting (kind of).
- The curve is your new "scheduler" (you're basically drawing it yourself instead of picking one from a dropdown).
- You can choose between linear curve or b-spline type. Up to you.

## Features

- **Interactive canvas widget** embedded directly in the ComfyUI node, no external tools needed
- **Click** to add control points, **drag** to reposition, **Shift+click** to remove
- **Two interpolation modes:**
  - **Smooth** — Cardinal/Hermite spline with per-point tension weights (`w=0` = Catmull-Rom, `w=1` = flat/linear blend)
  - **Linear** — Piecewise linear between control points
- Outputs a standard `SIGMAS` tensor compatible with **all ComfyUI samplers**
- No extra Python dependencies beyond what ComfyUI already includes

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

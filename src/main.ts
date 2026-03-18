/**
 * NKD Sigma Curve – Vue 3 extension entry point.
 *
 * When built with Vite (`npm run build`), this file is compiled into
 * web/nkd_sigma_curve.js and replaces the hand-written vanilla JS widget
 * with a proper Vue component mounted as a DOM widget.
 *
 * The ComfyUI extension hook (`beforeRegisterNodeDef`) intercepts the
 * NKDSigmaCurve node type and mounts a Vue app inside the DOM widget
 * element for every new node instance.
 */

import { createApp } from "vue";
import { app as comfyApp } from "../../scripts/app.js";
import SigmaCurveWidget from "@/SigmaCurveWidget.vue";

const NODE_NAME = "NKDSigmasCurve";
const EXT_NAME  = "NKD.SigmasCurve.Vue";

comfyApp.registerExtension({
  name: EXT_NAME,

  async beforeRegisterNodeDef(
    nodeType: any,
    nodeData: { name: string },
    _app: any
  ): Promise<void> {
    if (nodeData.name !== NODE_NAME) return;

    const origCreated: (() => void) | undefined =
      nodeType.prototype.onNodeCreated;

    nodeType.prototype.onNodeCreated = function (this: any) {
      const result = origCreated?.apply(this, arguments as any);

      // ── Locate the curve_data string widget and hide it ──────────────
      const curveDataWidget = this.widgets?.find(
        (w: any) => w.name === "curve_data"
      );

      if (curveDataWidget) {
        curveDataWidget.type           = "hidden";
        curveDataWidget.computedHeight = 0;
        curveDataWidget.computeSize    = () => [0, -4];
      }

      // ── Build container div for the Vue app ──────────────────────────
      const container = document.createElement("div");
      container.style.cssText =
        "width:100%;box-sizing:border-box;overflow:hidden;" +
        "border-top:1px solid rgba(255,255,255,0.06);";

      // Mount the Vue component into the container
      const vueApp = createApp(SigmaCurveWidget, {
        /** Called whenever the curve changes */
        onChange: (json: string) => {
          if (curveDataWidget) curveDataWidget.value = json;
          this.setDirtyCanvas(true);
        },
      });

      const instance = vueApp.mount(container) as InstanceType<
        typeof SigmaCurveWidget
      >;

      // ── Register DOM widget ──────────────────────────────────────────
      const domWidget = this.addDOMWidget(
        "sigma_curve_editor",
        "CURVE_EDITOR",
        container,
        {
          getValue: (): string => instance.serialise(),
          setValue: (val: string): void => {
            instance.deserialise(val);
            if (curveDataWidget) curveDataWidget.value = val;
          },
          serialize: false,
        }
      );

      // Canvas logical dimensions (must match SigmaCurveWidget.vue constants)
      const CANVAS_W  = 320;
      const CANVAS_H  = 200;
      const CANVAS_AR = CANVAS_H / CANVAS_W; // 0.625

      // barH is measured from the real DOM in requestAnimationFrame below.
      // Start with a safe overestimate so the node is never too short before
      // the measurement fires.
      let barH = 50;

      if (domWidget) {
        // v1 (LiteGraph / DOMWidgetImpl) sets the element's CSS width directly
        // from computeSize()[0]. Returning 0 makes the widget invisible, so we
        // return `w` (the node width LiteGraph passes in). In v2 the value is
        // ignored and CSS handles the width, so w is harmless there too.
        // Height scales proportionally so the canvas aspect ratio is preserved.
        domWidget.computeSize = (w: number) => [w, Math.round(w * CANVAS_AR) + barH];
      }

      // Enforce minimum width and lock height proportionally on every resize so
      // the node border never ends up behind the DOM widget.
      const origResize = this.onResize;
      this.onResize = function (this: any, size: [number, number]) {
        origResize?.apply(this, arguments as any);
        if (size[0] < CANVAS_W) size[0] = CANVAS_W;
        size[1] = this.computeSize(size[0])[1];
      };

      // Safety net: ensure node.computeSize() never reports less than the widget needs.
      const origComputeSize = this.computeSize.bind(this);
      this.computeSize = function (w?: number): [number, number] {
        const sz: [number, number] = origComputeSize(w);
        const width = sz[0] || this.size[0];
        const needed = Math.round(width * CANVAS_AR) + barH;
        if (sz[1] < needed) sz[1] = needed;
        return sz;
      };

      // onNodeCreated fires BEFORE LiteGraph restores widget values from the
      // saved workflow JSON, so curveDataWidget.value is still the default here.
      // For brand-new nodes that is correct; for nodes loaded from a workflow
      // we must wait for onConfigure (called after all widget values are set).
      const origConfigure = this.onConfigure;
      this.onConfigure = function (this: any, _data: any) {
        origConfigure?.apply(this, arguments as any);
        const saved = curveDataWidget?.value;
        if (saved) instance.deserialise(saved);
      };

      // Measure the real controls-bar height after the DOM is rendered, update
      // barH (both closures above already reference it), then force the node to
      // adopt the corrected size so the border always wraps the content.
      requestAnimationFrame(() => {
        const barEl = container.querySelector(".nkd-bar") as HTMLElement | null;
        const measured = barEl ? Math.ceil(barEl.getBoundingClientRect().height) : 0;
        if (measured > 0) barH = measured;

        const sz = this.computeSize(this.size[0]);
        this.setSize(sz);
        this.setDirtyCanvas(true, true);
      });

      // Clean up the Vue app when the node is removed
      const origRemoved = this.onRemoved;
      this.onRemoved = function (this: any) {
        instance.cleanup?.();
        vueApp.unmount();
        origRemoved?.apply(this, arguments as any);
      };

      return result;
    };
  },
});

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

      if (domWidget) {
        // canvas (200) + controls bar (34) = 234 px logical height
        domWidget.computeSize = () => [320, 234];
      }

      // Restore saved state
      const saved = curveDataWidget?.value;
      if (saved) instance.deserialise(saved);

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

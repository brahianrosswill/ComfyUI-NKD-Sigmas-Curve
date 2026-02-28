import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

/**
 * Vite config for nkd_sigma_curve.
 *
 * Builds the Vue widget into web/nkd_sigma_curve.js.
 * The ComfyUI scripts (app.js, api.js) are marked as external so they
 * are imported at runtime from the browser context.
 */
export default defineConfig({
  plugins: [vue()],

  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },

  build: {
    lib: {
      entry: "./src/main.ts",
      formats: ["es"],
      fileName: "nkd_sigma_curve",
    },
    rollupOptions: {
      // These paths are resolved by the browser at runtime
      external: [
        "../../scripts/app.js",
        "../../scripts/api.js",
      ],
      output: {
        // Output directly into web/ so ComfyUI can serve it
        dir: "web",
        entryFileNames: "nkd_sigma_curve.js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
    sourcemap: false,
    minify: false,      // Keep readable for debugging
    cssCodeSplit: false,
  },
});

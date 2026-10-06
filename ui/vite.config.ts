import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Strict CSP for production builds: no third-party origins anywhere.
// connect-src cannot enumerate the RPC/relayer/artifact origins because they
// come from the runtime /config.json, so it is limited to https: plus local
// loopback (dev-style deployments); everything else is same-origin only.
// 'wasm-unsafe-eval' is required by the snarkjs prover worker.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' https: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const cspPlugin: Plugin = {
  name: 'council-csp',
  apply: 'build',
  transformIndexHtml(html) {
    return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
  },
};

// The SDK must be pre-built (../sdk/dist) before installing/building the app;
// the `sdk-build` package script and `make ui-build` both take care of that.
export default defineConfig({
  plugins: [react(), tailwindcss(), cspPlugin],
  worker: {
    format: 'es',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    host: '0.0.0.0',
    port: 5175,
  },
});

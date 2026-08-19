import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';

// Get port from environment variable with fallback to 5567
const apiPort = process.env.API_PORT || 5567;

// flint-chart's map templates hardcode third-party basemap URLs, so rendering a
// US/World map would fetch topojson from vega.github.io. Those two files are
// vendored under public/geo; this rewrites the literals at build time so the
// upstream host never reaches the bundle. src/app/geoAssets.ts additionally
// rewrites at runtime, covering stored specs and any local flint checkout.
const LOCAL_BASEMAPS: Record<string, string> = {
  'https://vega.github.io/vega-lite/data/us-10m.json': '/geo/us-10m.json',
  'https://vega.github.io/vega-lite/data/world-110m.json': '/geo/world-110m.json',
};

const localizeBasemapUrls = (): Plugin => ({
  name: 'df-localize-basemap-urls',
  enforce: 'pre',
  transform(code, id) {
    if (!id.includes('flint-chart')) return null;
    let out = code;
    for (const [remote, local] of Object.entries(LOCAL_BASEMAPS)) {
      out = out.split(remote).join(local);
    }
    return out === code ? null : { code: out, map: null };
  },
});

export default defineConfig({
  plugins: [localizeBasemapUrls(), react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Advanced dev only: point `flint-chart` at a local checkout for HMR co-dev.
      //   FLINT_CHART_LOCAL=../flint-chart/packages/flint-js/src yarn start
      // Unset (default) → the bare `flint-chart` import resolves to the installed npm package.
      ...(process.env.FLINT_CHART_LOCAL
        ? { 'flint-chart': path.resolve(__dirname, process.env.FLINT_CHART_LOCAL) }
        : {}),
    },
    // Keep a single copy of Flint's (optional) peer deps when aliased to local source.
    dedupe: ['vega', 'vega-lite', 'echarts', 'chart.js'],
  },
  build: {
    outDir: path.join(__dirname, 'py-src', 'data_formulator', "dist"),
    rollupOptions: {
      output: {
        entryFileNames: `DataFormulator.js`,  // specific name for the main JS bundle
        chunkFileNames: `assets/[name]-[hash].js`, // keep default naming for chunks
        assetFileNames: `assets/[name]-[hash].[ext]`, // keep default naming for other assets
        manualChunks: {
          // Separate vendor chunks for better caching and parallel loading
          'vendor-react': ['react', 'react-dom', 'react-redux', 'redux', '@reduxjs/toolkit'],
          'vendor-mui': ['@mui/material', '@mui/icons-material', '@mui/lab', '@emotion/react', '@emotion/styled'],
          'vendor-vega': ['vega', 'vega-lite', 'vega-embed', 'react-vega'],
          'vendor-d3': ['d3'],
          'vendor-utils': ['lodash', 'localforage', 'dompurify', 'validator'],
          'vendor-editor': ['prismjs', 'prism-react-renderer', 'prettier'],
          'vendor-markdown': ['markdown-to-jsx', 'katex', 'react-katex'],
          'vendor-misc': ['exceljs', 'html2canvas', 'allotment', 'react-dnd', 'react-dnd-html5-backend', 'react-virtuoso'],
        }
      }
    },
    chunkSizeWarningLimit: 1000, // Warn if chunks exceed 1MB
  },
  server: {
    proxy: {
      '/api': {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
      '/auth/callback': {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      }
    }
  }
});

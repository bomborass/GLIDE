import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Single self-contained index.html: the same file is embedded in the JUCE
// plugin as a WebView resource and can be opened directly in a browser.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: { outDir: 'dist', assetsInlineLimit: 100000000 },
  // escape non-ASCII characters so the page reads the same whatever encoding the WebView assumes
  esbuild: { charset: 'ascii' },
});

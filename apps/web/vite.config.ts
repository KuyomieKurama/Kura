import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The API answers with "Content-Security-Policy: default-src 'self'". Fonts and the favicon must stay
  // separate files: data: URIs would be blocked.
  build: { assetsInlineLimit: 0 }
});

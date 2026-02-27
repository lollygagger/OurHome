import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'https://ourhome.maxburdett.com',
        changeOrigin: true,
        secure: true,
      },
      '/ws': {
        target: 'wss://ourhome.maxburdett.com',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});

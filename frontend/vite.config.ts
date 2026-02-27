import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const cfClientId = env.VITE_CF_ACCESS_CLIENT_ID;
  const cfClientSecret = env.VITE_CF_ACCESS_CLIENT_SECRET;

  const proxyHeaders: Record<string, string> = {};
  if (cfClientId) proxyHeaders['CF-Access-Client-Id'] = cfClientId;
  if (cfClientSecret) proxyHeaders['CF-Access-Client-Secret'] = cfClientSecret;

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': {
          target: 'https://ourhome.maxburdett.com',
          changeOrigin: true,
          secure: true,
          headers: proxyHeaders,
        },
        '/ws': {
          target: 'wss://ourhome.maxburdett.com',
          ws: true,
          changeOrigin: true,
          secure: true,
          configure: (proxy) => {
            proxy.on('proxyReqWs', (proxyReq) => {
              if (cfClientId) proxyReq.setHeader('CF-Access-Client-Id', cfClientId);
              if (cfClientSecret) proxyReq.setHeader('CF-Access-Client-Secret', cfClientSecret);
            });
          },
        },
      },
    },
  };
});

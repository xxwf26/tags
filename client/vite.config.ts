import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5322,
    proxy: {
      '/api': 'http://localhost:3322',
      '/uploads': 'http://localhost:3322',
    },
  },
});

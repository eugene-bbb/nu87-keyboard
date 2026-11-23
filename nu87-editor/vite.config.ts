import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Port 5200 is on the Companion bridge's allowed-origin list (usagi-ascii-pet keeps 5199).
export default defineConfig({
  plugins: [react()],
  base: './',
  server: { port: 5200, strictPort: true },
  preview: { port: 5200, strictPort: true },
});

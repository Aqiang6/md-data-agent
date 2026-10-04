import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/** The data-agent UI mounts under `/da-assets` inside the dsh webserver. */
export default defineConfig({
  plugins: [react()],
  base: '/da-assets/',
  build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
})

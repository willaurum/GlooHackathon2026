import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Only used by `npm run dev` outside Docker. In the container nginx does
  // the proxying (see nginx.conf).
  server: {
    proxy: { '/api': 'http://localhost:8000' },
  },
})

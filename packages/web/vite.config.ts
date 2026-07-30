import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // three.js + drei make vendor-three inherently large; it's isolated from
    // app code and only loads behind the scene's lazy boundary, so the
    // default 500 kB warning isn't actionable here.
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (/node_modules\/(three|@react-three)\//.test(id)) {
            return 'vendor-three'
          }
        },
      },
    },
  },
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/graphql': 'http://localhost:8000',
      '/hanime': 'http://localhost:8000',
      '/preview': 'http://localhost:8000'
    }
  }
})
import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/graphql': 'http://localhost:8000',
      '/hanime': 'http://localhost:8000',
      '/preview': 'http://localhost:8000'
    }
  }
})

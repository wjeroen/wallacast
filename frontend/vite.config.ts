import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      // After every build, stamp the service worker cache name with the
      // current build timestamp so that deploys always bust the old cache.
      // The source file stays as 'wallacast-v1'; only dist/ is modified.
      name: 'inject-sw-cache-version',
      closeBundle() {
        const swPath = path.resolve(__dirname, 'dist/service-worker.js');
        if (fs.existsSync(swPath)) {
          const version = Date.now().toString();
          const content = fs.readFileSync(swPath, 'utf-8');
          fs.writeFileSync(swPath, content.replace('wallacast-v1', `wallacast-${version}`));
          console.log(`[inject-sw-cache-version] Cache name set to wallacast-${version}`);
        }
      }
    }
  ],
})

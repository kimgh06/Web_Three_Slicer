// Standalone build for the independence check — its own minimal install (react/react-dom + vite +
// plugin-react) so it shares NOTHING with the demo. The alias pins packages/components to THIS app's
// single react copy (packages/components has no node_modules of its own).
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      react: path.resolve(here, 'node_modules/react'),
      'react-dom': path.resolve(here, 'node_modules/react-dom'),
      'react/jsx-runtime': path.resolve(here, 'node_modules/react/jsx-runtime'),
    },
  },
  server: { fs: { allow: ['../..'] } },   // reach packages/*
  build: { outDir: 'dist' },
})

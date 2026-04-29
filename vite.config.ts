// vite.config.ts
import { defineConfig } from 'vite';
import checker from 'vite-plugin-checker';
import path from 'path';

export default defineConfig({
  base: './',

  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },

  plugins: [
    checker({
      typescript: true,
    }),
  ],
});

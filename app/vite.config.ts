import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    root: 'src/renderer',
    base: './',
    build: { outDir: '../../out/renderer', emptyOutDir: true, target: 'chrome120' },
    plugins: [react()],
    server: { port: 5173, strictPort: true },
});

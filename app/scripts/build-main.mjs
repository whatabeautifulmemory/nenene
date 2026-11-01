// main/preload 번들. renderer 는 vite 가 맡는다.
//
// main 은 CJS 로 낸다. ESM main 은 electron 모듈을 정적 import 할 때 Electron 의 CJS 로더와
// 부딪혔다(cjsPreparseModuleExports TypeError). 파이프라인이 쓰는 import.meta.dirname 은
// define 으로 __dirname 에 매핑한다 — 번들 안에서 그 둘은 같은 뜻이다.
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('out/main', { recursive: true });
mkdirSync('out/preload', { recursive: true });

await build({
    entryPoints: ['src/main/index.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: 'out/main/index.cjs',
    external: ['electron'],
    sourcemap: true,
    logLevel: 'info',
    define: { 'import.meta.dirname': '__dirname' },
});

await build({
    entryPoints: ['src/preload/index.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: 'out/preload/index.cjs',
    external: ['electron'],
    logLevel: 'info',
});

// 원문 찾기 브라우저의 도구막대 — preload 와 정적 HTML.
await build({
    entryPoints: ['src/preload/browser-bar.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: 'out/preload/browser-bar.cjs',
    external: ['electron'],
    logLevel: 'info',
});
mkdirSync('out/browser', { recursive: true });
cpSync('src/browser/bar.html', 'out/browser/bar.html');

// PDF 글 뽑기(pdf.js) — 파이프라인(web.ts)이 main 번들 옆에서 찾아 자식 프로세스로 돌린다.
cpSync('../src/law/pdf-extract.mjs', 'out/main/pdf-extract.mjs');

// PDF 글 뽑기 — pdftotext(poppler)가 없을 때 쓰는 순수 JS 경로(pdf.js). 윈도우에는 pdftotext 가 기본으로 없고,
// 맥에서도 Finder·Dock 으로 띄운 앱은 Homebrew 경로를 PATH 에 받지 못한다.
//
// web.ts 가 자식 프로세스로 부른다(동기 API 를 지키려고). 앱에서는 Electron 바이너리를 ELECTRON_RUN_AS_NODE=1 로 돌린다.
//   node pdf-extract.mjs <file.pdf>          → stdout: {"pages":N,"text":"…"}   (쪽 사이는 \n\n\f — pdftotext 와 같다)
//   node pdf-extract.mjs --pages <file.pdf>  → stdout: {"pages":N}
// 실패하면 stderr 에 이유를 쓰고 0 이 아닌 값으로 끝난다.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// stdout 은 결과(JSON) 전용이다. pdf.js 는 경고를 console.log 로 찍는다(캔버스 패키지가 없을 때의 "Cannot polyfill …" 등) —
// 그대로 두면 JSON 앞에 섞여 결과를 못 읽는다. 전부 stderr 로 돌린다.
for (const k of ['log', 'info', 'warn', 'debug']) console[k] = (...a) => process.stderr.write(a.map(String).join(' ') + '\n');

const args = process.argv.slice(2);
const pagesOnly = args[0] === '--pages';
const file = pagesOnly ? args[1] : args[0];

try {
    const require = createRequire(import.meta.url);
    const pkg = dirname(require.resolve('pdfjs-dist/package.json'));
    const pdfjs = await import(pathToFileURL(join(pkg, 'legacy', 'build', 'pdf.mjs')).href);
    // 렌더링은 하지 않으므로 캔버스 관련 경고는 숨긴다(stdout 은 결과 전용).
    const doc = await pdfjs.getDocument({
        data: new Uint8Array(readFileSync(file)),
        // 한국어 CID 글꼴(비임베드 Adobe-Korea1 등)은 CMap 이 있어야 글자가 나온다.
        cMapUrl: join(pkg, 'cmaps') + '/',
        cMapPacked: true,
        standardFontDataUrl: join(pkg, 'standard_fonts') + '/',
        isEvalSupported: false,
        disableFontFace: true,
        useSystemFonts: false,
        verbosity: 0,
    }).promise;
    if (pagesOnly) {
        process.stdout.write(JSON.stringify({ pages: doc.numPages }));
    } else {
        const pages = [];
        for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i);
            const tc = await page.getTextContent();
            // 줄 단위로 모은다: {글, 줄의 세로 위치}. pdf.js 의 줄 끝 표지({str:'', hasEOL})는 다음 줄 좌표를 갖고 있어서,
            // 빈 줄을 따로 넣으면 모든 줄 뒤에 빈 줄이 생겼다 — 빈 줄은 넣지 않고, 문단 경계는 아래에서 줄 간격으로 되살린다.
            const rows = [];
            let line = '';
            let lineY = null;
            let lineSize = 0;
            let lastEnd = null;
            const flush = () => {
                if (line.trim()) rows.push({ text: line, y: lineY });
                line = '';
                lineY = null;
                lineSize = 0;
                lastEnd = null;
            };
            for (const it of tc.items) {
                if (!('str' in it)) continue;
                const x = it.transform[4];
                const y = it.transform[5];
                const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
                // 줄이 바뀌었으면(세로 위치가 글자 크기의 절반 넘게 달라짐) 끊는다. 기준은 이 줄의 **본문 글자**(가장 큰 글자)의 자리와 크기다 —
                // 작게 올려 쓴 각주 번호(…압수·수색이다³⁾ 따라서…)는 제 크기의 절반보다 더 올라가 있어, 그 글자로 재면 문장이 두 줄·두 문단으로 갈렸다.
                if (lineY !== null && Math.abs(y - lineY) > Math.max(size, lineSize) * 0.5 && line) flush();
                if (it.str) {
                    // 같은 줄에서 떨어져 있으면 띄운다 — 조각마다 붙여 쓰면 낱말이 붙는다.
                    if (lastEnd !== null && line && !line.endsWith(' ') && !it.str.startsWith(' ') && x - lastEnd > size * 0.2) line += ' ';
                    if (lineY === null || size > lineSize) {
                        lineY = y;
                        lineSize = size;
                    }
                    line += it.str;
                    lastEnd = x + (it.width ?? 0);
                }
                if (it.hasEOL) flush();
            }
            flush();
            // 문단 경계: 줄 간격이 이 쪽의 보통 간격(중앙값)보다 1.5배 넘게 벌어지거나, 위로 올라가면(다음 단) 빈 줄.
            // 반 줄도 안 되게 올라간 것은 단이 바뀐 것이 아니다(같은 줄의 올려 쓴 조각) — 줄바꿈만.
            const gaps = [];
            for (let k = 1; k < rows.length; k++) {
                const g = rows[k - 1].y - rows[k].y;
                if (g > 0) gaps.push(g);
            }
            gaps.sort((a, b) => a - b);
            const usual = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
            let text = rows[0]?.text ?? '';
            for (let k = 1; k < rows.length; k++) {
                const g = rows[k - 1].y - rows[k].y;
                const up = usual > 0 ? g < -usual * 0.5 : g <= 0;
                text += (up || (usual > 0 && g > usual * 1.5) ? '\n\n' : '\n') + rows[k].text;
            }
            pages.push(text);
            page.cleanup();
        }
        process.stdout.write(JSON.stringify({ pages: doc.numPages, text: pages.join('\n\n\f') }));
    }
    await doc.destroy();
} catch (e) {
    process.stderr.write(String(e && e.message ? e.message : e).slice(0, 500));
    process.exit(2);
}

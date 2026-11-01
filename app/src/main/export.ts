// Markdown → DOCX. 법학논문 내보내기.
//
// 각주를 진짜 Word 각주로 넣는다. 논문을 각주 목록으로 끝내면 법학논문의 형식이 무너지므로,
// 이건 타협할 수 없는 부분이다(footnotes 옵션 + FootnoteReferenceRun).
import { Document, Packer, Paragraph, TextRun, HeadingLevel, FootnoteReferenceRun, AlignmentType } from 'docx';

interface Run {
    text: string;
    bold?: boolean;
    footnote?: number;
}

/** 한 줄의 인라인 마크업을 run 목록으로. 지원: **굵게**, [^n] 각주. 그 외는 평문. */
function inline(line: string, footnoteNumbers: Set<number>): Run[] {
    const out: Run[] = [];
    const re = /(\*\*[^*]+\*\*|\[\^(\d+)\])/g;
    let last = 0;
    for (const m of line.matchAll(re)) {
        const at = m.index ?? 0;
        if (at > last) out.push({ text: line.slice(last, at) });
        if (m[2]) {
            const n = Number(m[2]);
            if (footnoteNumbers.has(n)) out.push({ text: '', footnote: n });
            else out.push({ text: `[${n}]` });
        } else {
            out.push({ text: m[0].slice(2, -2), bold: true });
        }
        last = at + m[0].length;
    }
    if (last < line.length) out.push({ text: line.slice(last) });
    return out.length ? out : [{ text: '' }];
}

const toRuns = (rs: Run[]) =>
    rs.map((r) =>
        r.footnote
            ? new FootnoteReferenceRun(r.footnote)
            : new TextRun({ text: r.text, bold: r.bold ?? false, font: '바탕체', size: 22 }),
    );

export async function markdownToDocx(markdown: string, topic: string): Promise<Buffer> {
    const lines = markdown.split('\n');

    // 각주 정의를 먼저 모은다.
    const footnotes = new Map<number, string>();
    const body: string[] = [];
    for (const line of lines) {
        const m = /^\[\^(\d+)\]:\s*(.*)$/.exec(line);
        if (m) footnotes.set(Number(m[1]), m[2]!.trim());
        else body.push(line);
    }

    const children: Paragraph[] = [];
    for (const raw of body) {
        const line = raw.replace(/\s+$/, '');
        if (!line.trim()) {
            continue;
        }
        if (/^---+\s*$/.test(line)) continue;
        if (/^\|\s*[-:]/.test(line)) continue; // 표 구분선
        if (/^\|/.test(line)) {
            // 표는 한 문단으로 눕힌다 — 레이아웃보다 내용 보존이 우선.
            children.push(new Paragraph({ children: toRuns(inline(line.replace(/^\||\|$/g, '').split('|').join(' · '), new Set(footnotes.keys()))) }));
            continue;
        }
        const h = /^(#{1,4})\s+(.*)$/.exec(line);
        if (h) {
            // 각주 정의는 Word 각주로 들어가므로 "## 각주" 머리는 비어 있는 절이 된다. 걷어낸다.
            if (/^각주\s*$/.test(h[2]!.trim())) continue;
            const level = h[1]!.length;
            children.push(
                new Paragraph({
                    children: toRuns(inline(h[2]!, new Set(footnotes.keys()))),
                    heading: level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
                    spacing: { before: 240, after: 120 },
                }),
            );
            continue;
        }
        if (line.startsWith('>')) {
            children.push(
                new Paragraph({
                    children: toRuns(inline(line.replace(/^>\s?/, ''), new Set(footnotes.keys()))),
                    indent: { left: 480 },
                    spacing: { after: 80 },
                }),
            );
            continue;
        }
        if (/^[-*]\s+/.test(line)) {
            children.push(
                new Paragraph({
                    children: toRuns(inline(line.replace(/^[-*]\s+/, ''), new Set(footnotes.keys()))),
                    bullet: { level: 0 },
                    spacing: { after: 60 },
                }),
            );
            continue;
        }
        children.push(
            new Paragraph({
                children: toRuns(inline(line, new Set(footnotes.keys()))),
                alignment: AlignmentType.JUSTIFIED,
                spacing: { after: 120, line: 360 },
                indent: { firstLine: 200 },
            }),
        );
    }

    const footnoteDefs: Record<number, { children: Paragraph[] }> = {};
    for (const [n, text] of [...footnotes.entries()].sort((a, b) => a[0] - b[0])) {
        footnoteDefs[n] = {
            children: [new Paragraph({ children: [new TextRun({ text, font: '바탕체', size: 18 })] })],
        };
    }

    const doc = new Document({
        title: topic,
        ...(Object.keys(footnoteDefs).length ? { footnotes: footnoteDefs } : {}),
        sections: [{ properties: {}, children }],
    });
    return Buffer.from(await Packer.toBuffer(doc));
}

/** 인쇄·열람용 HTML. 한글/워드에서 바로 열린다. 표·소절·각주·참고문헌을 논문 형식으로. */
export function markdownToHtml(markdown: string, topic: string): string {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const lines = markdown.split('\n');
    const notes = new Map<number, string>();
    const body: string[] = [];
    for (const l of lines) {
        const m = /^\[\^(\d+)\]:\s*(.*)$/.exec(l);
        if (m) notes.set(Number(m[1]), m[2]!.trim());
        else body.push(l);
    }
    const inl = (s: string) =>
        esc(s)
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/_([^_]+)_/g, '<em>$1</em>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/&lt;(https?:\/\/[^&\s]+)&gt;/g, '&lt;<a href="$1">$1</a>&gt;')
            .replace(/\[\^(\d+)\]/g, (_, n) => (notes.has(Number(n)) ? `<sup id="ref${n}"><a href="#fn${n}">${n}</a></sup>` : `[${n}]`));
    const out: string[] = [];
    let table: string[][] | null = null;
    let list: 'ul' | 'ol' | null = null;
    const flushTable = () => {
        if (!table) return;
        const [head, ...rows] = table;
        out.push('<table>');
        if (head) out.push(`<thead><tr>${head.map((c) => `<th>${inl(c)}</th>`).join('')}</tr></thead>`);
        if (rows.length) out.push(`<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inl(c)}</td>`).join('')}</tr>`).join('')}</tbody>`);
        out.push('</table>');
        table = null;
    };
    const flushList = () => {
        if (list) out.push(`</${list}>`);
        list = null;
    };
    for (const raw of body) {
        const l = raw.replace(/\s+$/, '');
        if (!l.trim()) {
            flushTable();
            flushList();
            continue;
        }
        if (/^\|/.test(l)) {
            flushList();
            if (/^\|\s*:?-+/.test(l)) continue; // 구분선
            const cells = l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
            (table ??= []).push(cells);
            continue;
        }
        flushTable();
        if (/^---+\s*$/.test(l)) {
            flushList();
            out.push('<hr>');
            continue;
        }
        const h = /^(#{1,4})\s+(.*)$/.exec(l);
        if (h) {
            flushList();
            const lv = h[1]!.length;
            if (/^각주\s*$/.test(h[2]!.trim())) continue; // 각주는 아래에서 다시 그린다
            out.push(`<h${lv}>${inl(h[2]!)}</h${lv}>`);
            continue;
        }
        if (l.startsWith('>')) {
            flushList();
            out.push(`<blockquote>${inl(l.replace(/^>\s?/, ''))}</blockquote>`);
            continue;
        }
        const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(l);
        if (li) {
            const kind: 'ul' | 'ol' = /\d/.test(li[2]!) ? 'ol' : 'ul';
            if (list !== kind) {
                flushList();
                list = kind;
                out.push(`<${kind}>`);
            }
            out.push(`<li>${inl(li[3]!)}</li>`);
            continue;
        }
        flushList();
        if (/^```/.test(l)) continue;
        out.push(`<p>${inl(l)}</p>`);
    }
    flushTable();
    flushList();
    const fnHtml = [...notes.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([n, t]) => `<li id="fn${n}">${inl(t)} <a href="#ref${n}" class="back">↩</a></li>`)
        .join('\n');
    return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(topic)}</title>
<style>
 body{font-family:"Batang","바탕체","AppleMyungjo",serif;max-width:820px;margin:48px auto;padding:0 24px;line-height:1.9;font-size:15px;color:#111}
 h1{font-size:22px;border-bottom:2px solid #111;padding-bottom:12px;margin-top:48px;line-height:1.5}
 h2{font-size:18px;margin-top:40px} h3{font-size:15.5px;margin-top:26px} h4{font-size:15px;margin-top:20px}
 p{text-align:justify;text-indent:1em;margin:0 0 10px}
 blockquote{margin:8px 0 8px 2em;color:#444;border-left:3px solid #ddd;padding-left:12px}
 ul,ol{margin:6px 0 12px 1.6em;padding:0} li{margin:3px 0}
 table{border-collapse:collapse;margin:12px 0;font-size:13.5px;width:100%}
 th,td{border:1px solid #bbb;padding:5px 8px;vertical-align:top;text-align:left}
 th{background:#f3f2ee}
 sup a{text-decoration:none;color:#0645ad;font-size:11px}
 hr{border:0;border-top:1px solid #ddd;margin:32px 0}
 ol#notes{font-size:12.5px;color:#333;line-height:1.7;margin-left:1.4em}
 ol#notes a.back{color:#999;text-decoration:none;font-size:11px}
 code{font-family:ui-monospace,monospace;font-size:12px;background:#f3f2ee;padding:0 3px}
 em{font-style:normal;color:#555}
</style></head><body>
${out.join('\n')}
${notes.size ? `<hr><h2>각주</h2><ol id="notes">${fnHtml}</ol>` : ''}
</body></html>`;
}

/**
 * 실행 대화 기록 → HTML. 감사(audit)와 성능 측정에 쓰는 문서다.
 *
 * 요약하지 않는다. 진행 로그·질문·답·완료 요약을 **일어난 순서대로** 그대로 편다. 감사에서
 * 필요한 것은 "무엇을 했는가"가 아니라 "무엇이 실제로 오갔는가"다.
 */
export function transcriptHtml(runDir: string, rows: any[]): string {
    const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const parts: string[] = [];
    let n = 0;
    for (const r of rows) {
        const t = r?.type;
        if (t === 'progress') {
            parts.push(`<div class="line"><span class="ts">${esc((r.at ?? '').slice(11, 19))}</span><pre>${esc(r.line)}</pre></div>`);
        } else if (t === 'asks') {
            n++;
            const asks = (r.asks ?? []) as any[];
            parts.push(
                `<div class="block ask"><h3>질문 ${n} · ${asks.length}건</h3>` +
                    asks
                        .map(
                            (a) =>
                                `<p><b>${esc(a.kind === 'source' ? '원문 요청' : '확인 질문')}</b> ${esc(a.question)}</p>` +
                                `<p class="meta">${esc(a.detail ?? '')}</p>`,
                        )
                        .join('') +
                    `</div>`,
            );
        } else if (t === 'answer') {
            const as = (r.answers ?? {}) as Record<string, any>;
            parts.push(
                `<div class="block answer"><h3>답변</h3>` +
                    Object.entries(as)
                        .map(([id, a]) => `<p><code>${esc(id)}</code> → <b>${esc(a.action)}</b> ${esc(a.note ?? '')}</p>`)
                        .join('') +
                    `</div>`,
            );
        } else if (t === 'done') {
            const s = r.summary ?? {};
            parts.push(
                `<div class="block done"><h3>완료</h3><p>원장: <code>${esc(s.runDir)}</code></p>` +
                    `<p>명제 ${esc(s.coverage?.claims)} · 인용 ${esc(s.coverage?.citations)} (원문확인 ${esc(s.coverage?.verified)}) · 사람에게 물음 ${esc(s.humanCount)}</p>` +
                    `<p>판정: ${Object.entries(s.verdicts ?? {})
                        .map(([k, v]) => `${esc(k)} ${esc(v)}`)
                        .join(' · ')}</p></div>`,
            );
        } else if (t === 'error') {
            parts.push(`<div class="block error"><h3>오류</h3><pre>${esc(r.message)}</pre></div>`);
        } else {
            parts.push(`<pre>${esc(JSON.stringify(r))}</pre>`);
        }
    }
    return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>실행 기록</title>
<style>
 body{font-family:-apple-system,'Apple SD Gothic Neo',sans-serif;max-width:900px;margin:32px auto;padding:0 20px;color:#1b1a17;font-size:13px}
 h1{font-size:18px} h3{font-size:13px;margin:0 0 6px}
 .line{display:flex;gap:8px;border-bottom:1px dashed #eee;padding:2px 0}
 .ts{color:#999;font-family:ui-monospace,monospace;font-size:11px;flex:0 0 62px}
 pre{margin:0;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,monospace;font-size:11.5px;line-height:1.55}
 .block{border:1px solid #e3e0d8;border-radius:8px;padding:10px 12px;margin:10px 0}
 .ask{background:#fffdf6} .answer{background:#f6faf7} .done{background:#f7f7fb} .error{background:#fdf0ee}
 .meta{color:#6d6a63;font-size:11.5px;white-space:pre-wrap}
 code{background:#f2f1ee;padding:1px 4px;border-radius:3px;font-size:11.5px}
</style></head><body>
<h1>실행 기록</h1>
<p style="color:#6d6a63">${esc(runDir)} · ${new Date().toISOString()}</p>
${parts.join('\n')}
</body></html>`;
}

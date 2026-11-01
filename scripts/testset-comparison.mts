// 테스트셋 양단 대조 — 주제·논지·접근방향·결론을 **주요 내용만 요약**해 나란히 놓고,
// 축별로 어떻게 같고 다른지 비교한다. 전문은 comparison-full.md 에 따로 둔다.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'testset');
// manifest에 있는 편만 — results/ 에는 ID가 바뀌기 전의 옛 결과가 남아 있을 수 있다.
const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8')) as { papers: { id: string }[] };
const rows = manifest.papers
    .map((p) => path.join(OUT, 'results', `${p.id}.json`))
    .filter((f) => fs.existsSync(f))
    .map((f) => JSON.parse(fs.readFileSync(f, 'utf8')))
    .filter((r) => !r.error)
    .sort((a, b) => String(a.title).localeCompare(String(b.title), 'ko'));

const DIR: Record<string, string> = { same: '같음', related: '관련', different: '다름', opposite: '반대', unclear: '불명' };
// 누출 표시 — ⚠ 원문(전문·초록·결론 발췌)을 연구 자료로 가져옴, △ 서지만 찾음. 수준이 없는 옛 결과는 원문으로 본다.
const leakMark = (r: any) => (r.conclusion?.leak ? ((r.conclusion.leakLevel || 'content') === 'content' ? '⚠' : '△') : '');
const leakNote = (r: any) =>
    !r.conclusion?.leak ? '' : leakMark(r) === '⚠' ? ' · ⚠ 연구 단계가 원 논문의 원문을 자료로 가져옴(누출)' : ' · △ 연구 단계가 원 논문의 서지만 찾음';

// 원본 논지·접근방향 문장이 입력 배경에도 있는가 — 있으면 그 축의 비교는 입력과 그 입력으로 쓴 글의 비교다.
const normText = (s: string) => s.normalize('NFC').replace(/\s+/g, '').replace(/[「」『』"“”'‘’<>《》〈〉.,:;?!·…\-–—()[\]]/g, '').toLowerCase();
const sentencesOf = (t: string) => t.replace(/\s+/g, ' ').split(/(?<=[.!?。])\s+/).map((s) => s.trim()).filter((s) => s.length >= 8);
const inInput = (id: string): { thesis: boolean; approach: boolean } => {
    try {
        const exp = JSON.parse(fs.readFileSync(path.join(OUT, 'papers', id, 'expected.json'), 'utf8'));
        const md = fs.readFileSync(path.join(OUT, 'papers', id, 'input.md'), 'utf8');
        const bg = normText(/## 배경·문제의식\n\n([\s\S]*?)\n\n## /m.exec(md)?.[1] ?? '');
        const contained = (s: string) => {
            const ss = sentencesOf(String(s ?? ''));
            return ss.length > 0 && ss.every((x) => bg.includes(normText(x)));
        };
        return { thesis: contained(exp.thesisOriginal), approach: contained(exp.approachOriginal) };
    } catch {
        return { thesis: false, approach: false };
    }
};
const echo = new Map(rows.map((r) => [r.id, inInput(r.id)]));
const echoMark = (r: any) => {
    const e = echo.get(r.id);
    const axes = [e?.thesis ? '논지' : '', e?.approach ? '접근' : ''].filter(Boolean);
    return axes.length ? ` · 입력 포함(${axes.join('·')})` : '';
};
const nThesis = rows.filter((r) => echo.get(r.id)?.thesis).length;
const nApproach = rows.filter((r) => echo.get(r.id)?.approach).length;

const clean = (s: string | undefined) => {
    let t = String(s ?? '').replace(/\r/g, ' ');
    t = t.replace(/⟦[^⟦⟧]*⟧/g, '');
    t = t.replace(/^#{1,6}\s+.*$/gm, '');
    t = t.replace(/^[-–—]\s*\d+\s*[-–—]$/gm, '');
    t = t.replace(/ACKNOWLEDGMENT[\s\S]*$/i, '');
    t = t.replace(/(?:이|본)\s*논문은[^.]*지원[^.]*\./g, '');
    t = t.replace(/\(\s*\)/g, '');
    t = t.replace(/[ \t]{2,}/g, ' ');
    t = t.replace(/\n{3,}/g, '\n\n');
    t = t.replace(/(?<!\n)\n(?!\n)/g, ' ');
    return t.trim();
};

const axisTable = (orig: string, gen: string) => `| **논지** | ${orig} | ${gen} |`;

const index = rows
    .map((r, i) => `| ${i + 1} | ${r.title} | ${DIR[r.direction?.direction ?? 'unclear'] ?? '—'}${leakMark(r) ? ` · ${leakMark(r)}` : ''}${echoMark(r)} |`)
    .join('\n');

const body = rows
    .map((r, i) => {
        const s = r.summary;
        if (!s) {
            return `## ${i + 1}. ${r.title}\n\n(요약 없음 — \`comparison-full.md\` 의 전문을 보십시오.)\n\n---\n`;
        }
        return `## ${i + 1}. ${r.title}

| | 원본 | 생성 |
|---|---|---|
| **논지** | ${s.original.thesis} | ${s.generated.thesis} |
| **접근방향** | ${s.original.approach} | ${s.generated.approach} |
| **결론** | ${s.original.conclusion} | ${s.generated.conclusion} |

**비교**

- **논지**: ${s.comparison.thesis}
- **접근방향**: ${s.comparison.approach}
- **결론**: ${s.comparison.conclusion}
- **종합**: ${s.comparison.overall}

방향 표시: **${DIR[r.direction?.direction ?? 'unclear'] ?? '—'}**${leakNote(r)}${echoMark(r)} · 인용 ${r.cites}건(검증 ${r.citesVerified})

---
`;
    })
    .join('\n');

const head = `# 테스트셋 양단 대조 — 요약 비교 (${new Date().toISOString().slice(0, 10)})

입력(\`input.md\`)에서는 초록에서 결과·결론으로 분류한 문장과 본문 결론 절과 거의 같은 문장, 제목의 부제를 뺐다
(규칙 기반이라 빠뜨릴 수 있다). 아래 "원본"의 **결론**은 입력에서 뺀 정답지(본문 결론 절, 없으면 초록 결과 문장)다.
"원본"의 **논지·접근방향**은 초록에서 뽑은 문장이라 입력 배경에도 들어 있을 수 있다 — 논지 ${nThesis}편, 접근방향 ${nApproach}편이
그렇다(목록의 '입력 포함'). 그 편의 해당 축 비교는 입력과 그 입력으로 쓴 글의 비교다.
"생성"은 파이프라인이 이 입력으로 쓴 논문이다. ⚠ 편은 연구 단계가 원 논문의 원문을 자료로 가져왔고, △ 편은 서지만 찾았다.
각 항목은 **주요 내용만 요약**했다. 원문 전문은 \`comparison-full.md\` 에 있다(줄임 없음). 요약·비교는 모델이 작성한
보조 자료이며, 판단은 전문을 읽어야 한다.

## 목록

| # | 주제 | 방향 |
|---|---|---|
${index}

---

${body}
`;

fs.writeFileSync(path.join(OUT, 'results', 'comparison.md'), head, 'utf8');

// 전문 대조(줄임 없음) — 검증용.
const full = rows
    .map((r, i) => {
        const expFile = path.join(OUT, 'papers', r.id, 'expected.json');
        const ledgerFile = path.join(OUT, 'runs', r.id, 'ledger.json');
        if (!fs.existsSync(expFile) || !fs.existsSync(ledgerFile)) return '';
        const exp = JSON.parse(fs.readFileSync(expFile, 'utf8'));
        const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
        const secs: any[] = ledger.paper?.sections ?? [];
        const last = secs.length ? secs[secs.length - 1] : {};
        const lastText = last?.revised?.trim() || last?.draft?.trim() || '';
        const thesis = ledger.paper?.thesis ?? {};
        return `## ${i + 1}. ${r.title}

**원본 논지**

${clean(exp.thesisOriginal || exp.abstract)}

**원본 접근방향**

${clean(exp.approachOriginal)}

**원본 결론**

${clean(exp.conclusionSection || (exp.resultSentences ?? []).join(' ') || '(원문에서 결론 절을 찾지 못함 — 정답지 없음)')}

**생성 논지**

${clean(thesis.thesis)}

**생성 접근방향**

${clean(thesis.method)}

**생성 결론**

${clean(`${thesis.position ?? ''}\n\n${lastText}`)}

방향 표시: **${DIR[r.direction?.direction ?? 'unclear'] ?? '—'}**${leakNote(r)}${echoMark(r)}

---
`;
    })
    .join('\n');

fs.writeFileSync(
    path.join(OUT, 'results', 'comparison-full.md'),
    `# 테스트셋 양단 대조 — 전문 (${new Date().toISOString().slice(0, 10)})\n\n줄임 없이 원문과 생성문을 그대로 싣는다. 요약 비교는 \`comparison.md\`.\n\n---\n\n${full}`,
    'utf8',
);

console.log(`요약 대조 ${rows.length}편 → comparison.md · comparison-full.md`);

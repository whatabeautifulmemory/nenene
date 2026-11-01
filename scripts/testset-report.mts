// 테스트셋 결과 집계 — 결론 비교를 중심으로.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TESTSET = path.join(process.cwd(), 'testset');
const OUT = path.join(TESTSET, 'results');
// manifest에 있는 편만 집계한다 — results/ 에는 ID가 바뀌기 전의 옛 결과가 남아 있을 수 있다(중복 집계).
const manifest = JSON.parse(fs.readFileSync(path.join(TESTSET, 'manifest.json'), 'utf8')) as { papers: { id: string }[] };
const rows = manifest.papers
    .map((p) => path.join(OUT, `${p.id}.json`))
    .filter((f) => fs.existsSync(f))
    .map((f) => JSON.parse(fs.readFileSync(f, 'utf8')))
    .filter((r) => !r.error)
    .sort((a, b) => String(a.title).localeCompare(String(b.title), 'ko'));

const pct = (x: number | undefined) => (typeof x === 'number' ? `${(x * 100).toFixed(0)}%` : '—');
const pp = (x: number | undefined) => (typeof x === 'number' ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%p` : '—');
const recall = (r: { hit: number; total: number } | undefined) => (r ? `${r.hit}/${r.total}` : '—');
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const DIR: Record<string, string> = { same: '같음', related: '관련', different: '다름', opposite: '반대', unclear: '불명' };
const LEAK: Record<string, string> = { content: '⚠', meta: '△' };
// 옛 결과(누출 수준 없이 leak만 있는 것)는 원문 누출로 본다.
const leakLevel = (r: any): string => (r.conclusion?.leak ? r.conclusion.leakLevel || 'content' : '');

const withConc = rows.filter((r) => r.conclusion && r.conclusion.source !== 'none');
const clean = withConc.filter((r) => !r.conclusion?.leak);
const noContent = withConc.filter((r) => leakLevel(r) !== 'content');
const leaksContent = rows.filter((r) => leakLevel(r) === 'content').length;
const leaksMeta = rows.filter((r) => leakLevel(r) === 'meta').length;
const dirCount = (xs: any[], k: string) => xs.filter((r) => r.direction?.direction === k).length;
const dirLine = (xs: any[]) => `같음 ${dirCount(xs, 'same')} · 관련 ${dirCount(xs, 'related')} · 다름 ${dirCount(xs, 'different')} · 반대 ${dirCount(xs, 'opposite')} · 불명 ${dirCount(xs, 'unclear')}`;
const covLine = (xs: any[]) => {
    const withBase = xs.filter((r) => typeof r.conclusion?.coverageBaseline === 'number');
    return `${pct(avg(xs.map((r) => r.conclusion.coverage)))}${withBase.length ? ` · 기준선 ${pct(avg(withBase.map((r) => r.conclusion.coverageBaseline)))} · 차이 ${pp(avg(withBase.map((r) => r.conclusion.coverageLift)))}` : ''}`;
};

// 실행 조건 — 결과에 남은 값으로 쓴다(고정 문자열로 쓰면 --quality·standard 실행도 short·no-quality로 찍힌다).
const modelOf = (r: any): string => {
    if (r.model) return String(r.model);
    try {
        return String(JSON.parse(fs.readFileSync(path.join(TESTSET, 'runs', r.id, 'ledger.json'), 'utf8')).model ?? '?');
    } catch {
        return '?';
    }
};
const uniq = (xs: string[]) => [...new Set(xs)].join(' / ') || '?';
const conditions = `${uniq(rows.map((r) => String(r.scale ?? '?')))} · ${uniq(rows.map((r) => (r.quality ? 'quality' : 'no-quality')))} · \`--assume-unavailable\` · ${uniq(rows.map(modelOf))}`;

// 입력이 바뀐 결과 — 전처리를 다시 돌린 뒤의 결과는 옛 입력으로 쓴 원고를 새 정답지와 비교한 것이다.
// 해시가 없는 옛 결과는 ledger.context(실행 때 다듬은 input.md)와 비교한다.
const stale = rows.filter((r) => {
    const f = path.join(TESTSET, 'papers', r.id, 'input.md');
    if (!fs.existsSync(f)) return false;
    const now = fs.readFileSync(f, 'utf8');
    if (r.inputHash) return createHash('sha1').update(now).digest('hex').slice(0, 16) !== r.inputHash;
    try {
        const c = JSON.parse(fs.readFileSync(path.join(TESTSET, 'runs', r.id, 'ledger.json'), 'utf8')).context;
        return typeof c === 'string' && c.trim() !== now.trim();
    } catch {
        return false;
    }
});

const table = rows
    .map(
        (r) =>
            `| ${r.title} | ${DIR[r.direction?.direction ?? 'unclear'] ?? '—'} | ${pct(r.conclusion?.coverage)} | ${pp(r.conclusion?.coverageLift)} | ${r.cites} | ${r.citesVerified} | ${r.citesFullText} | ${pct(r.bgCoverage)} | ${recall(r.titleRecall)} | ${LEAK[leakLevel(r)] ?? ''} |`,
    )
    .join('\n');

const totalCites = rows.reduce((a, r) => a + r.cites, 0);
const totalVerified = rows.reduce((a, r) => a + r.citesVerified, 0);
const totalFull = rows.reduce((a, r) => a + r.citesFullText, 0);
// 인용 수에는 원문에서 확인되지 않아 본문에서 뺀 인용(각주 없음)도 든다 — 그 처리 전에는 ✗ 각주였으므로 기존 결과와 같은 정의다. 옛 결과에는 칸이 없다.
const totalWithheld = rows.reduce((a, r) => a + (r.citesWithheld ?? 0), 0);

const md = `# 테스트셋 실행 결과 (${new Date().toISOString().slice(0, 10)})

조건: ${conditions}. 논문 ${rows.length}편 · 정상 종료 ${rows.filter((r) => r.exit === 0).length}편.
인용 합계 ${totalCites}건(검증 ${totalVerified} · 전문 ${totalFull}${totalWithheld ? ` · 확인되지 않아 본문에서 뺀 인용 ${totalWithheld}건 포함` : ''}).${stale.length ? `\n\n⚠ 입력이 바뀐 결과 ${stale.length}편 — 실행 뒤 전처리를 다시 돌렸다. 옛 입력으로 쓴 원고를 새 정답지와 비교한 값이다: ${stale.map((r) => r.title).join(' · ')}` : ''}

## 결론 비교 (핵심)

| 논문 | 방향 | 결론포괄 | 기준선 대비 | 인용 | 검증 | 전문 | 배경 | 문헌 | 누출 |
|---|---|---|---|---|---|---|---|---|---|
${table}

**요약** — 방향: ${dirLine(rows)}.
결론포괄 평균 ${covLine(withConc)}.
- 원문 누출(⚠) 제외 ${noContent.length}편: 방향 ${dirLine(noContent)} · 결론포괄 ${covLine(noContent)}
- 누출(⚠·△) 모두 제외 ${clean.length}편: 방향 ${dirLine(clean)} · 결론포괄 ${covLine(clean)}

누출 ⚠ ${leaksContent}편 — 연구 단계가 원 논문의 원문(전문·초록·결론 발췌)을 자료로 가져왔다. 그 편의 결론 비교는 독립적이지 않다.
누출 △ ${leaksMeta}편 — 원 논문의 서지(제목·DOI)만 찾았다(원문 내용은 자료에 없음). 근거는 \`results/<id>.json\` 의 \`conclusion.leakBy\`.

- **방향**은 원 논문 결론과 생성 논문 결론(입장+마지막 장)의 규범적 방향을 모델이 비교한 보조 지표다(같음/관련/다름/반대/불명). 정답지가 아니다.
- **결론포괄**은 원 논문에서 **입력에서 제외한 결론**(정답지)의 글자 2-gram 중 생성 결론(입장 + 마지막 장 앞 4,000자 + 논지)에 들어 있는 비율이다.
  글자 2-gram에는 기능어 쌍이 많아 **관계없는 논문의 생성 결론도 상당 부분을 덮는다** — 재현의 하한이 아니다.
  **기준선**은 같은 정답지를 다른 논문들의 생성 결론으로 잰 포괄의 평균이고, **기준선 대비**는 그 차이다. 차이가 0 근처면 우연 수준이다.
- **배경**은 입력 배경(초록에서 결과를 뺀 문장)의 2-gram이 생성 논지·입장에 들어 있는 비율.
- **문헌**은 원 참고문헌 제목을 생성 인용(raw·display)이 확보한 비율.

## 참고

- 제목 유사 평균 ${pct(avg(rows.map((r) => r.titleSim)))} · 제목어 평균 ${pct(avg(rows.map((r) => r.titleCoverage)))} — 제목은 생성 과정에서 재구성되므로 낮게 나오는 것이 정상이다.
- **양단 대조(요약)**: \`testset/results/comparison.md\` — 주제·원본/생성 논지·접근방향·결론을 모델이 요약해 비교한 것. **전문(줄임 없음)**: \`testset/results/comparison-full.md\`.
- 전체 상세: \`testset/results/<id>.json\`, 원고: \`testset/runs/<id>/paper.md\`.
`;

fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ generatedAt: new Date().toISOString(), count: rows.length, results: rows }, null, 2), 'utf8');
fs.writeFileSync(path.join(OUT, 'summary.md'), md, 'utf8');
console.log(`집계 ${rows.length}편 → ${path.join(OUT, 'summary.md')}`);

// 논지·접근방향·결론 요약 + 축별 비교 — 각 항목을 주요 내용만 2~3문장으로 압축하고,
// 원본과 생성이 어떻게 같고 다른지 축별로 비교한다.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { loadEnv } from '../src/env.ts';
import { resolveModels } from '../src/config.ts';
import { structured } from '../src/llm.ts';

loadEnv();
const { base } = resolveModels();

const Three = z.object({
    thesis: z.string().describe('논지 요약 2~3문장'),
    approach: z.string().describe('접근방향 요약 1~2문장'),
    conclusion: z.string().describe('결론 요약 2~3문장'),
});
const Synthesis = z.object({
    original: Three,
    generated: Three,
    comparison: z.object({
        thesis: z.string().describe('논지 비교 1~2문장'),
        approach: z.string().describe('접근방향 비교 1~2문장'),
        conclusion: z.string().describe('결론 비교 1~2문장'),
        overall: z.string().describe('종합 비교 2~3문장'),
    }),
});

const SYSTEM = `당신은 두 법학논문을 비교하는 연구 보조자다. 입력은 원본 논문(초록·논지·접근방향·결론)과 생성 논문(논지·접근방향·결론)이다.

과제:
1) 원본과 생성 각각에 대해 **논지·접근방향·결론**을 주요 내용만 2~3문장으로 요약한다. 원문을 그대로 옮기지 말고 핵심 주장·방법·결론을 압축한다.
2) 축별 비교: 논지·접근방향·결론이 어떻게 같고 다른지 각 1~2문장으로 쓴다. "같다/다르다"를 분명히 밝힌다.
3) 종합 비교 2~3문장: 같은 규범적 결론에 도달했는가, 접근과 논증은 어떻게 다른가.

규칙:
- 줄임표(…)와 생략 부호를 쓰지 않는다. 문장을 자르지 않는다.
- 원문을 그대로 인용하지 말고 요약한다.
- 평가적 수사("훌륭하다", "아쉽다")를 쓰지 않는다. 사실만.
- 한국어로 쓴다.`;

const OUT = path.join(process.cwd(), 'testset');
// manifest에 있는 편만 — results/ 에는 ID가 바뀌기 전의 옛 결과가 남아 있을 수 있다.
const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8')) as { papers: { id: string }[] };
let n = 0;
for (const { id } of manifest.papers) {
    const resultFile = path.join(OUT, 'results', `${id}.json`);
    if (!fs.existsSync(resultFile)) continue;
    const r = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    if (r.error) continue;
    const expFile = path.join(OUT, 'papers', r.id, 'expected.json');
    const ledgerFile = path.join(OUT, 'runs', r.id, 'ledger.json');
    if (!fs.existsSync(expFile) || !fs.existsSync(ledgerFile)) continue;
    const exp = JSON.parse(fs.readFileSync(expFile, 'utf8'));
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    const secs: any[] = ledger.paper?.sections ?? [];
    const last: any = secs.length ? secs[secs.length - 1] : {};
    const lastText = last?.revised?.trim() || last?.draft?.trim() || '';
    const thesis = ledger.paper?.thesis ?? {};
    const originalConclusion = exp.conclusionSection || (exp.resultSentences ?? []).join(' ');
    const user = [
        `## 주제\n${r.title}`,
        `## 원본\n### 초록\n${String(exp.abstract ?? '').slice(0, 3000)}`,
        `### 논지(발췌)\n${String(exp.thesisOriginal ?? '').slice(0, 1200)}`,
        `### 접근방향(발췌)\n${String(exp.approachOriginal ?? '').slice(0, 1200)}`,
        `### 결론(발췌)\n${String(originalConclusion).slice(0, 6000)}`,
        `## 생성\n### 논지\n${String(thesis.thesis ?? '').slice(0, 2500)}`,
        `### 접근방향\n${String(thesis.method ?? '').slice(0, 1500)}`,
        `### 장 구성\n${secs.map((s) => `${s.title ?? ''}(${s.role ?? ''})`).join(' / ').slice(0, 1500)}`,
        `### 결론\n${`${thesis.position ?? ''}\n\n${lastText}`.slice(0, 6000)}`,
    ].join('\n');
    try {
        const out = await structured(base, { name: 'axis_summary', description: '논지·접근방향·결론 요약과 축별 비교', system: SYSTEM, user, schema: Synthesis, temperature: 0, maxTokens: 1600 });
        r.summary = out;
        fs.writeFileSync(resultFile, JSON.stringify(r, null, 2), 'utf8');
        n++;
        console.log(`요약 ${n} · ${String(r.title).slice(0, 40)}`);
    } catch (e) {
        console.error('요약 실패:', r.title, e instanceof Error ? e.message : e);
    }
}
console.log(`\n요약·비교 ${n}편`);

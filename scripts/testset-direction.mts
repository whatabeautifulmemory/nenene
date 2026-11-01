// 결론 방향 판정(보조 지표) — 원 논문 결론과 생성 논문 결론의 **규범적 방향**을 모델이 비교한다.
// 결정적 지표(conclusion.coverage)와 함께 읽어야 한다. 모델 판정은 정답지가 아니다.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { loadEnv } from '../src/env.ts';
import { resolveModels } from '../src/config.ts';
import { structured } from '../src/llm.ts';
import { PROVIDERS, providerById } from '../src/providers.ts';

loadEnv();
// 공급자 이름부터 확인한다 — 모르는 이름(오타 'antropic', 'claude')은 resolveModels 가 기본 공급자로 보고 경고 없이 기본(집필) 모델·주소·키로
// 판정했다(3차: TESTSET_JUDGE_PROVIDER=antropic 이 rc 0 으로 results/B.json 을 덮어씀). 대소문자는 파이프라인처럼 가리지 않는다.
const askedProvider = process.env.TESTSET_JUDGE_PROVIDER?.trim();
if (askedProvider && !providerById(askedProvider.toLowerCase())) {
    console.error(`✗ TESTSET_JUDGE_PROVIDER=${askedProvider} 는 모르는 공급자다 — 판정하지 않고 멈춘다. results/ 는 그대로다.`);
    console.error(`  쓸 수 있는 값: ${PROVIDERS.map((p) => p.id).join(', ')}`);
    process.exit(1);
}
// 판정 모델은 이 스크립트 전용 변수 TESTSET_JUDGE_MODEL(·_PROVIDER·_BASE_URL·_API_KEY)로 정한다 — 기본 모델은 원고를 쓴 모델이라
// 자기 글에 관대할 수 있다. LEGAL_AGENT_MODEL_JUDGE 는 쓰라고 하지 않는다: 그 변수는 파이프라인의 판정·인용 검사 역할도 바꿔서,
// .env 에 두면 testset-run 이 시험하는 파이프라인 자체가 달라진다. TESTSET_JUDGE_* 를 주면 파이프라인 JUDGE 값과 섞지 않고
// 그것만 쓴다. 주지 않으면 파이프라인 JUDGE 역할(정해 둔 경우), 그다음 기본 모델이다.
const JUDGE_KEYS = ['MODEL', 'PROVIDER', 'BASE_URL', 'API_KEY'] as const;
const judgeEnv: NodeJS.ProcessEnv = { ...process.env };
const ownJudge = JUDGE_KEYS.some((k) => process.env[`TESTSET_JUDGE_${k}`]?.trim());
if (ownJudge) {
    for (const k of JUDGE_KEYS) {
        delete judgeEnv[`LEGAL_AGENT_${k}_JUDGE`];
        const v = process.env[`TESTSET_JUDGE_${k}`]?.trim();
        if (v) judgeEnv[`LEGAL_AGENT_${k}_JUDGE`] = v;
    }
}
const models = resolveModels(judgeEnv);
const judge = models.roles.judgments ?? models.base;
// 판정 프로파일을 못 만들었으면(키 없음 등) 알린다. 파이프라인 JUDGE 역할이면 그 역할처럼 기본 모델로 돌아간다.
for (const w of models.warnings.filter((x) => x.includes('JUDGE'))) console.warn(`⚠ ${ownJudge ? w.replace('역할 JUDGE', 'TESTSET_JUDGE') : w}`);
// TESTSET_JUDGE_* 를 직접 줬는데 프로파일을 못 만들었으면 멈춘다 — 기본 모델은 원고를 쓴 모델이라, 그대로 돌리면 사용자가 피하려던
// 같은 모델 판정으로 results/*.json 의 direction 을 모두 덮어쓴다(경고는 한 줄뿐이고 같은 모델 경고는 파일을 쓴 뒤에 나왔다).
if (ownJudge && !models.roles.judgments) {
    console.error('✗ TESTSET_JUDGE_* 로 판정 모델을 지정했지만 프로파일을 만들지 못했다(위 경고) — 기본(집필) 모델로 판정하지 않고 멈춘다. results/ 는 그대로다.');
    console.error('  공급자의 키(예: ANTHROPIC_API_KEY 또는 TESTSET_JUDGE_API_KEY)·모델(TESTSET_JUDGE_MODEL)을 확인하십시오.');
    process.exit(1);
}
// 프로파일은 만들었어도 집필 모델(기본 프로파일의 공급자+모델)과 같으면 멈춘다 — 키·주소만 주거나(TESTSET_JUDGE_API_KEY 만) 모델 이름을
// 집필 모델과 같게 주면 TESTSET_JUDGE_* 를 준 까닭(다른 모델로 판정)과 달리 같은 모델로 판정한다. 공급자를 모르는 역할(파이프라인 JUDGE 의
// 오타)은 resolveModels 가 기본 공급자로 본다 — 여기서도 같은 공급자로 친다.
// 공급자·모델 이름은 대소문자와 앞뒤 공백을 가리지 않고 비교한다 — 5차는 문자열을 그대로 비교해 TESTSET_JUDGE_MODEL=DEEPSEEK-FLASH(집필
// deepseek-flash)가 멈추지 않고 같은 모델로 판정했다(6차).
const sameId = (a?: string, b?: string) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
const sameAsWriter = sameId(judge.provider ?? models.base.provider, models.base.provider) && sameId(judge.model, models.base.model);
if (ownJudge && sameAsWriter) {
    console.error(
        `✗ TESTSET_JUDGE_* 로 지정한 판정 모델이 집필 모델과 같다(${models.base.provider ?? '기본 공급자'} · ${judge.model}) — 같은 모델 판정으로 ` +
            'results/*.json 의 direction 을 덮어쓰지 않고 멈춘다. results/ 는 그대로다.',
    );
    console.error('  집필과 다른 공급자·모델을 TESTSET_JUDGE_PROVIDER·TESTSET_JUDGE_MODEL 로 주십시오.');
    process.exit(1);
}
console.log(`판정 모델: ${judge.model} (${models.roles.judgments ? (ownJudge ? 'TESTSET_JUDGE_*' : '파이프라인 JUDGE 역할') : '기본 모델'})`);

const Direction = z.object({
    direction: z.enum(['same', 'related', 'different', 'opposite', 'unclear']).describe('규범적 방향'),
    reason: z.string().describe('한 문장 이유'),
});
const SYSTEM = `당신은 법학논문의 결론 방향을 비교하는 심사자다. 두 결론(원 논문, 생성 논문)을 읽고 **규범적 방향**이 같은지 판정한다.

- same: 궁극적으로 같은 규범적 결론에 도달한다(예: 둘 다 입법이 필요하다, 둘 다 현행법으로 충분하다, 둘 다 특정 기본권 침해다).
- related: 같은 문제를 다루고 결론의 일부가 겹치지만 핵심 주장이 다르다.
- different: 서로 다른 규범적 결론을 낸다.
- opposite: 정반대의 결론을 낸다.
- unclear: 결론이 불명확하거나 텍스트가 잘렸다.

표현·구성·제목의 차이는 무시하고, **무엇을 해야 한다고 주장하는가**(입법/개정/폐지/보장/제한/위헌/합헌/허용/금지)만 본다. 이유는 한국어 한 문장.`;

/** 긴 결론은 앞과 끝을 함께 준다 — 끝에 최종 제언("결론적으로 본 연구는 …")이 있다. */
const headTail = (s: string, n = 1500) => (s.length > n * 2 ? `${s.slice(0, n)}\n…(중략)…\n${s.slice(-n)}` : s);

const OUT = path.join(process.cwd(), 'testset');
// manifest에 있는 편만 — results/ 에는 ID가 바뀌기 전의 옛 결과가 남아 있을 수 있다.
const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8')) as { papers: { id: string }[] };
// 판정할 편을 먼저 다 읽는다(쓰지 않는다) — 원고를 쓴 모델(ledger.model "deepseek-flash @ https://…")과 판정 모델이 같은 편을 루프 **앞에서**
// 세어 멈추거나 경고하려는 것이다. 3차는 이 경고를 results/*.json 을 다 쓴 뒤에 찍었다.
const jobs = manifest.papers.flatMap(({ id }) => {
    const resultFile = path.join(OUT, 'results', `${id}.json`);
    if (!fs.existsSync(resultFile)) return [];
    const r = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    if (r.error) return [];
    const expectedFile = path.join(OUT, 'papers', r.id, 'expected.json');
    const ledgerFile = path.join(OUT, 'runs', r.id, 'ledger.json');
    if (!fs.existsSync(expectedFile) || !fs.existsSync(ledgerFile)) return [];
    return [{ resultFile, r, expected: JSON.parse(fs.readFileSync(expectedFile, 'utf8')), ledger: JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) }];
});
// ledger.model 의 첫 낱말이 원고를 쓴 모델이다("deepseek-flash @ https://…") — 위와 같이 대소문자·공백을 가리지 않는다.
const sameModel = jobs.filter(({ ledger }) => sameId(String(ledger.model ?? '').trim().split(/\s+/)[0], judge.model)).length;
// TESTSET_JUDGE_* 로 고른 판정 모델이 이 원고들을 쓴 모델이면 멈춘다(기본 프로파일과 같은 경우는 위에서 멈췄다 — 여기는 옛 실행의 원고).
if (ownJudge && sameModel) {
    console.error(`✗ ${sameModel}편은 원고를 쓴 모델(${judge.model})과 TESTSET_JUDGE_* 판정 모델이 같다 — 판정하지 않고 멈춘다. results/ 는 그대로다.`);
    console.error('  그 원고를 쓰지 않은 공급자·모델을 TESTSET_JUDGE_PROVIDER·TESTSET_JUDGE_MODEL 로 주십시오.');
    process.exit(1);
}
if (sameModel)
    console.warn(
        `⚠ ${sameModel}편은 원고를 쓴 모델과 판정 모델이 같다 — 이 스크립트를 돌릴 때만 TESTSET_JUDGE_MODEL(·TESTSET_JUDGE_PROVIDER)로 다른 모델을 지정하십시오\n` +
            `  (예: TESTSET_JUDGE_PROVIDER=anthropic TESTSET_JUDGE_MODEL=… npx tsx scripts/testset-direction.mts). LEGAL_AGENT_MODEL_JUDGE 는 파이프라인도 바꾼다.`,
    );
let n = 0;
for (const { resultFile, r, expected, ledger } of jobs) {
    const sections: { revised?: string; draft?: string }[] = ledger.paper?.sections ?? [];
    const last = sections[sections.length - 1];
    const gen = `${ledger.paper?.thesis?.position ?? ''}\n\n${headTail(last?.revised?.trim() || last?.draft?.trim() || '')}`;
    const truth = headTail(expected.conclusionSection || expected.resultSentences.join(' '));
    if (!truth.trim() || !gen.trim()) {
        r.direction = { direction: 'unclear', reason: '결론 텍스트 없음' };
        fs.writeFileSync(resultFile, JSON.stringify(r, null, 2), 'utf8');
        continue;
    }
    try {
        const out = await structured(judge, {
            name: 'conclusion_direction',
            description: '두 결론의 규범적 방향 판정',
            system: SYSTEM,
            user: [`## 원 논문 결론(정답지)\n${truth}`, '', `## 생성 논문 결론(입장 + 마지막 장)\n${gen}`].join('\n'),
            schema: Direction,
            temperature: 0,
            maxTokens: 400,
        });
        r.direction = { ...out, model: judge.model };
        fs.writeFileSync(resultFile, JSON.stringify(r, null, 2), 'utf8');
        n++;
        console.log(`${out.direction.padEnd(9)} · ${String(r.title).slice(0, 38)} — ${out.reason.slice(0, 70)}`);
    } catch (e) {
        console.error('judge 실패:', r.title, e instanceof Error ? e.message : e);
    }
}
console.log(`\n방향 판정 ${n}편 · 판정 모델 ${judge.model}${sameModel ? ` · 같은 모델 경고 ${sameModel}편(위)` : ''}`);

#!/usr/bin/env node
// CLI.
//   npm run run -- -t "주제" -c "배경"     초고→검증→수정 (기본)
//   npm run run -- --atomic                 원자 명제 파이프라인 (실험 비교용)
//   npm run run:mock                        고정 응답으로 배관만
//   npm run run -- --check                  준비 상태 점검 (legalize · 코퍼스 · pdftotext/pdf.js)
//   npm run run -- --from <runDir>          저장된 원장에서 논문만 다시 조립
//
// human-on-the-loop: 원문을 못 구하면 **멈춘다**. 대화형이면 답을 받을 때까지 진행하지 않고,
// 비대화형이면 exit 3 으로 끝난다. 조용히 넘어가는 경로는 없다.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stdin } from 'node:process';
import { parseArgs } from 'node:util';
import { MissingConfig, modelFor, resolveModels } from './config.ts';
import { complete, setRecorder, type Usage } from './llm.ts';
import { ensureLegalize, legalizeStatus, refreshLegalize, setLegalizeConsent, setLegalizeLocalOnly } from './law/legalize.ts';
import { sourceStatus } from './law/sources.ts';
import { HitlRequired } from './hitl.ts';
import { liveAsker, runPipeline, type Ledger } from './pipeline.ts';
import { composePaper, type PaperScale } from './compose.ts';
import { mockAsker, mockWriter } from './mock.ts';
import { writeOutputs } from './report.ts';
import { assemblePaper, composeManuscript } from './manuscript.ts';
import type { PaperThesis } from './schemas.ts';

const DEFAULT_TOPIC =
    '수사기관이 압수·수색영장에 기재되지 않은 원격지 서버의 전자정보를 영장에 기재된 정보처리장치를 통해 압수할 수 있는가';

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        topic: { type: 'string', short: 't' },
        context: { type: 'string', short: 'c' },
        'context-file': { type: 'string' },
        plan: { type: 'string' },
        scale: { type: 'string', default: 'standard' },
        atomic: { type: 'boolean', default: false },
        mock: { type: 'boolean', default: false },
        issues: { type: 'string', default: '2' },
        claims: { type: 'string', default: '6' },
        'snowball-depth': { type: 'string', default: '2' },
        'snowball-budget': { type: 'string', default: '12' },
        concurrency: { type: 'string', default: '3' },
        out: { type: 'string' },
        check: { type: 'boolean', default: false },
        quiet: { type: 'boolean', short: 'q', default: false },
        answers: { type: 'string' },
        'assume-unavailable': { type: 'boolean', default: false },
        'non-interactive': { type: 'boolean', default: false },
        'no-clarify': { type: 'boolean', default: false },
        // 품질 루프(반대 측 자료·보강 반복·수정본 재검증·인용 대조)를 끈다 — 예전 동작과 비교할 때
        'no-quality': { type: 'boolean', default: false },
        'max-clarify': { type: 'string', default: '6' },
        corpus: { type: 'string' },
        scratch: { type: 'string' },
        paper: { type: 'boolean', default: true },
        from: { type: 'string' },
    },
});

const log = (s: string) => process.stderr.write(`${s}\n`);

if (values.corpus) process.env.LEGAL_AGENT_CORPUS = values.corpus;
if (values.scratch) process.env.LEGAL_AGENT_SCRATCH = values.scratch;

// CLI 는 묻지 않고 받는다 — 받기에 동의한 것으로 둔다. 그래서 7일마다의 자동 갱신과 시행 전 법령의 직전 판본 받기도 연다.
// --mock 은 배관 시험이라 GitHub 에 나가지 않는다 — 갱신·직전 판본 받기는 물론 목록 받기·원문 가져오기도 하지 않고 이 컴퓨터에 있는 것만 쓴다(앱의 시험 실행과 같다).
// 갱신만 막던 때는 목록이 없으면 받고, 원문 캐시에 없는 조문·판례를 GitHub 에서 가져왔다.
// LPS_LEGALIZE_REFRESH=0·NODE_ENV=test·LPS_LEGALIZE_NETWORK=0 도 같다 — 여기서 켜지 않아도 legalize.ts(legalizeLocalOnly)가 env 를 본다.
setLegalizeConsent(!values.mock);
if (values.mock) setLegalizeLocalOnly(true);

// 법령·판례 목록 — 없으면 받는다(git 이 있으면 clone, 없으면 HTTP). bash 를 쓰지 않으므로 윈도우에서도 같다.
let legalizeReady = await ensureLegalize({ onProgress: (m) => log(`[legalize] ${m}`) }).catch((e: unknown) => {
    log(`[legalize] 준비 실패 — ${e instanceof Error ? e.message : String(e)}`);
    return null;
});
// 받은 지 7일이 지났으면 실행 전에 갱신한다(묻지 않는다). 실패해도 실행은 그대로 — 이전 판을 쓰고 진행 줄로 알린다.
// --mock·--from(다시 조립 — 실행이 아니다)·LPS_LEGALIZE_REFRESH=0 이면 하지 않는다.
if (legalizeReady?.ready && !values.mock && !values.from) {
    const r = await refreshLegalize({ onProgress: (m) => log(`[legalize] ${m}`) });
    if (r.refreshed.length) legalizeReady = legalizeStatus();
}

if (values.check) {
    const st = legalizeReady ?? legalizeStatus(); // 준비가 실패해도 이미 있는 것은 그대로 보여 준다
    const src = sourceStatus();
    log('legalize.kr');
    log(`  방식        ${st.mode === 'git' ? 'git 클론' : st.mode === 'http' ? 'HTTP (git 없음)' : '준비 안 됨'} · 클론 ${st.clones}/2`);
    log(`  법령 인덱스 ${st.lawIndex.toLocaleString()}건`);
    log(`  판례 인덱스 ${st.precedentIndex.toLocaleString()}건`);
    log('원문 확보');
    log(`  코퍼스 디렉터리 ${src.corpusDirs.length ? src.corpusDirs.join(', ') : '(없음)'}`);
    log(`  코퍼스 파일     ${src.corpusFiles}건`);
    log(`  pdftotext       ${src.pdftotext ? '사용 가능' : src.pdfjs ? '없음 — pdf.js 로 읽는다' : '없음 — pdf.js 도 없어 PDF 전문 추출 불가(npm install)'}`);
    const legalizeOk = st.ready && st.lawIndex > 0 && st.precedentIndex > 0;
    log(legalizeOk ? '  ✓ 법령·판례 사용 가능' : '  ✗ 자동 준비에 실패했습니다 — 네트워크를 확인하고 `npm run setup:legalize` 를 다시 실행하세요');
    process.exit(legalizeOk ? 0 : 1);
}

const topic = (values.topic ?? positionals.join(' ')).trim() || DEFAULT_TOPIC;
const context = (values['context-file'] ? readFileSync(values['context-file'], 'utf8') : values.context ?? '').trim();
const scale = (['short', 'standard', 'long'].includes(values.scale ?? '') ? values.scale : 'standard') as PaperScale;
let plan: PaperThesis | undefined;
if (values.plan) {
    try {
        plan = JSON.parse(readFileSync(values.plan, 'utf8')) as PaperThesis;
    } catch (e) {
        log(`설계 파일을 읽을 수 없습니다: ${values.plan} — ${e instanceof Error ? e.message : String(e)}`);
        process.exit(2);
    }
}

// 모델 설정이 없으면 위에서 끝난다 — --from(다시 조립)만 설정 없이 지나가고 그 갈래도 끝에서 나간다. 그래서 아래에서는 늘 정해져 있다.
let ask!: ReturnType<typeof liveAsker>;
let write!: (req: { name: string; system: string; user: string; maxTokens?: number }) => Promise<string>;
let modelLabel!: string;
let cfg: ReturnType<typeof resolveModels>['base'] | undefined;
/** 모델 설정이 없을 때의 안내 — --from 으로 옛 원자 원장을 조립하려 할 때 보여 준다 */
let missingConfig: string | undefined;
let modelSet: ReturnType<typeof resolveModels> | undefined;
/** 집필 호출(초고·수정·인용 고침)의 사용량 — composePaper 는 구조화 호출(ask)만 센다. 끝나고 원장에 더한다(앱 runner.ts 와 같이). */
const writeUsage: Usage = { prompt: 0, completion: 0, calls: 0 };
if (values.mock) {
    ask = mockAsker();
    write = mockWriter();
    modelLabel = 'mock (고정 응답)';
} else {
    try {
        modelSet = resolveModels();
        cfg = modelSet.base;
        // 역할·대체 프로파일을 만들지 못한 이유 — CLI 는 알리고 기본 모델로 진행한다(키를 다른 공급자로 보내지는 않는다).
        for (const w of modelSet.warnings) process.stderr.write(`경고: ${w}\n`);
        ask = liveAsker(modelFor(modelSet));
        const pick = modelFor(modelSet);
        write = (req) => complete(pick(req.name === 'revise' ? 'chapter' : req.name), req, writeUsage);
        const roleCount = Object.keys(modelSet.roles).length;
        modelLabel = `${cfg.model} @ ${cfg.baseUrl}${roleCount ? ` · 역할별 ${roleCount}개` : ''}${cfg.fallbacks?.length ? ` · 대체 ${cfg.fallbacks.length}` : ''}`;
    } catch (e) {
        if (e instanceof MissingConfig) {
            // 논문 원장을 다시 조립(--from)하는 데는 모델이 필요 없다 — 그때는 설정이 없어도 진행한다(옛 원자 원장만 모델이 필요하다).
            if (!values.from) {
                log(e.message);
                process.exit(2);
            }
            missingConfig = e.message;
        } else throw e;
    }
}

/** 저장된 원장에서 논문만 다시 조립한다. 파이프라인을 다시 돌리지 않는다. */
if (values.from) {
    const dir = resolve(values.from);
    let ledger: Ledger;
    try {
        ledger = JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8')) as Ledger;
    } catch (e) {
        log(`원장을 읽을 수 없습니다: ${join(dir, 'ledger.json')} — ${e instanceof Error ? e.message : String(e)}`);
        process.exit(2);
    }
    log(`원장: ${join(dir, 'ledger.json')} (${ledger.mode ?? 'atomic'} · 장/쟁점 ${ledger.issues.length}개)`);
    if (!ledger.paper && !cfg) {
        log(`옛 원자 원장은 산문을 다시 써야 해서 모델이 필요합니다. ${missingConfig ?? ''}`.trim());
        process.exit(2);
    }
    try {
        const paper = ledger.paper ? assemblePaper(ledger) : await composeManuscript(ledger, (req) => complete(cfg!, req, ledger.usage));
        const paperPath = join(dir, 'paper.md');
        writeFileSync(paperPath, paper.markdown);
        log(`논문: ${paperPath}  (${paper.markdown.length.toLocaleString()}자)`);
        log(`  장별: ${paper.diagnostics.chapters.map((c) => `${c.id} ${c.chars}`).join(' · ')}`);
        if (paper.diagnostics.flagged) log(`  ⚠ 필자 확인 필요 인용 ${paper.diagnostics.flagged}건`);
    } catch (e) {
        log(`논문 조립 실패: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
        process.exit(1);
    }
    process.exit(0);
}

const started = new Date();
const stamp = started.toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = values.out ?? join(process.cwd(), 'data', 'runs', `${stamp}${values.mock ? '-mock' : ''}`);
mkdirSync(outDir, { recursive: true });
if (!process.env.LEGAL_AGENT_SCRATCH) process.env.LEGAL_AGENT_SCRATCH = join(outDir, 'sources');

const interactive = !values['non-interactive'] && Boolean(stdin.isTTY) && !values.answers && !values['assume-unavailable'];

log(`주제: ${topic}`);
log(`모델: ${modelLabel}`);
log(`방식: ${values.atomic ? '원자 명제 파이프라인' : `초고→검증→수정 (${scale})`}`);
log(`출력: ${outDir}`);
log(
    `사람 개입: ${
        values['assume-unavailable'] ? '자동(모두 없음)' : values.answers ? `답 파일 ${values.answers}` : interactive ? '대화형' : '비대화형 — 답이 필요하면 중단'
    }\n`,
);

const transcriptPath = join(outDir, 'transcript.jsonl');
const writeTr = (rec: unknown) => {
    try {
        appendFileSync(transcriptPath, JSON.stringify({ at: new Date().toISOString(), ...(rec as object) }) + '\n');
    } catch {
        /* 기록 실패가 실행을 죽이지 않는다 */
    }
};
const callsPath = join(outDir, 'calls.jsonl');
const toolsPath = join(outDir, 'tools.jsonl');
setRecorder((r) => {
    try {
        appendFileSync(callsPath, JSON.stringify(r) + '\n');
    } catch {
        /* 기록 실패가 실행을 죽이지 않는다 */
    }
});

const hitl = {
    interactive,
    ...(values.answers ? { answersFile: values.answers } : {}),
    assumeUnavailable: values['assume-unavailable'],
};
const onProgress = (line: string) => {
    writeTr({ type: 'progress', line });
    if (!values.quiet) log(line);
};
const onTool = (e: unknown) => {
    try {
        appendFileSync(toolsPath, JSON.stringify(e) + '\n');
    } catch {
        /* 기록 실패가 실행을 죽이지 않는다 */
    }
};

let ledger: Ledger;
try {
    ledger = values.atomic
        ? await runPipeline(
              {
                  topic,
                  ...(context ? { context } : {}),
                  maxIssues: Number(values.issues),
                  maxClaimsPerIssue: Number(values.claims),
                  concurrency: Number(values.concurrency),
                  maxClarify: values['no-clarify'] ? 0 : Number(values['max-clarify']),
                  hitl,
                  onProgress,
                  onTool,
              },
              ask,
              modelLabel,
          )
        : await composePaper(
              {
                  topic,
                  ...(context ? { context } : {}),
                  ...(plan ? { plan } : {}),
                  scale,
                  concurrency: Number(values.concurrency),
                  snowballDepth: Number(values['snowball-depth']),
                  snowballBudget: Number(values['snowball-budget']),
                  ...(values['no-quality'] ? { quality: { counter: false, fireRounds: 1, reverify: 0, citeCheck: false } } : {}),
                  hitl,
                  onProgress,
                  onTool,
                  onEvent: (e) => writeTr(e),
              },
              ask,
              write,
              modelLabel,
          );
} catch (e) {
    if (e instanceof HitlRequired) {
        log('');
        log(e.message);
        const qPath = join(outDir, 'questions.json');
        const template: Record<string, unknown> = { _comment: 'action: provided | unavailable | answered. note: 파일 경로/URL 또는 답변 내용.' };
        for (const a of e.asks) template[a.id] = { action: '', note: '', _question: a.question };
        writeFileSync(qPath, JSON.stringify(template, null, 2));
        log('');
        log(`질문을 저장했습니다: ${qPath}`);
        log(`채운 뒤: npm run run -- --answers ${qPath}  (모델 호출은 다시 일어납니다)`);
        log(`원장은 저장하지 않았습니다 — 답 없는 원장은 "검토했으나 문제없음"으로 읽힙니다.`);
        process.exit(3);
    }
    log(`\n실패: ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof Error && 'body' in e) log(String((e as any).body).slice(0, 800));
    process.exit(1);
}
// 집필 호출을 빼면 원장·보고서의 호출 수·토큰이 호출 기록보다 ⅓가량 적게 찍혔다(실측: 원장 46회·25만 토큰, calls.jsonl 58회·39만).
ledger.usage = { prompt: ledger.usage.prompt + writeUsage.prompt, completion: ledger.usage.completion + writeUsage.completion, calls: ledger.usage.calls + writeUsage.calls };

writeTr({
    type: 'done',
    summary: {
        runDir: outDir,
        coverage: ledger.coverage,
        humanCount: ledger.human.length,
        verdicts: (() => {
            const v: Record<string, number> = {};
            for (const { items } of ledger.issues) for (const it of items) v[it.judgment.verdict] = (v[it.judgment.verdict] ?? 0) + 1;
            return v;
        })(),
    },
});
if (ledger.human.length) writeTr({ type: 'answer', answers: Object.fromEntries(ledger.human.map((h) => [h.id, h.answer])) });

const paths = writeOutputs(ledger, outDir);

if (values.paper) {
    log('');
    log(ledger.paper ? '논문 조립 (각주·참고문헌·검증 부록)…' : '논문 조립 중 (장별 집필)…');
    try {
        const paper = ledger.paper ? assemblePaper(ledger) : await composeManuscript(ledger, (req) => (values.mock ? mockWriter()({ name: 'chapter', ...req }) : complete(cfg!, req, ledger.usage)));
        const paperPath = join(outDir, 'paper.md');
        writeFileSync(paperPath, paper.markdown);
        log(`논문: ${paperPath}  (${paper.markdown.length.toLocaleString()}자)`);
        log(`  장별: ${paper.diagnostics.chapters.map((c) => `${c.id} ${c.chars}`).join(' · ')}`);
        if (paper.diagnostics.flagged) log(`  ⚠ 필자 확인 필요 인용 ${paper.diagnostics.flagged}건 (부록에 목록)`);
        else log('  ✓ 모든 인용 원문·웹 확인');
    } catch (e) {
        log(`논문 조립 실패: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
        log(`  원장은 저장되었습니다: ${paths.ledger}`);
    }
}

log('');
log('─'.repeat(64));
const c = ledger.coverage;
log(`주장 ${c.claims}개 · 인용 ${c.citations}건 (원문확인 ${c.verified} / 검증불가 ${c.unverifiable} / 차단 ${c.blocking})`);
log(`사람에게 물음 ${ledger.human.length} · 코드 강등 ${c.downgraded}${ledger.paper ? ` · 수정된 장 ${c.revised ?? 0}` : ''}`);
const dist: Record<string, number> = {};
for (const { items } of ledger.issues) for (const it of items) dist[it.judgment.verdict] = (dist[it.judgment.verdict] ?? 0) + 1;
log(`판정: ${Object.entries(dist).map(([k, v]) => `${k} ${v}`).join(' · ') || '(없음)'}`);
log('─'.repeat(64));
log(`report: ${paths.report}`);
log(`ledger: ${paths.ledger}`);
log(`calls:  ${callsPath}`);

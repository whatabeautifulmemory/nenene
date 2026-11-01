// 일곱 단계 파이프라인.
//
//   1) 쟁점 분해    주제 → 실제로 갈리는 법적 질문
//   2) 찬성 논증    원자적 명제 + 권위 + 전제 + 도약
//   3) 원문 확보    사전제공 파일 → legalize → arXiv → OA 사다리. **초록은 근거가 아니다**
//   3.5) 사람에게 묻기 ①  원문을 못 구했으면 멈추고 요구한다
//   4) 반대 논증    명제 + **원문 관련 부분**만 준다. 찬성측 논증은 주지 않는다
//   5) 판정         지지/박약/반박/미결 + 살아남은 반대 + discriminators
//   5.5) 사람에게 묻기 ②  미결이면 사람만 답할 수 있는 것을 되묻고, 답이 오면 재판정
//   6) 코드 강등    원문이 없는데 supported 라면 unresolved 로 내린다 (프롬프트가 아니라 코드)
//   7) 원장
//
// 3.5 가 4) 앞에 있다. 반대측이 초록이나 찬성측 해석을 베끼지 않고 원문에서 시작해야 하기 때문이다.
import { structured, type LlmConfig, type Usage } from './llm.ts';
import {
    CON_PROMPT,
    ISSUE_PROMPT,
    JUDGE_PROMPT,
    PLANNER_PROMPT,
    PRO_PROMPT,
    REVISE_PROMPT,
    SUPPLEMENT_PROMPT,
    WORKER_PROMPT,
    conInput,
    judgeInput,
    plannerInput,
    reviseInput,
    workerInput,
} from './prompts.ts';
import {
    ClaimBatch,
    JudgeBatch,
    IntentList,
    IssueList,
    ObjectionBatch,
    RevisedClaim,
    blockingStates,
    type Authority,
    type CitationCheck,
    type Claim,
    type Judgment,
    type Objection,
} from './schemas.ts';
import { verifyAll } from './law/verify.ts';
import { USABLE_AS_EVIDENCE, acquireSource, loadHumanProvided, recordProvided, type SourceDoc } from './law/sources.ts';
import { relevantPassages, renderPassages, type Passage } from './law/extract.ts';
import { articlesFromCitations, findCandidateArticles, findUncitedArticles, lawsFromCitations, probeTerms, resolveProvision, type ArticleHit } from './law/coverage.ts';
import { searchLiterature, type LitHit } from './law/literature.ts';
import { research } from './law/research.ts';
import { caseKind, citationOf, searchCases, type CaseHit } from './law/cases.ts';
import { rerankCases } from './law/rerank.ts';
import { clarifyAsk, runHitl, sourceAsk, type Answer, type AnsweredAsk, type Ask, type HitlOptions } from './hitl.ts';
import { setToolSink, type ToolEvent } from './trace.ts';

export interface Issue {
    id: string;
    question: string;
    why_contested: string;
    positions: string[];
}

export interface SourceResolution {
    authority: Authority;
    doc: SourceDoc;
    passages: Passage[];
    /** 이 권위를 이 명제의 근거로 쓸 수 있는가 */
    usable: boolean;
    why?: string;
    humanProvided?: boolean;
}

export type EvidenceGrade =
    | 'full_text'
    | 'partial'
    | 'abstract_only'
    | 'metadata_only'
    | 'unavailable'
    | 'fabricated'
    | 'none';

export interface Evidence {
    grade: EvidenceGrade;
    usableCount: number;
    total: number;
    reason: string;
}

export interface Downgrade {
    from: string;
    to: string;
    why: string;
    /**
     * 판정자가 실제로 낸 등급 — from 과 다를 때만 둔다. 판정자 절차 답에 맞춘 조정(compose applyJudgment, 박약→지지)이 from 을 냈다는 뜻이다.
     * 없으면 from 이 판정자의 등급이다. 보고서가 "판정자가 from 을 냈다"고 거짓으로 적지 않게 남긴다.
     */
    judged?: string;
}

export interface WithdrawnClaim {
    claim: Claim;
    /** 보정 전 명제 */
    originalProposition: string;
    changes: string[];
    why: string;
}

export interface LedgerItem {
    claim: Claim;
    /** 원문을 보기 전에 쓴 명제. 보정이 없었으면 생략. */
    original?: Claim;
    /** 원문에 비추어 무엇을 왜 고쳤는가 */
    changes?: string[];
    citations: CitationCheck[];
    sources: SourceResolution[];
    evidence: Evidence;
    objection: Objection;
    judgment: Judgment;
    /** 코드가 강제한 강등 — 판정을 고치는 것이 아니라 내리는 것이고, 왜인지 남긴다 */
    downgrade?: Downgrade;
    /** 이 명제에 대해 사람이 답한 것 */
    human: { question: string; answer: Answer }[];
}

export interface Ledger {
    topic: string;
    model: string;
    /** 'paper' = 초고→검증→수정 (compose.ts). 'atomic' = 원자 명제 파이프라인 (이 파일). */
    mode?: 'paper' | 'atomic';
    /** 새 파이프라인의 논문 설계·본문·인용 상태표. issues[] 는 장(section)에 대응한다. */
    paper?: import('./compose.ts').PaperPlan;
    startedAt: string;
    finishedAt?: string;
    issues: { issue: Issue; items: LedgerItem[]; withdrawn: WithdrawnClaim[] }[];
    /** 조사 기록 — 이 논문이 무엇을 보고 썼는지. 원장에 남겨야 논문과 대조할 수 있다. */
    dossier?: {
        topic: string;
        queries: string[];
        findings: { kind: string; citation: string; summary: string; quote?: string; url?: string }[];
    };
    /** 실행에 주어진 배경 — 원장에 남겨 논문 조립과 재현이 같은 배경을 보게 한다. */
    context?: string;
    usage: Usage;
    human: AnsweredAsk[];
    sourceStats: Record<string, number>;
    coverage: {
        claims: number;
        citations: number;
        verified: number;
        blocking: number;
        unverifiable: number;
        fullText: number;
        notFullText: number;
        downgraded: number;
        revised: number;
        withdrawn: number;
    };
}

export interface RunOptions {
    topic: string;
    /**
     * 주제와 함께 주는 배경. 왜 이 글을 쓰는지, 어떤 사안·판례·자료를 염두에 두는지,
     * 무엇을 주장하고 싶은지.
     *
     * 주제 한 줄만으로는 쟁점 분해가 일반론으로 흐른다 — 실제로 CI 실행에서 "헌법적 문제점"이
     * 개인정보법 쟁점으로 미끄러진 것이 그 예다. 맥락은 그걸 잡아 주는 값싼 장치다.
     */
    context?: string;
    maxIssues: number;
    maxClaimsPerIssue: number;
    concurrency: number;
    /** 미결 항목에 대해 되물을 최대 개수. 0 이면 되묻지 않는다. */
    maxClarify: number;
    hitl: HitlOptions;
    onProgress?: (msg: string) => void;
    /** 코드가 한 일(원문 확보·검증·누락 탐지)을 받는다. */
    onTool?: (e: ToolEvent) => void;
    /** 판정 후 재검증(추가 수집 → 재판정) 횟수 상한. FIRE 의 confidence 루프에 해당한다. */
    maxRecheck?: number;
}

export class Limiter {
    private active = 0;
    private queue: (() => void)[] = [];
    constructor(private readonly max: number) {}
    async run<T>(fn: () => Promise<T>): Promise<T> {
        if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
        this.active++;
        try {
            return await fn();
        } finally {
            this.active--;
            this.queue.shift()?.();
        }
    }
}

export type Asker = <T>(
    schema: any,
    req: { name: string; description: string; system: string; user: string },
    usage: Usage,
) => Promise<T>;

/**
 * 단계별로 다른 프로파일을 쓴다. `modelFor` 가 이름을 보고 고른다.
 * 기록(recorder)은 llm.ts 에 있고, 여기서는 어느 프로파일이 선택됐는지만 정한다.
 * signal 은 실행의 것 — 넘기지 않으면 「중단」 뒤에도 가고 있던 구조화 호출이 끝까지 돌고 다음 호출도 나간다(앱 실행이 그랬다).
 */
export function liveAsker(cfg: LlmConfig | ((name: string) => LlmConfig), signal?: AbortSignal): Asker {
    const pick = typeof cfg === 'function' ? cfg : () => cfg;
    return <T>(schema: any, req: any, usage: Usage) =>
        structured(
            pick(req.name),
            { schema, name: req.name, description: req.description, system: req.system, user: req.user },
            signal,
            usage,
        ) as Promise<T>;
}

export const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const sha = (s: string) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h).toString(36).slice(0, 8);
};

/** 원문을 근거로 쓸 수 있는지. 법령·판례는 원문 자체가 근거이고, 논문은 관련 대목이 있어야 한다. */
export function resolutionFor(authority: Authority, doc: SourceDoc, claim: Claim): SourceResolution {
    const base = { authority, doc };
    if (authority.type === 'statute' || authority.type === 'precedent') {
        const usable = doc.state === 'full_text' || doc.state === 'provided';
        return { ...base, passages: [], usable, ...(usable ? {} : { why: `원문 확보 실패 (${doc.state})` }) };
    }
    if (!USABLE_AS_EVIDENCE.has(doc.state)) {
        return { ...base, passages: [], usable: false, why: `원문 미확보 (${doc.state})` };
    }
    const ex = relevantPassages(doc.fullText ?? '', {
        proposition: claim.proposition,
        ...(authority.holding ? { holding: authority.holding } : {}),
        citation: authority.citation,
    });
    if (!ex.passages.length) {
        // 원문은 읽었는데 이 명제를 다루는 대목이 없다. 초록만 있는 것과 다른 상태이지만,
        // 근거로 쓸 수 없다는 점은 같다 — "안 읽은 것"이 아니라 "관계없는 것"이다.
        return { ...base, passages: [], usable: false, why: '원문은 확보했으나 명제와 관련된 대목이 없음' };
    }
    return { ...base, passages: ex.passages, usable: true, ...(doc.state === 'provided' ? { humanProvided: true } : {}) };
}

export function gradeEvidence(sources: SourceResolution[], citations: CitationCheck[]): Evidence {
    const usableCount = sources.filter((s) => s.usable).length;
    const total = sources.length;
    const states = sources.map((s) => s.doc.state);
    const anyFabricated = citations.some((c) => c.state === 'not_found') || states.includes('not_found');
    const anyAbstract = states.includes('abstract_only');
    const anyDeclined = states.includes('user_declined');

    // 조사 자료(웹 발췌)는 "읽을 수 있는 것"이지 전문이 아니다. 그것만으로 선 명제는 partial 이다 —
    // full_text 로 두면 뉴스 한 토막 위의 supported 가 그대로 선다.
    const snippetOnly = total > 0 && sources.every((s) => !s.usable || s.doc.how === 'research');
    if (total > 0 && usableCount === total && snippetOnly) return { grade: 'partial', usableCount, total, reason: '공개자료 발췌에만 의존 — 전문이 아니다' };
    // 필자가 원문 대신 내용을 적어 준 것은 진술이지 원문이 아니다 — 그것에 기댄 명제는 partial 이다.
    if (total > 0 && usableCount === total && sources.some((s) => s.usable && (s.doc.how ?? '').startsWith('human-summary')))
        return { grade: 'partial', usableCount, total, reason: '필자 답변(원문 아님)에 기댐' };
    if (total > 0 && usableCount === total) return { grade: 'full_text', usableCount, total, reason: '모든 인용의 원문 확보' };
    if (usableCount > 0) return { grade: 'partial', usableCount, total, reason: `${total}건 중 ${usableCount}건만 원문 확보` };
    if (anyFabricated) return { grade: 'fabricated', usableCount, total, reason: '인용한 판례·논문이 원문에서 확인되지 않음' };
    if (anyAbstract) return { grade: 'abstract_only', usableCount, total, reason: '초록만 확보 — 초록으로는 판단하지 않는다' };
    if (anyDeclined) return { grade: 'unavailable', usableCount, total, reason: '원문을 제공받지 못함 (사용자가 없음으로 확인)' };
    if (!total) return { grade: 'none', usableCount, total, reason: '인용 없음' };
    return { grade: 'metadata_only', usableCount, total, reason: '서지만 확인, 본문 미확보' };
}

/**
 * 프롬프트가 아니라 코드가 강제하는 강등.
 *
 * 모델은 원문을 읽지 않고도 supported 를 쓸 수 있다. 그걸 막는 것은 지시문이 아니라 이 함수다 —
 * 기존 구현 가 "게이트는 코드로 실행된다"고 한 것과 같은 이유다. 그리고 판정을 **고치지 않고
 * 내린다**: 왜 내렸는지를 함께 남기므로 조작이 아니라 규율이다.
 */
export function enforceEvidence(judgment: Judgment, evidence: Evidence, citations: CitationCheck[]): Downgrade | undefined {
    if (judgment.verdict !== 'supported') return undefined;
    const blocking = citations.filter((c) => blockingStates.has(c.state));
    if (evidence.grade === 'full_text' && !blocking.length) return undefined;

    const why =
        evidence.grade !== 'full_text' && evidence.grade !== 'partial'
            ? evidence.reason
            : blocking.length
              ? `인용 ${blocking.length}건이 원문에서 확인되지 않아 근거의 일부가 무효 (${blocking.map((b) => b.citation).join(', ')})`
              : evidence.reason;
    const to = evidence.usableCount > 0 ? 'weak' : 'unresolved';
    return { from: judgment.verdict, to, why };
}

export async function runPipeline(opts: RunOptions, ask: Asker, modelLabel: string): Promise<Ledger> {
    const usage: Usage = { prompt: 0, completion: 0, calls: 0 };
    const say = opts.onProgress ?? (() => {});
    setToolSink(opts.onTool ?? null);
    const limiter = new Limiter(opts.concurrency);
    // 재검증 예산. 명제마다 무한히 찾으면 비용이 통제되지 않는다 — FIRE 도 확신이 설 때까지만 돈다.
    const recheck = { left: opts.maxRecheck ?? 4 };
    const human: AnsweredAsk[] = [];
    const ledger: Ledger = {
        topic: opts.topic,
        ...(opts.context?.trim() ? { context: opts.context.trim() } : {}),
        model: modelLabel,
        mode: 'atomic',
        startedAt: new Date().toISOString(),
        issues: [],
        usage,
        human,
        sourceStats: {},
        coverage: {
            claims: 0,
            citations: 0,
            verified: 0,
            blocking: 0,
            unverifiable: 0,
            fullText: 0,
            notFullText: 0,
            downgraded: 0,
            revised: 0,
            withdrawn: 0,
        },
    };

    // ── 0.5) 조사 ───────────────────────────────────────────────────────────────
    //
    // 이 단계가 없으면 뒤의 모든 단계가 **모델의 기억**을 재료로 삼는다. 실제로 그랬다:
    // 웹 검색 호출 0건, 맥락의 URL 은 프롬프트에 붙여넣기만, 문헌 탐색은 0건.
    say('0.5/7 조사 (단서 URL · 백과 · 서지)');
    const dossier = await research(opts.topic, opts.context ?? '', {
        ...(process.env.LEGAL_AGENT_SCRATCH ? { scratch: process.env.LEGAL_AGENT_SCRATCH } : {}),
        ask: (schema, o) => ask<any>(schema as never, o as never, usage),
    });
    if (dossier.findings.length) {
        const byKind = (k: string) => dossier.findings.filter((f) => f.kind === k).length;
        say(
            `    발견 ${dossier.findings.length}건 (웹 ${byKind('news')} · 백과 ${byKind('fact')} · 문헌 ${byKind('doctrine')})`,
        );
        for (const f of dossier.findings.slice(0, 5)) say(`      · ${truncate(f.citation, 60)}`);
    } else {
        say('    조사에서 아무것도 얻지 못했습니다 — 이후 단계는 모델의 기억에 의존합니다.');
    }

    // ── 1) 쟁점 분해 ────────────────────────────────────────────────────────────
    say('1/7 쟁점 분해');
    const issueList = await ask<{ issues: Issue[] }>(IssueList, {
        name: 'issues',
        description: '주제를 다투어지는 법적 쟁점 목록으로 분해한다',
        system: ISSUE_PROMPT,
        user: [
            `## 주제\n${opts.topic}`,
            ...(opts.context?.trim() ? ['', `## 배경·맥락 (필자 제공)\n${opts.context.trim()}`] : []),
        ...(dossier.findings.length
            ? [
                  '',
                  '## 조사로 확인된 것 (출처 있는 것만. 이것을 우선 반영한다)',
                  ...dossier.findings.slice(0, 12).map((f) => `- [${f.kind}] ${f.summary}${f.url ? ` <${f.url}>` : ''}`),
              ]
            : []),
            '',
            '이 주제에서 실제로 다투어지는 법적 쟁점을 분해한다.',
            ...(opts.context?.trim()
                ? ['배경에 나온 사안·자료·관심사가 있으면 그것을 쟁점의 출발점으로 삼는다. 배경을 무시하고 일반론으로 가지 않는다.']
                : []),
        ].join('\n'),
    }, usage);
    const issues = issueList.issues.slice(0, opts.maxIssues);
    say(`    → 쟁점 ${issues.length}개`);

    // ── 1.5) 학설 탐색 ──────────────────────────────────────────────────────────
    //
    // 7개 주제 실행에서 인용 131건이 전부 조문이었다. 학설 0, 판례 0. 문헌을 **찾는 단계가
    // 없었기** 때문이다 — acquireSource 는 모델이 인용했을 때만 반응한다. 여기서 먼저 찾고,
    // 열린 원문을 프로젝트 스크래치패드에 내려받아 워커에게 쥐여 준다.
    say('1.5/7 학설 탐색 (열린 원문 내려받기)');
    const library: LitHit[] = [];
    for (const issue of issues) {
        const hits = await searchLiterature(issue.question, { limit: 2, ...(process.env.LEGAL_AGENT_SCRATCH ? { scratch: process.env.LEGAL_AGENT_SCRATCH } : {}) });
        for (const h of hits) if (!library.some((x) => x.title === h.title)) library.push(h);
        say(`    [${issue.id}] 문헌 ${hits.length}건 (전문 ${hits.filter((h) => h.hasFullText).length}건)`);
    }
    if (library.length) {
        for (const l of library.slice(0, 6)) say(`      ${l.hasFullText ? '전문' : '메타'} · ${truncate(l.citation, 70)}`);
    } else {
        say('    열린 원문을 찾지 못했습니다 — 조문 중심으로 진행합니다.');
    }

    // ── 2) 논증 설계 (planner) ──────────────────────────────────────────────────
    //
    // 예전에는 찬성측이 "명제를 만들고 + 권위를 고르고 + 그 권위의 취지를 쓴다"를 한 번에 했다.
    // 그래서 기억으로 조문을 귀속시켰고, 실제 실행에서 10개 명제 전부가 귀속 오류였다
    // (제215조 제1항을 근거로 댔는데 그 항은 삭제되어 있었다).
    //
    // ScopeWeaver 의 planner/worker 분리를 옮겼다: planner 는 **방향만** 정하고 인용하지 않는다.
    // 근거는 워커가 **원문을 쥐고** 붙인다. 워커는 원문 없이는 아무것도 쓸 수 없다.
    say('2/7 논증 설계 (planner)');
    const plan: { issue: Issue; claim: Claim }[] = [];
    for (const issue of issues) {
        let intents: { id: string; question: string; kind: string; laws: string[]; provisions?: string[]; needs: string }[] = [];
        try {
            const out = await ask<{ intents: any[] }>(IntentList, {
                name: 'intents',
                description: '쟁점에서 확립해야 할 것들을 논증 의도로 나눈다 (인용하지 않는다)',
                system: PLANNER_PROMPT,
                user: [
                    ...(opts.context?.trim() ? [`## 배경·맥락 (필자 제공)\n${opts.context.trim()}`, ''] : []),
                    plannerInput(issue),
                ].join('\n'),
            }, usage);
            intents = out.intents.slice(0, opts.maxClaimsPerIssue);
        } catch (e) {
            say(`    planner 실패 — 단일 호출로 대체: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
        }
        say(`    [${issue.id}] 의도 ${intents.length}개`);

        if (!intents.length) {
            // planner 가 비었으면 예전 경로로 떨어진다. 실행을 통째로 잃는 것보다 낫다.
            const claims = await ask<{ claims: Claim[] }>(ClaimBatch, {
                name: 'claims',
                description: '쟁점에 대한 찬성 논증을 원자적 명제의 사슬로 구성한다',
                system: PRO_PROMPT,
                user: [plannerInput(issue), '', '찬성 논증을 원자적 명제로 구성한다.'].join('\n'),
            }, usage);
            claims.claims.slice(0, opts.maxClaimsPerIssue).forEach((c, i) => plan.push({ issue, claim: { ...c, id: `${issue.id}-C${i + 1}` } }));
            continue;
        }

        // ── 2.5) 근거 수집 (worker) ─────────────────────────────────────────────
        // 각 워커는 의도 하나를 잡고, 관련 조문의 **실제 원문**을 쥔 채 명제를 만든다.
        say(`2.5/7 근거 수집 (worker) — ${issue.id}`);
        let seq = 0;
        await Promise.all(
            intents.map((intent) =>
                limiter.run(async () => {
                    const terms = probeTerms(`${issue.question} ${intent.question}`, [intent.question]);
                    // planner 가 지목한 조문을 먼저 원문으로 바꾼다. 이게 워커가 원문을 쥐는
                    // 주된 경로다 — 용어 매칭은 법령 어휘와 쟁점 어휘가 다르면 아무것도 못 찾는다
                    // (실제로 "촬영"으로 형사소송법을 훑어 0건이 나왔다).
                    const picked = (intent.provisions ?? []).map(resolveProvision);
                    const candidates = picked.filter((x): x is ArticleHit => 'articleNo' in x);
                    const missing = picked.filter((x): x is { missing: string } => 'missing' in x).map((x) => x.missing);
                    if (!candidates.length) {
                        const laws = intent.laws?.length ? intent.laws : ['대한민국헌법'];
                        candidates.push(...findCandidateArticles({ laws, terms, perLaw: 3 }));
                    }
                    // 이 의도와 어휘가 겹치는 조사 결과만 준다. 전부 주면 무관한 사실이
                    // 명제에 섞인다.
                    const itterms = probeTerms(`${issue.question} ${intent.question}`, [intent.question]);
                    const relevantFacts = dossier.findings
                        .filter((f) => {
                            const hay = `${f.citation} ${f.quote ?? f.summary}`.toLowerCase();
                            return itterms.filter((t) => hay.includes(t.toLowerCase())).length >= 1;
                        })
                        .slice(0, 4)
                        .map((f) => ({ citation: f.citation, quote: f.quote ?? f.summary, ...(f.url ? { url: f.url } : {}) }));
                    let claim: Claim | null = null;
                    try {
                        const out = await ask<{ claims: Claim[] }>(ClaimBatch, {
                            name: 'claims',
                            description: '의도 하나를, 주어진 조문 원문만으로 원자적 명제 하나로 만든다',
                            system: WORKER_PROMPT,
                            user: [
                                ...(missing.length ? [`## 확인했으나 없는 조문\n${missing.map((m) => `- ${m}`).join('\n')}\n`, ''] : []),
                                workerInput(intent, candidates, library, [], relevantFacts),
                            ].join('\n'),
                        }, usage);
                        claim = out.claims[0] ?? null;
                    } catch (e) {
                        say(`    워커 실패 — ${intent.question.slice(0, 40)}: ${e instanceof Error ? e.message.slice(0, 60) : String(e)}`);
                    }
                    if (!claim) return;
                    const id = `${issue.id}-C${++seq}`;
                    plan.push({ issue, claim: { ...claim, id } });
                    say(`    ${id} 명제 · 후보 조문 ${candidates.length}개 중 인용 ${claim.authority.length}건`);
                }),
            ),
        );
    }

    // ── 3) 원문 확보 (모델 호출 없음) ───────────────────────────────────────────
    say('3/7 원문 확보');
    const authorities = new Map<string, Authority>();
    for (const { claim } of plan) for (const a of claim.authority) authorities.set(a.citation, a);
    say(`    인용 ${authorities.size}건 · 사다리 가동`);

    const docCache = new Map<string, SourceDoc>();
    await Promise.all(
        [...authorities.values()].map((a) =>
            limiter.run(async () => {
                const doc = await acquireSource(a);
                docCache.set(a.citation, doc);
                ledger.sourceStats[doc.state] = (ledger.sourceStats[doc.state] ?? 0) + 1;
                say(`      ${doc.state.padEnd(15)} ${truncate(a.citation, 64)}`);
            }),
        ),
    );

    // ── 3.5) 사람에게 묻기 ①: 원문이 없다 ──────────────────────────────────────
    const sourceAsks: Ask[] = [];
    const idByCitation = new Map<string, string>();
    for (const a of authorities.values()) {
        const doc = docCache.get(a.citation)!;
        if (USABLE_AS_EVIDENCE.has(doc.state)) continue;
        const id = `src-${sha(a.citation)}`;
        idByCitation.set(a.citation, id);
        sourceAsks.push(
            sourceAsk({
                id,
                citation: a.citation,
                state: doc.state,
                attempts: doc.attempts ?? [doc.how],
                ...(doc.abstractText ? { abstractText: doc.abstractText } : {}),
                ...(doc.url ? { url: doc.url } : {}),
                ...(doc.error ? { note: doc.error } : {}),
            }),
        );
    }
    if (sourceAsks.length) {
        say(`3.5/7 사람에게 묻기 ① — 원문 미확보 ${sourceAsks.length}건`);
        const answered = await runHitl(sourceAsks, opts.hitl);
        human.push(...answered);
        for (const ans of answered) {
            const citation = [...idByCitation.entries()].find(([, id]) => id === ans.id)?.[0];
            if (!citation) continue;
            const doc = docCache.get(citation)!;
            if (ans.answer.action === 'provided' && ans.answer.note) {
                const got = await loadHumanProvided(ans.answer.note, { type: authorities.get(citation)?.type });
                if ('error' in got) {
                    docCache.set(citation, { ...doc, state: 'error', error: `제공된 자료를 읽지 못함: ${got.error}`, how: 'human' });
                    say(`      제공 실패 — ${got.error}`);
                } else {
                    docCache.set(citation, { state: 'provided', how: 'human', url: got.source, fullText: got.text, chars: got.text.length });
                    // 다음 실행에서 같은 것을 다시 묻지 않도록 기록한다.
                    recordProvided(citation, got.source); // 임시 폴더가 아니라 보관본 경로
                    say(`      제공받음 ${got.text.length.toLocaleString()}자 — ${truncate(citation, 50)}`);
                }
            } else if (ans.answer.action === 'answered' && ans.answer.note) {
                // 사람이 내용을 요약해 준 경우. 원문은 아니지만 사람이 보증한 진술이므로 쓴다.
                docCache.set(citation, { state: 'provided', how: 'human-summary', fullText: ans.answer.note, chars: ans.answer.note.length });
                say(`      사람 요약 제공 — ${truncate(citation, 50)}`);
            } else {
                docCache.set(citation, { ...doc, state: 'user_declined' });
            }
        }
    }

    // ── 3.6) 누락 보충 — 인용하지 않은 조문을 찾아 명제를 보탠다 ──────────────────
    //
    // 보정(3.7)은 인용을 뺄 수만 있으므로, 애초에 떠올리지 못한 조문은 영원히 등장하지 않는다.
    // CI 주제 실행에서 모델은 연계정보를 정의하는 제23조의5를 인용하지 않은 채 판정까지 갔다.
    // 여기서는 문자열 대조로 그런 조문을 찾아내고, 모델에게 **원문을 주고** 명제를 만들게 한다.
    say('3.6/7 누락 탐지');
    {
        const allCitations = [...authorities.keys()];
        const citedLaws = lawsFromCitations(allCitations);
        // 헌법적 검토를 표방한 주제라면 헌법 조문도 스캔 대상이다. 인용된 법률만 훑으면
        // 기본권 조항은 후보에도 오르지 않는다 — 실제로 첫 실행이 그렇게 헌법 없이 끝났다.
        if (issues.some((i) => /헌법|기본권|위헌/.test(i.question + i.why_contested))) {
            for (const n of ['대한민국헌법']) if (!citedLaws.some((l) => l.includes(n))) citedLaws.push(n);
        }
        const claimedArticles = articlesFromCitations(allCitations);
        const terms = probeTerms(issues.map((i) => i.question).join(' '), plan.map((p) => p.claim.proposition));
        const hits = findUncitedArticles({ citedLaws, terms, claimedArticles });
        if (!hits.length) {
            say('    인용하지 않은 관련 조문 없음');
        } else {
            say(`    후보 ${hits.length}건 — ${hits.map((h) => `${h.law} ${h.articleNo}`).join(', ')}`);
            const material = hits
                .map((h) => `### ${h.law} ${h.articleNo} (${h.heading})\n${h.excerpt}`)
                .join('\n\n');
            try {
                const sup = await ask<{ claims: Claim[] }>(ClaimBatch, {
                    name: 'supplement',
                    description: '인용되지 않은 조문들의 원문을 읽고, 쟁점에 관한 명제를 보탠다',
                    system: SUPPLEMENT_PROMPT,
                    user: [
                        `## 쟁점\n${issues.map((i) => i.question).join('\n')}`,
                        '',
                        '## 아직 인용되지 않은 조문과 그 원문',
                        material,
                        '',
                        '이 조문들이 쟁점에 관해 규정하는 바를 명제로 만든다.',
                    ].join('\n'),
                }, usage);
                let added = 0;
                for (const c of sup.claims.slice(0, 6)) {
                    const target = plan.find((p) => p.claim.authority.some((a) => c.authority[0] && lawsFromCitations([a.citation])[0] === lawsFromCitations([c.authority[0]!.citation])[0]))?.issue ?? issues[0]!;
                    const claim: Claim = { ...c, id: `${target.id}-S${++added}` };
                    for (const a of claim.authority) {
                        if (docCache.has(a.citation)) continue;
                        const doc = await acquireSource(a);
                        docCache.set(a.citation, doc);
                        ledger.sourceStats[doc.state] = (ledger.sourceStats[doc.state] ?? 0) + 1;
                    }
                    plan.push({ issue: target, claim });
                }
                say(`    보충 명제 ${added}건 추가`);
            } catch (e) {
                say(`    보충 실패: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`);
            }
        }
    }

    // ── 3.7) 명제 보정 — 원문을 본 뒤 찬성측이 자기 명제를 고친다 ────────────────
    //
    // 이 단계가 없으면 비대칭이 거꾸로 된다. 찬성측은 기억으로 쓰고, 반대측과 판정자는 원문을
    // 읽는다. 첫 실행에서 그 결과가 5/5 refuted 였고, 원인은 판정이 아니라 **찬성측이 원문을
    // 본 적이 없다는 것**이었다 (제215조 제1항을 근거로 댔는데 그 항은 삭제되어 있었다).
    // 반대측이 공격하기 전에 원문을 보여주고 고칠 기회를 준다. 인용은 뺄 수만 있고 더할 수 없다.
    say('3.7/7 명제 보정 (원문 대조)');
    const revisedPlan: { issue: Issue; claim: Claim; original?: Claim; changes?: string[] }[] = [];
    const withdrawnByIssue = new Map<string, WithdrawnClaim[]>();
    await Promise.all(
        plan.map(({ issue, claim }) =>
            limiter.run(async () => {
                const sources = claim.authority.map((a) => resolutionFor(a, docCache.get(a.citation)!, claim));
                const pack = sources
                    .map((s) =>
                        s.usable
                            ? `### ${s.authority.citation}\n${s.doc.fullText?.slice(0, 6000) ?? renderPassages(s.passages, 3500)}`
                            : `### ${s.authority.citation} — 원문 미확보. 이것을 근거로 쓰지 말 것.`,
                    )
                    .join('\n\n');
                let rev: any;
                try {
                    rev = await ask<any>(RevisedClaim, {
                        name: 'revision',
                        description: '원문에 비추어 자기 명제를 고치고, 지지되지 않는 인용을 뺀다',
                        system: REVISE_PROMPT,
                        user: reviseInput(claim, pack),
                    }, usage);
                } catch {
                    revisedPlan.push({ issue, claim });
                    return;
                }
                const keep = new Set(rev.keep_authorities ?? []);
                const kept = claim.authority.filter((a) => keep.has(a.citation));
                const changes: string[] = rev.changes ?? [];
                if (rev.withdraw || kept.length === 0) {
                    const list = withdrawnByIssue.get(issue.id) ?? [];
                    list.push({
                        claim,
                        originalProposition: claim.proposition,
                        changes,
                        why: rev.withdraw ? '원문이 명제를 지지하지 않아 찬성측이 철회' : '남은 인용이 없어 철회',
                    });
                    withdrawnByIssue.set(issue.id, list);
                    say(`    ${claim.id.padEnd(10)} 철회 — ${truncate(rev.withdraw ? '원문 미지지' : '인용 전부 제거', 40)}`);
                    return;
                }
                const corrected: Claim = {
                    ...claim,
                    proposition: rev.proposition,
                    premise: rev.premise,
                    step: rev.step,
                    authority: kept,
                };
                // **실제로 달라졌을 때만** 보정으로 센다.
                //
                // 처음에는 changes 배열이 비어 있지 않으면 보정으로 셌는데, 보정 모델이
                // "귀속 오류 없음: …" 이라고 확인만 하고 돌려주는 경우에도 배열이 채워져
                // 10개 명제가 전부 "보정됨"으로 집계됐다. 확인과 수정은 다르다.
                const changed =
                    corrected.proposition.trim() !== claim.proposition.trim() ||
                    corrected.premise.trim() !== claim.premise.trim() ||
                    corrected.step.trim() !== claim.step.trim() ||
                    kept.length !== claim.authority.length;
                revisedPlan.push({
                    issue,
                    claim: corrected,
                    ...(changed ? { original: claim, changes } : {}),
                });
                if (changed) say(`    ${claim.id.padEnd(10)} 보정 — ${truncate(changes[0] ?? '문언·귀속 수정', 64)}`);
            }),
        ),
    );
    // 병렬 완료 순서가 아니라 원래 순서로 되돌린다.
    const order = new Map(plan.map((p, i) => [p.claim.id, i]));
    revisedPlan.sort((a, b) => (order.get(a.claim.id) ?? 0) - (order.get(b.claim.id) ?? 0));
    say(`    보정 ${revisedPlan.filter((p) => p.original).length}건 · 철회 ${[...withdrawnByIssue.values()].flat().length}건`);

    // ── 3.8) 추가 조사 — 근거가 없는 명제를 위해 **다시 찾으러 간다** ──────────────
    //
    // 조사는 처음 한 번으로 끝나지 않는다. 3.7 까지 와서도 학설·판례가 하나도 없는 명제는
    // 판정에서 weak 로 떨어질 수밖에 없다. 그때 "근거가 없다"고 적고 끝내는 대신, 그 명제가
    // 필요로 하는 것을 **질의로 만들어** 다시 찾는다. 찾은 것은 그 자리에서 권위가 되고,
    // 판정자는 그것을 보고 판단한다.
    //
    // 비용 때문에 상한을 둔다: 실행당 최대 3건, 각 1회.
    const needsDoctrine = revisedPlan.filter(
        ({ claim }) => !claim.authority.some((a) => a.type === 'scholarship' || a.type === 'precedent' || a.type === 'practice'),
    );
    if (needsDoctrine.length) {
        const targets = needsDoctrine.slice(0, 3);
        say(`3.8/7 추가 조사 — 학설·판례가 없는 명제 ${needsDoctrine.length}건 중 ${targets.length}건`);
        await Promise.all(
            targets.map(({ claim }) =>
                limiter.run(async () => {
                    const q = `${claim.proposition} ${claim.premise}`.slice(0, 220);
                    const d = await research(q, '', {
                        ...(process.env.LEGAL_AGENT_SCRATCH ? { scratch: process.env.LEGAL_AGENT_SCRATCH } : {}),
                        ask: (schema, o) => ask<any>(schema as never, o as never, usage),
                    });
                    // 관련성 필터. 이게 없으면 "법인" 같은 일반 개념 문서가 그 명제의 근거로
                    // 붙는다 — 근거가 없는 것보다 나쁘다. 문헌(서지)은 받고, 백과·사실 자료는
                    // 제목이 명제 안에 실제로 등장할 때만 받는다.
                    const hay = `${claim.proposition} ${claim.premise} ${q}`;
                    const useful = d.findings
                        .filter((f) => f.quote && f.kind !== 'statute')
                        .filter((f) => {
                            if (f.kind === 'doctrine') return true;
                            const m = f.citation.match(/[「『]([^」』]+)[」』]/);
                            const title = m?.[1] ?? '';
                            return title.length >= 4 && hay.includes(title);
                        })
                        .slice(0, 2);
                    if (!useful.length) {
                        say(`    ${claim.id.padEnd(10)} 추가 조사 — 찾지 못함`);
                        return;
                    }
                    for (const f of useful) {
                        if (claim.authority.some((a) => a.citation === f.citation)) continue;
                        claim.authority.push({
                            type: f.kind === 'doctrine' ? 'scholarship' : 'practice',
                            citation: f.citation,
                            holding: f.summary.slice(0, 200),
                        });
                        // 찾은 것 자체가 원문이다 — 네트워크로 다시 가져올 필요가 없다.
                        docCache.set(f.citation, {
                            state: 'provided',
                            how: 'research',
                            ...(f.url ? { url: f.url } : {}),
                            fullText: `${f.summary}\n\n"${f.quote}"${f.url ? `\n\n출처: ${f.url}` : ''}`,
                            chars: (f.quote ?? '').length,
                        });
                    }
                    say(`    ${claim.id.padEnd(10)} 추가 조사 — ${useful.length}건 확보 (${truncate(useful[0]!.citation, 48)})`);
                }),
            ),
        );
    }

    // ── 2.7) 판례 부착 — **명제마다** 검색한다 ─────────────────────────────────
    //
    // 쟁점 문장으로 검색하면 실패한다. 쟁점은 "보호조치 개념의 적정성"처럼 추상적이고, 판례
    // 색인에는 그런 문장이 없다. 반면 워커가 만든 명제는 "정보통신망법 제48조 제1항의
    // 보호조치는 …"처럼 구체적이고 검색어가 실제로 들어 있다. 그래서 검색을 워커 뒤로 옮겼다.
    //
    // 넓게 뽑고(20) 리랭커가 좁게 고른다. 규칙 점수만으로 자르면 행정법 판례가 섞인다.
    say('3.8/7 판례 부착 (명제별 검색 · 리랭크)');
    let caseAttached = 0;
    await Promise.all(
        plan.slice(0, 6).map(({ claim }) =>
            limiter.run(async () => {
                if (claim.authority.some((a) => a.type === 'precedent')) return;
                const query = `${claim.proposition} ${claim.premise}`.slice(0, 300);
                // 명제의 도메인을 정한다. 형사 명제에는 형사 사건만 붙인다.
                const isCrim = claim.authority.some(
                    (a) => a.type === 'statute' && /형법|정보통신망|폭력행위|성폭력|마약|특정경제|특정범죄/.test(a.citation),
                );
                const cands = searchCases(query, { limit: 20 }).filter((c) => {
                    const k = caseKind(c.caseNo);
                    return !isCrim || k === 'criminal' || k === 'other';
                });
                if (!cands.length) return;
                const picked = await rerankCases(claim.proposition, cands, (schema, o) => ask<any>(schema as never, o as never, usage));
                if (!picked.length) return;
                for (const h of picked.slice(0, 2)) {
                    const auth: Authority = { type: 'precedent', citation: citationOf(h), holding: h.summary.slice(0, 200) };
                    claim.authority.push(auth);
                    // 원문을 **여기서** 가져와 캐시에 넣는다. 이게 없으면 이후 단계가
                    // docCache 에서 undefined 를 꺼내 판례를 조용히 버린다(실제로 그랬다).
                    const doc = await acquireSource(auth);
                    docCache.set(auth.citation, doc);
                    say(`      ${doc.state} · ${truncate(auth.citation, 50)}`);
                    caseAttached++;
                }
                say(`    ${claim.id.padEnd(10)} 판례 ${picked.length}건 — ${truncate(citationOf(picked[0]!), 52)}`);
            }),
        ),
    );
    say(`    판례 부착 ${caseAttached}건`);

    // ── 4) 반대 논증 + 5) 판정 ─────────────────────────────────────────────────
    say('4/7 반대 논증 · 5/7 판정');
    const itemsByIssue = new Map<string, LedgerItem[]>();
    await Promise.all(
        revisedPlan.map(({ issue, claim, original, changes }) =>
            limiter.run(async (): Promise<void> => {
                const citations = verifyAll(claim.authority);
                const sources = claim.authority.map((a) => resolutionFor(a, docCache.get(a.citation)!, claim));
                const pack = sources
                    .map((s) =>
                        s.usable
                            ? `### ${s.authority.citation} [${s.doc.state}]\n${renderPassages(s.passages, 3000) || (s.doc.fullText ?? '').slice(0, 3000)}`
                            : `### ${s.authority.citation} [${s.doc.state}] — 원문 미확보. 이 권위를 근거로 쓰지 말 것.`,
                    )
                    .join('\n\n');

                const objection = await ask<{ objections: Objection[] }>(ObjectionBatch, {
                    name: 'objections',
                    description: '명제 하나를 원문 발췌에 비추어 공격하고, 자신을 죽일 조건을 밝힌다',
                    system: CON_PROMPT,
                    user: conInput(claim, pack),
                }, usage);
                const obj = { ...objection.objections[0]!, claimId: claim.id };

                const judged = await ask<{ judgments: Judgment[] }>(JudgeBatch, {
                    name: 'judgments',
                    description: '명제와 반대를 원문에 비추어 4등급으로 판정한다',
                    system: JUDGE_PROMPT,
                    user: judgeInput(claim, obj, pack),
                }, usage);
                let judgment = { ...judged.judgments[0]!, claimId: claim.id };

                // ── 재검증 루프 (FIRE) ───────────────────────────────────────────
                //
                // 적대적 리뷰만으로는 부족하다. 판정이 "약함/미해결"이라고 말했을 때 기록하고
                // 끝내면 그 명제는 영원히 약한 채로 논문에 남는다. FIRE(Xie et al., Findings of
                // NAACL 2025)는 **판정의 확신도가 다음 행동을 결정**하게 한다 — 확신이 없으면
                // 답하지 않고 질의를 만들어 다시 찾는다. 여기서도 confidence 가 낮으면 판정이
                // 지목한 부족분으로 다시 찾고, 붙여서, **다시 판정**한다. 예산이 떨어지면 멈춘다.
                for (let round = 0; round < 2 && recheck.left > 0; round++) {
                    const conf = judgment.confidence ?? 0.5;
                    if (conf >= 0.7) break;
                    recheck.left--;
                    const before = `${judgment.verdict}(${conf.toFixed(2)})`;
                    const missingText = [...(judgment.discriminators ?? []), ...(judgment.surviving ?? [])].join(' ').slice(0, 180);
                    const q = `${claim.proposition} ${missingText}`.slice(0, 240);
                    const d = await research(q, '', {
                        ...(process.env.LEGAL_AGENT_SCRATCH ? { scratch: process.env.LEGAL_AGENT_SCRATCH } : {}),
                        ask: (schema, o) => ask<any>(schema as never, o as never, usage),
                    });
                    // 출처 등급이 낮은 것은 근거로 쓰지 않는다. 딥시크가 authority 를 주는데
                    // 그동안 버리고 있었다 — 등급 없는 웹 조각과 판례를 같은 무게로 다뤘다.
                    const useful = d.findings
                        .filter((f) => f.quote && (f.kind === 'news' || f.kind === 'fact') && (f.authority ?? 2) >= 2)
                        .sort((a, b) => (b.authority ?? 0) - (a.authority ?? 0))
                        .slice(0, 2);
                    if (!useful.length) {
                        say(`    ${claim.id.padEnd(10)} 재검증 ${before} — 채울 자료 없음`);
                        break;
                    }
                    for (const f of useful) {
                        if (claim.authority.some((a) => a.citation === f.citation)) continue;
                        const auth: Authority = { type: 'practice', citation: f.citation, holding: f.summary.slice(0, 200) };
                        claim.authority.push(auth);
                        const doc = {
                            state: 'provided' as const,
                            how: 'research',
                            ...(f.url ? { url: f.url } : {}),
                            fullText: `${f.summary}\n\n"${f.quote}"${f.url ? `\n\n출처: ${f.url}` : ''}`,
                        };
                        docCache.set(auth.citation, doc);
                        sources.push(resolutionFor(auth, doc, claim));
                        citations.push(...verifyAll([auth]));
                    }
                    const pack2 = sources
                        .map((s) =>
                            s.usable
                                ? `### ${s.authority.citation} [${s.doc.state}]\n${renderPassages(s.passages, 3000) || (s.doc.fullText ?? '').slice(0, 3000)}`
                                : `### ${s.authority.citation} [${s.doc.state}] — 원문 미확보.`,
                        )
                        .join('\n\n');
                    const again = await ask<{ judgments: Judgment[] }>(JudgeBatch, {
                        name: 'judgments',
                        description: '새 자료를 포함해 다시 판정한다',
                        system: JUDGE_PROMPT,
                        user: judgeInput(claim, obj, pack2),
                    }, usage);
                    judgment = { ...again.judgments[0]!, claimId: claim.id };
                    say(
                        `    ${claim.id.padEnd(10)} 재검증 ${round + 1} — ${before} → ${judgment.verdict}(${(judgment.confidence ?? 0).toFixed(2)}) +${useful.length}건`,
                    );
                }

                const item: LedgerItem = {
                    claim,
                    ...(original ? { original } : {}),
                    ...(changes ? { changes } : {}),
                    citations,
                    sources,
                    evidence: gradeEvidence(sources, citations),
                    objection: obj,
                    judgment,
                    human: [],
                };
                const down = enforceEvidence(judgment, item.evidence, citations);
                if (down) {
                    item.downgrade = down;
                    item.judgment = { ...judgment, verdict: down.to as Judgment['verdict'] };
                }
                const list = itemsByIssue.get(issue.id) ?? [];
                list.push(item);
                itemsByIssue.set(issue.id, list);
                say(`    ${claim.id.padEnd(10)} ${item.judgment.verdict}${down ? ` (강등 ${down.from}→${down.to})` : ''} · 근거 ${item.evidence.grade}`);
            }),
        ),
    );

    // ── 5.5) 사람에게 묻기 ②: 미결 → 되묻고 재판정 ─────────────────────────────
    const unresolvedItems = [...itemsByIssue.values()].flat().filter((it) => it.judgment.verdict === 'unresolved');
    if (opts.maxClarify > 0 && unresolvedItems.length) {
        say(`5.5/7 사람에게 묻기 ② — 미결 ${unresolvedItems.length}건 중 최대 ${opts.maxClarify}건`);
        const targets = unresolvedItems.slice(0, opts.maxClarify);
        const asks = targets.map((it) =>
            clarifyAsk({
                id: `clr-${it.claim.id}`,
                proposition: it.claim.proposition,
                discriminators: it.judgment.discriminators,
                why: it.judgment.reasoning,
            }),
        );
        const answered = await runHitl(asks, opts.hitl);
        human.push(...answered);

        const answeredById = new Map(answered.map((a) => [a.id, a]));
        await Promise.all(
            targets.map((it) =>
                limiter.run(async () => {
                    const ans = answeredById.get(`clr-${it.claim.id}`);
                    if (!ans || ans.answer.action !== 'answered' || !ans.answer.note) return;
                    const pack = it.sources
                        .filter((s) => s.usable)
                        .map((s) => `### ${s.authority.citation}\n${renderPassages(s.passages, 3000)}`)
                        .join('\n\n');
                    const rejudged = await ask<{ judgments: Judgment[] }>(JudgeBatch, {
                        name: 'judgments',
                        description: '사람이 확인해 준 사실을 더해 명제를 다시 판정한다',
                        system: JUDGE_PROMPT,
                        user: judgeInput(it.claim, it.objection, pack, ans.answer.note),
                    }, usage);
                    const next = { ...rejudged.judgments[0]!, claimId: it.claim.id };
                    it.human.push({ question: ans.question, answer: ans.answer });
                    const down = enforceEvidence(next, it.evidence, it.citations);
                    it.judgment = down ? { ...next, verdict: down.to as Judgment['verdict'] } : next;
                    if (down) it.downgrade = down;
                    say(`    재판정 ${it.claim.id} → ${it.judgment.verdict}`);
                }),
            ),
        );
    } else if (unresolvedItems.length) {
        say(`5.5/7 미결 ${unresolvedItems.length}건 — 되묻지 않음`);
    }

    // ── 7) 원장 ────────────────────────────────────────────────────────────────
    for (const issue of issues) {
        const items = (itemsByIssue.get(issue.id) ?? []).sort((a, b) => a.claim.id.localeCompare(b.claim.id));
        const withdrawn = withdrawnByIssue.get(issue.id) ?? [];
        ledger.issues.push({ issue, items, withdrawn });
        ledger.coverage.claims += items.length;
        for (const it of items) {
            ledger.coverage.citations += it.citations.length;
            ledger.coverage.verified += it.citations.filter((c) => c.state === 'verified').length;
            ledger.coverage.unverifiable += it.citations.filter((c) => c.state === 'unverifiable').length;
            ledger.coverage.blocking += it.citations.filter((c) => blockingStates.has(c.state)).length;
            if (it.evidence.grade === 'full_text') ledger.coverage.fullText++;
            else ledger.coverage.notFullText++;
            if (it.downgrade) ledger.coverage.downgraded++;
            if (it.original) ledger.coverage.revised++;
        }
        ledger.coverage.withdrawn += withdrawn.length;
    }

    setToolSink(null);
    ledger.dossier = dossier;
    ledger.finishedAt = new Date().toISOString();
    return ledger;
}

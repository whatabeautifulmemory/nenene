// 초고 → 검증 → 수정 파이프라인.
//
//   research   조사        웹·백과·서지 + 맥락의 사건번호(헌재 포함) 원문
//   thesis     논지 설계   제목·중심 논지·핵심 개념·연구질문·입장·범위·방법
//   outline    목차 설계   장(章) 구성 — 역할·주장·자료·분량
//   draft      초고 집필   장 순서대로. 앞 장 요지를 보며. 인용은 ⟦…⟧ 마커
//   cite       인용 확보   마커 추출 → 사다리(코퍼스·웹·헌재) → 검증 → 상태표
//   hitl       사람에게    확보 못 한 인용
//   review     적대적 검토 장마다 하중을 지는 주장 추출 → (반대 측 자료 검색) → 반대 → 판정
//   gapfill    보강        판정이 요구한 자료를 찾아 재판정 — 확신할 때까지 최대 3회(FIRE 식)
//   revise     수정        초고 + 인용 상태표 + 판정 → 다시 쓴다
//   reverify   재검증      수정본에서 바뀐 주장을 다시 반대·판정해 원장을 최종 원고에 맞춘다(기본 1회, 2회면 반박·미결·악화를 한 번 더 고침)
//   citecheck  인용 대조   각주 문장 ↔ 원문 발췌(모델) + 숫자·날짜(코드), 걸린 문장만 한 번 고친다
//   assemble   조립        초록·주제어 (각주·참고문헌은 manuscript.ts 가 코드로)
//
// 왜 순서를 뒤집었나: 원자 명제를 먼저 검증하고 조립하면, 검증 가능한 것(조문 요약)만 남아
// 논문이 보고서로 퇴화한다. 논문은 먼저 써야 논지가 생기고, 검증은 그 논지를 깎는 데 쓴다.
import type { Usage } from './llm.ts';
import { conInput, judgeInput } from './prompts.ts';
import {
    ABSTRACT_PROMPT,
    CITE_CHECK_PROMPT,
    CITE_FIX_PROMPT,
    CON_PROMPT_PAPER,
    EXTRACT_PROMPT,
    GAP_PROMPT,
    JUDGE_PROMPT_PAPER,
    OUTLINE_PROMPT,
    REVISE_SECTION_PROMPT,
    THESIS_PROMPT,
    WRITER_SYSTEM,
    outlineBlock,
    previousBlock,
    researchBlock,
    thesisBlock,
    type ResearchHandle,
} from './prompts-paper.ts';
import {
    AbstractSchema,
    CiteCheckBatch,
    ClaimExtractBatch,
    GapNeedList,
    JudgeBatch,
    ObjectionBatch,
    OutlineSchema,
    PaperThesisSchema,
    blockingStates,
    type Authority,
    type CitationCheck,
    type Claim,
    type ClaimExtractT,
    type Judgment,
    type Objection,
    type PaperThesis,
} from './schemas.ts';
import { prefetchStatutes, verifyAll } from './law/verify.ts';
import { USABLE_AS_EVIDENCE, acquireSource, loadHumanProvided, recordProvided, type SourceDoc } from './law/sources.ts';
import { relevantPassages, renderPassages } from './law/extract.ts';
import { research, type Finding } from './law/research.ts';
import { discoverDecisions, fetchDecision } from './law/decisions.ts';
import { extractReferences, pickReferences, type RefCandidate } from './law/snowball.ts';
import { searchLiterature } from './law/literature.ts';
import { citationOf, searchCases } from './law/cases.ts';
import { rerankCases } from './law/rerank.ts';
import { findCandidateArticles, probeTerms } from './law/coverage.ts';
import { stem } from './law/cases.ts';
import { parsePrecedentCitation } from './law/verify.ts';
import { searchWeb } from './law/search.ts';
import { caseNosIn, classify, extractCites, identityOf, isReferential, normalizeKey, roman, statusMark, toAuthority, type Cite, type CiteKind } from './law/cite.ts';
import { runHitl, sourceAsk, type AnsweredAsk, type Ask, type HitlOptions } from './hitl.ts';
import { setToolSink, type ToolEvent } from './trace.ts';
import { withoutCites } from './manuscript.ts';
import { Limiter, enforceEvidence, gradeEvidence, resolutionFor, sha, truncate, type Asker, type Ledger, type LedgerItem, type SourceResolution } from './pipeline.ts';

export type PaperScale = 'short' | 'standard' | 'long';

export type SectionRole = 'intro' | 'background' | 'analysis' | 'doctrine' | 'evaluation' | 'comparative' | 'proposal' | 'conclusion';

export interface PaperSection {
    id: string;
    number: string;
    title: string;
    role: SectionRole;
    brief: string;
    claims: string[];
    sources: string[];
    subsections: string[];
    targetChars: number;
    draft?: string;
    revised?: string;
    claimIds?: string[];
    citeKeys?: string[];
}

export interface CiteStatus {
    key: string;
    raw: string;
    kind: CiteKind;
    n: number;
    check: string;
    source: string;
    how?: string;
    url?: string;
    note?: string;
    display?: string;
    sections: string[];
    /**
     * 원문에서 확인되지 않아 조립 전에 본문에서 마커를 뺀 인용(plan.withheld 와 같은 것). 상태표(plan.cites·'cites' 이벤트)에는
     * 남겨 앱 인용표·원장이 ✗ 「본문에서 뺌」으로 보이게 한다 — 각주·참고문헌에는 들어가지 않는다. sections 는 빼기 전에 쓰인 장.
     */
    withheld?: true;
}

/** 인용 대조 한 건 — 각주 문장과 그 원문 발췌. */
export interface CiteCheckRecord {
    sectionId: string;
    sentence: string;
    cite: string;
    verdict: 'supported' | 'partial' | 'unsupported' | 'unchecked';
    reason: string;
    /** 원문에 없는 숫자·날짜 */
    numbers?: string[];
    /** 고침 단계에서 이 문장이 바뀌었는가 */
    fixed?: boolean;
    /** 고친 뒤 다시 대조한 문장 */
    recheck?: boolean;
}

/** 품질 루프 기록 — 반대 측 자료 검색, 보강 회차, 재검증 회차. */
export interface QualityLog {
    counter: { searched: number; withMaterial: number; skipped: number };
    fire: { round: number; targets: number; needs: number; gained: number; rejudged: number }[];
    reverify: { round: number; sections: number; reused: number; rechecked: number; failing: number; rewritten: number }[];
}

export interface PaperPlan {
    /** 연쇄 탐색 단계별 기록 — 후보 수, 고른 수, 전문을 얻어 다음 단계로 넘긴 수 */
    snowball?: { hop: number; candidates: number; picked: number; fullText: number }[];
    /** 인용 대조 결과 */
    citeCheck?: CiteCheckRecord[];
    /** 품질 루프 기록 */
    quality?: QualityLog;
    thesis: PaperThesis;
    sections: PaperSection[];
    abstract?: string;
    keywords?: string[];
    cites?: CiteStatus[];
    /** 원문에서 확인되지 않아(not_found·article_missing·date_mismatch) 조립 전에 본문에서 마커를 뺀 인용 — 각주가 아니라 부록에 남는다 */
    withheld?: CiteStatus[];
    scale?: PaperScale;
}

export type StageId = 'research' | 'thesis' | 'outline' | 'draft' | 'cite' | 'hitl' | 'snowball' | 'review' | 'gapfill' | 'revise' | 'reverify' | 'citecheck' | 'assemble';

export type ComposeEvent =
    | { type: 'stage'; stage: StageId; status: 'start' | 'done' | 'skip' | 'error'; detail?: string }
    | { type: 'plan'; plan: PaperPlan }
    | { type: 'section'; section: PaperSection; phase: 'draft' | 'revised' }
    | { type: 'cites'; cites: CiteStatus[] }
    | { type: 'review'; sectionId: string; item: LedgerItem }
    | { type: 'reviews'; sectionId: string; items: LedgerItem[] };

/** 장 산문을 쓰는 함수. 구조화 출력이 아니라 plain completion — 긴 산문은 JSON 으로 받지 않는다. */
export type Writer = (req: { name: string; system: string; user: string; maxTokens?: number; temperature?: number }) => Promise<string>;

export interface ComposeOptions {
    topic: string;
    context?: string;
    /** 구상 단계에서 확정한 설계. 있으면 논지 설계 단계를 건너뛴다. */
    plan?: PaperThesis;
    scale?: PaperScale;
    concurrency: number;
    hitl: HitlOptions;
    /** 장마다 검토할 주장 수 상한 */
    claimsPerSection?: number;
    /** 연쇄 탐색 깊이(1~3). 1 = 초고가 인용한 원문의 참고문헌까지, 2 = 그 참고문헌의 참고문헌까지. 기본 2 */
    snowballDepth?: number;
    /** 연쇄 탐색이 새로 가져오는 문헌 총량 상한. 기본 12 */
    snowballBudget?: number;
    /**
     * 품질 루프. 기본은 전부 켬 — 반대 측 자료 검색, 보강 3회(FIRE 식), 수정본 재검증 1회(2 를 주면 한 번 더 고침), 인용 대조.
     * CLI --no-quality 는 {counter:false, fireRounds:1, reverify:0, citeCheck:false} — 예전 동작(비교용).
     */
    quality?: { counter?: boolean; fireRounds?: number; reverify?: number; citeCheck?: boolean };
    onProgress?: (msg: string) => void;
    onTool?: (e: ToolEvent) => void;
    onEvent?: (e: ComposeEvent) => void;
    signal?: AbortSignal;
}

const SCALE: Record<PaperScale, { min: number; max: number; total: number; claims: number }> = {
    short: { min: 5, max: 6, total: 12_000, claims: 3 },
    standard: { min: 7, max: 9, total: 22_000, claims: 4 },
    long: { min: 9, max: 12, total: 35_000, claims: 4 },
};

/** 권위 자체를 겨냥한 공격 — 이것만 반박(refuted)의 근거가 된다. */
const AUTHORITY_ATTACKS = new Set(['authority_false', 'authority_misread', 'authority_out_of_scope', 'counter_authority']);

/**
 * "원문이 확보되지 않았다"에 기댄 반대 — 보강이 원문을 붙이면 낡는다. 조사·"발췌"·"모두" 가 끼거나 "제공되지 않았다"로 쓴 것도 잡는다
 * (실측: "원문은 확보되지 않았다", "원문 발췌도 제공되지 않았다", "원문이 모두 확보되지 않았고" 를 놓쳤다).
 * "원문에서 확인되지 않는다"(원문이 그렇게 말하지 않는다)는 원문이 있는 반대라 잡지 않는다.
 * "전문가(專門家) 없는 집행"은 전문(全文)의 반대가 아니다 — 조사 '가'는 발췌 뒤에만 붙고(원문·전문 뒤는 '이'), 전문 바로 뒤의 '가'는 전문가다.
 */
const STALE_OBJECTION =
    /(?:원문|전문(?!가))(?:\s*발췌)?(?:이|을|의|은|는|도|가)?\s*(?:모두\s*|전혀\s*|아직\s*|자체가\s*|기록에\s*)?(?:확보되지|확보하지|미확보|입수되지|제공되지|미제공|주어지지|확인할 수 없|없[다는어으고])|발췌가\s*(?:없|확보되지|제공되지|주어지지)|확보된 원문이 없|not_found/;

const COURT_ABBR: Record<string, string> = {
    헌재: '헌법재판소',
    대판: '대법원',
    서울행법: '서울행정법원',
    서울고법: '서울고등법원',
    서울중앙지법: '서울중앙지방법원',
};
const DECISION_HOST = /law\.go\.kr\/(?:LSW\/)?(?:precInfoP|detcInfoP)|casenote\.kr|lbox\.kr|scourt\.go\.kr|ccourt\.go\.kr\/.*(?:View|Download)|glaw\.scourt/i;

/**
 * 웹 페이지 본문에서 "서울행법 2007. 11. 23. 선고 2007구합22009 판결" 같은 표지를 찾아 정식 인용으로 만든다.
 * 판례 사이트가 아닌 페이지에서는 본문 앞머리에 표지가 있을 때만 믿는다 — 기사 속 인용 하나로 판례를 만들지 않는다.
 */
export function formalCaseCitation(text: string, url?: string): string | null {
    const re = /(대법원|헌법재판소|헌재|대판|[가-힣]{2,6}(?:고등|지방|행정|가정|회생|특허)법원|서울행법|서울고법|서울중앙지법|[가-힣]{2,4}지법)\s*(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?\s*(?:선고|자)?\s*(\d{4}\s*(?![년월일건명차조항호])[가-힣]{1,3}\s*\d+)\s*(판결|결정)?/;
    const isDecisionPage = url ? DECISION_HOST.test(url) : false;
    const scope = isDecisionPage ? text : text.slice(0, 300);
    const m = re.exec(scope);
    if (!m) return null;
    let court = m[1]!;
    court = COURT_ABBR[court] ?? court.replace(/지법$/, '지방법원');
    const caseNo = m[5]!.replace(/\s+/g, '');
    const isCC = court === '헌법재판소' || /헌[가-힣]/.test(caseNo);
    const kind = m[6] ?? (isCC ? '결정' : '판결');
    return `${court} ${m[2]}. ${Number(m[3])}. ${Number(m[4])}. 선고 ${caseNo} ${kind}`;
}

const tokensFor = (chars: number) => Math.min(8192, Math.ceil(chars * 2) + 800);

/** 정수 설정값 — 숫자가 아니거나 범위 밖이면 기본값(NaN 이 상한을 끄지 않게). */
const clampInt = (v: number | undefined, lo: number, hi: number, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.floor(v))) : d;

/**
 * 문단을 문장으로. 마침표·물음표 뒤 공백에서 자른다 — 단, 날짜의 마침표("2007. 6. 28.")에서는 자르지 않고,
 * 마침표 뒤에 붙은 인용 마커·⚠ 는 앞 문장에 붙인다("…이다. ⟦X⟧ 그러나" → "…이다. ⟦X⟧" | "그러나").
 * "…다⟦X⟧ ⚠.", "…인가?", "…한다(제114조)." 도 끝으로 본다. 제목 줄(#)은 뺀다.
 */
export function sentencesOf(text: string): string[] {
    const out: string[] = [];
    const END = /[.?!](?:\s*⚠)?(?:\s*⟦[^⟧]*⟧)*(?:\s*⚠\.?)?\s+/g;
    for (const para of text.split(/\n+/)) {
        const p = para.trim();
        if (!p || p.startsWith('#')) continue;
        let start = 0;
        for (const m of p.matchAll(END)) {
            const at = m.index!;
            const end = at + m[0].length;
            const before = p.slice(Math.max(0, at - 16), at + 1);
            // 날짜·번호 속 마침표: "2007. 6." / "6. 28." / "2007. 6. 28." 의 마지막 점(뒤가 날짜를 잇지 않아도 날짜 끝이면 문장 끝이 아닐 수 있다)
            if (/\d\.$/.test(before) && /^\d/.test(p.slice(end))) continue;
            if (/(?:19|20)\d{2}\.\s*\d{1,2}\.\s*\d{1,2}\.$/.test(before) && !/[⟧⚠]/.test(m[0])) continue;
            out.push(p.slice(start, end).trim());
            start = end;
        }
        const rest = p.slice(start).trim();
        if (rest) out.push(rest);
    }
    return out.filter(Boolean);
}

/**
 * 문장의 숫자·날짜가 원문에 있는가 — 연도(2007년), 날짜(2007. 6. 28. / 2017년 11월 29일), 수량(30일·12명·5%).
 * 조문 번호(제6조 제1항)와 사건번호(2004헌마644)는 숫자 대조 대상이 아니다. 원문에 없는 것을 돌려준다.
 * source 에는 문장이 인용한 모든 원문(과 판결의 선고일 머리)을 함께 넣는다 — 한 문장이 두 판결의 날짜를 말할 수 있다.
 */
export function numberMismatches(sentence: string, source: string, opts: { statute?: boolean } = {}): string[] {
    let s0 = sentence.replace(/⟦[^⟧]*⟧/g, ' ').replace(/제\s*\d+\s*조(?:\s*의\s*\d+)?(?:\s*제\s*\d+\s*[항호])*/g, ' ');
    // 조문을 인용한 문장의 연혁 연도("2011년 개정으로")는 대조하지 않는다 — 조문 원문에는 제정·개정 연도가 없어 맞는 연도도
    // "원문에 없는 숫자"로 걸리고, 고침 단계가 그 연도를 지운다. 날짜까지 쓴 것(2011. 7. 18. 개정)은 조문의 <개정 …> 표기와 대조한다.
    if (opts.statute) s0 = s0.replace(/(?<![\d.])(?:19|20)\d{2}\s*년\s*(?:\d{1,2}\s*월\s*)?(?:의\s*)?(?:[가-힣·]{1,20}법(?:률)?\s*)?(?:전부\s*|일부\s*)?(?:개정|신설|제정|시행|공포)/g, ' ');
    const toks = new Set<string>();
    // 날짜를 먼저 뽑아 지운다 — "2017년 11월 29일" 의 "29일" 이 일수로 읽히지 않게.
    let s = s0.replace(/(?<!\d)((?:19|20)\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/g, (_m, y: string, mo: string, d: string) => {
        toks.add(`${y}.${Number(mo)}.${Number(d)}.`);
        return ' ';
    });
    s = s.replace(/(?<!\d)((?:19|20)\d{2})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})\s*\.?/g, (_m, y: string, mo: string, d: string) => {
        toks.add(`${y}.${Number(mo)}.${Number(d)}.`);
        return ' ';
    });
    // 사건번호(2004헌마644, 99헌마513)는 지운다 — "년·월·일" 앞의 숫자는 사건번호가 아니다.
    s = s.replace(/(?<!\d)(?:\d{4}|[6-9]\d)\s*(?![년월일])[가-힣]{1,3}\s*\d+/g, ' ');
    for (const m of s.matchAll(/(?<![\d.])((?:19|20)\d{2})\s*년/g)) toks.add(m[1]!);
    const PARTICLE = '(?=$|[^가-힣]|이|가|을|를|은|는|의|에|로|으로|과|와|도|만|간|이내|이상|이하|미만|초과|동안|부터|까지|째)';
    for (const m of s.matchAll(new RegExp(`(?<![\\d.,])(\\d{1,3}(?:,\\d{3})+|\\d+)\\s*(일|명|건|%|퍼센트|개월|세)${PARTICLE}`, 'g'))) toks.add(`${m[1]}${m[2]}`);
    const src = source
        .replace(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/g, '$1.$2.$3.')
        .replace(/(\d{4})-(\d{1,2})-(\d{1,2})/g, '$1.$2.$3.')
        .replace(/\s+/g, '')
        .replace(/(\d{4})\.0?(\d{1,2})\.0?(\d{1,2})/g, '$1.$2.$3');
    const miss: string[] = [];
    for (const t of toks) {
        if (/^\d{4}$/.test(t)) {
            if (!src.includes(t)) miss.push(`${t}년`);
        } else if (/^\d{4}\.\d/.test(t)) {
            if (!src.includes(t) && !src.includes(t.replace(/\.$/, ''))) miss.push(t);
        } else if (!src.includes(t) && !src.includes(t.replace(/,/g, ''))) miss.push(t);
    }
    return miss;
}

/** 조사 결과 → 핸들. R1, R2 … 집필 모델은 이 핸들로만 인용한다. */
function handles(findings: Finding[]): ResearchHandle[] {
    return findings.map((f, i) => ({
        handle: `R${i + 1}`,
        kind: f.kind,
        citation: cleanTitle(f.citation),
        summary: f.summary,
        ...(f.quote ? { quote: f.quote } : {}),
        ...(f.url ? { url: f.url } : {}),
    }));
}

/** 웹 스크랩에서 온 제목 쓰레기(<table>…, 문장 조각)를 걷어낸다. 각주에 그대로 들어가면 안 된다. */
export function cleanTitle(s: string): string {
    let t = s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // 끝의 <url> 은 호출자가 따로 붙인다
    t = t.replace(/\s*<https?:\/\/[^>]+>\s*$/, '').trim();
    if (t.length > 110) t = `${t.slice(0, 108)}…`;
    return t || '(제목 없음)';
}

export { identityOf };

export async function composePaper(opts: ComposeOptions, ask: Asker, write: Writer, modelLabel: string): Promise<Ledger> {
    const usage: Usage = { prompt: 0, completion: 0, calls: 0 };
    const say = opts.onProgress ?? (() => {});
    const emit = opts.onEvent ?? (() => {});
    const stage = (id: StageId, status: 'start' | 'done' | 'skip' | 'error', detail?: string) => emit({ type: 'stage', stage: id, status, ...(detail ? { detail } : {}) });
    /**
     * 「중단」을 단계·회차 경계에서 본다. 모델 호출의 catch 만 보면, 남은 일이 캐시·코드 작업뿐인 멈춘 실행은 무언가 던질 때까지
     * 끝까지 돌았다(앱은 그동안 새 실행을 받지 않는다). 신호의 이유(AbortError)를 던진다 — fetch·llm.ts 가 멈출 때 던지는 것과 같고,
     * 앱 runner 는 그 실행을 「중단됨」으로 끝낸다.
     */
    const halt = (): void => opts.signal?.throwIfAborted();
    setToolSink(opts.onTool ?? null);
    const limiter = new Limiter(opts.concurrency);
    const scale = opts.scale ?? 'standard';
    const S = SCALE[scale];
    const human: AnsweredAsk[] = [];
    const scratch = process.env.LEGAL_AGENT_SCRATCH;

    const ledger: Ledger = {
        topic: opts.topic,
        ...(opts.context?.trim() ? { context: opts.context.trim() } : {}),
        model: modelLabel,
        mode: 'paper',
        startedAt: new Date().toISOString(),
        issues: [],
        usage,
        human,
        sourceStats: {},
        coverage: { claims: 0, citations: 0, verified: 0, blocking: 0, unverifiable: 0, fullText: 0, notFullText: 0, downgraded: 0, revised: 0, withdrawn: 0 },
    };

    // ── research ────────────────────────────────────────────────────────────────
    stage('research', 'start');
    say('조사 — 웹 · 백과 · 서지 · 판례 원문');
    const dossier = await research(opts.topic, opts.context ?? '', {
        ...(scratch ? { scratch } : {}),
        ask: (schema, o) => ask<any>(schema as never, o as never, usage),
        ...(opts.signal ? { signal: opts.signal } : {}),
    });
    // 맥락에 사건번호가 있으면 결정 본문을 미리 가져온다 — 집필 모델이 기억이 아니라 요지를 읽고 쓰게.
    const preSeed = new Map<string, SourceDoc>();
    /** 같은 문서를 identityOf 로 찾는다 — preSeed/preDocs 는 normalizeKey 라 표기가 다르면 못 찾는다 */
    const preById = new Map<string, SourceDoc>();
    const mentioned = caseNosIn(`${opts.topic}\n${opts.context ?? ''}`);
    for (const no of mentioned.slice(0, 6)) {
        const isCC = /헌[가나다라마바사아자차카타파하]/.test(no);
        const cite = isCC ? `헌법재판소 ${no} 결정` : `${no} 판결`;
        const d = await fetchDecision(cite, opts.signal ? { signal: opts.signal } : {});
        const text = d.fullText ?? d.abstractText;
        if (!text) {
            say(`    ${no} — 웹에서 본문을 찾지 못함`);
            continue;
        }
        preSeed.set(normalizeKey(cite), d);
        preById.set(identityOf(cite), d);
        dossier.findings.push({
            id: `case-${no}`,
            kind: 'case',
            authority: 4,
            citation: cite,
            summary: text.replace(/\s+/g, ' ').slice(0, 240),
            quote: text.replace(/\s+/g, ' ').slice(0, 1200),
            ...(d.url ? { url: d.url } : {}),
            fetchedAt: new Date().toISOString(),
        });
        say(`    ${no} — ${d.state} (${(d.chars ?? text.length).toLocaleString()}자)`);
    }
    // 사건번호 없이 언급된 결정("헌법재판소는 2007년 참정권 영역에서 …")을 찾아 본문을 가져온다.
    // 이게 없으면 집필 모델은 "2007년 결정"이라고만 쓰고 인용을 달지 못한다(실제로 그랬다).
    try {
        const found = await discoverDecisions(`${opts.topic}\n${opts.context ?? ''}`, { ...(opts.signal ? { signal: opts.signal } : {}), max: 3 });
        for (const d of found) {
            if (dossier.findings.some((f) => f.citation.includes(d.caseNo))) continue;
            const text = (d.doc.fullText ?? d.doc.abstractText ?? '').replace(/\s+/g, ' ');
            preSeed.set(normalizeKey(d.citation), d.doc);
            preById.set(identityOf(d.citation), d.doc);
            dossier.findings.push({
                id: `case-${d.caseNo}`,
                kind: 'case',
                authority: 4,
                citation: d.citation,
                summary: text.slice(0, 240),
                quote: text.slice(0, 1500),
                ...(d.doc.url ? { url: d.doc.url } : {}),
                fetchedAt: new Date().toISOString(),
            });
            say(`    ${d.citation} — ${d.doc.state} (${(d.doc.chars ?? text.length).toLocaleString()}자)`);
        }
    } catch (e) {
        say(`    결정 탐색 실패: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
    }
    // 웹 검색이 물어온 판례 페이지(국가법령정보센터·casenote·lbox)는 "뉴스"가 아니라 판례다.
    // 정식 인용으로 바꿔야 사다리가 사건번호로 원문을 대조하고, 못 구하면 필자에게 묻는다.
    for (const f of dossier.findings) {
        if (f.kind !== 'news' && f.kind !== 'fact') continue;
        const formal = formalCaseCitation(`${f.citation}\n${(f.quote ?? '').slice(0, 400)}\n${f.summary.slice(0, 300)}`, f.url);
        if (!formal) continue;
        f.kind = 'case';
        f.citation = formal;
    }
    // 조사에서 이미 본문을 가져온 결정은 인용 단계에서 다시 찾지 않도록 미리 넣어 둔다.
    const preDocs = preSeed;
    // 쓰레기 제목·빈 인용문은 자료가 아니다.
    dossier.findings = dossier.findings.filter((f) => (f.quote ?? f.summary).trim().length >= 40);
    const rh = handles(dossier.findings);
    const byHandle = new Map(rh.map((h) => [h.handle, h]));
    for (let i = 0; i < dossier.findings.length; i++) dossier.findings[i]!.id = rh[i]!.handle;
    ledger.dossier = dossier;
    say(`    자료 ${rh.length}건 (${['news', 'fact', 'doctrine', 'case'].map((k) => `${k} ${rh.filter((x) => x.kind === k).length}`).join(' · ')})`);
    stage('research', 'done', `${rh.length}건`);

    // ── thesis ──────────────────────────────────────────────────────────────────
    let thesis: PaperThesis;
    if (opts.plan && opts.plan.thesis.trim()) {
        thesis = opts.plan;
        say('논지 — 구상 단계의 설계를 쓴다');
        stage('thesis', 'skip', '구상 단계에서 확정');
    } else {
        stage('thesis', 'start');
        say('논지 설계');
        thesis = await ask<PaperThesis>(PaperThesisSchema, {
            name: 'thesis',
            description: '논문의 제목·중심 논지·핵심 개념·연구질문·입장·범위·방법을 정한다',
            system: THESIS_PROMPT,
            user: [
                `## 주제\n${opts.topic}`,
                ...(opts.context?.trim() ? ['', `## 배경·맥락 (필자 제공)\n${opts.context.trim()}`] : []),
                '',
                researchBlock(rh, 20, 200),
                '',
                '논문의 설계를 세운다.',
            ].join('\n'),
        }, usage);
        say(`    제목: ${thesis.title}`);
        say(`    연구질문 ${thesis.questions.length}개 · 개념 ${thesis.concepts.length}개`);
        stage('thesis', 'done', thesis.title);
    }

    // ── outline ─────────────────────────────────────────────────────────────────
    stage('outline', 'start');
    say('목차 설계');
    const outline = await ask<{ sections: Omit<PaperSection, 'number'>[] }>(OutlineSchema, {
        name: 'outline',
        description: '논문의 목차를 짠다 — 장마다 역할·주장·자료·분량',
        system: OUTLINE_PROMPT,
        user: [
            thesisBlock(thesis),
            '',
            ...(opts.context?.trim() ? [`## 배경·맥락 (필자 제공)\n${opts.context.trim()}`, ''] : []),
            researchBlock(rh, 24, 160),
            '',
            `## 규모\n장 ${S.min}~${S.max}개 · 본문 총 약 ${S.total.toLocaleString()}자 (서론·결론 포함). targetChars 의 합이 이에 맞게.`,
            '',
            '목차를 짠다.',
        ].join('\n'),
    }, usage);
    const sections: PaperSection[] = outline.sections.slice(0, S.max).map((s, i) => ({
        ...s,
        id: s.id || `S${i + 1}`,
        number: roman(i + 1),
        targetChars: Math.max(600, Math.min(6000, s.targetChars || 2000)),
        subsections: s.subsections ?? [],
        sources: s.sources ?? [],
        claims: s.claims ?? [],
    }));
    if (sections.length < 3) throw new Error(`목차가 너무 짧습니다 (${sections.length}장)`);
    const plan: PaperPlan = { thesis, sections, scale };
    emit({ type: 'plan', plan });
    for (const s of sections) say(`    ${s.number}. ${s.title} (${s.targetChars}자)`);
    stage('outline', 'done', `${sections.length}장`);

    // ── draft ───────────────────────────────────────────────────────────────────
    stage('draft', 'start');
    for (const s of sections) {
        halt();
        say(`초고 — ${s.number}. ${s.title}`);
        const user = [
            thesisBlock(thesis),
            '',
            outlineBlock(sections),
            '',
            previousBlock(sections),
            '',
            `## 지금 쓸 장: ${s.number}. ${s.title}`,
            `역할: ${s.role}`,
            `이 장이 하는 일: ${s.brief}`,
            '세울 주장:',
            ...s.claims.map((c) => `- ${c}`),
            s.subsections.length ? `소절: ${s.subsections.map((x, i) => `${i + 1}. ${x}`).join(' / ')}` : '소절: 없음 (소제목 없이 문단으로)',
            `분량: 약 ${s.targetChars.toLocaleString()}자`,
            s.sources.length ? `쓸 자료: ${s.sources.join(' · ')}` : '',
            '',
            researchBlock(rh, 24, 300),
            '',
            `이 장을 쓴다. 장 제목은 쓰지 않는다. 분량 약 ${s.targetChars.toLocaleString()}자.`,
        ].join('\n');
        try {
            let body = await write({ name: 'chapter', system: WRITER_SYSTEM, user, maxTokens: tokensFor(s.targetChars) });
            body = stripOwnHeading(body, s.title);
            s.draft = body;
        } catch (e) {
            if (opts.signal?.aborted) throw e;
            s.draft = `_(이 장 생성 실패: ${e instanceof Error ? e.message.slice(0, 160) : String(e)})_`;
            say(`    실패: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`);
        }
        s.citeKeys = extractCites(s.draft).map((c) => c.key);
        emit({ type: 'section', section: s, phase: 'draft' });
        say(`    ${s.draft.length.toLocaleString()}자 · 인용 ${s.citeKeys.length}건`);
    }
    stage('draft', 'done', `${sections.reduce((a, s) => a + (s.draft?.length ?? 0), 0).toLocaleString()}자`);

    // ── cite ────────────────────────────────────────────────────────────────────
    halt();
    stage('cite', 'start');
    say('인용 확보 · 대조');
    type CiteEntry = { cite: Cite; authority: Authority | null; sections: Set<string>; formalKind?: CiteKind; display?: string };
    const cites = new Map<string, CiteEntry>();
    /** 정식 인용 문자열 → 마커 키. 핸들로 인용된 문헌·판례를 검토 단계가 정식 서지로 찾을 때 쓴다. */
    const byFormal = new Map<string, string>();
    /** 연쇄 탐색·보강이 등록한 인용의 종류 — identityOf(citation) → kind. entryFor 가 먼저 불리므로 여기서 선언한다. */
    const boostKind = new Map<string, CiteKind>();
    const entryFor = (c: Cite): CiteEntry => {
        // 문헌·판례를 핸들(⟦R5⟧)로 인용했으면 정식 서지로 바꿔 **사다리를 태운다.** 핸들을 "공개자료"로 통과시키면
        // KCI 초록만 가진 문헌이 전문인 것처럼 지나가고, 아무도 원문을 묻지 않는다(실제로 그랬다).
        if (c.kind === 'research') {
            const h = byHandle.get(c.raw.toUpperCase());
            if (h && (h.kind === 'doctrine' || h.kind === 'case' || h.kind === 'statute')) {
                const formalKind: CiteKind = h.kind === 'case' ? classify(h.citation) : h.kind === 'statute' ? 'statute' : 'scholarship';
                byFormal.set(normalizeKey(h.citation), c.key);
                return {
                    cite: c,
                    authority: { type: h.kind === 'case' ? 'precedent' : h.kind === 'statute' ? 'statute' : 'scholarship', citation: h.citation, holding: h.summary.slice(0, 200) },
                    sections: new Set<string>(),
                    formalKind,
                    display: h.citation,
                };
            }
        }
        // "같은 판결"·"위 논문" — 앞의 인용을 가리킬 뿐 찾을 대상이 아니다. 사다리도 질문도 없다.
        if (isReferential(c.raw)) return { cite: c, authority: null, sections: new Set<string>() };
        const authority = toAuthority(c, (h) => byHandle.get(h));
        // 연쇄 탐색·보강이 찾아 준 인용은 **찾을 때의 종류**로 다룬다. 제목에 '판결'이 든 논문이 판례 사다리를 타면
        // 원문 있는 문헌이 "사건번호 없음"으로 끝난다.
        const bk = c.kind !== 'research' ? boostKind.get(identityOf(c.raw)) : undefined;
        if (authority && bk && bk !== c.kind) {
            authority.type = bk === 'statute' ? 'statute' : bk === 'scholarship' ? 'scholarship' : 'precedent';
            return { cite: c, authority, sections: new Set<string>(), formalKind: bk };
        }
        return { cite: c, authority, sections: new Set<string>() };
    };
    for (const s of sections) {
        for (const c of extractCites(s.draft ?? '')) {
            const e = cites.get(c.key) ?? entryFor(c);
            e.sections.add(s.id);
            cites.set(c.key, e);
        }
    }
    say(`    인용 ${cites.size}건`);
    const docCache = new Map<string, SourceDoc>(); // by cite key
    const checkByKey = new Map<string, CitationCheck>();
    /** 코퍼스에는 없지만 웹에서 본문을 확인했거나 필자가 원문을 준 것 — "없는 판례·문헌"이 아니다. 차단 판정을 푼다. */
    const reconcileCheck = (check: CitationCheck, doc: SourceDoc): CitationCheck => {
        if (!blockingStates.has(check.state as never) || doc.state !== 'provided') return check;
        const how = doc.how.startsWith('human-summary') ? '필자가 내용으로 답함(원문 아님)' : doc.how.startsWith('human') ? '필자가 원문 제공' : `웹에서 본문 확인 (${doc.url ?? doc.how})`;
        return { ...check, state: 'unverifiable', note: `코퍼스에 없으나 ${how}` };
    };

    /** 시행 전 법령의 직전 판본 받기(prefetchStatutes) — 실패는 실행을 막지 않고 진행 줄로만 알린다. */
    const prefetchLogged = async (auths: Authority[]): Promise<void> => {
        for (const r of await prefetchStatutes(auths, opts.signal ? { signal: opts.signal } : {})) {
            if (r.state === 'failed') say(`      ⚠ 직전(현행) 판본을 받지 못해 시행 전 판본과 대조 — ${truncate(r.citation, 40)}: ${(r.error ?? '').slice(0, 120)}`);
        }
    };

    /** 인용 하나의 원문을 확보·검증한다. 초고 뒤와 수정본 뒤, 두 번 쓰인다. */
    const resolveCite = async (e: CiteEntry): Promise<void> => {
                if (!e.authority && isReferential(e.cite.raw)) {
                    docCache.set(e.cite.key, { state: 'not_found', how: 'none', error: '지시 표현 — 앞의 인용을 정식 인용으로 다시 써야 한다' });
                    checkByKey.set(e.cite.key, { citation: e.cite.raw, type: 'scholarship', state: 'unverifiable', note: '지시 표현(같은 판결·위 논문) — 정식 인용으로 바꿔야 한다' });
                    return;
                }
                if (!e.authority) {
                    docCache.set(e.cite.key, { state: 'not_found', how: 'none', error: '조사 핸들이 자료 목록에 없음' });
                    checkByKey.set(e.cite.key, { citation: e.cite.raw, type: 'practice', state: 'not_found', note: '조사 자료 핸들이 목록에 없음' });
                    return;
                }
                if (e.cite.kind === 'research' && !e.formalKind) {
                    const h = byHandle.get(e.cite.raw.toUpperCase())!;
                    docCache.set(e.cite.key, {
                        state: 'provided',
                        how: 'research',
                        ...(h.url ? { url: h.url } : {}),
                        title: h.citation,
                        fullText: `${h.summary}\n\n${h.quote ?? ''}`,
                        chars: (h.quote ?? h.summary).length,
                    });
                    checkByKey.set(e.cite.key, { citation: e.authority.citation, type: 'practice', state: 'unverifiable', note: '조사 자료 (출처 URL 있음)' });
                    return;
                }
                const seeded = preDocs.get(normalizeKey(e.authority.citation));
                // 시행 전 법령이면 직전(현행) 판본을 먼저 받아 둔다 — 확보(원문)와 검증(동기)이 같은 판본을 읽게. 못 받으면 시행 전 판본으로 대조하고 알린다.
                await prefetchLogged([e.authority]);
                const doc = seeded && USABLE_AS_EVIDENCE.has(seeded.state) ? seeded : await acquireSource(e.authority, opts.signal ? { signal: opts.signal } : {});
                docCache.set(e.cite.key, doc);
                ledger.sourceStats[doc.state] = (ledger.sourceStats[doc.state] ?? 0) + 1;
                const check = reconcileCheck(verifyAll([e.authority])[0]!, doc);
                checkByKey.set(e.cite.key, check);
                say(`      ${doc.state.padEnd(13)} ${check.state.padEnd(15)} ${truncate(e.cite.raw, 60)}`);
    };
    await Promise.all([...cites.values()].map((e) => limiter.run(() => resolveCite(e))));
    const statusOf = (key: string): CiteStatus => {
        const e = cites.get(key)!;
        const doc = docCache.get(key) ?? { state: 'error', how: 'none' };
        let check = checkByKey.get(key) ?? { citation: e.cite.raw, type: 'scholarship', state: 'unverifiable' };
        // 필자가 원문을 주었거나 웹에서 본문을 확인했으면, 코퍼스의 "없음"은 더 이상 결정적이지 않다.
        // 이게 없으면 사람이 준 원문이 ✗ 로 남아 수정 단계가 그 인용을 지운다.
        check = reconcileCheck(check, doc);
        // "원문 코퍼스가 없는 인용 종류"는 검증기의 말이지 독자에게 할 말이 아니다 — 사다리가 어디까지 갔는지를 적는다.
        if (check.state === 'unverifiable' && (!check.note || /코퍼스가 없는 인용 종류/.test(check.note))) {
            const tried = doc.attempts?.length ? ` (시도: ${doc.attempts.slice(0, 4).join(' → ')})` : '';
            const note =
                doc.state === 'abstract_only' ? `${doc.how.startsWith('kci') && /원문 내려받기를 제공하지 않음/.test(doc.error ?? '') ? 'KCI가 원문 공개를 막은 논문 — 서지·초록만 확보' : '서지·초록만 확보, 원문 미입수'}${tried}`
                : doc.state === 'metadata_only' ? `서지만 확보, 원문 미입수${tried}`
                : doc.state === 'user_declined' ? '필자가 원문 없음이라 답함'
                : doc.state === 'not_found' ? `코퍼스·웹·KCI 어디에도 없음${tried}`
                : doc.state === 'corpus_gap' ? `코퍼스에 없는 종류(헌재 등)이고 웹에서도 못 찾음${tried}`
                : doc.state === 'paywalled' ? `유료 사이트에 막힘${doc.url ? ` (${doc.url})` : ''}`
                : doc.state === 'login_required' ? `로그인이 필요한 페이지${doc.url ? ` (${doc.url})` : ''}`
                : doc.state === 'error' ? (doc.error ?? '확보 실패')
                : undefined;
            if (note) check = { ...check, note };
        }
        const h = e.cite.kind === 'research' && !e.formalKind ? byHandle.get(e.cite.raw.toUpperCase()) : undefined;
        const display = e.display ?? (h ? `${h.citation}${h.url ? `, <${h.url}>` : ''} (조회 ${new Date().toISOString().slice(0, 10)})` : undefined);
        return {
            key,
            raw: e.cite.raw,
            kind: e.formalKind ?? e.cite.kind,
            n: 0,
            check: check.state,
            source: doc.state,
            how: doc.how,
            ...(doc.url ? { url: doc.url } : {}),
            // 필자가 준 파일을 못 읽었으면 그 이유가 코퍼스 판정보다 중요하다.
            ...(doc.state === 'error' && doc.how.startsWith('human') && doc.error ? { note: doc.error } : check.note ? { note: check.note } : doc.error ? { note: doc.error } : {}),
            ...(display ? { display } : {}),
            sections: [...e.sections],
        };
    };
    let cstat = [...cites.keys()].map(statusOf);
    plan.cites = cstat;
    emit({ type: 'cites', cites: cstat });
    stage('cite', 'done', `${cstat.filter((c) => USABLE_AS_EVIDENCE.has(c.source as never)).length}/${cstat.length} 확보`);

    // ── hitl ────────────────────────────────────────────────────────────────────
    //
    // 확보 못 한 인용을 사람에게 묻는다. **두 번** 불린다 — 초고 뒤(①)와, 보강 자료를 들고 다시 쓴 수정본 뒤(②).
    // 같은 인용을 두 번 묻지 않는다.
    const askedKeys = new Set<string>();
    const askedIds = new Set<string>(); // identityOf — 쪽수·법원 표기만 다른 같은 인용
    const askHumans = async (round: 1 | 2): Promise<void> => {
        halt(); // 멈춘 실행은 필자에게 묻지 않는다
        const seenId = new Set<string>();
        const needHuman = cstat.filter((c) => {
            if (USABLE_AS_EVIDENCE.has(c.source as never) || c.kind === 'research' || c.kind === 'url' || askedKeys.has(c.key)) return false;
            // 이미 "없음"이라 답한 것(이번 실행이든 지난 실행의 기록이든)과 지시 표현은 묻지 않는다.
            if (c.source === 'user_declined' || isReferential(c.raw)) return false;
            // 같은 판결·논문을 표기만 달리 두 번 인용했으면 한 번만 묻는다 — 답은 둘 다에 쓴다.
            const id = identityOf(c.display ?? c.raw);
            if (askedIds.has(id) || seenId.has(id)) return false;
            seenId.add(id);
            return true;
        });
        if (!needHuman.length) {
            if (round === 1) stage('hitl', 'skip', '전부 확보');
            return;
        }
        stage('hitl', 'start', `${needHuman.length}건${round === 2 ? ' (수정본의 새 인용)' : ''}`);
        say(`사람에게 묻기${round === 2 ? ' ②' : ''} — 원문 미확보 ${needHuman.length}건`);
        const asks: Ask[] = needHuman.map((c) => {
            const doc = docCache.get(c.key)!;
            return sourceAsk({
                id: `src-${sha(c.raw)}`,
                citation: c.display ?? c.raw,
                state: doc.state,
                attempts: doc.attempts ?? [doc.how],
                ...(doc.abstractText ? { abstractText: doc.abstractText } : {}),
                ...(doc.url ? { url: doc.url } : {}),
                ...(doc.error ? { note: doc.error } : {}),
            });
        });
        const idToKey = new Map(needHuman.map((c) => [`src-${sha(c.raw)}`, c.key]));
        for (const c of needHuman) {
            askedKeys.add(c.key);
            askedIds.add(identityOf(c.display ?? c.raw));
        }
        const answered = await runHitl(asks, opts.hitl);
        human.push(...answered);
        /** 기억은 마커 문자열과 정식 서지 둘 다에 — 다음 실행의 사다리는 정식 서지(authority.citation)로 찾는다. */
        const remember = (key: string, what: string) => {
            const e = cites.get(key)!;
            recordProvided(e.cite.raw, what);
            if (e.authority && e.authority.citation !== e.cite.raw) recordProvided(e.authority.citation, what);
            if (e.display && e.display !== e.cite.raw) recordProvided(e.display, what);
        };
        for (const ans of answered) {
            const key = idToKey.get(ans.id);
            if (!key) continue;
            const doc = docCache.get(key)!;
            const label = truncate(cites.get(key)!.display ?? cites.get(key)!.cite.raw, 60);
            if (ans.answer.action === 'provided' && ans.answer.note) {
                // 인용 종류를 넘긴다 — 1면짜리 PDF 를 미리보기로 거절하는 것은 논문뿐이다(실무·기사는 1면일 수 있다).
                const type = cites.get(key)!.authority?.type;
                const got = await loadHumanProvided(ans.answer.note, type ? { type } : {}).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
                if (!('error' in got) && got.warnings?.length) say(`    ⚠ ${label} — 일부를 읽지 못함: ${got.warnings.join('; ').slice(0, 200)}`);
                if ('error' in got) {
                    docCache.set(key, { ...doc, state: 'error', error: `제공된 자료를 읽지 못함: ${got.error}`, how: 'human' });
                    say(`    ⚠ ${label} — 제공된 자료를 읽지 못함: ${got.error.slice(0, 160)}`);
                    // 필자는 줬는데 우리가 못 읽었다 — ②에서 (이유를 보여 주며) 다시 묻는다.
                    askedKeys.delete(key);
                    askedIds.delete(identityOf(cites.get(key)!.display ?? cites.get(key)!.cite.raw));
                } else {
                    docCache.set(key, { state: 'provided', how: 'human', url: got.source, fullText: got.text, chars: got.text.length, ...(got.warnings?.length ? { error: `일부를 읽지 못함: ${got.warnings.join('; ').slice(0, 200)}` } : {}) });
                    remember(key, got.source); // 임시 폴더가 아니라 복사해 둔 경로를 기억한다
                    say(`    ✓ ${label} — 제공받음 ${got.text.length.toLocaleString()}자`);
                }
            } else if (ans.answer.action === 'answered' && ans.answer.note) {
                // 답에 URL 이 있으면 가져와 읽는다 — "여기 있다"는 답은 요약이 아니라 원문 제공이다.
                // file:// 은 앱의 원문 찾기 브라우저가 붙인 파일이다(직접 답하면서 파일도 넣은 경우).
                const urls = ans.answer.note.match(/(?:https?|file):\/\/[^\s"'<>「」『』]+/g);
                const type = cites.get(key)!.authority?.type;
                const got = urls ? await loadHumanProvided(urls.join(' '), type ? { type } : {}).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) })) : null;
                if (got && !('error' in got)) {
                    docCache.set(key, { state: 'provided', how: 'human-web', url: got.source, fullText: `${ans.answer.note}\n\n${got.text}`, chars: got.text.length });
                    say(`    ✓ ${label} — 답의 URL 에서 ${got.text.length.toLocaleString()}자`);
                } else {
                    docCache.set(key, {
                        state: 'provided',
                        how: 'human-summary',
                        fullText: ans.answer.note,
                        chars: ans.answer.note.length,
                        ...(got && 'error' in got ? { error: `URL 을 읽지 못해 답한 내용만 씀: ${got.error.slice(0, 160)}` } : {}),
                    });
                    if (got && 'error' in got) say(`    ◐ ${label} — URL 을 읽지 못해 답한 내용만 씀: ${got.error.slice(0, 120)}`);
                }
                remember(key, `answered:${ans.answer.note}`); // 글로 답한 것도 다음 실행에 다시 묻지 않는다
            } else if (ans.answer.action === 'unavailable' && ans.answer.by === 'assume-unavailable') {
                // --assume-unavailable 은 필자의 답이 아니다 — 아무에게도 묻지 않았다. user_declined 로 두면 각주가 "필자 확인"·"필자가 원문
                // 없음이라 답함"이라 적고, 기억에 남기면 사람이 답할 수 있는 다음 실행에서도 묻지 않는다(실측: 23편 실행 뒤 provided.json
                // 173건이 전부 자동 "없음", 각주 132줄이 "필자가 원문 없음이라 답함"). 사다리가 남긴 상태 그대로 두고, 자동 처리라는 것만 적는다.
                docCache.set(key, { ...doc, how: `${doc.how}+assume-unavailable` });
            } else if (ans.answer.action === 'unavailable') {
                docCache.set(key, { ...doc, state: 'user_declined' });
                remember(key, 'unavailable:'); // 다음 실행에서 같은 것을 다시 묻지 않는다(사다리는 다시 돈다)
            } else {
                say(`    ? ${label} — 답의 형식을 알 수 없어 그대로 둠 (${ans.answer.action})`);
            }
            // 검토 단계는 checkByKey 를 본다 — 여기서 풀어 주지 않으면 필자가 준 원문이 ✓ 로 보이면서 주장은 "미확인"으로 강등된다.
            const ck = checkByKey.get(key);
            if (ck) checkByKey.set(key, reconcileCheck(ck, docCache.get(key)!));
            // 같은 판결·논문을 다른 표기로도 인용했으면 그쪽에도 같은 답을 쓴다.
            const id = identityOf(cites.get(key)!.display ?? cites.get(key)!.cite.raw);
            for (const [k2, e2] of cites) {
                if (k2 === key || identityOf(e2.display ?? e2.cite.raw) !== id) continue;
                docCache.set(k2, docCache.get(key)!);
                const ck2 = checkByKey.get(k2);
                if (ck2) checkByKey.set(k2, reconcileCheck(ck2, docCache.get(key)!));
                askedKeys.add(k2);
            }
        }
        cstat = [...cites.keys()].map(statusOf);
        plan.cites = cstat;
        emit({ type: 'cites', cites: cstat });
        stage('hitl', 'done');
    };
    await askHumans(1);

    // ── snowball ────────────────────────────────────────────────────────────────
    //
    // 원문을 읽고 나서야 알게 되는 것 — 판결이 원용한 선례, 논문이 비판한 선행연구, 참조조문. 확보한 원문의
    // 참고문헌·참조판례·참조조문을 뽑아 모델이 고르고, 코드가 찾는다. 찾은 것은 "보강 자료"로 수정 단계에 간다.
    const boost: ResearchHandle[] = [];
    /** 이미 인용했거나 조사 자료에 있는 것인가 — 사건번호·제목으로 본다(표기 차이로 같은 것을 두 번 찾지 않게). */
    const knownIds = (): Set<string> => {
        const ids = new Set<string>();
        for (const [, e] of cites) {
            ids.add(identityOf(e.display ?? e.cite.raw));
            if (e.authority) ids.add(identityOf(e.authority.citation));
        }
        // 기사·사실 자료는 그 판결·논문의 원문이 아니다 — 그것 때문에 원문 확보를 막지 않는다.
        for (const f of dossier.findings) if (f.kind !== 'news' && f.kind !== 'fact') ids.add(identityOf(f.citation));
        return ids;
    };
    const addBoost = async (citation: string, kind: 'scholarship' | 'precedent' | 'statute', why: string): Promise<SourceDoc> => {
        const authority: Authority = { type: kind, citation, holding: why.slice(0, 200) };
        boostKind.set(identityOf(citation), kind === 'precedent' ? classify(citation) : kind);
        const seeded = preDocs.get(normalizeKey(citation));
        await prefetchLogged([authority]);
        const doc = seeded && USABLE_AS_EVIDENCE.has(seeded.state) ? seeded : await acquireSource(authority, opts.signal ? { signal: opts.signal } : {});
        preDocs.set(normalizeKey(citation), doc);
        preById.set(identityOf(citation), doc);
        ledger.sourceStats[doc.state] = (ledger.sourceStats[doc.state] ?? 0) + 1;
        const text = doc.fullText ?? doc.abstractText ?? '';
        if (!text.trim()) return doc;
        const ex = relevantPassages(text, { proposition: thesis.thesis, holding: why, citation });
        const quote = (ex.passages.map((x) => x.text).join(' ') || text).replace(/\s+/g, ' ').slice(0, 1200);
        const usable = USABLE_AS_EVIDENCE.has(doc.state);
        const id = `R${dossier.findings.length + 1}`;
        const findingKind: Finding['kind'] = kind === 'precedent' ? 'case' : kind === 'statute' ? 'statute' : 'doctrine';
        const summary = `${why.slice(0, 160)}${usable ? '' : ' (전문 미확보 — 초록·서지만)'}`;
        dossier.findings.push({ id, kind: findingKind, authority: 3, citation, summary, quote, ...(doc.url ? { url: doc.url } : {}), fetchedAt: new Date().toISOString() });
        const h: ResearchHandle = { handle: id, kind: findingKind, citation, summary, quote, ...(doc.url ? { url: doc.url } : {}) };
        rh.push(h);
        byHandle.set(id, h);
        boost.push(h);
        return doc;
    };
    // 여러 단계로 따라간다 — 원문의 참고문헌, 그 참고문헌의 참고문헌…. 끝나는 것을 보장하는 장치:
    //  · 이미 본 문헌(identityOf)은 다시 찾지 않는다 → A↔B 상호 인용으로 돌지 않는다
    //  · 새로 가져오는 문헌 총량(budget)과 깊이(depth)에 상한 → 반복은 많아야 depth 번
    //  · 단계마다 모델이 "어느 주장에 필요한가"로 고르고, 고를 것이 없거나 새 전문이 없으면 그 자리에서 멈춘다
    //  · 깊을수록 덜 고르고(6 → 3 → 2), 2단계부터 문헌은 논지와 낱말이 겹쳐야 후보가 된다(주제 이탈 방지)
    halt();
    stage('snowball', 'start');
    say('연쇄 탐색 — 확보한 원문의 참고문헌·참조판례·참조조문');
    const snowLog: { hop: number; candidates: number; picked: number; fullText: number }[] = [];
    {
        // 숫자가 아니면(--snowball-depth x → NaN) 기본값 — NaN 이면 비교가 전부 거짓이 되어 상한이 꺼진다.
        const fin = (v: number | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
        const depth = Math.max(1, Math.min(3, Math.floor(fin(opts.snowballDepth, 2))));
        const budget = Math.max(1, Math.min(40, Math.floor(fin(opts.snowballBudget, 12))));
        const PER_HOP = [6, 3, 2];
        const SHOW = 60; // 모델에게 한 번에 보이는 후보 수
        const visited = knownIds();
        // 주제 관문 낱말 — 주제·핵심 개념·논지의 어간. 조사가 붙은 활용형("판결의", "아니라")을 관문으로 쓰면
        // 주제에 맞는 문헌이 떨어지고 무관한 문헌이 통과한다.
        const GATE_STOP = new Set(['아니라', '필요', '판결', '결정', '구조', '따라서', '대법원', '헌법재판소', '경우', '문제', '연구', '검토', '관한', '대한', '통한']);
        const squash = (x: string) => x.replace(/[\s·ㆍ]/g, '');
        const topicTerms = [
            ...new Set(
                [
                    ...opts.topic.split(/[\s·ㆍ,'"‘’“”]+/),
                    ...thesis.concepts.flatMap((c) => c.term.split(/[\s·ㆍ,]+/)),
                    ...probeTerms(`${thesis.title} ${thesis.thesis}`, sections.flatMap((x) => x.claims)).map(stem),
                ]
                    .map((t) => stem(t.replace(/[^가-힣A-Za-z0-9]/g, '')))
                    .filter((t) => t.length >= 2 && !GATE_STOP.has(t)),
            ),
        ];
        type Src = { text: string; from: string };
        let frontier: Src[] = [];
        for (const [key, e] of cites) {
            const doc = docCache.get(key);
            const kind = e.formalKind ?? e.cite.kind;
            if (!doc || !USABLE_AS_EVIDENCE.has(doc.state) || !doc.fullText || doc.fullText.length < 2000) continue;
            if (kind !== 'scholarship' && kind !== 'precedent' && kind !== 'constitutional') continue;
            frontier.push({ text: doc.fullText, from: e.display ?? e.cite.raw });
        }
        let added = 0;
        let hop = 0;
        let stopWhy = '';
        while (true) {
            if (hop >= depth) {
                stopWhy = `깊이 ${depth}단계에 도달`;
                break;
            }
            if (added >= budget) {
                stopWhy = `총량 ${budget}건에 도달`;
                break;
            }
            if (!frontier.length) {
                stopWhy = hop === 0 ? '따라갈 원문 없음' : '새로 확보한 전문이 없음';
                break;
            }
            halt();
            hop++;
            // 원문마다 후보를 모은 뒤 **돌아가며** 섞는다 — 앞 원문 하나가 보이는 자리(60)를 다 차지하지 않게.
            const perSource: RefCandidate[][] = [];
            const seenThisHop = new Set<string>();
            for (const src of frontier) {
                const mine: RefCandidate[] = [];
                for (const r of extractReferences(src.text)) {
                    const k = identityOf(r.citation);
                    if (visited.has(k) || seenThisHop.has(k)) continue;
                    // 2단계부터 문헌은 주제 낱말이 하나는 겹쳐야 한다(관문 낱말이 없으면 관문을 열어 둔다).
                    // 판례·조문은 참조판례·참조조문에서 온 것이라 둔다.
                    if (hop >= 2 && r.kind === 'scholarship' && topicTerms.length && !topicTerms.some((t) => squash(r.citation).includes(t))) continue;
                    seenThisHop.add(k);
                    mine.push({ ...r, from: src.from });
                }
                perSource.push(mine);
            }
            const candidates: RefCandidate[] = [];
            for (let i = 0; candidates.length < SHOW && perSource.some((p) => i < p.length); i++) {
                for (const p of perSource) if (i < p.length && candidates.length < SHOW) candidates.push(p[i]!);
            }
            const unseen = seenThisHop.size - candidates.length;
            // 모델에게 **보인** 것만 본 것으로 친다 — 못 보인 후보는 다음 단계에서 다시 후보가 될 수 있다.
            for (const c of candidates) visited.add(identityOf(c.citation));
            if (!candidates.length) {
                stopWhy = `${hop}단계: 따라갈 참조 없음`;
                snowLog.push({ hop, candidates: 0, picked: 0, fullText: 0 });
                break;
            }
            const max = Math.min(PER_HOP[hop - 1] ?? 2, budget - added);
            const cnt = (k: RefCandidate['kind']) => candidates.filter((c) => c.kind === k).length;
            say(`    ${hop}단계 후보 ${candidates.length}건 (판례 ${cnt('precedent')} · 문헌 ${cnt('scholarship')} · 조문 ${cnt('statute')})${unseen > 0 ? ` · 표시 못 한 ${unseen}건은 다음 단계로` : ''} — 최대 ${max}건 선택`);
            stage('snowball', 'start', `${hop}/${depth}단계 · 누적 ${added}/${budget}건`);
            let picks: Awaited<ReturnType<typeof pickReferences>>;
            try {
                picks = await pickReferences(
                    { thesis: thesisBlock(thesis), claims: sections.flatMap((x) => x.claims), candidates, max },
                    (schema, o) => ask<any>(schema as never, o as never, usage),
                );
            } catch (e) {
                // 고르기 실패를 "필요한 것 없음"으로 적으면 오류가 숨는다.
                stopWhy = `${hop}단계: 참조 고르기 실패(${e instanceof Error ? e.message.slice(0, 80) : String(e)})`;
                snowLog.push({ hop, candidates: candidates.length, picked: 0, fullText: 0 });
                break;
            }
            if (!picks.length) {
                stopWhy = `${hop}단계: 논지에 필요한 참조 없음`;
                snowLog.push({ hop, candidates: candidates.length, picked: 0, fullText: 0 });
                break;
            }
            const next: Src[] = [];
            for (const pk of picks) {
                const d = await addBoost(pk.citation, pk.kind, pk.why);
                added++;
                say(`    ${hop}단계 ${d.state.padEnd(13)} ${truncate(pk.citation, 60)} — ${truncate(pk.why, 46)}`);
                // 전문이 들어온 판결문·논문만 다음 단계의 출발점이 된다(초록·서지에는 참고문헌이 없다).
                if (USABLE_AS_EVIDENCE.has(d.state) && d.fullText && d.fullText.length >= 2000 && pk.kind !== 'statute') next.push({ text: d.fullText, from: pk.citation });
            }
            snowLog.push({ hop, candidates: candidates.length, picked: picks.length, fullText: next.length });
            frontier = next;
        }
        say(`    연쇄 탐색 종료 — ${stopWhy} · ${hop}단계 · ${added}건`);
        if (!added) stage('snowball', 'skip', stopWhy);
        else stage('snowball', 'done', `${hop}단계 · ${added}건 · ${stopWhy}`);
    }

    // ── review ──────────────────────────────────────────────────────────────────
    halt();
    stage('review', 'start');
    say('적대적 검토 — 주장 추출 · 반대 · 판정');
    const perSection = opts.claimsPerSection ?? S.claims;
    const itemsBySection = new Map<string, LedgerItem[]>();
    /** 마커로 인용된 권위가 없어 내적 타당성으로만 판정한 주장 — 보강 뒤 재판정 때 자리표시 권위를 근거 계산에서 뺀다 */
    const implicitClaims = new Set<string>();
    /** 보강으로 새로 붙은 권위의 인용 문자열(주장별) — 마커 없던 주장은 이것만으로 근거를 센다. 보강 회차를 거쳐 쌓인다. */
    const gainedAuth = new Map<string, Set<string>>();
    const authorityFor = (citation: string): { authority: Authority; doc: SourceDoc } | null => {
        const nk = normalizeKey(citation.replace(/^⟦|⟧$/g, ''));
        const key = cites.has(nk) ? nk : (byFormal.get(nk) ?? nk);
        const e = cites.get(key);
        if (e?.authority) return { authority: e.authority, doc: docCache.get(key) ?? { state: 'error', how: 'none' } };
        // 핸들만 쓴 경우
        const h = byHandle.get(citation.trim().toUpperCase());
        if (h) {
            const k = normalizeKey(h.handle);
            const ee = cites.get(k);
            if (ee?.authority) return { authority: ee.authority, doc: docCache.get(k) ?? { state: 'error', how: 'none' } };
        }
        return null;
    };

    // 품질 루프 설정 — 끄면(--no-quality) 예전 동작: 반대 측 자료 없음, 보강 1회, 재검증·인용 대조 없음.
    const Q = {
        counter: opts.quality?.counter ?? true,
        fireRounds: clampInt(opts.quality?.fireRounds, 1, 3, 3),
        // 기본 1회 — 수정본을 다시 판정해 원장을 최종 원고에 맞춘다. 2회(약하면 한 번 더 고침)는 실측에서 판정은 그대로인데
        // 호출만 늘었다. 2 를 주면 예전처럼 반박·미결·악화 주장을 한 번 더 고친다.
        reverify: clampInt(opts.quality?.reverify, 0, 2, 1),
        citeCheck: opts.quality?.citeCheck ?? true,
    };
    const qualityLog: QualityLog = { counter: { searched: 0, withMaterial: 0, skipped: 0 }, fire: [], reverify: [] };

    /** 판정자·반대측에게 주는 원문 발췌 묶음. */
    const packOf = (rs: SourceResolution[]): string =>
        rs
            .map((r) =>
                r.usable
                    ? `### ${r.authority.citation} [${r.doc.how.startsWith('human-summary') ? '필자 답변 — 원문이 아니라 필자의 진술' : r.doc.state}]\n${renderPassages(r.passages, 2500) || (r.doc.fullText ?? '').slice(0, 2500)}`
                    : `### ${r.authority.citation} [${r.doc.state}] — 원문 미확보. 이 권위를 근거로 쓰지 말 것.`,
            )
            .join('\n\n');

    // 반대 측 자료 — 반대 논증을 세우기 전에 같은 쟁점의 판례(코퍼스 원문)·문헌을 찾아 준다. 반대측이 기억이 아니라
    // 자료에서 공격하게 하려는 것이다. 모델 호출 없이 코드 검색만, 논문 전체 30건까지.
    const COUNTER_CAP = 30;
    /** 주장별 반대 측 자료 — 문자열이 아니라 항목으로 둔다. 쓸 때마다 그 주장의 **지금** 권위를 빼고 그린다(보강이 같은 자료를 근거로 붙였을 수 있다). */
    const counterOf = new Map<string, { id: string; line: string }[]>();
    // 어간으로 줄이면 조사 붙은 일반어("규정은"→규정)가 검색어·관련성 거름을 채운다 — 뺀다.
    const COUNTER_STOP = new Set(['규정', '요건', '절차', '판례', '대법원', '헌법재판소', '법원', '경우', '문제', '기준', '내용', '관련', '사건', '결정', '판결', '법률', '조항', '대상', '의미', '해석', '적용', '필요', '이상', '이하', '전제', '부여', '충족', '발생', '아니라', '대한민국', '시행령']);
    // 용언 꼴("발생하지", "보유만으로", "거주한다")은 검색어가 못 된다 — 명사처럼 끝나는 것만.
    const nounish = (t: string) => !/(?:하지|하고|하며|하여|한다|된다|되지|되고|되어|으로|에서|부터|까지|이며|이고|만|않는|없는|있는|않는다|없다|있다)$/.test(t);
    const counterTerms = (text: string) => [...new Set(probeTerms(text, []).map(stem))].filter((t) => t.length >= 2 && !COUNTER_STOP.has(t) && nounish(t));
    /** 논문 주제의 낱말 — 반대 측 문헌이 이 논문의 주제와 닿는지 거르는 데 쓴다 */
    const topicNouns = new Set(counterTerms(`${opts.topic} ${thesis.title} ${thesis.concepts.map((c) => c.term).join(' ')}`));
    const counterFor = async (claim: Claim): Promise<{ id: string; line: string }[]> => {
        if (!Q.counter) return [];
        if (qualityLog.counter.searched >= COUNTER_CAP) {
            qualityLog.counter.skipped++;
            return [];
        }
        const terms = counterTerms(claim.proposition).slice(0, 5);
        if (terms.length < 2) return [];
        qualityLog.counter.searched++;
        const q = terms.join(' ');
        // KCI 는 짧은 질의에서 정확하다(다섯 낱말을 넣으면 0건) — 문헌 검색은 앞의 두 낱말로.
        const litQ = terms.slice(0, 2).join(' ');
        const own = new Set(claim.authority.map((a) => identityOf(a.citation)));
        const items: { id: string; line: string }[] = [];
        try {
            for (const h of searchCases(q, { limit: 6 })) {
                const cit = citationOf(h);
                const id = identityOf(cit);
                if (own.has(id) || !h.summary?.trim()) continue;
                items.push({ id, line: `- [판례 · 코퍼스 원문] ${cit} — 판시사항: ${truncate(h.summary.replace(/\s+/g, ' '), 260)}` });
                if (items.length >= 2) break;
            }
        } catch {
            /* 코퍼스 없음 */
        }
        try {
            const lit = await searchLiterature(litQ, { limit: 4, ...(scratch ? { scratch } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
            for (const h of lit) {
                if (items.length >= 4) break;
                const id = identityOf(h.citation);
                // 관련성: 주장 낱말 2개, 또는 주장 낱말 1개 + 논문 주제 낱말 1개가 제목에 있어야 한다.
                const claimHits = terms.filter((t) => h.title.includes(t)).length;
                const topicHit = [...topicNouns].some((t) => h.title.includes(t));
                if (!(claimHits >= 2 || (claimHits >= 1 && topicHit)) || own.has(id) || !h.excerpt?.trim()) continue;
                items.push({ id, line: `- [문헌 · ${h.hasFullText ? '전문' : '초록·서지'}] ${h.citation} — ${truncate(h.excerpt.replace(/\s+/g, ' '), 260)}` });
            }
        } catch (e) {
            if (opts.signal?.aborted) throw e;
        }
        if (items.length) qualityLog.counter.withMaterial++;
        return items;
    };
    /** 반대 측 자료 블록. 반대측에게는 "공격에 쓰라", 판정자에게는 "실제로 반박·한정하는지 따져라" — 판정자에게 공격을 시키지 않는다. */
    const counterBlock = (claim: Claim, role: 'con' | 'judge'): string => {
        const own = new Set(claim.authority.map((a) => identityOf(a.citation)));
        const items = (counterOf.get(claim.id) ?? []).filter((x) => !own.has(x.id));
        if (!items.length) return '';
        return [
            '## 반대 측 후보 자료 (도구가 찾은 것, 원문 발췌만 근거로)',
            role === 'con'
                ? '이 명제를 반박하거나 한정하는 데 쓸 수 있으면 쓴다. 쓸모없으면 무시한다. 발췌에 없는 내용을 이 자료에 기대어 주장하지 않는다.'
                : '도구가 찾아 반대측에게 준 자료다. 이 발췌가 명제를 실제로 반박·한정하는지 발췌에 비추어 따진다. 발췌에 없는 내용은 고려하지 않는다.',
            ...items.map((x) => x.line),
        ].join('\n');
    };
    const withCounter = (pack: string, claim: Claim): string => {
        const c = counterBlock(claim, 'judge');
        return c ? `${pack}\n\n${c}` : pack;
    };

    /**
     * 반대 논증 하나. 논문용 반대측(CON_PROMPT_PAPER)에게 명제·권위 원문 발췌·주장 유형·반대 측 자료를 준다.
     * 찬성측의 전제·도약은 주지 않는다(원문에서 다시 시작하게). 형식이 어긋나면 형태를 못박아 한 번 더.
     */
    const objectFor = async (claim: Claim, pack: string, id: string): Promise<Objection> => {
        const counter = counterBlock(claim, 'con');
        const role = claim.role ? `\n\n## 주장 유형\n${claim.role} — 권위는 이 주장의 전제로 쓰였다. 결론이 조문에 문언으로 없다는 것은 반대가 아니다.` : '';
        const conUser = `${conInput(claim, pack)}${role}${counter ? `\n\n${counter}` : ''}`;
        let o: { objections: Objection[] };
        try {
            o = await ask<{ objections: Objection[] }>(ObjectionBatch, {
                name: 'objections',
                description: '주장 하나를 원문 발췌에 비추어 공격하고, 자신을 죽일 조건과 반대의 무게(strength)를 밝힌다',
                system: CON_PROMPT_PAPER,
                user: conUser,
            }, usage);
        } catch (e) {
            if (opts.signal?.aborted) throw e;
            // 모델이 가끔 objections 를 여러 개, 다른 필드 이름으로 낸다. 형태를 못박아 한 번 더.
            o = await ask<{ objections: Objection[] }>(ObjectionBatch, {
                name: 'objections',
                description: '주장 하나를 공격하는 반대 논증 **하나**. objections 배열에 원소 하나, 필드는 claimId·objection·alternative·attack·premise·defeat·authority·strength',
                system: CON_PROMPT_PAPER,
                user: `${conUser}\n\n출력 형식: objections 배열에 **정확히 하나**의 객체. 필드 이름은 objection(반대 논증 본문)·alternative·attack·premise·defeat·authority·strength 그대로.`,
            }, usage);
        }
        if (!o.objections[0]) throw new Error('반대 논증이 비어 있음');
        return { ...o.objections[0], claimId: id };
    };

    /** 판정자 절차 답에 맞춘 조정의 표지 — 재판정마다 지우고 다시 단다(지난 회차의 표지가 다른 판정 옆에 남지 않게). */
    const PROCEDURE_LABELS = ['판정자 절차에 맞춰 박약→지지', '판정자 절차에 맞춰 지지→박약', '판정자 절차에 맞춰 반박→박약'];

    /** 판정을 적용한다 — 근거 등급 · 절차 맞춤 · 코드 강등 · 반박→박약 조정. 검토·보강·재검증이 같이 쓴다. */
    const applyJudgment = (it: LedgerItem, judgment: Judgment): void => {
        const mine = gainedAuth.get(it.claim.id);
        const implicit = implicitClaims.has(it.claim.id);
        delete it.downgrade;
        /** 근거 강등을 거는 인용. undefined 면 걸지 않는다(권위 없이 선 평가·정책 명제). */
        let gc: CitationCheck[] | undefined;
        if (implicit && !mine?.size) {
            // 마커가 지워져도(수정 → recite) 확인되지 않은 권위(not_found 등)를 든 주장은 내적 타당성만으로 보지 않는다 —
            // checkByKey 의 차단 판정은 남는다. 그걸 무시하면 없는 판례에 기댄 명제가 지지로 남았다(mock S2-V1-3).
            const bad = it.citations.flatMap((c, i) => (blockingStates.has(c.state) ? [{ c, r: it.sources[i] }] : []));
            if (bad.length) {
                gc = bad.map((x) => x.c);
                it.evidence = gradeEvidence(bad.flatMap((x) => (x.r ? [x.r] : [])), gc);
            } else {
                it.evidence = { grade: 'none', usableCount: 0, total: 0, reason: '마커로 인용된 권위가 없는 평가·정책 명제 — 내적 타당성으로만 판정' };
            }
        } else {
            // 마커 없던 주장은 검토가 넣은 자리표시 '(명시된 권위 없음)'·마커 없는 권위를 근거 수에 넣지 않는다 —
            // 넣으면 전문을 찾아 줘도 "2건 중 1건만 확보"로 영영 지지가 되지 않는다.
            const gs = implicit && mine ? it.sources.filter((r) => mine.has(r.authority.citation)) : it.sources;
            gc = implicit && mine ? it.citations.filter((c) => mine.has(c.citation)) : it.citations;
            it.evidence = gradeEvidence(gs, gc);
        }
        // 반대측이 "권위가 실재하지 않는다(authority_false)"고 했는데 그 권위의 원문이 확인되어 있으면 표지가 틀렸다 —
        // "권위가 그렇게 말하지 않는다(authority_misread)"로 바로잡는다(실측: 검증된 조문에 authority_false 15건).
        if (it.objection.attack === 'authority_false') {
            const explicitOk = it.sources.length > 0 && it.sources.every((r) => r.usable || r.authority.citation === '(명시된 권위 없음)') && !it.citations.some((c) => blockingStates.has(c.state));
            if (explicitOk && it.sources.some((r) => r.usable)) {
                it.objection = { ...it.objection, attack: 'authority_misread' };
                if (!it.changes?.includes('반대 공격 유형 정정(authority_false→misread)')) it.changes = [...(it.changes ?? []), '반대 공격 유형 정정(authority_false→misread)'];
            }
        }
        // 판정자 자신의 절차 답과 판정을 맞춘다(JUDGE_PROMPT_PAPER: 1·2 참·4 거짓 → 지지, 4 참 → 박약, 1·2 가 깨져야 반박) —
        // 전제 확인 · 추론 타당 · 대안이 똑같이 그럴듯하지 않음인데 박약이면 지지, 전제 미확인·추론 단절·대안 동등인데 지지면 박약,
        // 전제·추론이 다 섰는데 반박이면 박약. (실측: 공정 판정이 지지인 13건이 박약으로 남았고 판정자는 문언주의를 1건만 알아봤다.)
        // 지난 판정의 표지는 지운다 — 재판정이 맞춤 없이 끝났는데 "박약→지지"가 남아 있으면 감사 기록이 거짓이 된다.
        if (it.changes?.some((c) => PROCEDURE_LABELS.includes(c))) it.changes = it.changes.filter((c) => !PROCEDURE_LABELS.includes(c));
        const judged = judgment;
        const P = judgment.premises_supported;
        const I = judgment.inference_valid;
        const A = judgment.alternative_equally_plausible;
        const relabel = (to: Judgment['verdict'], label: string) => {
            judgment = { ...judgment, verdict: to };
            it.changes = [...(it.changes ?? []), label];
        };
        // 반박→박약은 코드 자신의 검증이 권위를 막지 않았을 때만이다. 인용이 원문에서 확인되지 않았으면(not_found 등 · 근거 '미확인')
        // 판정자의 반박은 코드가 확인한 사실(없는 판례에 기댄 명제)과 맞는다 — 절차 답(전제·추론 참)이 그와 어긋나도 반박으로 둔다.
        // 박약으로 올리면 강등(지지만 내린다)도 걸리지 않아, 수정 단계가 그 문장을 지우지 않고 유보로 남긴다.
        const codeBlocks = it.evidence.grade === 'fabricated' || (gc ?? []).some((c) => blockingStates.has(c.state));
        if (judgment.verdict === 'weak' && P === true && I === true && A === false) relabel('supported', PROCEDURE_LABELS[0]!);
        else if (judgment.verdict === 'supported' && (P === false || I === false || A === true)) relabel('weak', PROCEDURE_LABELS[1]!);
        else if (judgment.verdict === 'refuted' && P === true && I === true && !codeBlocks) relabel('weak', PROCEDURE_LABELS[2]!);
        // 근거 등급 강등은 절차 맞춤 **뒤에** 건다 — 앞에서 걸면 박약→지지로 올라간 판정이 강등을 비켜 갔다(실측: not_found 판례
        // 하나에 기댄 명제가 지지). 판정자가 낸 지지가 절차로 박약이 되었어도, 그 지지에 걸렸을 강등(→미결)은 그대로 받는다.
        let down = gc ? (enforceEvidence(judgment, it.evidence, gc) ?? enforceEvidence(judged, it.evidence, gc)) : undefined;
        // 내린 등급이 판정자의 것이 아니라 절차 맞춤이 낸 것이면 판정자의 등급을 따로 남긴다 — 보고서가 "판정자가 지지를 냈다"고 적지 않게.
        if (down && judged.verdict !== down.from) down = { ...down, why: `${down.why} — 판정자는 ${judged.verdict}, 절차 답으로 ${down.from}`, judged: judged.verdict };
        const q = judgment.objection_quality;
        const weakObjection = (q !== undefined && q !== 'substantive') || it.objection.strength === 'none';
        if (down) {
            it.downgrade = down;
            it.judgment = { ...judgment, verdict: down.to as Judgment['verdict'] };
        } else if (judgment.verdict === 'refuted' && weakObjection) {
            // 실질적이지 않은 반대(문언주의·낡은 "원문 없음"·반대 없음)만으로는 반박이 아니다.
            it.downgrade = { from: 'refuted', to: 'weak', why: `반대가 실질적이지 않음(${q ?? `strength ${it.objection.strength}`}) — 반박이 아니라 박약으로 조정` };
            it.judgment = { ...judgment, verdict: 'weak' };
        } else if (judgment.verdict === 'refuted' && !AUTHORITY_ATTACKS.has(it.objection.attack)) {
            // 반박은 권위가 모순되거나 오귀속되었을 때만이다. 추론 간극·전제 다툼·귀결은 박약이다 —
            // 프롬프트로 부탁해도 모델은 침묵을 반박으로 썼다(27개 중 13개). 그래서 코드가 조정한다.
            it.downgrade = { from: 'refuted', to: 'weak', why: `반대의 공격 유형이 '${it.objection.attack}' — 권위의 모순·오독이 아니므로 반박이 아니라 박약으로 조정` };
            it.judgment = { ...judgment, verdict: 'weak' };
        } else {
            it.judgment = judgment;
        }
    };

    /** 판정만 다시 낸다(반대는 그대로) — 보강 회차가 쓴다. "전 → 후" 문자열을 돌려준다. */
    const rejudge = async (sid: string, it: LedgerItem, description: string): Promise<string> => {
        const before = `${it.judgment.verdict}(${(it.judgment.confidence ?? 0).toFixed(2)})`;
        const j = await ask<{ judgments: Judgment[] }>(JudgeBatch, {
            name: 'judgments',
            description,
            system: JUDGE_PROMPT_PAPER,
            user: judgeInput(it.claim, it.objection, withCounter(packOf(it.sources), it.claim)),
        }, usage);
        if (!j.judgments[0]) throw new Error('판정이 비어 있음');
        applyJudgment(it, { ...j.judgments[0], claimId: it.claim.id });
        emit({ type: 'review', sectionId: sid, item: it });
        return `${before} → ${it.judgment.verdict}(${(it.judgment.confidence ?? 0).toFixed(2)})`;
    };

    /** 장의 원고에서 하중을 지는 주장을 뽑는다 — 초고 검토와 수정본 재검증이 같이 쓴다. */
    const extractClaims = async (s: PaperSection, text: string): Promise<ClaimExtractT[]> => {
        try {
            const out = await ask<{ claims: ClaimExtractT[] }>(ClaimExtractBatch, {
                name: 'claims_extract',
                description: '장의 원고에서 하중을 지는 주장을 뽑는다',
                system: EXTRACT_PROMPT,
                user: [`## 장: ${s.number}. ${s.title}`, '', text, '', `하중을 지는 주장 ${perSection}개 이하를 뽑는다.`].join('\n'),
            }, usage);
            return out.claims.slice(0, perSection);
        } catch (e) {
            if (opts.signal?.aborted) throw e;
            say(`    ${s.number} 주장 추출 실패: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`);
            return [];
        }
    };

    /** 주장 하나를 검토한다 — 원문 연결 · 반대 측 자료 · 반대 · 판정 · 코드 강등. 실패하면 null. */
    const reviewClaim = async (s: PaperSection, ex: ClaimExtractT, id: string): Promise<LedgerItem | null> => {
        // 초고의 권위를 확보된 원문에 연결한다. 마커로 인용된 권위만 원문과 연결된다. 그런 권위가 하나도 없는
        // 주장(순수 평가·정책 명제)은 "원문 미확인"으로 강등하지 않는다 — JUDGE_PROMPT_PAPER 대로 내적 타당성으로 판정한다.
        const explicit = ex.authority.filter((a) => authorityFor(a.citation));
        const implicitOnly = explicit.length === 0;
        if (implicitOnly) implicitClaims.add(id);
        const authority: Authority[] = explicit.length ? explicit : ex.authority.length ? ex.authority : [{ type: 'scholarship', citation: '(명시된 권위 없음)', holding: '' }];
        const claim: Claim & { span?: string } = { id, proposition: ex.proposition, role: ex.role, premise: ex.premise, step: ex.step, authority, span: ex.span };
        const resolved = authority.map((a) => {
            const hit = authorityFor(a.citation);
            const auth = hit ? { ...hit.authority, holding: a.holding || hit.authority.holding } : a;
            const doc = hit?.doc ?? { state: 'not_found' as const, how: 'none', error: '초고에 마커가 없는 권위' };
            return resolutionFor(auth, doc, claim);
        });
        const citations: CitationCheck[] = authority.map((a) => {
            const key = normalizeKey(a.citation);
            return checkByKey.get(key) ?? { citation: a.citation, type: a.type, state: 'unverifiable', note: '초고에 인용 마커가 없어 검증 대상이 아님' };
        });
        const pack = packOf(resolved);
        const counterItems = await counterFor(claim);
        if (counterItems.length) counterOf.set(id, counterItems);
        const counter = counterBlock(claim, 'con');
        let objection: Objection;
        let judgment: Judgment;
        try {
            objection = await objectFor(claim, pack, id);
            const j = await ask<{ judgments: Judgment[] }>(JudgeBatch, {
                name: 'judgments',
                description: '주장과 반대를 원문에 비추어 4등급으로 판정한다',
                system: JUDGE_PROMPT_PAPER,
                user: judgeInput(claim, objection, withCounter(pack, claim)),
            }, usage);
            if (!j.judgments[0]) throw new Error('판정이 비어 있음');
            judgment = { ...j.judgments[0], claimId: id };
        } catch (e) {
            if (opts.signal?.aborted) throw e;
            say(`    ${id} 검토 실패: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`);
            return null;
        }
        const item: LedgerItem = { claim, citations, sources: resolved, evidence: gradeEvidence(resolved, citations), objection, judgment, human: [] };
        applyJudgment(item, judgment);
        emit({ type: 'review', sectionId: s.id, item });
        const down = item.downgrade;
        say(`    ${id.padEnd(8)} ${item.judgment.verdict}${down ? ` (강등 ${down.from}→${down.to})` : ''}${counter ? ' · 반대 측 자료' : ''} · ${truncate(claim.proposition, 56)}`);
        return item;
    };

    await Promise.all(
        sections.map((s) =>
            limiter.run(async () => {
                if (!s.draft || s.role === 'intro' || s.role === 'conclusion') {
                    itemsBySection.set(s.id, []);
                    return;
                }
                const extracted = await extractClaims(s, s.draft);
                const items: LedgerItem[] = [];
                for (let i = 0; i < extracted.length; i++) {
                    const it = await reviewClaim(s, extracted[i]!, `${s.id}-C${i + 1}`);
                    if (it) items.push(it);
                }
                itemsBySection.set(s.id, items);
                s.claimIds = items.map((it) => it.claim.id);
            }),
        ),
    );
    if (qualityLog.counter.skipped) say(`    반대 측 자료 검색 상한(${COUNTER_CAP}건) — ${qualityLog.counter.skipped}개 주장은 검색 없이 검토`);
    stage('review', 'done', `${[...itemsBySection.values()].flat().length}개 주장${Q.counter ? ` · 반대 측 자료 ${qualityLog.counter.withMaterial}건` : ''}`);

    // ── gapfill ─────────────────────────────────────────────────────────────────
    //
    // 판정이 "이게 있어야 판단된다"고 한 것(discriminators)을 찾아온다 — FIRE(Xie et al. 2024) 식으로 **반복**한다.
    //  · 회차마다: 대상 주장의 질의를 만들고(이미 시도한 검색어는 다시 쓰지 않는다) → 찾아 붙이고 → 새 원문이 생긴 주장만 재판정
    //  · 주장이 루프를 떠나는 때: 확신했을 때(지지·반박, 또는 확신도 0.7 이상의 박약), 그 회차에 새 원문이 없을 때, 회차 상한
    //  · 회차마다 대상 6건까지, 회차는 많아야 3번(끄면 1번 — 예전 동작)
    // 판정이 자료를 요구했는데 자료를 주고 판정을 안 바꾸면 요구가 장식이다.
    halt();
    stage('gapfill', 'start');
    {
        const FIRE_CONF = 0.7;
        const VKo: Record<string, string> = { supported: '지지', weak: '박약', refuted: '반박', unresolved: '미결' };
        const allItems = [...itemsBySection.entries()].flatMap(([sid, its]) => its.map((it) => ({ sid, it })));
        const askFn = (schema: unknown, o: { name: string; description: string; system: string; user: string }) => ask<any>(schema as never, o as never, usage);
        const known = knownIds();
        /** 주장별로 이미 시도한 검색어(공백 지운 소문자) */
        const tried = new Map<string, Set<string>>();
        /** 루프를 떠난 주장 */
        const retired = new Set<string>();
        const qkey = (q: string) => q.replace(/\s+/g, '').toLowerCase();
        /** 이미 어딘가에 있는 원문(인용 확보·연쇄 탐색) — 다시 찾지 말고 이 주장에 붙인다 */
        const findKnownDoc = (fid: string, citation: string): SourceDoc | undefined => {
            const pre = preDocs.get(normalizeKey(citation));
            if (pre && USABLE_AS_EVIDENCE.has(pre.state)) return pre;
            for (const [k, e] of cites) {
                if (identityOf(e.display ?? e.cite.raw) !== fid && !(e.authority && identityOf(e.authority.citation) === fid)) continue;
                const d = docCache.get(k);
                if (d && USABLE_AS_EVIDENCE.has(d.state)) return d;
            }
            const byId = preById.get(fid);
            if (byId && USABLE_AS_EVIDENCE.has(byId.state)) return byId;
            return undefined;
        };
        const eligible = ({ it }: { it: LedgerItem }): boolean => {
            if (retired.has(it.claim.id)) return false;
            const v = it.judgment.verdict;
            if (v === 'unresolved') return true; // 미결은 "판정"이 아니다 — 확신도와 무관하게 자료를 더 찾는다
            if (v !== 'weak' || !it.judgment.discriminators.length) return false;
            return Q.fireRounds === 1 || (it.judgment.confidence ?? 0) < FIRE_CONF;
        };
        let rounds = 0;
        let rejudgedTotal = 0;
        for (let round = 1; round <= Q.fireRounds; round++) {
            halt();
            const targets = allItems
                .filter(eligible)
                .sort((a, b) => (a.it.judgment.verdict === 'unresolved' ? 0 : 1) - (b.it.judgment.verdict === 'unresolved' ? 0 : 1))
                .slice(0, 6);
            if (!targets.length) break;
            rounds = round;
            say(`보강${Q.fireRounds > 1 ? ` ${round}회차` : ''} — 판정이 자료를 요구한 주장 ${targets.length}건`);
            stage('gapfill', 'start', Q.fireRounds > 1 ? `${round}/${Q.fireRounds}회차 · 대상 ${targets.length}건` : `대상 ${targets.length}건`);
            let needs: { claimId: string; kind: 'precedent' | 'statute' | 'scholarship' | 'fact'; query: string; citation?: string; why: string }[] = [];
            try {
                const out = await ask<{ needs: typeof needs }>(GapNeedList, {
                    name: 'gap_needs',
                    description: '판정이 요구한 자료를 찾기 위한 질의를 만든다',
                    system: GAP_PROMPT,
                    user: [
                        thesisBlock(thesis),
                        '',
                        ...targets.map(({ it }) => {
                            const prev = [...(tried.get(it.claim.id) ?? [])];
                            return [
                                `### ${it.claim.id} — ${VKo[it.judgment.verdict] ?? it.judgment.verdict}`,
                                `주장: ${it.claim.proposition}`,
                                `이미 있는 권위: ${it.claim.authority.map((a) => a.citation).join(' · ') || '(없음)'}`,
                                `판정 이유: ${it.judgment.reasoning.slice(0, 500)}`,
                                '이 판정을 뒤집을 수 있는 것:',
                                ...it.judgment.discriminators.slice(0, 5).map((d) => `- ${d}`),
                                ...(prev.length ? [`이미 시도한 검색어(다시 쓰지 않는다): ${prev.join(' · ')}`] : []),
                            ].join('\n');
                        }),
                        '',
                        '주장마다 최대 2개의 질의를 만든다.',
                    ].join('\n'),
                }, usage);
                needs = (out.needs ?? []).slice(0, 12);
            } catch (e) {
                if (opts.signal?.aborted) throw e;
                say(`    질의 생성 실패: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`);
            }
            // 이미 시도한 검색어는 버린다 — 같은 검색을 되풀이하면 회차가 아니라 반복이다.
            if (Q.fireRounds > 1) needs = needs.filter((n) => {
                const set = tried.get(n.claimId) ?? new Set<string>();
                // 종류와 정식 인용까지 같아야 같은 검색이다 — 같은 검색어라도 판례 검색과 문헌 검색은 다르다.
                const k = qkey(`${n.kind}:${n.citation || n.query || ''}`);
                if (!k || set.has(k)) {
                    if (k) say(`    ${n.claimId.padEnd(8)} 이미 시도한 검색어 — ${truncate(n.query, 40)}`);
                    return false;
                }
                set.add(k);
                tried.set(n.claimId, set);
                return true;
            });
            const gained = new Set<string>();
            for (const n of needs) {
                const t = targets.find((x) => x.it.claim.id === n.claimId);
                if (!t) continue;
                const found: { citation: string; kind: 'scholarship' | 'precedent' | 'statute' }[] = [];
                try {
                    if (n.kind === 'statute') {
                        if (n.citation && /제\s*\d+\s*조/.test(n.citation)) found.push({ citation: n.citation, kind: 'statute' });
                        else {
                            const law = /([가-힣·\s]{2,30}?(?:법률|법|령|규칙))/.exec(n.query)?.[1]?.trim();
                            if (law) for (const h of findCandidateArticles({ laws: [law], terms: probeTerms(n.query, [t.it.claim.proposition]), perLaw: 2 })) found.push({ citation: `${h.law} ${h.articleNo}`, kind: 'statute' });
                        }
                    } else if (n.kind === 'precedent') {
                        if (n.citation && parsePrecedentCitation(n.citation)) found.push({ citation: n.citation, kind: 'precedent' });
                        else {
                            const cands = searchCases(n.query, { limit: 12 });
                            if (cands.length) for (const h of (await rerankCases(t.it.claim.proposition, cands, askFn)).slice(0, 2)) found.push({ citation: citationOf(h), kind: 'precedent' });
                        }
                    } else if (n.kind === 'scholarship') {
                        const hits = await searchLiterature(n.query, { limit: 3, ...(scratch ? { scratch } : {}) });
                        // 키워드 검색은 어휘만 맞으면 엉뚱한 분야를 물어온다("인증 수준" → 어린이집 평가인증). 제목이
                        // 주장·질의와 용어를 둘 이상(어휘가 둘뿐이면 하나) 공유해야 한다.
                        const vocab = new Set(probeTerms(`${t.it.claim.proposition} ${n.query} ${n.why}`, []));
                        const need = Math.min(2, vocab.size);
                        const relevant = hits.filter((h) => [...vocab].filter((v) => v.length >= 2 && h.title.includes(v)).length >= need);
                        for (const h of relevant.slice(0, 2)) found.push({ citation: h.citation, kind: 'scholarship' });
                        if (hits.length && !relevant.length) say(`    ${t.it.claim.id.padEnd(8)} 문헌 ${hits.length}건 중 관련 없음 — ${truncate(n.query, 40)}`);
                        if (!relevant.length && n.citation) found.push({ citation: n.citation, kind: 'scholarship' });
                    } else {
                        const { results } = await searchWeb(n.query, { count: 3, content: true });
                        for (const r of results.slice(0, 2)) {
                            const text = `${r.summary ?? ''} ${r.content ?? ''}`.trim();
                            if (text.length < 80) continue;
                            const id = `R${dossier.findings.length + 1}`;
                            const citation = `${cleanTitle(r.title)} <${r.url}>`;
                            const quote = text.replace(/\s+/g, ' ').slice(0, 600);
                            dossier.findings.push({ id, kind: 'news', ...(r.authority !== undefined ? { authority: r.authority } : {}), citation, summary: (r.snippet || quote).slice(0, 240), quote, url: r.url, fetchedAt: new Date().toISOString() });
                            const h: ResearchHandle = { handle: id, kind: 'news', citation, summary: (r.snippet || quote).slice(0, 240), quote, url: r.url };
                            rh.push(h);
                            byHandle.set(id, h);
                            boost.push(h);
                        }
                        say(`    ${t.it.claim.id.padEnd(8)} 사실 자료 ${results.length}건 — ${truncate(n.query, 40)}`);
                    }
                } catch (e) {
                    if (opts.signal?.aborted) throw e;
                    say(`    ${t.it.claim.id.padEnd(8)} 탐색 실패: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
                }
                for (const f of found.slice(0, 2)) {
                    // 이미 인용했거나 ①에서 물어본 것(쪽수·법원 표기만 다른 것 포함)은 다시 찾지도 묻지도 않는다.
                    const fid = identityOf(f.citation);
                    let d: SourceDoc;
                    // 1) 이미 확보된 원문(인용 확보·①에서 필자가 준 것·연쇄 탐색) — 판정이 "이게 필요하다"고 했으니 **이 주장에** 붙인다.
                    const have = findKnownDoc(fid, f.citation);
                    if (have) {
                        d = have;
                        say(`    ${t.it.claim.id.padEnd(8)} 이미 있음 → 붙임 ${truncate(f.citation, 54)}`);
                    } else if (askedIds.has(fid)) {
                        // 2) ①에서 물었는데 원문을 얻지 못한 것 — 다시 찾지도 묻지도 않는다.
                        say(`    ${t.it.claim.id.padEnd(8)} 이미 물어봄    ${truncate(f.citation, 60)}`);
                        continue;
                    } else if (boostKind.has(fid)) {
                        // 3) 이번 보강·연쇄 탐색에서 이미 사다리를 태운 것 — 같은 실패를 되풀이하지 않는다.
                        say(`    ${t.it.claim.id.padEnd(8)} 이미 찾아봄    ${truncate(f.citation, 60)}`);
                        continue;
                    } else {
                        // 4) 조사 자료에 서지만 있거나 처음 보는 것 — 사다리를 태운다(조사 자료에 있다고 원문이 있는 것은 아니다).
                        known.add(fid);
                        d = await addBoost(f.citation, f.kind, n.why);
                        say(`    ${t.it.claim.id.padEnd(8)} ${d.state.padEnd(13)} ${truncate(f.citation, 60)}`);
                    }
                    if (!USABLE_AS_EVIDENCE.has(d.state)) continue;
                    // 같은 자료를 같은 주장에 두 번 붙이지 않는다(회차가 바뀌어도). 이미 **쓸 수 있는** 원문으로 붙어 있을 때만 건너뛴다 —
                    // 마커 없이 이름만 있던 권위(원문 없음)는 보강이 찾아온 원문으로 채워야 한다.
                    if (t.it.sources.some((r) => r.usable && identityOf(r.authority.citation) === fid)) continue;
                    const auth: Authority = { type: f.kind, citation: f.citation, holding: n.why.slice(0, 200) };
                    const r = resolutionFor(auth, d, t.it.claim);
                    if (!r.usable) continue;
                    t.it.sources.push(r);
                    t.it.claim.authority.push(auth);
                    // 웹에서 본문을 확인한 판례가 코퍼스 색인에 없다고 차단 판정이 되면, 살리려던 주장을 그 자료로 강등하게 된다.
                    t.it.citations.push(reconcileCheck(verifyAll([auth])[0]!, d));
                    gained.add(t.it.claim.id);
                    if (!gainedAuth.has(t.it.claim.id)) gainedAuth.set(t.it.claim.id, new Set());
                    gainedAuth.get(t.it.claim.id)!.add(auth.citation);
                }
            }
            // 재판정 — 새 원문이 생긴 주장만. 반대는 그대로 두고 판정자만 다시 본다.
            // 새 원문이 없는 주장은 루프를 떠난다(다음 회차에 같은 판정·같은 질의가 되풀이될 뿐이다).
            let rejudged = 0;
            for (const { sid, it } of targets) {
                if (!gained.has(it.claim.id)) {
                    retired.add(it.claim.id);
                    continue;
                }
                try {
                    // 반대가 "원문이 없다"에 기대고 있었는데 이제 원문이 붙었으면, 낡은 반대로 재판정하지 않고 반대부터 다시 세운다.
                    // 판정자가 이미 낡은 반대라고 적었으면(stale_missing_source) 문구와 상관없이 그렇다.
                    const stale = STALE_OBJECTION.test(it.objection.objection) || it.judgment.objection_quality === 'stale_missing_source';
                    if (stale && it.sources.some((r) => r.usable)) {
                        it.objection = await objectFor(it.claim, packOf(it.sources), it.claim.id);
                        it.changes = [...(it.changes ?? []), '보강 뒤 반대 다시 세움'];
                        say(`    ${it.claim.id.padEnd(8)} 원문이 생겨 반대를 다시 세움`);
                    }
                    const tr = await rejudge(sid, it, '보강 자료를 더해 다시 판정한다');
                    rejudged++;
                    say(`    ${it.claim.id.padEnd(8)} 재판정 ${tr}`);
                } catch (e) {
                    if (opts.signal?.aborted) throw e;
                    retired.add(it.claim.id);
                    say(`    ${it.claim.id.padEnd(8)} 재판정 실패: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
                }
            }
            rejudgedTotal += rejudged;
            qualityLog.fire.push({ round, targets: targets.length, needs: needs.length, gained: gained.size, rejudged });
        }
        if (!rounds) stage('gapfill', 'skip', '보강할 주장 없음');
        else stage('gapfill', 'done', `${rounds}회차 · ${boost.length}건 보강 · 재판정 ${rejudgedTotal}건`);
    }

    /** 이 장과 어휘가 겹치는 보강 자료만 준다 — 전부 주면 무관한 자료가 끼어든다. 적으면(≤6) 전부 준다. */
    const boostBlock = (sec: PaperSection): string => {
        if (!boost.length) return '## 보강 자료\n(없음 — 새 인용을 추가하지 않는다)';
        const terms = probeTerms(`${sec.title} ${sec.brief}`, sec.claims);
        const mine = boost.length <= 6 ? boost : boost.filter((h) => terms.some((t) => `${h.citation} ${h.quote ?? ''} ${h.summary}`.includes(t)));
        if (!mine.length) return '## 보강 자료\n(이 장과 관련된 것 없음 — 새 인용을 추가하지 않는다)';
        return [
            '## 보강 자료 (연쇄 탐색·보강에서 새로 확보. 이 장에 필요하면 ⟦정식 인용⟧ 으로 추가할 수 있다)',
            ...mine.slice(0, 10).map((h) => {
                // 웹 기사·보도자료 같은 사실 자료는 정식 서지가 없다 — 조사 자료처럼 핸들(⟦R14⟧)로 인용하게 한다.
                // 제목을 ⟦ ⟧ 에 넣으면 '대법원'이 든 기사 제목이 판례로 분류되어 판례 사다리를 탄다.
                if (h.kind === 'news' || h.kind === 'practice' || h.kind === 'other') return `- ⟦${h.handle}⟧ ${h.citation} — 공개자료 — ${h.summary.slice(0, 120)}\n  "${(h.quote ?? '').slice(0, 320)}"`;
                const d = preDocs.get(normalizeKey(h.citation));
                const state = d && USABLE_AS_EVIDENCE.has(d.state) ? '전문' : '초록·서지만 (단정 금지)';
                return `- ⟦${h.citation}⟧ — ${state} — ${h.summary.slice(0, 120)}\n  "${(h.quote ?? '').slice(0, 320)}"`;
            }),
        ].join('\n');
    };

    // ── revise ──────────────────────────────────────────────────────────────────
    halt();
    stage('revise', 'start');
    // 각주(cite.ts renderFootnotes)와 같은 표지를 쓴다 — 수정 단계와 원고가 같은 인용을 다르게 부르면 안 된다.
    const markOf = (c: CiteStatus) => {
        const m = statusMark(c);
        return `${m.mark} ${m.label}`;
    };
    const VK: Record<string, string> = { supported: '지지', weak: '박약', refuted: '반박', unresolved: '미결' };
    /**
     * 장 하나를 고쳐 쓴다 — 인용 상태표 · 검토 결과 · 보강 자료를 들고. 수정과 재검증이 같이 쓴다.
     * 실패하거나 터무니없이 짧으면(거절·잘림) 원래 원고를 돌려준다 — 빈 장보다 낫다.
     */
    const reviseSection = async (s: PaperSection, base: string, items: LedgerItem[], baseLabel: string, focus?: string): Promise<string> => {
        const mine = cstat.filter((c) => c.sections.includes(s.id));
        const quoteOf = (c: CiteStatus) => {
            const d = docCache.get(c.key);
            const t = d?.fullText ?? d?.abstractText ?? '';
            return t ? t.replace(/\s+/g, ' ').slice(0, 320) : '';
        };
        const table = mine.length
            ? mine
                  .map((c) => {
                      const q = quoteOf(c);
                      return `- ⟦${c.raw}⟧ → ${markOf(c)}${c.note ? ` (${c.note.slice(0, 100)})` : ''}${q ? `\n  원문 발췌: "${q}"` : ''}`;
                  })
                  .join('\n')
            : '(이 장에는 인용 마커가 없다)';
        const reviews = items.length
            ? items
                  .map(
                      (it) =>
                          `### ${it.claim.id} — ${VK[it.judgment.verdict] ?? it.judgment.verdict}${it.downgrade ? ' (근거 부족으로 강등)' : ''}\n주장: ${it.claim.proposition}\n본문 위치: "${(it.claim as Claim & { span?: string }).span?.slice(0, 200) ?? ''}"\n반대(${it.objection.attack}): ${it.objection.objection.slice(0, 400)}\n판정 이유: ${it.judgment.reasoning.slice(0, 500)}${it.judgment.surviving.length ? `\n살아남은 반대:\n${it.judgment.surviving.map((x) => `- ${x}`).join('\n')}` : ''}`,
                  )
                  .join('\n\n')
            : '(이 장은 검토 대상 주장이 없다 — 인용 상태표만 반영한다)';
        const user = [
            thesisBlock(thesis),
            '',
            `## 이 장: ${s.number}. ${s.title}`,
            `역할: ${s.role} · 분량 약 ${s.targetChars.toLocaleString()}자`,
            '',
            baseLabel,
            base,
            '',
            '## 인용 상태표',
            table,
            '',
            '## 검토 결과',
            reviews,
            '',
            boostBlock(s),
            '',
            focus ?? '검증 결과에 비추어 이 장을 고쳐 쓴다. 고친 본문 전체만 출력한다.',
        ].join('\n');
        try {
            let body = await write({ name: 'revise', system: REVISE_SECTION_PROMPT, user, maxTokens: tokensFor(s.targetChars) });
            body = stripOwnHeading(body, s.title);
            if (body.length >= Math.min(400, base.length * 0.4)) return body;
            say('    수정본이 너무 짧아 이전 원고를 유지');
            return base;
        } catch (e) {
            if (opts.signal?.aborted) throw e;
            say(`    수정 실패 — 이전 원고 유지: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`);
            return base;
        }
    };
    await Promise.all(
        sections.map((s) =>
            limiter.run(async () => {
                if (!s.draft) return;
                const mine = cstat.filter((c) => c.sections.includes(s.id));
                const items = itemsBySection.get(s.id) ?? [];
                const changesNeeded = mine.some((c) => !markOf(c).startsWith('✓') && !markOf(c).startsWith('◐')) || items.some((it) => it.judgment.verdict !== 'supported');
                if (!changesNeeded) {
                    s.revised = s.draft;
                    emit({ type: 'section', section: s, phase: 'revised' });
                    say(`수정 — ${s.number}. ${s.title}: 고칠 것 없음`);
                    return;
                }
                say(`수정 — ${s.number}. ${s.title}`);
                s.revised = await reviseSection(s, s.draft, items, '## 초고');
                emit({ type: 'section', section: s, phase: 'revised' });
            }),
        ),
    );
    /**
     * 원고의 인용을 다시 센다. 새 마커(보강 자료)는 **확보·검증**하고, 지워진 마커는 상태표에서 뺀다 — 집계는 초고가 아니라
     * 원고를 말해야 한다. 사람에게 묻지는 않는다(묻는 것은 수정 직후 한 번, askHumans(2)).
     */
    const recite = async (): Promise<number> => {
        for (const e of cites.values()) e.sections.clear();
        const fresh: CiteEntry[] = [];
        for (const s of sections) {
            for (const c of extractCites(s.revised ?? s.draft ?? '')) {
                if (cites.has(c.key)) {
                    cites.get(c.key)!.sections.add(s.id);
                    continue;
                }
                const e: CiteEntry = { ...entryFor(c), sections: new Set([s.id]) };
                cites.set(c.key, e);
                fresh.push(e);
            }
            s.citeKeys = extractCites(s.revised ?? s.draft ?? '').map((c) => c.key);
        }
        for (const [k, e] of [...cites.entries()]) if (!e.sections.size) cites.delete(k);
        if (fresh.length) {
            say(`    원고의 새 인용 ${fresh.length}건 — 확보·검증`);
            await Promise.all(fresh.map((e) => limiter.run(() => resolveCite(e))));
        }
        cstat = [...cites.keys()].map(statusOf);
        plan.cites = cstat;
        emit({ type: 'cites', cites: cstat });
        return fresh.length;
    };
    await recite();
    await askHumans(2);
    stage('revise', 'done');

    // ── reverify ────────────────────────────────────────────────────────────────
    //
    // 수정 단계가 고치거나 새로 쓴 문장은 판정을 받은 적이 없다. 바뀐 장의 주장을 다시 뽑아
    //  · 예전 주장과 같으면(어간 Jaccard ≥ 0.5, 마커로 인용한 권위가 같음) 예전 판정을 그대로 쓰고
    //  · 아니면 반대 측 자료·반대·판정을 다시 돌린다.
    // 다시 판정한 주장이 반박·미결이거나 판정이 나빠졌으면 **그 주장들만** 들고 한 번 더 고치고 다시 검증한다. 검증은 많아야 2회 —
    // 마지막 회차 뒤에는 고치지 않으므로 원고와 판정이 어긋나지 않는다.
    halt();
    stage('reverify', 'start');
    if (Q.reverify <= 0) {
        stage('reverify', 'skip', '꺼짐');
    } else {
        const termsOf = (p: string) => new Set(probeTerms(p, []).map(stem).filter((t) => t.length >= 2));
        const jaccard = (a: Set<string>, b: Set<string>) => {
            if (!a.size && !b.size) return 1;
            let inter = 0;
            for (const x of a) if (b.has(x)) inter++;
            return inter / (a.size + b.size - inter);
        };
        const markedIds = (as: { citation: string }[]) => new Set(as.filter((a) => authorityFor(a.citation)).map((a) => identityOf(a.citation)));
        const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
        // 판정의 서열 — 수정 뒤 판정이 나빠졌는지 본다.
        const RANK: Record<string, number> = { supported: 3, weak: 2, unresolved: 1, refuted: 0 };
        // 부정·유보 표지 — 어간 비교는 "있다/없다"를 못 가린다("압수할 수 있다" ↔ "없다" 의 Jaccard 가 1이다).
        const POL = /(않|없|아니|못하|불가|여지|확인되지|단정할 수 없|는지는|인지는|라고 보기 어렵)/g;
        const polarity = (p: string) => new Set(p.match(POL) ?? []);
        const spanOf = (it: LedgerItem) => (it.claim as Claim & { span?: string }).span?.trim() ?? '';
        const squashWs = (x: string) => x.replace(/\s+/g, ' ');
        /** 예전 주장의 **자기** 권위(보강이 붙인 것은 빼고) */
        const ownMarked = (o: LedgerItem) => {
            const g = gainedAuth.get(o.claim.id);
            return markedIds(g ? o.claim.authority.filter((a) => !g.has(a.citation)) : o.claim.authority);
        };
        let pending = sections.filter((s) => s.draft && s.revised && s.revised !== s.draft && s.role !== 'intro' && s.role !== 'conclusion');
        let rounds = 0;
        for (let round = 1; round <= Q.reverify && pending.length; round++) {
            halt();
            rounds = round;
            say(`수정본 재검증${Q.reverify > 1 ? ` ${round}회차` : ''} — 바뀐 장 ${pending.length}개`);
            stage('reverify', 'start', `${round}/${Q.reverify}회차 · ${pending.length}개 장`);
            const log = { round, sections: pending.length, reused: 0, rechecked: 0, failing: 0, rewritten: 0 };
            const rewrite: PaperSection[] = [];
            await Promise.all(
                pending.map((s) =>
                    limiter.run(async () => {
                        const old = itemsBySection.get(s.id) ?? [];
                        const extracted = await extractClaims(s, s.revised!);
                        if (!extracted.length) return; // 뽑기 실패 — 예전 판정을 지운 채 비워 두지 않는다
                        const text = squashWs(s.revised!);
                        const next: LedgerItem[] = [];
                        const fresh: LedgerItem[] = [];
                        const used = new Set<LedgerItem>();
                        /** 다시 판정한 주장 → 그것이 대신한 예전 주장의 판정 */
                        const priorVerdict = new Map<LedgerItem, string>();
                        let failed = 0;
                        for (let i = 0; i < extracted.length; i++) {
                            const ex = extracted[i]!;
                            const exT = termsOf(ex.proposition);
                            const exA = markedIds(ex.authority);
                            // 예전 판정을 그대로 쓰는 조건: 그 문장이 수정본에 **그대로** 남아 있고(span 은 원문 그대로다),
                            // 부정·유보가 같고, 어간이 겹치고, 자기 권위가 같다. 문장이 바뀌었으면 다시 판정한다.
                            const prev = old.find(
                                (o) =>
                                    !used.has(o) &&
                                    (!spanOf(o) || text.includes(squashWs(spanOf(o)))) &&
                                    sameSet(polarity(o.claim.proposition), polarity(ex.proposition)) &&
                                    jaccard(termsOf(o.claim.proposition), exT) >= 0.5 &&
                                    sameSet(ownMarked(o), exA),
                            );
                            if (prev) {
                                used.add(prev);
                                next.push(prev);
                                log.reused++;
                                continue;
                            }
                            const it = await reviewClaim(s, ex, `${s.id}-V${round}-${i + 1}`);
                            if (!it) {
                                failed++;
                                continue;
                            }
                            it.changes = [...(it.changes ?? []), '수정본 재검증'];
                            next.push(it);
                            fresh.push(it);
                            // 이 주장이 대신하는 예전 주장(같은 문장이거나 어간이 겹치는 것)은 다시 남기지 않는다 — 중복 판정이 된다.
                            const replaced = old.find((o) => !used.has(o) && ((spanOf(o) && ex.span && squashWs(spanOf(o)) === squashWs(ex.span)) || jaccard(termsOf(o.claim.proposition), exT) >= 0.5));
                            if (replaced) {
                                used.add(replaced);
                                priorVerdict.set(it, replaced.judgment.verdict);
                            }
                        }
                        // 뽑기에서 빠졌지만 문장이 그대로 남은 예전 주장은 판정과 함께 남긴다. 다시 판정이 실패한 장은
                        // 예전 판정을 버리지 않는다(표시를 달아 남긴다) — 공급자 오류가 판정 기록을 지우면 안 된다.
                        for (const o of old) {
                            if (used.has(o)) continue;
                            const kept = spanOf(o) && text.includes(squashWs(spanOf(o)));
                            if (kept) next.push(o);
                            else if (failed) next.push({ ...o, changes: [...(o.changes ?? []), '재검증 실패 — 수정 전 판정'] });
                        }
                        log.rechecked += fresh.length;
                        itemsBySection.set(s.id, next);
                        s.claimIds = next.map((it) => it.claim.id);
                        // 화면의 검토 목록도 갈아끼운다 — 'review' 는 덧붙이기만 해서 대체된 예전 판정이 남는다.
                        emit({ type: 'reviews', sectionId: s.id, items: next });
                        // 다시 고치는 것은 **반박·미결**이거나 수정 뒤 판정이 **나빠진** 주장만이다. 박약은 이 판정자의 기본값이라
                        // 박약까지 고치게 하면 거의 모든 장을 다시 쓰고도 판정은 그대로였다(실측 15/15 → 13/13, 호출 3배).
                        const failing = fresh.filter((it) => {
                            const v = it.judgment.verdict;
                            if (v === 'refuted' || v === 'unresolved') return true;
                            const was = priorVerdict.get(it);
                            return was !== undefined && (RANK[v] ?? 0) < (RANK[was] ?? 0);
                        });
                        log.failing += failing.length;
                        if (!failing.length || round >= Q.reverify) return;
                        const focus = [
                            `재검증에서 아래 ${failing.length}개 주장이 반박·미결이거나 수정 뒤 판정이 나빠졌다. **이 주장들만** 고친다 —`,
                            '원문이 닿는 데까지로 줄이거나, 단정을 풀거나, 보강 자료로 뒷받침한다. 나머지 문장은 그대로 둔다. 새 인용은 보강 자료 목록에 있는 것만.',
                            '고친 본문 전체만 출력한다.',
                        ].join('\n');
                        const before = s.revised!;
                        const after = await reviseSection(s, before, failing, '## 현재 원고 (수정본)', focus);
                        if (after !== before) {
                            s.revised = after;
                            rewrite.push(s);
                            log.rewritten++;
                            emit({ type: 'section', section: s, phase: 'revised' });
                        }
                    }),
                ),
            );
            qualityLog.reverify.push(log);
            say(`    재검증 ${round}회차 — 그대로 ${log.reused} · 다시 판정 ${log.rechecked} · 고칠 대상(반박·미결·악화) ${log.failing} · 다시 고침 ${log.rewritten}`);
            if (rewrite.length) await recite(); // 다시 고친 장의 새 마커를 다음 회차 전에 확보한다
            pending = rewrite;
        }
        if (!rounds) stage('reverify', 'skip', '바뀐 장 없음');
        else stage('reverify', 'done', `${rounds}회차 · 다시 판정 ${qualityLog.reverify.reduce((a, r) => a + r.rechecked, 0)}건`);
    }

    // ── citecheck ───────────────────────────────────────────────────────────────
    //
    // 각주를 단 문장이 그 각주의 원문에 뒷받침되는가. 모델이 발췌와 대조하고(뒷받침/일부/아님), 숫자·날짜는 코드가 원문에서
    // 찾는다. 걸린 문장만 장마다 한 번 고치고, 고친 문장만 다시 대조한다. 그 뒤로는 고치지 않는다.
    halt();
    stage('citecheck', 'start');
    const citeChecks: CiteCheckRecord[] = [];
    if (!Q.citeCheck) {
        stage('citecheck', 'skip', '꺼짐');
    } else {
        say('인용 대조 — 각주 문장 ↔ 원문 발췌');
        const MAX_PER_SECTION = 20;
        type Pair = { id: string; sentence: string; cite: Cite; passage: string; numbers: string[] };
        const sourceFor = (c: Cite): { text: string; full: boolean; header: string } | null => {
            const e = cites.get(c.key);
            if (!e) return null;
            if (e.cite.kind === 'research' && !e.formalKind) {
                const h = byHandle.get(e.cite.raw.toUpperCase());
                return h ? { text: `${h.summary}\n${h.quote ?? ''}`, full: false, header: '' } : null;
            }
            const d = docCache.get(c.key);
            if (!d || !USABLE_AS_EVIDENCE.has(d.state) || !d.fullText) return null;
            if (d.how.startsWith('human-summary')) return null; // 필자 답변은 원문이 아니다 — 대조할 원문이 없다
            // 판결의 선고일은 코퍼스 본문이 아니라 머리(제목: "대법원 2022-06-30 선고 2022도1452")에 있다. 숫자 대조에 함께 넣는다.
            // 인용 마커의 날짜는 넣지 않는다 — 마커의 날짜가 틀렸을 수 있다.
            return { text: d.fullText, full: true, header: d.title ?? '' };
        };
        const pairsOf = (sid: string, text: string, only?: (sentence: string) => boolean): Pair[] => {
            const out: Pair[] = [];
            let n = 0;
            for (const sentence of sentencesOf(text)) {
                if (only && !only(sentence)) continue;
                const plain = sentence.replace(/⟦[^⟧]*⟧/g, '').trim();
                if (plain.length < 15) continue;
                const cs = extractCites(sentence).map((c) => ({ c, src: sourceFor(c) }));
                // 숫자는 이 문장이 인용한 **모든** 원문(과 판결 머리)에서 찾는다 — 두 판결의 날짜를 한 문장에 쓰면
                // 각 날짜는 각자의 원문에만 있다. 원문 하나라도 조사 자료 발췌뿐이면(짧아서) 숫자 대조를 하지 않는다.
                const allFull = cs.length > 0 && cs.every((x) => x.src?.full);
                const union = cs.map((x) => (x.src ? `${x.src.header}\n${x.src.text}` : '')).join('\n');
                const statute = cs.some(({ c }) => (cites.get(c.key)?.formalKind ?? c.kind) === 'statute');
                const nums = allFull ? numberMismatches(plain, union, { statute }) : [];
                for (const { c, src } of cs) {
                    if (!src) continue;
                    const ex = src.full ? relevantPassages(src.text, { proposition: plain, citation: c.raw }, 2) : null;
                    const passage = ((ex?.passages.length ? renderPassages(ex.passages, 1200) : '') || src.text.slice(0, 1200)).trim();
                    if (!passage) continue;
                    out.push({ id: `${sid}-K${++n}`, sentence, cite: c, passage, numbers: nums });
                }
            }
            return out;
        };
        const checkPairs = async (s: PaperSection, pairs: Pair[]): Promise<Map<string, { verdict: CiteCheckRecord['verdict']; reason: string }>> => {
            const out = new Map<string, { verdict: CiteCheckRecord['verdict']; reason: string }>();
            if (!pairs.length) return out;
            try {
                const r = await ask<{ checks: { id: string; verdict: 'supported' | 'partial' | 'unsupported'; reason: string }[] }>(CiteCheckBatch, {
                    name: 'cite_check',
                    description: '각주 문장이 인용한 원문 발췌에 뒷받침되는지 대조한다',
                    system: CITE_CHECK_PROMPT,
                    user: [
                        `## 장: ${s.number}. ${s.title}`,
                        '',
                        ...pairs.map((p) => [`### [${p.id}]`, `문장: ${p.sentence.replace(/\s+/g, ' ').slice(0, 600)}`, `인용: ⟦${p.cite.raw}⟧`, '원문 발췌:', p.passage].join('\n')),
                        '',
                        `${pairs.length}건 모두 판단한다.`,
                    ].join('\n\n'),
                }, usage);
                // 모델이 id 를 "[S2-K1]"·소문자·공백 섞어 돌려줘도 맞춘다.
                const norm = (x: string) => x.replace(/[\[\]\s]/g, '').toUpperCase();
                const byNorm = new Map(pairs.map((p) => [norm(p.id), p.id]));
                for (const c of r.checks ?? []) {
                    const id = byNorm.get(norm(c.id));
                    if (id) out.set(id, { verdict: c.verdict, reason: c.reason });
                }
            } catch (e) {
                if (opts.signal?.aborted) throw e;
                say(`    ${s.number} 인용 대조 실패: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`);
            }
            return out;
        };
        const fixSentences = async (s: PaperSection, text: string, flagged: Pair[], verdicts: Map<string, { verdict: CiteCheckRecord['verdict']; reason: string }>): Promise<string | null> => {
            const list = flagged
                .map((p) => {
                    const v = verdicts.get(p.id);
                    const why = [v?.verdict === 'unsupported' ? `원문이 뒷받침하지 않음 — ${truncate(v.reason, 200)}` : '', p.numbers.length ? `원문에 없는 숫자·날짜: ${p.numbers.join(', ')}` : ''].filter(Boolean).join(' / ');
                    return `- 문장: "${p.sentence.replace(/\s+/g, ' ').slice(0, 500)}"\n  인용: ⟦${p.cite.raw}⟧\n  문제: ${why}\n  원문 발췌: "${p.passage.replace(/\s+/g, ' ').slice(0, 500)}"`;
                })
                .join('\n');
            try {
                let body = await write({
                    name: 'cite_fix',
                    system: CITE_FIX_PROMPT,
                    user: [`## 장: ${s.number}. ${s.title}`, '', '## 현재 원고', text, '', '## 고칠 문장', list, '', '위 문장들만 고친 본문 전체를 출력한다.'].join('\n'),
                    maxTokens: tokensFor(s.targetChars),
                });
                body = stripOwnHeading(body, s.title);
                // 안전장치 — 고칠 문장만 고쳤는가. 길이가 크게 달라지거나, 걸리지 않은 인용이 사라지거나, 새 인용이 생기면 받지 않는다.
                if (body.length < text.length * 0.8 || body.length > text.length * 1.25) {
                    say(`    ${s.number} 인용 고침을 버림 — 길이가 크게 달라짐(${text.length.toLocaleString()} → ${body.length.toLocaleString()}자)`);
                    return null;
                }
                const before = new Set(extractCites(text).map((c) => c.key));
                const after = new Set(extractCites(body).map((c) => c.key));
                const flaggedKeys = new Set(flagged.map((p) => p.cite.key));
                // 걸리지 않은 문장은 한 글자도 바뀌면 안 된다 — 문장 단위로 확인한다(인용 키 단위로만 보면, 걸린 인용을
                // 걸리지 않은 문장에서까지 지우거나, 인용 없는 문장을 몰래 고쳐도 통과했다).
                const squash = (x: string) => x.replace(/\s+/g, ' ').trim();
                const flaggedSentences = new Set(flagged.map((p) => squash(p.sentence)));
                const bodyFlat = squash(body);
                const changed = sentencesOf(text).filter((x) => !flaggedSentences.has(squash(x)) && !bodyFlat.includes(squash(x)));
                if (changed.length) {
                    say(`    ${s.number} 인용 고침을 버림 — 걸리지 않은 문장 ${changed.length}개가 바뀜`);
                    return null;
                }
                const lost = [...before].filter((k) => !after.has(k) && !flaggedKeys.has(k));
                const added = [...after].filter((k) => !before.has(k));
                if (lost.length || added.length) {
                    say(`    ${s.number} 인용 고침을 버림 — 걸리지 않은 인용 ${lost.length}건이 사라지거나 새 인용 ${added.length}건이 생김`);
                    return null;
                }
                return body;
            } catch (e) {
                if (opts.signal?.aborted) throw e;
                say(`    ${s.number} 인용 고침 실패: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`);
                return null;
            }
        };
        let fixedSections = 0;
        await Promise.all(
            sections.map((s) =>
                limiter.run(async () => {
                    const text = s.revised ?? s.draft;
                    if (!text) return;
                    const all = pairsOf(s.id, text);
                    const pairs = all.slice(0, MAX_PER_SECTION);
                    if (all.length > pairs.length) {
                        say(`    ${s.number} 각주 문장 ${all.length}건 중 ${pairs.length}건만 대조(장당 상한)`);
                        // 대조하지 못한 것도 기록한다 — 부록의 건수가 전수 대조처럼 읽히지 않게.
                        for (const p of all.slice(MAX_PER_SECTION)) citeChecks.push({ sectionId: s.id, sentence: p.sentence.replace(/\s+/g, ' ').slice(0, 300), cite: p.cite.raw, verdict: 'unchecked', reason: `장당 상한(${MAX_PER_SECTION}건)으로 대조하지 않음` });
                    }
                    if (!pairs.length) return;
                    const verdicts = await checkPairs(s, pairs);
                    const recs: CiteCheckRecord[] = pairs.map((p) => {
                        const v = verdicts.get(p.id);
                        return {
                            sectionId: s.id,
                            sentence: p.sentence.replace(/\s+/g, ' ').slice(0, 300),
                            cite: p.cite.raw,
                            verdict: v?.verdict ?? 'unchecked',
                            reason: v?.reason ?? (verdicts.size ? '대조 결과에 빠짐' : '대조 실패'),
                            ...(p.numbers.length ? { numbers: p.numbers } : {}),
                        };
                    });
                    citeChecks.push(...recs);
                    const flagged = pairs.filter((p) => verdicts.get(p.id)?.verdict === 'unsupported' || p.numbers.length > 0);
                    const ok = recs.filter((r) => r.verdict === 'supported').length;
                    say(`    ${s.number} 각주 문장 ${pairs.length}건 — 뒷받침 ${ok} · 일부 ${recs.filter((r) => r.verdict === 'partial').length} · 아님 ${recs.filter((r) => r.verdict === 'unsupported').length} · 숫자 불일치 ${pairs.filter((p) => p.numbers.length).length}`);
                    if (!flagged.length) return;
                    const fixed = await fixSentences(s, text, flagged, verdicts);
                    if (!fixed || fixed === text) return;
                    s.revised = fixed;
                    fixedSections++;
                    emit({ type: 'section', section: s, phase: 'revised' });
                    // 원장 맞추기 — 고침이 바꾼 문장에 걸린 주장은 새 문장으로 바꾸고, 빠진 인용은 근거에서도 빼고, 다시 판정한다.
                    // (그러지 않으면 원고에서 지운 각주가 부록에서는 "원문 확인 · 지지"로 남는다.) 바뀐 주장 수만큼만 돈다.
                    {
                        const flat = (x: string) => x.replace(/\s+/g, ' ').trim();
                        const nowFlat = flat(fixed);
                        const A = sentencesOf(text);
                        const B = sentencesOf(fixed);
                        const keysNow = new Set(extractCites(fixed).map((c) => c.key));
                        const keyOf = (citation: string) => {
                            const nk = normalizeKey(citation.replace(/^⟦|⟧$/g, ''));
                            return cites.has(nk) ? nk : byFormal.get(nk);
                        };
                        for (const it of itemsBySection.get(s.id) ?? []) {
                            const claim = it.claim as Claim & { span?: string };
                            const span = flat(claim.span ?? '');
                            // 이번 고침이 바꾼 문장만 — 고치기 전 원고에 있었고 고친 뒤에 없어진 것.
                            if (!span || !flat(text).includes(span) || nowFlat.includes(span)) continue;
                            // 재판정이 실패하면 이 상태로 되돌린다 — 바뀐 문장·근거에 예전 판정·근거 등급이 붙으면 원장이 어긋난다.
                            const prior = { span: claim.span, proposition: claim.proposition, authority: it.claim.authority, sources: it.sources, citations: it.citations, implicit: implicitClaims.has(it.claim.id) };
                            // 바뀐 문장 찾기 — 문장 수가 같으면 같은 자리의 문장이다.
                            const i = A.findIndex((x) => flat(x).includes(span));
                            const replaced = i >= 0 && A.length === B.length ? B[i] : undefined;
                            if (replaced) {
                                claim.span = replaced;
                                claim.proposition = replaced.replace(/⟦[^⟧]*⟧/g, '').replace(/\s*⚠\s*/g, ' ').trim();
                            }
                            // 권위·원문·인용 검증은 같은 자리끼리 짝이다(검토·보강이 함께 넣는다). 핸들(⟦R1⟧)은 권위에는 'R1' 로, 원문·검증에는
                            // 풀어 쓴 서지로 들어 있어 문자열로 거르면 권위만 빠지고 원문은 근거로 남았다 — 자리로 거른다.
                            const gone = it.claim.authority.map((a) => {
                                const k = keyOf(a.citation);
                                return k !== undefined && !keysNow.has(k);
                            });
                            if (gone.some(Boolean)) {
                                const aligned = it.sources.length === gone.length && it.citations.length === gone.length;
                                const dropped = new Set(it.claim.authority.filter((_, j) => gone[j]).map((a) => a.citation));
                                it.claim.authority = it.claim.authority.filter((_, j) => !gone[j]);
                                it.sources = aligned ? it.sources.filter((_, j) => !gone[j]) : it.sources.filter((r) => !dropped.has(r.authority.citation));
                                it.citations = aligned ? it.citations.filter((_, j) => !gone[j]) : it.citations.filter((c) => !dropped.has(c.citation));
                                if (!it.claim.authority.some((a) => authorityFor(a.citation))) implicitClaims.add(it.claim.id);
                                if (!it.claim.authority.length) it.claim.authority = [{ type: 'scholarship', citation: '(명시된 권위 없음)', holding: '' }];
                            }
                            it.changes = [...(it.changes ?? []), '인용 대조로 문장 수정'];
                            try {
                                const tr = await rejudge(s.id, it, '인용 대조로 문장이 바뀌어 다시 판정한다');
                                say(`    ${it.claim.id.padEnd(8)} 인용 대조 뒤 재판정 ${tr}`);
                            } catch (e) {
                                if (opts.signal?.aborted) throw e;
                                if (prior.span === undefined) delete claim.span;
                                else claim.span = prior.span;
                                claim.proposition = prior.proposition;
                                it.claim.authority = prior.authority;
                                it.sources = prior.sources;
                                it.citations = prior.citations;
                                if (!prior.implicit) implicitClaims.delete(it.claim.id);
                                it.changes = [...(it.changes ?? []).filter((c) => c !== '인용 대조로 문장 수정'), '인용 대조 뒤 재판정 실패 — 고치기 전 문장·판정'];
                                emit({ type: 'review', sectionId: s.id, item: it });
                                say(`    ${it.claim.id.padEnd(8)} 인용 대조 뒤 재판정 실패: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
                            }
                        }
                    }
                    // 걸린 문장이 바뀌었는지 적고, 새로 쓴 문장만 다시 대조한다(그 뒤로는 고치지 않는다).
                    const now = new Set(sentencesOf(fixed));
                    for (const r of recs) if (flagged.some((p) => p.sentence.replace(/\s+/g, ' ').slice(0, 300) === r.sentence && p.cite.raw === r.cite)) r.fixed = !now.has(flagged.find((p) => p.cite.raw === r.cite && p.sentence.replace(/\s+/g, ' ').slice(0, 300) === r.sentence)!.sentence);
                    const old = new Set(sentencesOf(text));
                    const again = pairsOf(s.id, fixed, (x) => !old.has(x)).map((p, i) => ({ ...p, id: `${s.id}-R${i + 1}` })).slice(0, MAX_PER_SECTION);
                    const v2 = await checkPairs(s, again);
                    for (const p of again) {
                        const v = v2.get(p.id);
                        citeChecks.push({
                            sectionId: s.id,
                            sentence: p.sentence.replace(/\s+/g, ' ').slice(0, 300),
                            cite: p.cite.raw,
                            verdict: v?.verdict ?? 'unchecked',
                            reason: v?.reason ?? '대조 실패',
                            ...(p.numbers.length ? { numbers: p.numbers } : {}),
                            recheck: true,
                        });
                    }
                }),
            ),
        );
        if (fixedSections) await recite(); // 고침이 마커를 뺐을 수 있다
        plan.citeCheck = citeChecks;
        const first = citeChecks.filter((r) => !r.recheck);
        const bad = first.filter((r) => r.verdict === 'unsupported' || r.numbers?.length).length;
        stage('citecheck', first.length ? 'done' : 'skip', first.length ? `${first.length}건 대조 · 걸림 ${bad} · 고친 장 ${fixedSections}` : '대조할 각주 문장 없음');
    }

    // ── assemble (초록·주제어) ───────────────────────────────────────────────────
    halt();
    stage('assemble', 'start');
    // 원문에서 확인되지 않은 인용(✗ — not_found·article_missing·date_mismatch)은 각주로 논문에 들어가지 않는다. 수정 단계에
    // 부탁만 하면 남았다(실측: 23편 중 2편이 ✗ 각주를 단 채 나갔다). 마지막 recite 뒤, 조립 전에 코드가 마커를 뺀다 —
    // 문장은 필자의 주장으로 남기고, 뺀 인용은 plan.withheld 와 검증 부록에 남긴다. 그 인용에 기댄 주장은 판정자가 이미 그 인용을
    // "원문 미확보"로 보고 판정했고 지지였다면 근거 강등도 받았으므로, 다시 판정하지 않고 표시만 단다(원장의 인용 검증 기록은 그대로 —
    // 무엇을 왜 뺐는지가 남아야 한다).
    const blockedNow = cstat.filter((c) => blockingStates.has(c.check as never));
    if (blockedNow.length) {
        const keys = new Set(blockedNow.map((c) => c.key));
        const keyOfCitation = (citation: string) => {
            const nk = normalizeKey(citation.replace(/^⟦|⟧$/g, ''));
            return cites.has(nk) ? nk : (byFormal.get(nk) ?? nk);
        };
        for (const s of sections) {
            const text = s.revised ?? s.draft;
            if (!text) continue;
            const next = withoutCites(text, keys);
            if (next === text) continue;
            s.revised = next;
            emit({ type: 'section', section: s, phase: 'revised' });
        }
        const WITHHELD = '확인되지 않은 인용을 본문에서 뺌';
        for (const [sid, its] of itemsBySection) {
            const hit = its.filter((it) => it.claim.authority.some((a) => keys.has(keyOfCitation(a.citation))));
            for (const it of hit) if (!it.changes?.includes(WITHHELD)) it.changes = [...(it.changes ?? []), WITHHELD];
            if (hit.length) emit({ type: 'reviews', sectionId: sid, items: its });
        }
        plan.withheld = [...(plan.withheld ?? []), ...blockedNow.map((c) => ({ ...c, withheld: true as const }))];
        await recite();
        // recite 는 원고의 마커만 센다 — 그대로 두면 뺀 인용이 상태표('cites' 이벤트)에서 소리 없이 사라져, 앱 인용표에 ✗ 가 아니라
        // 아무것도 남지 않았다. 「본문에서 뺌」 표지를 달아 상태표 끝에 남긴다(cstat 은 원고의 것 그대로 — 각주·집계는 cstat 으로 센다).
        const inBody = new Set(cstat.map((c) => c.key));
        plan.cites = [...cstat, ...plan.withheld.filter((c) => !inBody.has(c.key))];
        emit({ type: 'cites', cites: plan.cites });
        say(`    확인되지 않은 인용 ${blockedNow.length}건 — 본문에서 마커를 뺌(문장은 남김, 부록에 기록)`);
    }
    say('초록 · 주제어');
    try {
        const ab = await ask<{ abstract: string; keywords: string[] }>(AbstractSchema, {
            name: 'abstract',
            description: '국문초록과 주제어를 쓴다',
            system: ABSTRACT_PROMPT,
            user: [
                thesisBlock(thesis),
                '',
                '## 각 장의 요지',
                ...sections.map((s) => {
                    const t = (s.revised ?? s.draft ?? '').replace(/⟦[^⟧]*⟧/g, '');
                    const first = t.split(/\n\s*\n/).find((p) => p.trim() && !p.trim().startsWith('#')) ?? '';
                    return `### ${s.number}. ${s.title}\n${first.replace(/\s+/g, ' ').slice(0, 600)}`;
                }),
                '',
                '국문초록과 주제어를 쓴다.',
            ].join('\n'),
        }, usage);
        plan.abstract = ab.abstract;
        plan.keywords = ab.keywords;
    } catch (e) {
        say(`    초록 생성 실패: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`);
    }

    // ── 원장 ────────────────────────────────────────────────────────────────────
    for (const s of sections) {
        const items = itemsBySection.get(s.id) ?? [];
        ledger.issues.push({
            issue: { id: s.id, question: `${s.number}. ${s.title}`, why_contested: s.brief, positions: s.claims },
            items,
            withdrawn: [],
        });
        ledger.coverage.claims += items.length;
        for (const it of items) {
            ledger.coverage.citations += it.citations.length;
            ledger.coverage.verified += it.citations.filter((c) => c.state === 'verified').length;
            ledger.coverage.unverifiable += it.citations.filter((c) => c.state === 'unverifiable').length;
            ledger.coverage.blocking += it.citations.filter((c) => blockingStates.has(c.state)).length;
            if (it.evidence.grade === 'full_text') ledger.coverage.fullText++;
            else ledger.coverage.notFullText++;
            if (it.downgrade) ledger.coverage.downgraded++;
        }
    }
    // 원고 수준의 인용 집계 — 논문의 각주는 명제 단위가 아니라 인용 단위다. 본문에서 뺀 차단 인용도 센다 —
    // 확인하지 못한 인용이 집계에서 사라지면 "차단 0"으로 읽힌다.
    const withheld = plan.withheld ?? [];
    ledger.coverage.citations = cstat.length + withheld.length;
    ledger.coverage.verified = cstat.filter((c) => c.check === 'verified').length;
    ledger.coverage.blocking = cstat.filter((c) => blockingStates.has(c.check as never)).length + withheld.length;
    ledger.coverage.unverifiable = cstat.filter((c) => c.check === 'unverifiable' || c.check === 'corpus_gap').length;
    ledger.coverage.revised = sections.filter((s) => s.revised && s.revised !== s.draft).length;
    ledger.paper = { ...plan, snowball: snowLog, quality: qualityLog };
    stage('assemble', 'done');
    setToolSink(null);
    ledger.finishedAt = new Date().toISOString();
    return ledger;
}

/** 모델이 장 제목을 스스로 붙이면 걷어낸다 — 조립기가 붙이므로 두 번 찍힌다. */
function stripOwnHeading(body: string, title: string): string {
    let b = body.trim();
    // 코드펜스로 감싼 경우
    const fence = /^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i.exec(b);
    if (fence) b = fence[1]!.trim();
    const lines = b.split('\n');
    while (lines.length && (/^#{1,2}\s/.test(lines[0]!) || (lines[0]!.trim() && lines[0]!.trim() === title.trim()) || /^[IVX]+\.\s/.test(lines[0]!.trim()))) {
        lines.shift();
        while (lines.length && !lines[0]!.trim()) lines.shift();
    }
    return lines.join('\n').trim();
}

/** 구상 대화에서 설계를 뽑는다 (앱의 「대화에서 설계 뽑기」). */
export async function proposeThesis(
    args: { topic: string; context?: string; messages: { role: 'user' | 'assistant'; content: string }[]; current?: PaperThesis | null; findings?: Finding[] },
    ask: Asker,
    usage: Usage,
): Promise<PaperThesis> {
    const { PLAN_FROM_CHAT_PROMPT } = await import('./prompts-paper.ts');
    const rh = handles(args.findings ?? []);
    const chat = args.messages
        .slice(-30)
        .map((m) => `${m.role === 'user' ? '필자' : '파트너'}: ${m.content.replace(/\s+/g, ' ').slice(0, 1800)}`)
        .join('\n\n');
    return ask<PaperThesis>(PaperThesisSchema, {
        name: 'thesis',
        description: '대화에서 논문 설계를 뽑는다',
        system: PLAN_FROM_CHAT_PROMPT,
        user: [
            `## 주제\n${args.topic}`,
            ...(args.context?.trim() ? ['', `## 배경·맥락 (필자 제공)\n${args.context.trim()}`] : []),
            ...(args.current && (args.current.thesis || args.current.title) ? ['', '## 필자가 이미 적어 둔 설계 (존중한다)', thesisBlock(args.current)] : []),
            '',
            '## 필자와의 대화',
            chat || '(대화 없음)',
            '',
            researchBlock(rh, 16, 160),
            '',
            '대화에서 논문의 설계를 뽑는다.',
        ].join('\n'),
    }, usage);
}

// 원문 확보 사다리. **초록으로 판단하지 않는다**는 규칙을 코드로 강제하는 부분이다.
//
// 순서 (싼 것부터, 그리고 저자가 이미 가진 것부터):
//   0. 사전제공 파일 (data/corpus/**  + LEGAL_AGENT_CORPUS 로 지정한 디렉터리)
//   1. 법령·판례  → legalize.kr (로컬, 결정적)
//   2. arXiv      → PDF 전문
//   3. OpenAlex   → OA 위치
//   4. Crossref → Unpaywall (DOI 가 있을 때)
//   5. Semantic Scholar (레이트리밋 걸리면 조용히 건너뜀)
//   6. 인용문에 URL 이 있으면 직접 가져오기
//
// 각 단계는 **전문을 얻었는지**를 정직하게 보고한다. 초록만 얻으면 abstract_only 이고,
// 그건 "읽었다"가 아니다. 이 구별이 없으면 파이프라인은 페이월 뒤의 논문을 읽은 척한다.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, delimiter, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abstractMarker, fetchUrl, htmlToText, isSiteWidePdf, lastPdfError, pdfjsAvailable, pdfPages, pdfToText } from './web.ts';
import { courtConflict, decisionCourtIn, parsePrecedentCitation, resolveDocument, verifyAuthority } from './verify.ts';
import { courtCovered } from './legalize.ts';
import { fetchDecision, fetchDecisionUrl } from './decisions.ts';
import { bestKciMatch, kciArticlePage, kciDetail, kciFullText, kciSearch, normTitle, type KciArticle } from './kci.ts';
import { identityOf } from './cite.ts';
import type { Authority } from '../schemas.ts';
import { record } from '../trace.ts';

// 앱에서는 이 모듈이 번들되어 경로가 달라진다. 그래서 루트를 환경변수로 덮을 수 있게 둔다 —
// import.meta.dirname 만 믿으면 번들 후 data/cache 를 찾지 못해 인덱스가 없는 것처럼 보인다.
// legalize.ts 와 같은 이유로 지연 계산한다.
const root = () => process.env.LEGAL_AGENT_ROOT ?? resolve(import.meta.dirname, '../..');
const CACHE = () => join(root(), 'data/cache/sources');

export type SourceState =
    | 'full_text' // 전문 확보
    | 'abstract_only' // 초록만 — **판단 근거로 쓸 수 없다**
    | 'metadata_only' // 서지만 — 쓸 수 없다
    | 'paywalled' // 원문은 있으나 접근 차단
    | 'login_required' // 로그인월
    | 'not_found' // 어디에도 없다 — 인용 자체가 의심스럽다
    | 'corpus_gap' // 이 코퍼스가 다루지 않는 법원/문서 종류 — 실재 여부 판정 불가
    | 'provided' // 사용자가 제공
    | 'user_declined' // 사용자가 "없다"고 답했다 — 있는 척하지 않고 진행
    | 'offline' // 법령·판례 원문이 이 컴퓨터에 없고 GitHub 에 나가지 않는다(허용 안 함·시험 실행) — 필자가 원문 파일을 주면 대조한다
    | 'error';

/** 인용 근거로 쓸 수 있는 상태. 이 목록 밖이면 그 명제는 supported 가 될 수 없다. */
export const USABLE_AS_EVIDENCE = new Set<SourceState>(['full_text', 'provided']);

export interface SourceDoc {
    state: SourceState;
    /** 어느 경로로 얻었는가: corpus | legalize | arxiv | openalex | crossref | unpaywall | s2 | direct | human */
    how: string;
    url?: string;
    title?: string;
    fullText?: string;
    chars?: number;
    abstractText?: string;
    error?: string;
    /** 시도했지만 실패한 경로들 — 사람에게 물을 때 "무엇을 해봤는지"를 보여주기 위한 것 */
    attempts?: string[];
    /** 받은 글의 꼴 — 식별자 대조에서 PDF(첫 쪽의 DOI)와 웹 페이지(그 페이지가 밝힌 DOI)를 가른다. 없으면(예전 캐시) 주소로 짐작한다. */
    kind?: 'html' | 'pdf' | 'text' | 'other';
    /** 웹 페이지가 **스스로** 밝힌 DOI(citation_doi·dc.identifier·prism.doi·og 메타). 본문에 인용된 남의 DOI 는 아니다. */
    pageDois?: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 전문으로 인정할 최소 분량과 구조 신호. 논문 한 편은 이보다 훨씬 길다. */
const FULL_TEXT_MIN = 6000;
const STRUCTURE_MARKERS = ['참고문헌', 'References', 'REFERENCES', '서론', 'Introduction', '결론', 'Conclusion', 'Ⅰ.', 'I. ', '각주'];

/**
 * 전문으로 보이는가. headings 이면 구조 신호를 **제목 자리**(줄 머리, 「Ⅰ.」「1.」 같은 번호 뒤)에 있을 때만 센다 — 웹 페이지용.
 * KCI 논문 소개 페이지는 「참고문헌 (41) 열기/닫기」 위젯과 초록 속 낱말 「…결론에 도달하였다」 로 둘을 채워 초록 페이지가 전문이 됐다.
 * PDF 에서 뽑은 글은 줄이 흐트러질 수 있어 그대로 어디서든 센다.
 */
function looksLikeFullText(text: string, headings = false): boolean {
    if (text.length < FULL_TEXT_MIN) return false;
    if (!headings) return STRUCTURE_MARKERS.filter((m) => text.includes(m)).length >= 2;
    const esc = (m: string) => m.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const atHead = (m: string) =>
        new RegExp(`(?:^|\\n)[ \\t\\r]*(?:[#*【〈<\\[(][ \\t]*)?(?:(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+|[IVX]+|\\d{1,2}|제\\s*\\d+\\s*[장절])\\s*[.)]?[ \\t]*)?${esc(m)}`).test(text);
    return STRUCTURE_MARKERS.filter(atHead).length >= 2;
}

/** KCI 논문 소개 페이지 — 서지·초록·참고문헌 목록뿐이다. 원문은 「KCI 원문 내려받기」(kciFullText)로만 받는다. */
const KCI_LANDING = /kci\.go\.kr\/kciportal\/ci\/sereArticleSearch\/ciSereArtiView/i;

/** 머리(--- … ---)의 본문. 없으면 null. 편집기가 앞에 붙인 BOM 도 넘긴다. */
function frontMatter(text: string): string | null {
    return /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text.slice(0, 8000))?.[1] ?? null;
}

/** 조사 노트(research persist)인가 — 머리 안 어디에 표지가 있어도 된다. 앞 400자만 보면 긴 제목 줄에 밀려 표지를 놓쳤다. */
function isResearchNote(text: string): boolean {
    const m = frontMatter(text);
    return m !== null && /(?:^|\n)fetched_by:\s*research\s*(?:$|\n)/.test(m);
}

/** 초록으로 보이는가 — 있으면 abstract_only 로 정직하게 내려간다. */
function hasAbstract(text: string): boolean {
    return /(^|\n)\s*(국문초록|초\s*록|ABSTRACT|Abstract|요\s*약)\b/.test(text) || text.includes('초록');
}

// ---- 0. 사전제공 파일 -------------------------------------------------------------

interface CorpusFile {
    path: string;
    text: string;
    name: string;
    /** PDF 쪽수 — 짧은 PDF 만 센다(1면짜리 초록면·미리보기를 가르려고). */
    pages?: number;
}

/**
 * 코퍼스 캐시 — **파일마다** 크기·수정 시각이 같으면 다시 읽지 않는다. 폴더는 부를 때마다 새로 훑는다(목록과 stat 은 싸다).
 * 앱은 한 프로세스에서 여러 실행·프로젝트를 돌리므로, 한 번 채우고 끝이면 references/ 에 새로 넣은 파일이 앱을 다시 켤 때까지 안 보였다.
 * 그 뒤 폴더의 수정 시각을 열쇠로 삼았더니, 스크래치에 원문 하나가 떨어질 때마다 references/ 의 PDF 를 전부 다시 뽑았고
 * (pdf.js 면 PDF 마다 수 초 — 그동안 앱의 main 프로세스가 멈춘다), 하위 폴더에 넣거나 같은 이름으로 덮어쓴 파일은 못 봤다.
 * 이번에 훑은 파일만 남긴다 — 다른 프로젝트의 파일과 제목 대조를 하지 않게. 읽지 못한 파일도 기억한다(바뀌기 전에는 다시 돌리지 않는다).
 */
let corpusCache = new Map<string, { key: string; file: CorpusFile | null }>();

export function corpusDirs(): string[] {
    const extra = (process.env.LEGAL_AGENT_CORPUS ?? '')
        .split(delimiter) // 윈도우는 ';' — 'D:\\…' 의 ':' 로 자르면 드라이브 문자가 떨어져 나간다
        .map((s) => s.trim())
        .filter(Boolean);
    return [join(root(), 'data/corpus'), ...extra].filter((d) => existsSync(d));
}

function walk(dir: string, acc: string[] = [], depth = 0): string[] {
    if (depth > 4) return acc;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p, acc, depth + 1);
        else if (/\.(pdf|md|txt|html?|docx)$/i.test(entry.name)) acc.push(p);
    }
    return acc;
}

function readCorpusFile(p: string): CorpusFile | null {
    try {
        const ext = extname(p).toLowerCase();
        let text = '';
        let pages: number | undefined;
        if (ext === '.pdf') {
            const buf = readFileSync(p);
            text = pdfToText(buf) ?? '';
            // 쪽수는 짧은 PDF 만 — 1면짜리는 글이 짧다. pdf.js 로 읽었으면 방금 센 것을 다시 쓴다.
            if (text && text.length < 12_000) pages = pdfPages(buf) ?? undefined;
        } else if (ext === '.docx') {
            text = docxToText(p) ?? '';
        } else {
            text = readFileSync(p, 'utf8');
            if (ext === '.html' || ext === '.htm') text = htmlToText(text);
        }
        // 조사 노트(research-*.md)는 자료가 아니라 **자료의 목록**이다. 제목이 들어 있으니 제목 대조에 걸리고,
        // 그러면 KCI 초록이 "사전제공 전문"으로 둔갑한다(실제로 그랬다 — 질문이 한 번도 안 뜬 두 번째 원인).
        if (isResearchNote(text)) return null;
        return text.length > 500 ? { path: p, text, name: basename(p).toLowerCase(), ...(pages ? { pages } : {}) } : null;
    } catch {
        return null; // 읽을 수 없는 파일은 건너뛴다
    }
}

function loadCorpus(): CorpusFile[] {
    const next = new Map<string, { key: string; file: CorpusFile | null }>();
    const files: CorpusFile[] = [];
    for (const dir of corpusDirs()) {
        for (const p of walk(dir)) {
            if (next.has(p)) continue; // 겹치는 코퍼스 폴더
            let key: string;
            try {
                const st = statSync(p);
                key = `${st.size}@${st.mtimeMs}`;
            } catch {
                continue;
            }
            const hit = corpusCache.get(p);
            const entry = hit?.key === key ? hit : { key, file: readCorpusFile(p) };
            next.set(p, entry);
            if (entry.file) files.push(entry.file);
        }
    }
    corpusCache = next;
    return files;
}

const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();

/**
 * 제목 대조. **다른 논문을 읽는 것이 아무것도 못 읽는 것보다 나쁘다.**
 *
 * 이 함수가 없던 첫 버전은 arXiv 검색 결과의 첫 항목을 그대로 집었다 — "Attention Is All You
 * Need" 로 검색하자 "Tool Attention Is All You Need: Dynamic Tool Gating…" 이라는 다른 논문의
 * PDF 62,000자를 전문으로 받아 왔고, 상태는 full_text 였다. 파이프라인은 그것을 읽고 판정했을
 * 것이다. 그래서 지금은 길이 비율까지 보고, 후보가 여럿이면 가장 잘 맞는 하나를 고른다.
 */
export function titleScore(refTitle: string, foundTitle: string): number {
    const cl = (t: string) => norm(t).replace(/[^\p{L}\p{N}]/gu, '');
    const a = cl(refTitle);
    const b = cl(foundTitle);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
    // **접두** 관계는 부제가 붙은 정상 인용이다 — "원격 압수수색의 법적 성격: 대법원 … 판결을
    // 소재로". 그래서 비율을 낮게 잡아도 인정한다.
    if (b.startsWith(a) || a.startsWith(b)) return ratio >= 0.3 ? 0.9 : 0;
    // 반면 단순 **포함**은 길이가 비슷할 때만. 이 구분이 없으면
    // "Tool Attention Is All You Need: …" 가 "Attention Is All You Need" 를 포함한다는 이유로
    // 통과한다 — 실제로 그렇게 다른 논문을 읽었다. 접두가 아니라서 여기서 걸린다.
    if (ratio >= 0.75 && (a.includes(b) || b.includes(a))) return 0.85;
    const tok = (t: string) => t.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
    const ta = new Set(tok(foundTitle));
    const tb = tok(refTitle);
    if (tb.length < 3) return 0;
    const hit = tb.filter((t) => ta.has(t)).length / tb.length;
    if (hit >= 0.8 && ratio >= 0.65) return 0.8;
    return 0;
}

const TITLE_MIN = 0.8;
const titleMatches = (ref: string, found: string) => titleScore(ref, found) >= TITLE_MIN;

/** 인용에 따옴표로 적힌 제목. 「받은 글이 그 글인가」 대조에는 이것만 쓴다 — 따옴표 없는 인용의 제목 후보는 저자·학술지가 섞여 있다. */
function quotedTitle(citation: string): string | undefined {
    return /[「『"“]([^」』"”]{8,})[」』"”]/.exec(citation)?.[1];
}

/**
 * 받은 글이 그 제목의 글로 보이는가 — 제목(앞 40자)이 글 어딘가에 그대로 있거나, 앞부분에 제목 낱말이 거의 다 있다.
 * 제목을 모르면 판단하지 않는다(true). 출판사 페이지·DOI 가 **다른 논문**의 PDF 를 내줘도 상태는 full_text 였다.
 * 짧은 제목(글자 10자 미만, 「잊혀질 권리의 한계」)은 낱말로 맞출 수 없으니 그 글자 그대로 있어야 한다 — 같은 글자일 때만. PDF(kind 'pdf')는
 * **첫머리(첫 쪽 창, frontOf)** 에, 웹 페이지(kind 'page')는 머리 제목을 담은 글 전체에 — 웹 페이지까지 앞 3000자로 보던 때는 긴 메뉴 뒤에 h1 을 단
 * 실무 해설 페이지(「딥페이크 처벌법」)가 「인용한 글이 아님」이 됐다. 짧으면 「모름」(true)으로 보던 때는 따옴표 제목이 유일한 대조인 소개 페이지에서
 * 사이드바의 학회 규정 PDF 가 그 글의 전문으로 들어왔다. 다른 글자(번역 제목)는 글자로 가를 수 없어 전처럼 판단하지 않는다.
 * 웹 페이지의 짧은 제목은 main(머리 제목 + 본문만 남긴 글 — web.ts mainOnly)이 있으면 거기서 찾는다 — 글 전체에서 찾던 때는 다른 글 끝의 「인기 글」 상자·링크 목록의
 * 짧은 제목이 그 글의 제목으로 맞았다.
 */
export function mentionsTitle(title: string | undefined, text: string, kind: 'pdf' | 'page' = 'pdf', main?: string): boolean {
    if (!title) return true;
    const cl = (t: string) => norm(t).replace(/[^\p{L}\p{N}]/gu, '');
    const key = cl(title).slice(0, 40);
    if (!key) return true;
    if (key.length < 10) {
        const front = frontOf(text);
        return scriptOf(title) !== scriptOf(front) || cl(kind === 'pdf' ? front : (main ?? text)).includes(key);
    }
    if (cl(text).includes(key)) return true;
    const tok = (t: string) => t.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
    const words = new Set(tok(text.slice(0, 6000)));
    const tb = tok(title);
    return tb.length >= 3 && tb.filter((t) => words.has(t)).length / tb.length >= 0.8;
}

/** 여러 후보 중 가장 잘 맞는 하나. 첫 항목을 집지 않는다. */
function bestTitleMatch<T extends { title: string }>(refTitle: string, items: T[]): T | null {
    let best: T | null = null;
    let bestScore = 0;
    for (const it of items) {
        const sc = titleScore(refTitle, it.title);
        if (sc > bestScore) {
            bestScore = sc;
            best = it;
        }
    }
    return bestScore >= TITLE_MIN ? best : null;
}

/** 인용문에서 DOI / arXiv ID / 제목 후보 / URL 을 뽑는다. */
export function parseRef(citation: string): { doi?: string; arxiv?: string; title?: string; url?: string } {
    // 이 프로젝트의 인용 형식은 「제목 <url>」 이다 — '>' 를 URL·DOI 에 넣으면 주소가 틀려 URL 단계는 404, DOI 단계는 건너뛰어졌다.
    // 끝의 문장부호("doi:10.1/x.")도 뗀다.
    const doi = /10\.\d{4,9}\/[^\s,;)"'<>]+/.exec(citation)?.[0]?.replace(/[.,;:]+$/, '');
    const arxiv = /(?:arXiv:\s*|arxiv\.org\/abs\/)(\d{4}\.\d{4,5})(v\d+)?/i.exec(citation)?.[1];
    const rawUrl = /https?:\/\/[^\s)"<>]+/.exec(citation)?.[0];
    const url = rawUrl ? trimUrl(rawUrl) : undefined;
    const quoted = quotedTitle(citation);
    const stripped = citation
        .replace(/10\.\d{4,9}\/\S+/g, ' ')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[<>]/g, ' ')
        .replace(/\b(19|20)\d{2}\b/g, ' ')
        .replace(/\d+\s*(면|쪽|p{1,2}\.)/g, ' ')
        .replace(/[,.\d]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const title = quoted ?? (stripped.length >= 12 ? stripped : undefined);
    return {
        ...(doi ? { doi } : {}),
        ...(arxiv ? { arxiv } : {}),
        ...(title ? { title } : {}),
        ...(url ? { url } : {}),
    };
}

// ---- 캐시 ------------------------------------------------------------------------

function cacheKey(a: Authority): string {
    return createHash('sha1').update(`${a.type}|${a.citation}`).digest('hex').slice(0, 16);
}

/**
 * 캐시 판(版). 이 판부터 쓰는 항목은 받을 때 지금의 검사(제목 대조·KCI 소개 페이지·사이트 공통 PDF·법원 대조)를 거쳤다.
 * 판이 없는 예전 항목은 꺼낼 때 같은 검사를 한 번 더 한다(stillTrusted) — 그 검사가 없던 때 잘못 받은 전문(KCI 소개 페이지·다른 논문·투고규정 PDF,
 * 다른 법원의 판결)이 전역 캐시에 남아 영원히 「전문」으로 나오지 않게. 글자 검사뿐이라 싸다. 통과한 항목은 다시 받지 않는다.
 */
const CACHE_V = 2;

function readCache(a: Authority): SourceDoc | null {
    const f = join(CACHE(), `${cacheKey(a)}.json`);
    if (!existsSync(f)) return null;
    try {
        const { v, ...d } = JSON.parse(readFileSync(f, 'utf8')) as SourceDoc & { v?: number };
        // 실패 상태는 캐시하지 않는다 — 다음 실행에서 접근이 열렸을 수 있다.
        if (!USABLE_AS_EVIDENCE.has(d.state)) return null;
        // 사전제공 파일에서 찾은 것은 캐시에서 꺼내지 않는다 — 코퍼스는 어차피 다시 훑는다. 전역 캐시(모든 프로젝트가 같이 쓴다)에 두면
        // 파일을 지우거나 바로잡아도, 다른 프로젝트를 열어도 그 파일의 글이 「사전제공 원문」으로 계속 나왔다. 예전에 쓴 항목도 여기서 걸러진다.
        if (d.how === 'corpus') return null;
        // 웹에서 가져온 결정문은 7일 뒤 다시 찾는다 — 한 번 잘못 잡은 페이지가 영원히 남지 않게.
        if (d.how.startsWith('web') && Date.now() - statSync(f).mtimeMs > 7 * 86_400_000) return null;
        if ((v ?? 1) < CACHE_V && !stillTrusted(a, d)) return null;
        return d;
    } catch {
        return null;
    }
}

/** 판이 없는 캐시 항목이 지금의 검사도 통과하는가. 못 하면 사다리를 다시 돈다(그 결과가 새 판으로 덮어쓴다). */
function stillTrusted(a: Authority, d: SourceDoc): boolean {
    if (a.type === 'precedent') {
        const caseNo = parsePrecedentCitation(a.citation)?.caseNo;
        const found = caseNo ? decisionCourtIn(`${d.title ?? ''}\n${(d.fullText ?? '').slice(0, 3000)}`, caseNo) : undefined;
        return !(found && courtConflict(a.citation, found));
    }
    if (!['direct', 'arxiv', 'openalex', 'unpaywall', 's2'].includes(d.how)) return true; // 법령·KCI 원문 등 — 그때도 지금과 같은 검사였다
    if (vetFullText(d, a.citation).state !== 'full_text') return false;
    if (d.how !== 'direct' || !d.url) return true;
    if (KCI_LANDING.test(d.url) || isSiteWidePdf(d.url)) return false;
    // 웹 페이지(주소가 .pdf 가 아닌 것)는 구조 신호가 제목 자리에 있어야 한다 — PDF 를 웹 주소로 받았으면 다시 받을 뿐이다.
    return /\.pdf(?:$|[?#])/i.test(d.url) || looksLikeFullText(d.fullText ?? '', true);
}

function writeCache(a: Authority, d: SourceDoc): void {
    if (!USABLE_AS_EVIDENCE.has(d.state)) return;
    mkdirSync(CACHE(), { recursive: true });
    writeFileSync(join(CACHE(), `${cacheKey(a)}.json`), JSON.stringify({ ...d, v: CACHE_V, fullText: d.fullText?.slice(0, 200_000) }));
}

// ---- 사람이 제공한 원문의 기억 ---------------------------------------------------

const PROVIDED = () => join(CACHE(), 'provided.json');

/** 인용 → 사람이 준 경로/URL. 한 번 제공하면 다음 실행에서 다시 묻지 않는다. */
function readProvided(): Record<string, string> {
    try {
        return JSON.parse(readFileSync(PROVIDED(), 'utf8')) as Record<string, string>;
    } catch {
        return {};
    }
}

export function recordProvided(citation: string, note: string): void {
    const all = readProvided();
    all[citation] = note;
    mkdirSync(CACHE(), { recursive: true });
    writeFileSync(PROVIDED(), JSON.stringify(all, null, 2));
}

// ---- 사다리 ----------------------------------------------------------------------

/** 실패 상태의 서열: 더 많이 알아낸 쪽을 남긴다 — 사용자에게 물을 때 그 정보가 필요하다. */
const FAILURE_RANK: Record<SourceState, number> = {
    full_text: 100,
    provided: 95,
    paywalled: 60,
    login_required: 55,
    abstract_only: 50,
    corpus_gap: 40,
    metadata_only: 30,
    not_found: 10,
    user_declined: 5,
    offline: 20,
    error: 1,
};

const worse = (a: SourceDoc, b: SourceDoc): SourceDoc => (FAILURE_RANK[b.state] > FAILURE_RANK[a.state] ? b : a);

/** 전문을 얻는 즉시 멈춘다. 얻지 못했으면 가장 많이 알아낸 실패 상태를 남긴다. */
/**
 * 받아온 원문을 **프로젝트 스크래치패드에 떨어뜨린다.**
 *
 * 지금까지는 전역 캐시(data/cache/sources)에만 남았다. 그러면 사용자는 무엇을 받았는지 볼 수
 * 없고, 프로젝트를 옮기면 그 자료가 따라오지 않는다. 받은 원문은 그 프로젝트의 자료다 —
 * references/ 옆에 놓고, 다음 실행에서는 사전제공 파일처럼 먼저 읽힌다.
 */
function writeScratch(a: Authority, doc: SourceDoc): void {
    const dir = process.env.LEGAL_AGENT_SCRATCH;
    if (!dir || doc.state !== 'full_text' || !doc.fullText) return;
    // 법령·판례는 이미 로컬 코퍼스다. 사람이 준 파일도 이미 프로젝트 안에 있다.
    if (['legalize', 'corpus', 'human', 'human(기록)', 'human-summary'].some((h) => doc.how.startsWith(h))) return;
    try {
        mkdirSync(dir, { recursive: true });
        const base = a.citation
            .replace(/[\\/:*?"<>|]/g, ' ')
            .replace(/\s+/g, '-')
            .slice(0, 80);
        const header = [
            '---',
            `citation: ${a.citation.replace(/\n/g, ' ')}`,
            `title: ${(doc.title ?? '').replace(/\n/g, ' ')}`,
            `source: ${doc.url ?? ''}`,
            `fetched_by: ${doc.how}`,
            `fetched_at: ${new Date().toISOString()}`,
            '---',
            '',
        ].join('\n');
        writeFileSync(join(dir, `${base}.md`), header + doc.fullText);
    } catch {
        /* 저장 실패가 실행을 죽이지 않는다 — 캐시에는 남아 있다 */
    }
}

/** 지난 실행에서 필자가 답한 것 — 정확한 문자열로, 없으면 같은 인용(identityOf)으로 찾는다. */
function rememberedFor(a: Authority): string | undefined {
    const all = readProvided();
    if (all[a.citation]) return all[a.citation];
    const id = identityOf(a.citation);
    return Object.entries(all).find(([k]) => identityOf(k) === id)?.[1];
}

export async function acquireSource(a: Authority, opts: { signal?: AbortSignal } = {}): Promise<SourceDoc> {
    const started = Date.now();
    let doc = await acquireSourceInner(a, opts);
    // 지난 실행에서 "없음"이라 답했고 이번에도 사다리가 못 찾았으면 다시 묻지 않는다(user_declined 는 묻지 않는다).
    if (!USABLE_AS_EVIDENCE.has(doc.state) && rememberedFor(a)?.startsWith('unavailable:')) {
        doc = { ...doc, state: 'user_declined', how: `${doc.how}+human(기록)`, error: '지난 실행에서 필자가 원문 없음이라 답함' };
    }
    writeScratch(a, doc);
    record({
        kind: 'acquire',
        name: doc.how,
        subject: a.citation,
        ok: USABLE_AS_EVIDENCE.has(doc.state),
        ms: Date.now() - started,
        detail: `${doc.state}${doc.chars ? ` · ${doc.chars.toLocaleString()}자` : ''}${doc.error ? ` · ${doc.error.slice(0, 120)}` : ''}`,
        ...(doc.url ? { input: doc.url } : {}),
    });
    return doc;
}

async function acquireSourceInner(a: Authority, opts: { signal?: AbortSignal } = {}): Promise<SourceDoc> {
    const cached = readCache(a);
    if (cached) return { ...cached, how: `${cached.how}(캐시)` };

    // 0'. 지난 번에 사람이 준 원문이 있으면 그것부터. 같은 질문을 두 번 하지 않는다.
    const remembered = rememberedFor(a);
    if (remembered && !remembered.startsWith('unavailable:')) {
        const got = await loadHumanProvided(remembered, { type: a.type });
        if (!('error' in got)) {
            const summary = got.source === 'answered';
            return { state: 'provided', how: summary ? 'human-summary(기록)' : 'human(기록)', ...(summary ? {} : { url: got.source }), fullText: got.text, chars: got.text.length };
        }
    }

    // 1. 법령·판례는 로컬 코퍼스에서 결정적으로.
    if (a.type === 'statute' || a.type === 'precedent') {
        const doc = resolveDocument(a);
        const check = verifyAuthority(a);
        if (!doc) {
            // 헌법재판소 결정처럼 이 코퍼스가 아예 담지 않는 법원은 "없는 판례"가 아니라
            // "판정 불가"다. 사람에게 물어서 받을 수 있는 종류의 공백이므로 그렇게 보고한다.
            const parsed = a.type === 'precedent' ? parsePrecedentCitation(a.citation) : null;
            const gap = parsed?.court ? !courtCovered(parsed.court) : false;
            // 웹에서 받은 판결도 인용한 법원의 것이어야 한다 — 코퍼스가 법원 불일치로 내주지 않은 판결(대법원 2009도10845 를 「서울고등법원」으로 쓴 인용)을
            // 사건번호 검색이 그대로 물어오면, 검증은 not_found 인데 사다리는 그 판결을 원문으로 줬다. 판결문 머리의 법원으로 본다(못 읽으면 가르지 않는다).
            const otherCourt = (d: SourceDoc) => {
                const found = parsed?.caseNo ? decisionCourtIn(`${d.title ?? ''}\n${(d.fullText ?? d.abstractText ?? '').slice(0, 3000)}`, parsed.caseNo) : undefined;
                return Boolean(found && courtConflict(a.citation, found));
            };
            // 인용 문자열에 URL 이 있으면 그 페이지를 먼저 읽는다 (law.go.kr precInfoP 링크 등).
            // 예전에는 코퍼스 해석이 실패하면 URL 을 보지도 않고 error 로 버렸다.
            const url = /https?:\/\/[^\s)>\]」』]+/.exec(a.citation)?.[0];
            if (url) {
                const web = await fetchDecisionUrl(url, parsed?.caseNo, opts);
                if (USABLE_AS_EVIDENCE.has(web.state) && !otherCourt(web)) {
                    writeCache(a, web);
                    return web;
                }
            }
            // 코퍼스에 없는 판례·결정은 웹에서 찾는다. 헌재 결정은 코퍼스에 0건이라 이 경로가 유일하다.
            if (a.type === 'precedent' && parsed?.caseNo) {
                const web = await fetchDecision(a.citation, opts);
                if (!otherCourt(web)) {
                    if (USABLE_AS_EVIDENCE.has(web.state)) {
                        writeCache(a, web);
                        return web;
                    }
                    if (web.state === 'abstract_only') return { ...web, attempts: [...(web.attempts ?? []), 'legalize'] };
                }
            }
            // 원문이 이 컴퓨터에 없고 GitHub 에 나가지 않는다(허용 안 함·시험 실행 — verify 의 「… 이 컴퓨터에 없음」) — 오류가 아니라 필자가 원문 파일을 주면 풀리는 질문이다.
            // 'error' 로 두던 때는 질문 카드가 「원문을 가져오는 중 오류가 발생했습니다.」로 시작했다. 검증 판정(unverifiable, 차단 아님)은 그대로다.
            const offline = check.state === 'unverifiable' && /이 컴퓨터에 없음/.test(check.note ?? '');
            return {
                state: gap ? 'corpus_gap' : check.state === 'not_found' ? 'not_found' : offline ? 'offline' : 'error',
                how: 'legalize',
                title: a.citation,
                ...(offline ? { error: '이 컴퓨터에 원문이 없음 — GitHub 접근을 허용하지 않음. 원문 파일을 주면 그것으로 대조합니다.' } : check.note ? { error: check.note } : {}),
            };
        }
        const out: SourceDoc = { state: 'full_text', how: 'legalize', url: doc.provenance, title: doc.title, fullText: doc.body, chars: doc.body.length };
        writeCache(a, out);
        return out;
    }

    const ref = parseRef(a.citation);
    // DOI·arXiv ID·URL 로 받은 전문은 제목으로 한 번 더 본다(vetFullText). 제목 검색으로 찾은 것은 이미 제목을 맞췄다.
    const cited = quotedTitle(a.citation);
    // 소개 페이지에서 따라간 PDF 의 대조용 — 따옴표 제목, 없으면 인용의 제목 후보(저자·학술지가 섞였어도 PDF 첫 쪽의 낱말과 맞춰 볼 수는 있다), DOI.
    // 인용이 규정·지침(rules)이나 토론문·서평(disc) 그 자체인지도 — 그러면 운영 문서·토론문 첫머리를 거르지 않는다. 학술대회 발표문·자료집(conf)이면 그 일정·표지의
    // 「지정토론」「종합토론」「토론자」 는 토론문 표지가 아니다.
    const ident = {
        ...(cited ? { title: cited } : ref.title ? { hint: ref.title } : {}),
        ...(ref.doi ? { doi: ref.doi } : {}),
        rules: citesRule(a.citation),
        disc: citesDiscussion(a.citation),
        conf: citesConference(a.citation),
    };
    const attempts: string[] = [];
    let bestFailure: SourceDoc = { state: 'not_found', how: 'none' };
    const keep = (d: SourceDoc, label: string): SourceDoc => {
        attempts.push(label);
        bestFailure = worse(bestFailure, d);
        return d;
    };

    // 0. 사전제공 파일
    const local = matchCorpus(a, ref);
    if (local) {
        // 파이프라인이 스크래치패드에 내려받은 파일은 전문일 때만 믿는다. 필자가 references/ 에 넣은 파일은 그대로 믿는다 —
        // 짧은 판결문·발췌를 필자가 일부러 준 것일 수 있다.
        const scratch = process.env.LEGAL_AGENT_SCRATCH;
        // 앱의 원문 찾기 브라우저가 저장한 페이지(captured_by: nenene-browser)도 스크래치처럼 다룬다 — 필자가 고른 것은 맞지만
        // 다른 인용의 제목 대조에 걸려 「전문」으로 둔갑하면 안 된다.
        const capture = isBrowserCapture(local.text);
        const fromScratch = Boolean(scratch && local.path.startsWith(scratch)) || capture;
        // 논문의 1면짜리 PDF 는 초록면·미리보기다(원문 찾기 브라우저로 받은 「KCI 원문 미리보기」가 references/ 에 들어온다) — 필자가 넣었어도 원문이 아니다.
        // 논문(scholarship)만 — 보도·실무 자료·보도자료는 1면짜리가 원문일 수 있다(onePageIsPreview).
        const preview = local.pages === 1 && onePageIsPreview(a.type);
        // 예전 실행이 KCI 논문 소개 페이지를 「전문」으로 받아 스크래치에 남긴 것 — 그 페이지는 늘 초록·서지다(kci-pdf 로 받은 원문은 다르다).
        const fm = frontMatter(local.text) ?? '';
        const staleLanding = fromScratch && KCI_LANDING.test(/(?:^|\n)source:\s*(\S+)/.exec(fm)?.[1] ?? '') && !/(?:^|\n)fetched_by:\s*kci/.test(fm);
        if ((fromScratch && (!looksLikeFullText(local.text, capture) || staleLanding)) || preview) {
            keep({ state: 'abstract_only', how: 'corpus', url: local.path, title: basename(local.path), abstractText: local.text.slice(0, 3000), chars: local.text.length }, preview ? '사전제공(1면 PDF)' : '스크래치(전문 아님)');
        } else {
            // 캐시에 쓰지 않는다 — readCache 의 설명.
            return { state: 'provided', how: 'corpus', url: local.path, title: basename(local.path), fullText: local.text, chars: local.text.length };
        }
    }

    // 0.5) 한국 학술지 — KCI. 논문 페이지의 "KCI 원문 내려받기"로 전문을 받는다. 버튼이 없으면 서지·초록으로 실패의 질을 높인다.
    if (a.type === 'scholarship' && (ref.title || ref.doi)) {
        const k = keep(await tryKci(ref, a.citation, opts.signal), 'KCI');
        if (k.state === 'full_text') {
            writeCache(a, k);
            return k;
        }
    }

    if (ref.arxiv || ref.title) {
        const got = await tryArxiv(ref, opts.signal);
        const arx = keep(ref.arxiv ? vetFullText(got, a.citation) : got, `arXiv${ref.arxiv ? `:${ref.arxiv}` : ''}`);
        if (arx.state === 'full_text') {
            writeCache(a, arx);
            return arx;
        }
    }

    // 인용한 DOI 의 서지(OpenAlex·Unpaywall 이 그 DOI 로 찾은 저자·연도). 뒤 단계(「인용된 URL」·「DOI 소개 페이지」)가 받은 글이 **그 DOI 의 글**로
    // 받아들여지면(vetFullText 의 식별자가 그 DOI) 같은 저자·연도 대조를 건다 — 앞 단계가 연도·저자로 버린 글을 출판사 페이지의 citation_pdf_url 이나
    // DOI 가 주소에 없는 인용 URL 이 서지 없이 되살렸다(주소에 DOI 가 있을 때만 걸던 때).
    let doiByline: Byline | undefined;

    if (ref.title || ref.doi) {
        const got = await tryOpenAlex(ref, opts.signal);
        if (ref.doi) doiByline ??= docByline.get(got);
        const oa = keep(ref.doi ? vetFullText(got, a.citation, doiByline) : got, 'OpenAlex OA');
        if (oa.state === 'full_text') {
            writeCache(a, oa);
            return oa;
        }
    }

    if (ref.title || ref.doi) {
        const got = await tryCrossrefUnpaywall(ref, opts.signal);
        if (ref.doi) doiByline ??= docByline.get(got);
        const up = keep(ref.doi ? vetFullText(got, a.citation, doiByline) : got, 'Crossref/Unpaywall');
        if (up.state === 'full_text') {
            writeCache(a, up);
            return up;
        }
    }

    if (ref.title) {
        const s2 = keep(await trySemanticScholar(ref, opts.signal), 'Semantic Scholar');
        if (s2.state === 'full_text') {
            writeCache(a, s2);
            return s2;
        }
    }

    if (ref.url) {
        const got = classifyFetched(await fetchFollowingPdf(ref.url, opts, ident));
        const doc = keep(vetFullText(got, a.citation, doiByline), '인용된 URL 직접');
        if (doc.state === 'full_text') {
            writeCache(a, doc);
            return doc;
        }
    }

    // DOI 의 소개 페이지 — 열린 원문 목록(OpenAlex·Unpaywall)에 없어도 출판사 페이지가 PDF 링크를 다는 경우가 많다.
    if (ref.doi && (!ref.url || !ref.url.includes(ref.doi))) {
        const doc = keep(vetFullText(classifyFetched(await fetchFollowingPdf(`https://doi.org/${ref.doi}`, opts, ident)), a.citation, doiByline), 'DOI 소개 페이지');
        if (doc.state === 'full_text') {
            writeCache(a, doc);
            return doc;
        }
    }

    return { ...bestFailure, attempts };
}

function matchCorpus(a: Authority, ref: { doi?: string; arxiv?: string; title?: string }): CorpusFile | null {
    const files = loadCorpus();
    if (!files.length) return null;
    const title = quotedTitle(a.citation);
    for (const f of files) {
        // DOI·arXiv 는 **그 글 자신의 것**만 본다 — 파일 이름이나 첫 쪽(앞 3000자, 첫 쪽이 길면 6000자까지). 본문 전체를 보면
        // 참고문헌 목록에 그 DOI 를 적은 **다른 논문**이 걸린다: 스크래치에 받은 논문 X 의 참고문헌에서 연쇄로 고른 Y 가 X 의 글을
        // 「사전제공 원문」으로 받았다. 첫 쪽 각주에 남의 DOI 가 있을 수 있으니 인용에 제목이 있으면 제목도 맞아야 한다.
        const ff = f.text.indexOf('\f');
        const head = norm(f.text.slice(0, Math.min(Math.max(ff, 3000), 6000)));
        const byDoi = Boolean(ref.doi && (head.includes(norm(ref.doi)) || f.name.includes(norm(ref.doi).replace(/\//g, '_'))));
        const byArxiv = Boolean(ref.arxiv && (head.includes(ref.arxiv) || f.name.includes(ref.arxiv)));
        if ((byDoi || byArxiv) && mentionsTitle(title, f.text, ff >= 0 || /\.pdf$/i.test(f.path) ? 'pdf' : 'page')) return f;
    }
    if (!ref.title) return null;
    const key = norm(ref.title).replace(/[^\p{L}\p{N}]/gu, '').slice(0, 40);
    if (key.length < 10) return null;
    for (const f of files) {
        const head = norm(f.text.slice(0, 4000)).replace(/[^\p{L}\p{N}]/gu, '');
        if (head.includes(key)) return f;
    }
    return null;
}

/**
 * 가져온 것이 원문이 아닌 소개(랜딩) 페이지인데 원문 PDF 링크(citation_pdf_url 등)를 달고 있으면 그 PDF 를 받아 본다 —
 * 사람에게 묻기 전에. 링크가 있는데도 「원문을 주세요」라고 묻던 경우를 없앤다. 후보는 앞에서부터 세 개까지(pdfLinks 의 순서) —
 * 받은 PDF 가 그 글이 아니거나 못 읽으면 다음 후보로 간다. 첫 후보 하나만 보던 때는 사이드바의 사이트 공통 PDF 를 버리고 나서
 * 본문의 원문 PDF 는 보지도 않고 초록 페이지로 돌아갔다. 제목은 맞아도 **전문이 아닌** PDF(호 목차·1면 초록면·짧은 글)에서도 멈추지 않는다 —
 * 그 제목을 목차 줄로 담은 「이번 호 목차 PDF」에서 멈추던 때는 한 칸 뒤의 원문 PDF 를 받지 못했다. 그렇게 넘어간 **다음** 후보는 그 제목을 **제 글의 제목**으로
 * 달아야 한다(ownTitleOf) — 첫머리 어딘가에 제목이 있기만 하면 받던 때는 그 제목을 담은 토론문(「「원격 압수수색의 법적 쟁점」에대한토론문」)이 인용한 글의 전문이 됐다.
 * 끝까지 전문이 없으면 처음 맞은 PDF 를(보도·실무 자료는 1면짜리가 원문일 수 있다 — 쓸지는 받는 쪽이 정한다), 그것도 없으면 처음 것(소개 페이지)을 돌려준다.
 */
const PDF_TRIES = 3;
async function fetchFollowingPdf(
    url: string,
    opts: { signal?: AbortSignal } = {},
    cited: { title?: string; hint?: string; doi?: string; rules?: boolean; disc?: boolean; conf?: boolean } = {},
): Promise<Awaited<ReturnType<typeof fetchUrl>>> {
    const d = await fetchUrl(url, opts);
    if (d.error || d.kind !== 'html' || !d.pdfLinks?.length || looksLikeFullText(d.text, true)) return d;
    // 따라간 PDF 가 그 글인가.
    //  · 인용에 받은 PDF 와 **같은 글자의 따옴표 제목**이 있으면 그 제목만 본다(메타 링크도). 페이지 제목·DOI 가 맞는 PDF 에서 멈추던 때는
    //    사이트 이름이 첫머리에 적힌 투고규정 PDF·호 목차에서 멈췄고, vetFullText 가 그것을 제목 없음으로 버리는데도 뒤의 원문 PDF 는 보지 않았다.
    //  · 따옴표 제목이 없거나 번역 제목(받은 PDF 와 다른 글자)이면, 페이지가 「이 글의 PDF」라고 밝힌 링크(citation_pdf_url 등)는 그대로 받는다 —
    //    그 메타는 그 글의 것이고, 같은 글인지는 vetFullText 가 식별자(DOI 등)로 본다. 메타 링크까지 페이지 <title> 과 맞추던 때는 학술 메타 없는 학술지의
    //    맞는 PDF 를 버리고 초록 페이지로 돌아갔다.
    //  · 본문의 <a> 링크는 사이트 공통 PDF 일 수 있다 — 이 페이지의 글 제목(articleTitleIn: 학술 메타·머리 제목 h1·<title> 의 글 조각, 사이트 이름은 아니다)·인용의 제목 후보·DOI 가운데
    //    하나는 PDF 에 있어야 한다. 맞춰 볼 것이 하나도 없으면 <a> 는 받지 않는다 — 링크 글이 「PDF」여도 사이드바의 투고규정일 수 있다(HITL 의 짧은 <title>).
    let matched: Awaited<ReturnType<typeof fetchUrl>> | undefined;
    for (const link of d.pdfLinks.slice(0, PDF_TRIES)) {
        const p = await fetchUrl(link.url, opts);
        const crossScript = Boolean(cited.title && p.text.trim()) && scriptOf(cited.title!) !== scriptOf(p.text.slice(0, 3000));
        const titles = [cited.title, d.articleTitle, cited.hint].filter((t): t is string => Boolean(t));
        // 맞았으나 전문이 아닌 PDF 를 지나온 뒤라면 그 제목(따옴표 제목, 없으면 이 페이지의 글 제목)이 이 PDF **제 제목**이어야 한다 — 같은 글자일 때만.
        const own = cited.title && !crossScript ? cited.title : d.articleTitle;
        // 운영 문서(투고·편집 규정, 저자 안내, 저작권 양도서)가 첫머리인 PDF 는 인용한 글이 아니다 — 페이지의 글 제목(articleTitleIn)을 잘못 읽어도.
        // 인용이 규정·지침 그 자체를 가리키면(rules — citesRule) 보지 않는다.
        const opDoc = p.kind === 'pdf' && !(cited.rules ?? citesRule(cited.title ?? cited.hint ?? '')) && operatingFront(p.text);
        // 토론문·서평 첫머리인 PDF 도 인용한 글이 아니다 — 어느 후보든(첫 후보도). 거르기만 한다(제 제목 대조 ownTitleOf 는 맞은 비전문 PDF 다음에만).
        // 인용이 토론문·서평 그 자체면(disc — citesDiscussion) 보지 않는다. 학술대회 발표문·자료집이면(conf — citesConference) 일정·표지 낱말은 빼고 본다.
        const discDoc =
            p.kind === 'pdf' && !(cited.disc ?? citesDiscussion(cited.title ?? cited.hint ?? '')) && discussionFront(p.text, cited.conf ?? false, cited.title ?? cited.hint);
        const same =
            !opDoc &&
            !discDoc &&
            (cited.title && !crossScript
                ? mentionsTitle(cited.title, p.text)
                : link.meta || titles.some((t) => mentionsTitle(t, p.text)) || Boolean(cited.doi && norm(p.text.slice(0, 6000)).includes(norm(cited.doi)))) &&
            !(matched && own && scriptOf(own) === scriptOf(p.text.slice(0, 3000)) && !ownTitleOf(own, p.text));
        const ok = !p.error && p.kind === 'pdf' && Boolean(p.text.trim()) && same;
        // 전문인가 — classifyFetched 가 PDF 에 대는 잣대(여러 면 + 분량·구조 신호).
        const full = ok && !(p.pages !== undefined && p.pages <= 1) && looksLikeFullText(p.text);
        record({
            kind: 'acquire',
            name: 'pdf-link',
            subject: url.slice(0, 120),
            ok: full,
            input: link.url,
            detail: p.error
                ? p.error.slice(0, 160)
                : `${p.kind} ${p.text.length.toLocaleString()}자${p.pages ? ` · ${p.pages}면` : ''}${same ? (full ? '' : ' · 제목은 맞으나 전문이 아니어서 다음 후보로') : opDoc ? ' · 운영 문서(규정·저자 안내)라 버림' : discDoc ? ' · 토론문·서평이라 버림' : ' · 제목이 맞지 않아 버림'}`,
        });
        if (full) return p;
        if (ok) matched ??= p;
        if (opts.signal?.aborted) break;
    }
    return matched ?? d;
}

/**
 * 운영 문서의 첫머리인가 — 앞 40줄 안에 규정·규칙·세칙·지침·요령·정관·안내 낱말이 든 짧은 머리 줄과 그 아래 조문 줄(「제1조 (목적)」「제1조(목적)」「제1조 원고는 …」),
 * 또는 앞 다섯 줄 안의 영문 머리 줄 「Guidelines/Instructions/Information for Authors」「Author Guidelines」「Submission Guidelines」「Copyright Transfer Agreement」.
 * 머리 줄은 문장이 아니다(SENTENCE_END) — 짧은 줄이 많은 한글 PDF 에서 「… 목적 규정을 검토한다.」 같은 초록 문장과 「제1조(목적)는 …」 문장을 머리·조문으로 보던 때는
 * 조문을 다루는 논문을 운영 문서로 버렸다.
 * 투고규정·저자 안내 PDF 는 학술지 이름·글 제목 낱말을 첫머리에 담아, 페이지의 글 제목을 사이트 이름으로 잘못 읽으면(siteParts) 필자의 원문으로 들어왔다 —
 * 그 뒷받침이다(fetchFollowingPdf·vetFullText).
 */
const OP_HEAD_KO = /규정|규칙|세칙|지침|요령|정관|안내/;
/** 조문 줄 — 줄 머리의 「제1조」(괄호 조 제목은 있어도 된다) 다음이 빈칸이거나 줄 끝. 「제1조(목적)는 …」 처럼 토씨가 붙으면 조문을 다루는 글의 문장이다. */
const OP_ARTICLE = /^제\s*1\s*조(?:\s*[(（][^)）]{1,12}[)）])?(?:\s|$)/;
/** 머리 줄이 아닌 문장 — 마침표나 「…다」 로 끝난다(「이 글은 … 목적 규정을 검토한다.」). */
const SENTENCE_END = /(?:[.。]|다)$/;
/**
 * 영문 머리 줄 — 그 이름이 줄 머리나 구분자 뒤(「Journal of Digital Law - Submission Guidelines …」「…: Instructions for Authors」)에서 **대문자로** 시작한다.
 * 줄 어디든 보던 때는 제목에 그 말을 담은 논문(「The Copyright Transfer Agreement as a Standard Form Contract」)을 직접 주소로 받아도 운영 문서로 버렸다.
 * 대문자만 — 줄바꿈으로 줄 머리에 온 소문자 문장 조각(「copyright transfer agreement between …」)은 머리 줄이 아니다.
 */
const OP_NAME_EN = /^(?:(?:guidelines?|instructions?|information)\s+(?:for|to)\s+(?:authors?|contributors?)|authors?['’]?s?\s+guidelines?|submission\s+guidelines?|copyright\s+transfer\s+agreement)\b/i;
const opHeadEn = (l: string) => l.split(/\s+[-–—|]\s+|[:：]\s+/).some((seg) => /^[A-Z]/.test(seg) && OP_NAME_EN.test(seg));
function operatingFront(text: string): boolean {
    const lines = frontOf(text)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 40);
    const art = lines.findIndex((l) => OP_ARTICLE.test(l));
    if (art > 0 && lines.slice(0, art).some((l) => l.length <= 50 && OP_HEAD_KO.test(l) && !SENTENCE_END.test(l))) return true;
    return lines.slice(0, 5).some((l) => l.length <= 120 && opHeadEn(l));
}

/**
 * 인용이 규정·지침 그 자체를 가리키는가 — 따옴표 제목(없으면 인용의 제목 후보)에 규정·규칙·세칙·지침·요령·정관·고시·훈령·예규·guideline·policy 가 있다.
 * 그때는 운영 문서 첫머리(operatingFront)가 그 글일 수 있다.
 */
function citesRule(citation: string): boolean {
    const name = quotedTitle(citation) ?? parseRef(citation).title ?? citation;
    return /규정|규칙|세칙|지침|요령|정관|고시|훈령|예규|guidelines?|polic(?:y|ies)/i.test(name);
}

/**
 * PDF 가 그 제목을 **제 글의 제목**으로 달았는가 — 첫머리(쪽 머리글 줄을 뺀 앞 여섯 줄 안)의 줄 머리에서 제목이 시작되고(줄 앞의 갈래 꼬리표는 뗀다),
 * 뒤에 「에 대한 (지정)토론」「토론문」「서평」「발표에 대한」이 붙지 않으며 앞 줄이 「(지정)토론문」「서평」 머리가 아니다. 호 목차·토론문·서평도 그 제목을 첫머리에 담는다.
 * 쪽 머리글 줄: 쪽 번호·권호(「제33권 제2호」, 한자 「第33卷 第2號」)·ISSN·DOI·주소·「연구논문」, 한자만인 줄(「韓國刑事法學會」「刑事法硏究」「硏究論文」),
 * 학회·학술지 이름 줄(…학회·학회지·연구·법학·논총·논집·저널로 끝나는 짧은 줄 — 그 줄이 제목의 앞부분이면 제목이다), KCI 배지 줄(「KCI 등재학술지」).
 * 갈래 꼬리표: 줄 앞 괄호 속 여덟 자까지(「[판례평석]」「〈논단〉」「[판례연구]」「<특별기고>」「【특집】」). 다른 글을 다루는 글의 꼬리표(OTHER_WORK_TAG —
 * 「[반론]」「〈신간 소개〉」)는 떼지 않는다 — 떼던 때는 인용 제목을 단 반론이 제 제목 대조를 지나 그 글의 전문이 됐다(8차 K8.5).
 * 꼬리표를 몇 낱말로만, 머리글을 몇 꼴로만 보고 앞 세 줄만 보던 때는 목차 PDF 다음의 원문 PDF(「[판례평석] 제목」, 학회·학술지·KCI·연구논문·권호 다섯 줄 뒤의 제목,
 * 한자 머리글 넷 뒤의 제목)를 버리고 목차로 돌아갔다.
 */
const PAGE_HEAD_LINE =
    /^\s*(?:[-–—]?\s*\d{1,4}\s*[-–—]?|(?:연구|일반|특집|기획|초청)?\s*논문|(?:Research|Original|Review)?\s*Article|Special\s+Issue|KCI\s*등재(?:후보)?\s*(?:학술지)?)\s*$|제\s*\d+\s*[권집]|第\s*\d+\s*[卷輯集]|\d+\s*권\s*\d+\s*호|\bvol(?:ume)?\.?\s*\d|\bISSN\b|\bpp?\.\s*\d|https?:\/\/|\bdoi\b/i;
/** 한자만인 줄(숫자·괄호·문장부호는 된다) — 학회·학술지·갈래의 한자 머리글. */
const HANJA_LINE = /^(?=.*\p{Script=Han})[\p{Script=Han}\d\s.,·()（）\-–]+$/u;
/** 학회·학술지 이름 줄 — 짧은 줄이 이 낱말로 끝난다. */
const SOCIETY_LINE = /(?:학회지?|연구|법학|논총|논집|저널)$/;
const CATEGORY_TAG = /^\s*[〈<《［\[【(（][^〉>》］\]】)）\n]{1,8}[〉>》］\]】)）]\s*/;
/** 다른 글을 다루는 글의 갈래 낱말 — 반론·재반론·답론·반박·토론·서평·논평·신간 소개(낱자 사이 빈칸은 된다). */
const OTHER_WORK = '(?:재\\s*)?반\\s*론|답\\s*론|반\\s*박|토\\s*론|서\\s*평|논\\s*평|신\\s*간\\s*소\\s*개';
/** 줄 머리의 그 꼬리표(「[반론] …」「〈신간 소개〉 …」「【서평】」). */
const OTHER_WORK_TAG = new RegExp(`^\\s*[〈<《［\\[【(（]\\s*(?:${OTHER_WORK})\\s*[〉>》］\\]】)）]`);
/** 그 낱말 하나뿐인 줄(괄호는 지우고 본다 — 「논 평」「[반론]」). */
const OTHER_WORK_LINE = new RegExp(`^(?:${OTHER_WORK})$`);
const NOT_OWN_TAIL = /^(?:에대한(?:지정)?토론|토론문|서평|발표에대한)/;
const NOT_OWN_HEAD = /^(?:지정)?토론문?$|^서평$/;
function ownTitleOf(title: string, text: string): boolean {
    const cl = (t: string) => norm(t).replace(/[^\p{L}\p{N}]/gu, '');
    // 부제(「: …」「 - …」)는 PDF 첫머리에서 줄이 달라지거나 빠질 수 있다 — 주제목으로도 본다.
    const keys = [...new Set([title, title.split(/\s*[:：]\s+|\s+[-–—]\s+/)[0]!].map((t) => cl(t).slice(0, 80)))].filter((k) => k.length >= 4);
    if (!keys.length) return true;
    // 한자·학회 이름 줄은 그 줄이 제목의 앞부분(또는 제목을 담은 줄)이면 머리글이 아니다 — 「…에 관한 연구」 로 끝나는 제목 줄.
    const titleLine = (l: string) => {
        const c = cl(l);
        return Boolean(c) && keys.some((k) => k.startsWith(c) || c.startsWith(k));
    };
    const pageHead = (l: string) => {
        const t = l.trim();
        return PAGE_HEAD_LINE.test(l) || (!titleLine(t) && (HANJA_LINE.test(t) || (t.length <= 25 && SOCIETY_LINE.test(t))));
    };
    const lines = frontOf(text)
        .split('\n')
        .map((l) => (OTHER_WORK_TAG.test(l) ? l : l.replace(CATEGORY_TAG, '')))
        .filter((l) => l.trim() && !pageHead(l));
    for (let i = 0; i < Math.min(6, lines.length); i++) {
        const rest = cl(lines.slice(i, i + 4).join('\n'));
        const key = keys.find((k) => rest.startsWith(k));
        if (key) return !NOT_OWN_TAIL.test(rest.slice(key.length)) && !lines.slice(0, i).some((l) => NOT_OWN_HEAD.test(cl(l)));
    }
    return false;
}

/**
 * 토론문·서평의 첫머리인가 — 앞 열두 줄 안에 토론·서평 표지가 있다: 줄 전체가 「토론」「서 평」「書 評」, 줄 속의 「지정·약정·종합토론(문)」「토론문」「討論(文)」
 * 「토론자:」「발표에 대한 토론」, 영문 줄 머리의 「Book Review」「Reviewed by」「Review of」「Comment on」「Discussion of」「Response to」,
 * 다른 글을 다루는 글의 꼬리표·줄(「[반론] …」「[재반론]」「[답론]」「[반박]」「[논평]」「〈신간 소개〉」, 그 낱말 하나뿐인 줄 — 8차 K8.5).
 * 줄 끝의 「…에 대한 (약정·지정)토론」 은 **제목 줄과 그 뒤 세 줄** 안, 초록·장 머리말(titleBlockEnd) 앞에서만 표지다 — 앞 열두 줄 어디든 보던 때는
 * 초록 줄바꿈으로 줄 끝이 「…의 허용 범위에 대한 토론」 이 된 논문 자신의 PDF 를 버렸다(8차 K8.3). 제목 줄은 인용 제목을 담은 첫 줄(두 줄에 걸치면 그 첫 줄),
 * 없으면 쪽 머리·권호 줄(runningHeadLine)이 아닌 첫 줄이다 — 토론문의 제목은 「「T」에 대한 토론」 이라 그 줄이 제목 줄이다. 쪽 머리가 아닌 첫 줄만 보던 때는
 * 학술대회 이름·세션·사회·발표 네 줄 뒤의 「「T」에 대한 (지정)토론」 이 창 밖이 되어 그 토론문이 인용한 글의 전문이 됐다(8차 뒤따름 K8.3).
 * 인용이 학술대회 발표문·자료집이면(conf — citesConference) 일정·표지의 「지정토론(:)」「종합토론」「토론자」 는 표지가 아니다 — 그 인용한 발표문 표지의
 * 「지정토론: …」, 자료집 일정표의 「17:00 종합토론」 으로 그 글 자신의 PDF 를 버렸다(8차 K8.3). 「지정토론문」 은 「토론문」 으로 여전히 표지다.
 * 그 제목을 첫머리에 담은 토론문·서평은 인용한 글의 원문이 아니다 — 갈래 낱말 몇 개(줄 전체의 「토론문」「서평」, 제목 바로 뒤 「에대한토론」)만 보던 때는
 * 「2021년 … 하계학술대회 지정토론문」「약정토론문」「토론자: … (… 발표에 대한 토론)」「書 評」「討論文」「종합토론」「Book Review」 PDF 가 그 글의 전문이 됐다.
 */
const DISC_WHOLE = /^(?:토\s*론|서\s*평|書\s*評)$/;
const DISC_PART = /약정\s*토론|토론문|討\s*論|발표에\s*대한\s*토론/;
/** 학술대회 일정·표지의 표지 — 인용이 발표문·자료집·학술대회 글이면 보지 않는다. */
const DISC_PROGRAMME = /(?:지정|종합)\s*토론|토론자\s*[:：]/;
/** 줄 끝 표지 — 제목 줄과 그 뒤 세 줄에서만. */
const DISC_LINE_END = /에\s*대한\s*(?:약정|지정)?\s*토론(?:문)?\s*[)）」』\]]*\s*$/;
/** 제목 덩어리가 끝나는 줄 — 초록 라벨(「국문초록」「[초록]」「Abstract」「요약:」)과 장 머리말(「Ⅰ. 서론」「I. Introduction」). 그 줄부터는 제목 줄이 아니다. */
const ABSTRACT_LABEL = /^[\[【〈<(]?\s*(?:국문|영문|한글)?\s*(?:초\s*록|요\s*약|abstract|summary)\s*[\]】〉>)]?\s*(?:[:：].*)?$/i;
const titleBlockEnd = (l: string) => ABSTRACT_LABEL.test(l) || /^(?:[ⅠⅡⅢⅣⅤ]|I{1,3}|IV|V)\s*[.．]\s/.test(l);
const DISC_EN = /^(?:book\s+review|reviewed\s+by|review\s+of|comments?\s+on|discussion\s+of|response\s+to)\b/i;
function discussionFront(text: string, conf = false, cited?: string): boolean {
    const lines = frontOf(text)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 12);
    const key = (x: string) => x.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
    const want = cited ? key(cited) : '';
    const carries = (n: number) => lines.findIndex((_, i) => key(lines.slice(i, i + n).join('')).includes(want));
    const at = want.length >= 6 ? [1, 2].map(carries).find((i) => i >= 0) ?? -1 : -1;
    const title = at >= 0 ? at : lines.findIndex((l) => !runningHeadLine(l));
    const block = lines.findIndex((l, i) => i > title && titleBlockEnd(l));
    const last = Math.min(title + 3, block > title ? block - 1 : title + 3);
    return lines.some((l, i) => {
        const bare = l.replace(/[\s\[\]【】〈〉<>()（）《》［］]/g, ' ').trim();
        return (
            DISC_WHOLE.test(bare) ||
            OTHER_WORK_LINE.test(bare) ||
            OTHER_WORK_TAG.test(l) ||
            DISC_PART.test(l) ||
            (!conf && DISC_PROGRAMME.test(l)) ||
            (title >= 0 && i >= title && i <= last && DISC_LINE_END.test(l)) ||
            discEnHead(l)
        );
    });
}
/**
 * 영문 표지 줄 — 줄 머리의 표지가 **대문자로** 시작한다(「Book Review」「BOOK REVIEW」「Response to …」). 대소문자를 가리지 않던 때는 초록 줄바꿈으로
 * 줄 머리에 온 문장 조각(「response to deepfake sexual abuse …」「review of remote search statutes …」)이 표지가 되어 그 논문 자신의 PDF 를 첫 후보부터 버렸다.
 */
const discEnHead = (l: string) => /^[A-Z]/.test(l) && DISC_EN.test(l);

/**
 * 인용이 토론문·서평·논평 그 자체인가 — 따옴표 제목(없으면 인용 전체)에 토론·서평·書評이나 다른 글을 다루는 글의 갈래 낱말(반론·답론·반박·논평·신간 소개 —
 * 홀로 선 낱말만, OTHER_WORK_CITED)이 있거나, 영문 표지 「Book Review」「Review of」「Review Essay」「Comment(s) on」「Response to」「Reply to」「Discussion of」 가 있다.
 * 그때는 토론문 첫머리(discussionFront)가 그 글일 수 있다 — 제목 줄 자체가 표지 꼴인 글을 버리지 않게. 맨 「review」 는 아니다 — 따옴표 없는 Bluebook 인용의
 * 학술지 이름(「33 Korea Law Review 1」「Harvard Law Review」)으로 예외가 켜지던 때는 다른 글의 Book Review PDF 가 인용한 글의 전문이 됐다(8차 K8.4).
 * 같은 까닭에 따옴표 제목이 없으면 Bluebook 학술지 칸(BLUEBOOK_JOURNAL — 「33 Review of Law & Economics 1 (2021)」)은 빼고 본다 — 학술지 이름 속
 * 「Review of」 로 예외가 켜지던 때는 서평 PDF 가 인용한 글의 전문이 됐다(8차 뒤따름 K8.4).
 */
const DISC_CITED_EN = /\b(?:book\s+review|review\s+(?:of|essay)|comments?\s+on|(?:response|reply)\s+to|discussion\s+of)\b/i;
/**
 * 인용 제목 속 다른 글을 다루는 글의 갈래 낱말 — 앞뒤에 한글이 붙지 않은 것(「[반론] …」「…에 대한 반론」「논평:」). 낱말 조각으로 보던 때는
 * 「언론중재법상 반론보도청구권의 요건」 의 「반론」 으로 예외가 켜져, 학술대회 페이지에서 발표문 앞에 걸린 그 토론문이 인용한 발표문의 전문이 됐다(8차 뒤따름 K8.5).
 */
const OTHER_WORK_CITED = new RegExp(`(?<![가-힣])(?:${OTHER_WORK})(?![가-힣])`);
const BLUEBOOK_JOURNAL = /(?:^|,)\s*\d+\s+[^,]*?\s\d+(?:\s*\(\d{4}\))?(?=\s*(?:,|$))/g;
const citesDiscussion = (citation: string) => {
    const t = quotedTitle(citation) ?? citation.replace(BLUEBOOK_JOURNAL, ',');
    return /토론|서평|書評/.test(t) || OTHER_WORK_CITED.test(t) || DISC_CITED_EN.test(t);
};
/**
 * 인용이 학술대회의 발표문·자료집인가 — 인용 어디든 발표문·발제문·자료집·학술대회·세미나·심포지엄·포럼·워크숍·proceedings 가 있다.
 * 그때 그 PDF 표지·일정표의 「지정토론」「종합토론」「토론자」 는 토론문 표지가 아니다(discussionFront).
 */
const citesConference = (citation: string) => /발표문|발제문|자료집|학술대회|세미나|심포지엄|포럼|워크숍|proceedings/i.test(citation);

/**
 * 받은 전문이 **인용한 그 글**인가. 따옴표로 적힌 제목이 본문(또는 페이지가 밝힌 제목)에 없으면 전문으로 받지 않는다 —
 * 모델이 쓴 인용의 DOI·URL 이 실재하는 **다른 논문**을 가리키면, 그 논문이 인용한 글의 원문으로 스크래치·캐시에 남았다.
 * KCI 는 저자·연도·제목으로 이미 맞춘 것이고 제목이 한자일 수 있어 여기서 다시 보지 않는다.
 *
 * 인용 제목이 받은 글과 **다른 글자**(영문 논문을 한글 번역 제목으로 인용)면 제목으로는 가를 수 없다. 그때는 **강한 식별자**가 있을 때만 같은 글로 본다 —
 * 인용한 DOI 가 그 글 **자신의** DOI 이거나(PDF 는 첫 쪽, 웹 페이지는 그 페이지가 밝힌 DOI), KCI 논문 ID·arXiv ID 로 그 등록처에서 받은 것(strongIdentifier).
 * 그리고 저자·연도가 어긋나면 버린다(bylineConflict) — 식별자가 그 DOI 이면, 어느 단계가 받았든 그 DOI 의 서지(doiByline: OpenAlex·Unpaywall)로 맞춘다.
 * URL·DOI 소개 페이지에서 받았다는 것만으로 믿던 때는 모델이 쓴 URL 이 가리킨 **다른** 영문 글이 한글 인용의 전문이 됐다.
 * 식별자가 없으면 그 글은 인용한 글이 아니다(not_found, 1차와 같다). metadata_only 로 그 글의 주소를 들고 있던 때는 「서지만 확보 · 후보 위치: <다른 글>」로 읽혀,
 * 지어낸 한글 인용의 「실재하지 않을 수 있다」 신호가 흐려졌다. 앞 단계가 찾은 진짜 서지(OpenAlex·Crossref 의 metadata_only)는 사다리가 그대로 남긴다(worse).
 * 같은 글자인데 제목이 없으면 다른 글이다(not_found).
 */
function vetFullText(d: SourceDoc, citation: string, doiByline?: Byline): SourceDoc {
    const citedTitle = quotedTitle(citation);
    const notIt = (why: string): SourceDoc => ({ state: 'not_found', how: d.how, ...(d.url ? { url: d.url } : {}), error: `받은 문서가 인용한 글로 보이지 않음 — ${why}` });
    // 운영 문서(투고·편집 규정, 저자 안내)가 첫머리인 PDF 는 인용한 글이 아니다 — 인용이 규정·지침 그 자체가 아니면(citesRule). 따옴표 제목이 없어도.
    if (d.state === 'full_text' && isPdfDoc(d) && !citesRule(citation) && operatingFront(d.fullText ?? '')) return notIt('운영 문서(규정·저자 안내)의 첫머리');
    if (!citedTitle) return d;
    // 초록·서지 페이지도 그 글이어야 한다 — DOI·URL 이 가리킨 **다른** 논문의 소개 페이지가 「초록만 확보」로 남으면 필자에게 다른 글의 초록이 보이고,
    // 앞 단계가 찾은 진짜 서지(metadata_only)를 가린다. 같은 글자의 따옴표 제목일 때만(번역 제목은 가를 수 없다).
    // 따라간 PDF 를 따옴표 제목으로만 고르게 되면서(fetchFollowingPdf) 다른 논문의 PDF 대신 그 소개 페이지가 돌아오게 되어 여기서 본다.
    if (d.state === 'abstract_only') {
        const why = notThisLanding(d, citedTitle);
        return why ? notIt(why) : d;
    }
    // 서지·짧은 페이지(metadata_only)는 보지 않는다(1차와 같다) — 전문도 초록도 아니어서 근거로도, 필자에게 보일 초록으로도 쓰이지 않고,
    // 들고 있는 주소는 인용이 스스로 적은 그 URL 이다. 몇 줄뿐인 페이지로는 글자 갈래·제목 대조도 믿을 수 없다.
    const main = docMain.get(d);
    if (d.state !== 'full_text' || mentionsTitle(citedTitle, `${d.title ?? ''}\n${d.fullText ?? ''}`, isPdfDoc(d) ? 'pdf' : 'page', main && `${d.title ?? ''}\n${main}`)) return d;
    if (scriptOf(citedTitle) === docScript(d)) return notIt(`제목 「${citedTitle.slice(0, 40)}」 이 본문에 없음`);
    const id = strongIdentifier(citation, d);
    // 다른 글의 주소는 들지 않는다 — 사다리의 마지막 실패로 남으면 필자에게 「후보 위치」로 보인다.
    if (!id) return { state: 'not_found', how: d.how, error: '받은 문서가 인용한 글로 보이지 않음 — 인용과 다른 글자로 적혀 제목으로 대조할 수 없고, 같은 글임을 보일 식별자(PDF 첫 쪽의 DOI·그 페이지가 밝힌 DOI·KCI 논문 ID·arXiv ID)가 없음' };
    const why = bylineConflict(citation, d, id.startsWith('DOI ') ? doiByline : undefined);
    return why ? notIt(why) : d;
}

/**
 * 소개 페이지의 제목 자리와 글(pageHeadsIn) — classifyFetched 가 abstract_only 웹 페이지에 붙인다. 문서 객체에만 붙고 캐시에는 안 들어간다.
 * text 는 관련 목록을 뺀 글(web.ts relatedFree), main 은 짧은 제목을 찾을 머리 제목 + 본문(mainOnly).
 */
const docPage = new WeakMap<SourceDoc, { heads: string[]; subheads: string[]; declared: string[]; text: string; main?: string }>();
/** 전문 웹 페이지의 머리 제목(h1) + 본문만 남긴 글(mainOnly) — vetFullText 가 짧은 제목을 찾는 자리. 문서 객체에만 붙는다. */
const docMain = new WeakMap<SourceDoc, string>();

/**
 * 같은 글자의 따옴표 제목으로 본 소개 페이지가 **인용한 그 글의 것이 아닌** 이유 — 그 글이면(또는 가를 수 없으면) undefined.
 *  1. 제목 자리(학술 메타·og:title·<title>·h1) 하나에 그 제목이 있으면 그 글이다.
 *  2. 없는데 페이지가 **같은 글자로** 제 글의 제목을 내걸었으면(학술 메타, 사이트 이름도 일반 머리말도 아닌 머리 h1) 다른 글이다 — h2·h3·본문에 그 제목이 있어도
 *     「관련 논문」 목록일 수 있으니 메타·머리 제목을 믿는다. h2·h3 을 내건 제목보다 먼저 보던 때는 관련 논문 목록을 h3 로 단 다른 논문의 소개 페이지가
 *     그 글의 초록으로 필자에게 보였다. 「국내학술지 논문 상세정보 보기」 같은 일반 머리말 h1 을 내건 제목으로 보던 때는 제목을 div 에 단 맞는 페이지를 버렸다.
 *  3. 내건 제목이 없으면 h2·h3, 그다음 페이지 글 전체에서 찾는다. <title> 과 앞 3000자만 보던 때는 일반 <title>(「RISS 검색 - 국내학술지논문 상세보기」)에
 *     긴 내비게이션 뒤 <h3> 로 제목을 단 맞는 소개 페이지를 「인용한 글이 아님」으로 버렸다.
 * 페이지를 모르면(예전 경로·API 의 초록) 제목과 초록 발췌로 본다.
 */
function notThisLanding(d: SourceDoc, citedTitle: string): string | undefined {
    // 소개 페이지 글에는 풀리지 않은 HTML 이름(「압수&middot;수색」 — htmlToText 는 몇 개만 푼다)이 남아 제목 글자를 끊으므로 지우고 본다.
    const clean = (t: string) => t.replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, '');
    const page = docPage.get(d);
    const body = clean(page?.text ?? `${d.title ?? ''}\n${d.abstractText ?? ''}`);
    const script = scriptOf(citedTitle);
    if (script !== scriptOf(body)) return undefined;
    const miss = `제목 「${citedTitle.slice(0, 40)}」 이 소개 페이지에 없음`;
    if (!page) return mentionsTitle(citedTitle, body, 'page') ? undefined : miss;
    const hit = (h: string) => Boolean(h) && mentionsTitle(citedTitle, clean(h), 'page');
    if ([d.title ?? '', ...page.heads].some(hit)) return undefined;
    const other = page.declared.map(clean).find((t) => scriptOf(t) === script);
    if (other) return `소개 페이지가 내건 제목이 다른 글(「${other.slice(0, 40)}」)의 것 — 본문·소제목에 인용한 제목이 있어도 관련 글 목록일 수 있다`;
    if (page.subheads.some(hit)) return undefined;
    return mentionsTitle(citedTitle, body, 'page', page.main && clean(page.main)) ? undefined : miss;
}

/**
 * 받은 글의 글자 갈래 — **본문 앞부분**(몇천 자)으로 본다. 웹 페이지의 제목(citation_title·og:title·<title>)은 사이트 이름(「LAWFIRM INSIGHTS」)일 때가 많아,
 * 제목으로 보던 때는 한글 인용·한글 본문인데도 「번역 제목」이 되어 제목 대조를 건너뛰고 다른 한글 글을 받았다. 본문이 없을 때만 제목.
 */
function docScript(d: SourceDoc): 'cjk' | 'latin' {
    const body = (d.fullText ?? '').slice(0, 3000);
    return scriptOf(body.trim() ? body : (d.title ?? ''));
}

/** 받은 글의 첫머리 — 첫 쪽(첫 \f 까지, 적어도 3000자·많아야 6000자). 웹 페이지는 앞 3000자. matchCorpus 와 같은 자리. */
function frontOf(text: string): string {
    const ff = text.indexOf('\f');
    return text.slice(0, Math.min(Math.max(ff, 3000), 6000));
}

/**
 * 글자가 다른 인용과 받은 글이 같은 글임을 보이는 식별자 — 있으면 그 이름, 없으면 undefined.
 *  · DOI: 인용한 DOI 가 받은 글 **자신의** DOI 다. PDF 는 첫 쪽 창(frontOf)의 머리 DOI, 없으면 첫 DOI 나 각주 밖 첫 DOI 줄이 그것이어야 한다(ownPdfDoiIs) —
 *    첫 쪽 창 어디든 보던 때는 자기 DOI(doi:10.9999/…)를 머리에 단 반론·논평이 첫 쪽 문장에 인용한 원 논문의 DOI 로 그 논문의 전문이 됐다. 참고문헌에 적힌 남의 DOI 는 창 밖이다.
 *    웹 페이지는 그 페이지가 밝힌 DOI 만 — citation_doi·dc.identifier·prism.doi·og 메타, 메타가 없을 때만 머리의 「DOI:」 라벨(줄 머리·서지 칸).
 *    첫머리 어디든 보던 때는 「This post responds to Smith (2020), doi:…」 처럼 그 DOI 를 문장 속에 인용한 블로그·논평이 그 논문의 전문이 됐고,
 *    메타가 있어도 라벨을 보던 때는 제 citation_doi 가 다른 글이 본문 앞 「관련 논문」 상자의 「DOI: …」 로 그 논문의 전문이 됐다.
 *    알려진 한계: 메타 없는 블로그가 머리 서지 상자에 「DOI: 10.…」 라벨 줄을 달면(논평 대상의 DOI) 그 글로 받는다 — 서지 칸과 가를 글자가 없다.
 *    저자·연도가 맞으면(bylineConflict) 걸러지지 않는다.
 *  · arXiv ID: arXiv 에서 그 ID 로 받은 것이거나 첫머리에 그 ID 가 있다.
 *  · KCI 논문 ID(ART…): KCI(kci.go.kr)가 그 ID 로 내준 것이거나 첫머리에 그 ID 가 있다. 다른 사이트 주소에 ID 가 들어 있는 것은 아니다.
 */
function strongIdentifier(citation: string, d: SourceDoc): string | undefined {
    const ref = parseRef(citation);
    const head = norm(frontOf(d.fullText ?? ''));
    const url = d.url ?? '';
    if (ref.doi && (isPdfDoc(d) ? ownPdfDoiIs(frontOf(d.fullText ?? ''), head, ref.doi) : ownDoiOfPage(d, ref.doi))) return `DOI ${ref.doi}`;
    if (ref.arxiv && ((d.how.startsWith('arxiv') && url.includes(ref.arxiv)) || head.includes(ref.arxiv))) return `arXiv ${ref.arxiv}`;
    const art = /ART\d{9}/.exec(citation)?.[0];
    if (art && (head.includes(norm(art)) || (/^https?:\/\/(?:[^/?#]+\.)?kci\.go\.kr[/:?#]/i.test(url) && url.includes(art)))) return `KCI ${art}`;
    return undefined;
}

/** PDF 에서 뽑은 글인가. 꼴을 모르는 예전 캐시는 주소(.pdf)·경로(arXiv·KCI 원문)·쪽 나눔(\f)으로 짐작한다. */
function isPdfDoc(d: SourceDoc): boolean {
    if (d.kind) return d.kind === 'pdf';
    return d.how.startsWith('arxiv') || d.how.startsWith('kci-pdf') || /\.pdf(?:$|[?#])/i.test(d.url ?? '') || (d.fullText ?? '').includes('\f');
}

/** PDF 첫 쪽 창(공백을 뺀 소문자)의 첫 DOI 가 그 DOI 인가. 줄바꿈에 끊긴 DOI 도 공백을 빼면 이어진다. */
function firstDoiIs(head: string, doi: string): boolean {
    const at = head.search(/10\.\d{4,9}\//);
    return at >= 0 && head.startsWith(norm(doi), at);
}

/**
 * PDF 첫 쪽 창의 DOI 가 그 글 **제 DOI** 로 인용한 DOI 인가.
 *  1. 머리(앞 다섯 줄 안, 제목 앞의 쪽 머리·권호 줄)에 DOI 가 있으면(doi.org 주소든 줄 속 「DOI:」 든) 그것이 그 글의 DOI 다 — 다르면 다른 글(반론·논평)이다.
 *     머리 줄 속 제 DOI(「형사법연구 제34권 제1호 … https://doi.org/10.9999/…」「… pp.1-30 DOI: 10.9999/…」)를 보지 않던 때는 그 아래 「대상 논문: … ⏎ DOI: 10.1234/…」
 *     라벨 줄로 반론이 대상 논문의 전문이 됐다.
 *  2. 머리에 없으면 각주 자리 밖의 **첫** DOI 줄(「DOI:」「doi:」 라벨 + 그 DOI 하나뿐인 줄, 또는 doi.org 주소만인 줄)이 그것이다. 그런 줄이 없을 때만 첫 DOI(firstDoiIs).
 *     각주 자리: 각주 표지(「1)」「1.」「*」「†」「‡」「주1)」 위 첨자 숫자)로 시작하는 줄부터 그 각주가 끝날 때까지 — 그 각주의 DOI 줄, 마침표로 끝난 줄, 투고일·심사일·
 *     게재확정일·Received·Keywords 같은 서지 줄, 다음 각주 표지 앞에서 끝난다. 첫 대문자 「DOI:」 줄만 보던 때는 줄바꿈에 끊겨 제 줄에 선 각주의 「DOI: 10.5555/…」 가
 *     제 DOI 가 되어 그 논문 자신의 PDF 를 버렸고, 소문자 「doi:」·doi.org 주소 줄을 보지 않던 때는 아래쪽 제 DOI 줄을 놓쳤다.
 *     소속·학위 각주(AFFIL_NOTE — 「*」「†」「**」 + 교수·박사·대학교·Professor·University…, DOI·인용 부호 없음)는 각주 자리를 열지 않는다 — 열던 때는
 *     「* 한빛대학교 법학전문대학원 교수, 법학박사」 바로 다음의 제 「DOI:」 줄을 각주의 것으로 건너뛰어 그 논문 자신의 PDF 를 버렸다(8차 K8.6).
 *  3. 첫 쪽의 DOI 줄이 **모두** 각주 자리에 있으면 제 DOI 줄은 없다 — 첫 쪽 창의 첫 DOI(firstDoiIs)로 받지 않는다(제목 대조가 가른다). 그때도 첫 DOI 로 보던 때는
 *     각주에 「doi:」 줄로 인용한 남의 DOI 가 그 논문의 DOI 가 되어 다른 글이 인용한 글의 전문이 됐다(8차 K8.6). 제목 덩어리(첫 각주 표지·초록·장 머리말 앞)의
 *     서지 줄 속 DOI 만은 제 DOI 로 본다(8차 뒤따름 K8.6).
 * 문장 속에 인용한 DOI(「This reply responds to …, doi:10.1234/…, and …」)는 줄에 홀로 서지 않으니 여전히 아니다.
 */
const DOI_IN_LINE = /(?:https?:\/\/(?:dx\.)?doi\.org\/|\bdoi\b[ \t ]*[:：]?[ \t ]*)(10\.\d{4,9}\/[^\s,;)"'<>]+)/i;
const DOI_LINE = /^[ \t ]*(?:doi[ \t ]*[:：]?[ \t ]*(?:https?:\/\/(?:dx\.)?doi\.org\/)?|https?:\/\/(?:dx\.)?doi\.org\/)(10\.\d{4,9}\/[^\s,;)"'<>]+)[ \t ]*$/i;
const FOOT_MARK = /^(?:\d{1,3}\)|\d{1,3}\.(?!\d)|[*†‡]|주\s*\d+\)|[¹²³⁴⁵⁶⁷⁸⁹⁰])/;
const BIB_LINE = /^(?:투고일|접수일|심사일|수정일|게재확정일|게재일|논문접수|Received|Revised|Accepted|Published|키워드|주제어|Key\s*words?)/i;
/** 소속·학위 각주 — 「*」「†」(「**」 도) 표지 + 소속·학위 낱말, DOI 도 인용 부호(「」『』“”·면·pp.·p.)도 없는 줄. 각주 자리를 열지 않는다. */
const AFFIL_WORD =
    /교수|부교수|조교수|강사|연구원|연구위원|박사|법학박사|변호사|판사|검사|대학교|대학원|법학전문대학원|연구소|Professor|Lecturer|Researcher|Ph\.\s?D\.?|J\.D\.|LL\.M\.|S\.J\.D\.|University|School\s+of\s+Law/i;
const CITE_MARK = /[「」『』“”면]|\bpp?\./;
const affilNote = (l: string) => /^[*†]/.test(l) && AFFIL_WORD.test(l) && !DOI_IN_LINE.test(l) && !CITE_MARK.test(l);
function ownPdfDoiIs(front: string, head: string, doi: string): boolean {
    const want = norm(doi);
    const doiOf = (m: RegExpExecArray | null) => (m ? norm(m[1]!.replace(/[.,;:]+$/, '')) : undefined);
    const lines = front.split('\n').map((l) => l.trim()).filter(Boolean);
    // 머리 = 제목 **앞**의 쪽 머리·권호 줄들(앞 다섯 줄 안) — 제목 아래 줄(「대상 논문: … https://doi.org/<대상>」)까지 머리로 보던 때는 반론이 대상 논문의 전문이 됐다.
    const lead: string[] = [];
    for (const l of lines.slice(0, 5)) {
        if (FOOT_MARK.test(l) || !runningHeadLine(l)) break;
        lead.push(l);
    }
    const top = lead.find((l) => DOI_IN_LINE.test(l));
    if (top) return doiOf(DOI_IN_LINE.exec(top)) === want;
    // 각주 밖 첫 DOI 줄이 먼저다 — 첫 DOI(firstDoiIs)를 먼저 보던 때는 각주 1) 에 인용한 남의 DOI 가 첫 DOI 일 때 그 논문의 전문이 됐다.
    // 각주 밖 DOI 줄이 없을 때만 첫 DOI 로 본다(4차 결정 4 — 첫 쪽 머리·서지 칸 속의 DOI).
    let foot = false;
    let footDoi = false;
    for (const l of lines) {
        if (FOOT_MARK.test(l)) {
            // 표지 줄에 DOI 까지 있거나 마침표로 끝났으면 그 줄로 끝난 각주. 소속·학위 각주는 각주 자리가 아니다(앞 각주도 여기서 끝난다).
            foot = !affilNote(l) && !DOI_IN_LINE.test(l) && !/[.。]$/.test(l);
            continue;
        }
        const own = doiOf(DOI_LINE.exec(l));
        if (own) {
            if (!foot) return own === want;
            foot = false; // 각주의 DOI 줄 — 그 각주는 여기서 끝난다
            footDoi = true;
            continue;
        }
        if (foot && (BIB_LINE.test(l) || /[.。]$/.test(l))) foot = false; // 서지 줄 앞에서, 또는 마침표로 끝난 줄에서 각주가 끝난다
    }
    // DOI 줄이 다 각주의 것이면 제 DOI 줄은 없다 — 첫 쪽 창의 첫 DOI 는 그 각주의 남의 DOI 일 수 있다(8차 K8.6). 다만 제목 덩어리(첫 각주 표지·초록 라벨·
    // 장 머리말 앞, 소속·학위 각주는 넘는다)의 서지 줄 속 DOI(「형사법연구 제33권 제2호(2021) pp.1-30, DOI 10.1234/…」)는 라벨 줄이 아니어도 제 DOI 다 —
    // 그것까지 버리던 때는 줄바꿈된 각주가 「doi:」 줄을 홀로 세운 그 논문 자신의 PDF 를 버렸다(8차 뒤따름 K8.6).
    if (footDoi) {
        const end = lines.findIndex((l) => (FOOT_MARK.test(l) && !affilNote(l)) || titleBlockEnd(l));
        return firstDoiIs(norm(lines.slice(0, end < 0 ? lines.length : end).join('\n')), doi);
    }
    return firstDoiIs(head, doi);
}
/** 제목 앞의 쪽 머리·권호 줄인가 — ownTitleOf 의 쪽 머리글 꼴(권호·쪽·ISSN·DOI·주소·KCI 배지·「연구논문」, 한자만인 줄, 짧은 학회·학술지 이름 줄). */
const runningHeadLine = (l: string) => PAGE_HEAD_LINE.test(l) || HANJA_LINE.test(l) || (l.length <= 25 && SOCIETY_LINE.test(l));

/** 웹 페이지가 그 DOI 를 **자기** DOI 로 밝혔는가 — 메타(pageDois). 메타가 없을 때만 머리(앞 3000자)의 DOI 라벨(doiLabelsIn) — 메타가 밝힌 DOI 가 다르면 그것이 그 페이지다. */
function ownDoiOfPage(d: SourceDoc, doi: string): boolean {
    const want = norm(doi);
    const own = d.pageDois?.length ? d.pageDois : doiLabelsIn(frontOf(d.fullText ?? ''));
    return own.some((x) => norm(x) === want);
}

/**
 * 머리의 DOI 라벨 — 줄 머리·탭 뒤나 서지 칸 사이(「·」「|」「•」) 다음의 「DOI: 10.…」「doi 10.…」「DOI: https://doi.org/10.…」. 「DOI」 라벨이 있어야 한다.
 * 「John Smith · J. Law & Tech. 3 (2020) · doi:10.…」 는 그 글의 서지 칸이고, 「…responds to Smith (2020), doi:10.…, on …」 은 문장 속 인용이다.
 * 라벨 없이 줄에 홀로 선 doi.org 주소는 세지 않는다 — 블로그의 「논문 보기: ⏎ https://doi.org/…」 링크도 그 꼴이다.
 */
function doiLabelsIn(text: string): string[] {
    const re = /(?:^|\n|\t|[·•|｜])[ \t\u00a0]*(?:DOI|doi)[ \t\u00a0]*[:：]?[ \t\u00a0]*(?:https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/[^\s,;)"'<>]+)/g;
    return [...text.matchAll(re)].map((m) => m[1]!.replace(/[.,;:]+$/, ''));
}

/** 글자 갈래 — 한글·한자가 라틴 글자의 1/3 이상이면 cjk. 짧은 제목과 본문 앞부분에 같은 잣대(영문 논문 속 한글 낱말 몇 개로 갈래가 바뀌지 않게). */
function scriptOf(s: string): 'cjk' | 'latin' {
    const cjk = (s.match(/[가-힣一-鿿]/g) ?? []).length;
    const latin = (s.match(/[A-Za-z]/g) ?? []).length;
    return cjk > 0 && cjk * 3 >= latin ? 'cjk' : 'latin';
}

/** 식별자로 찾은 글의 서지(OpenAlex·Unpaywall) — 번역 제목일 때 bylineConflict 가 저자·연도를 맞춰 본다. 문서 객체에만 붙고 캐시에는 안 들어간다. */
type Byline = { year?: number; authors?: string[] };
const docByline = new WeakMap<SourceDoc, Byline>();

/** OpenAlex 작품·Unpaywall 응답의 서지. 연도도 저자도 없으면 undefined. */
function bylineOf(year: unknown, authors: string[]): Byline | undefined {
    const out: Byline = { ...(typeof year === 'number' ? { year } : {}), ...(authors.length ? { authors } : {}) };
    return out.year !== undefined || out.authors ? out : undefined;
}

/** 번역 제목의 인용과 받은 글의 저자·연도가 어긋나는가 — 어긋나면 이유, 맞거나 가를 수 없으면 undefined. 글에 붙은 서지가 없으면 fallback(그 DOI 의 서지). */
function bylineConflict(citation: string, d: SourceDoc, fallback?: Byline): string | undefined {
    const meta = docByline.get(d) ?? fallback;
    const year = citedYear(citation);
    if (year && meta?.year && Math.abs(meta.year - Number(year)) > 1) return `연도 불일치(인용 ${year}, 받은 글 ${meta.year})`;
    // 저자는 받은 글과 같은 글자로 적혔을 때만 맞춰 본다(영문 논문의 「Smith」·「Lee J.」). 「스미스」·「김철수」를 영문 글에 대 보는 것은 어느 쪽 증거도 아니다.
    const lead = citation.split(/[,，「『"“(]/)[0] ?? '';
    const names = (lead.match(docScript(d) === 'latin' ? /[A-Za-z][A-Za-z'\-]+/g : /[가-힣]{2,5}/g) ?? []).filter((n) => !/^(?:et|al|and|외|등)$/i.test(n));
    if (!names.length) return undefined;
    // 서지가 없으면 글의 **첫머리**에서 찾는다 — 본문 전체를 보면 참고문헌의 「Smith 2019.」가 저자로 걸렸다.
    const pool = (meta?.authors?.length ? meta.authors.join(' ') : `${d.title ?? ''}\n${frontOf(d.fullText ?? '')}`).toLowerCase();
    return names.some((n) => pool.includes(n.toLowerCase())) ? undefined : `번역 제목이라 저자로 대조했으나 저자(${names.join('·')})가 받은 글에 없음`;
}

function classifyFetched(d: Awaited<ReturnType<typeof fetchUrl>>): SourceDoc {
    if (d.error) return { state: 'error', how: 'direct', url: d.url, error: d.error };
    if (d.login) return { state: 'login_required', how: 'direct', url: d.url };
    if (d.paywall) return { state: 'paywalled', how: 'direct', url: d.url };
    if (!d.text.trim()) return { state: 'error', how: 'direct', url: d.url, error: 'empty' };
    // 1면짜리 PDF는 초록면(미리보기)이다. 길이가 길어도 전문이 아니다 — KCI 미리보기가 이렇다.
    if (d.kind === 'pdf' && d.pages !== undefined && d.pages <= 1) {
        return {
            state: hasAbstract(d.text) ? 'abstract_only' : 'metadata_only',
            how: 'direct',
            url: d.url,
            chars: d.text.length,
            ...(hasAbstract(d.text) ? { abstractText: d.text.slice(0, 3000) } : {}),
            error: `PDF ${d.pages}면(초록면) — 전문이 아니다. 여러 면의 원문을 확보해야 한다`,
        };
    }
    // 웹 페이지는 구조 신호가 제목 자리에 있어야 전문이다. KCI 논문 소개 페이지는 늘 초록·서지다.
    const landing = d.kind === 'html' && KCI_LANDING.test(d.url);
    if (!landing && looksLikeFullText(d.text, d.kind === 'html')) {
        const out: SourceDoc = {
            state: 'full_text',
            how: 'direct',
            url: d.url,
            ...(d.title ? { title: d.title } : {}),
            fullText: d.text,
            chars: d.text.length,
            kind: d.kind,
            ...(d.dois?.length ? { pageDois: d.dois } : {}),
        };
        // 짧은 제목을 찾을 자리 — 머리 제목(h1)과 본문만 남긴 글. 곁 상자·메뉴·링크 목록은 뺀다(vetFullText).
        if (d.kind === 'html' && d.mainText !== undefined) docMain.set(out, [...(d.heads ?? []), d.mainText].join('\n'));
        return out;
    }
    const out: SourceDoc = {
        state: hasAbstract(d.text) ? 'abstract_only' : 'metadata_only',
        how: 'direct',
        url: d.url,
        // 페이지 제목은 vetFullText 가 「그 글의 소개 페이지인가」를 볼 때 쓴다(초록 발췌가 앞 3000자뿐이라 긴 내비게이션 뒤의 제목을 놓치지 않게).
        ...(d.kind === 'html' && d.title ? { title: d.title } : {}),
        ...(hasAbstract(d.text) ? { abstractText: d.text.slice(0, 3000) } : {}),
        chars: d.text.length,
    };
    // 소개 페이지의 제목 자리와 글 전체 — vetFullText(notThisLanding)가 그 글의 소개 페이지인지 본다.
    if (out.state === 'abstract_only' && d.kind === 'html')
        docPage.set(out, {
            heads: d.heads ?? [],
            subheads: d.subheads ?? [],
            declared: d.declared ?? [],
            text: d.landText ?? d.text,
            ...(d.mainText !== undefined ? { main: [...(d.heads ?? []), d.mainText].join('\n') } : {}),
        });
    return out;
}

/**
 * KCI — 한국 학술지. Open API 로 서지·초록을 찾고, 논문 페이지의 "KCI 원문 내려받기"로 전문 PDF 를 받는다.
 *
 * 받으면 full_text. 버튼이 없거나(학술지 정책) 받지 못하면 abstract_only/metadata_only 로 남기고 그 이유를
 * error 에 적는다 — 사람에게 원문을 물을 때 정확한 서지와 함께 "왜 못 받았는지"가 보인다.
 * OpenAlex·Crossref 가 한국 문헌에서 실패하는 자리를 이 단계가 메운다.
 */
/**
 * KCI 검색 결과가 **인용한 그 논문**인가. 제목만 같으면 안 된다 — 「사이버범죄에 관한 연구」는 저자가 다른 논문이 여럿이고,
 * 제목이 앞부분만 같은 다른 논문도 흔하다. 저자(인용의 첫 쉼표·따옴표 앞)와 연도(±1)를 맞춰 본다.
 * 저자가 기관명이거나 없으면 저자 대신 제목 완전 일치를 요구한다.
 */
export function kciMatchesCitation(citation: string, a: KciArticle, title: string): { ok: boolean; why?: string } {
    const year = citedYear(citation);
    if (year && a.year && Math.abs(Number(a.year) - Number(year)) > 1) return { ok: false, why: `연도 불일치(인용 ${year}, KCI ${a.year})` };
    const names = citedAuthors(citation);
    const kciNames = a.authors.map((n) => n.replace(/\s+/g, ''));
    if (names.length) {
        // 같은 이름만 같다고 본다. 포함 관계는 둘 다 3자 이상일 때만(2자 이름 "이근" ⊂ "이근우" 를 같다고 하지 않게).
        const same = (n: string, k: string) => n === k || (n.length >= 3 && k.length >= 3 && (k.includes(n) || n.includes(k)));
        const hit = names.some((n) => kciNames.some((k) => same(n, k)));
        return hit ? { ok: true } : { ok: false, why: `저자 불일치(인용 ${names.join('·')}, KCI ${kciNames.slice(0, 3).join('·') || '미상'})` };
    }
    // 저자를 못 읽었으면(기관 저자 등) 제목이 완전히 같아야 한다.
    return normTitle(a.title) === normTitle(title) ? { ok: true } : { ok: false, why: '저자를 확인할 수 없고 제목도 완전히 같지 않음' };
}

/** 인용의 저자들 — 첫 쉼표·따옴표 앞. "김철수 외 2인", "박영찬·정재민·한상미 외", "김 철 수". */
export function citedAuthors(citation: string): string[] {
    const lead = citation.split(/[,，「『"“(]/)[0]!.trim();
    return lead
        .replace(/\s*(?:외|등)\s*(?:\d+\s*(?:인|명))?\s*$/, '') // 한글 뒤 \b 는 JS 에서 듣지 않는다 — 끝의 "외 2인"을 직접 뗀다
        .split(/\s*[·ㆍ・,]\s*/)
        .map((x) => x.replace(/\s+/g, ''))
        .filter((x) => /^[가-힣]{2,5}$|^[A-Za-z][A-Za-z.\-]{1,30}$/.test(x));
}

/** 발행 연도 — 제목 안의 연도("2020년 형사소송법 개정")가 아니라 제목 **뒤**의 것. */
export function citedYear(citation: string): string | undefined {
    const rest = citation.replace(/^[^「『“"]*[「『“"][^」』”"]+[」』”"]/, '');
    const ys = [...rest.matchAll(/(?<!\d)((?:19|20)\d{2})(?!\d)/g)].map((m) => m[1]!);
    return ys[0] ?? /(?<!\d)((?:19|20)\d{2})(?!\d)/.exec(citation)?.[1];
}

/** 인용의 게재지 — 학술지명·권·호·시작 쪽. "「헌법학연구」 제11권 제3호, 2005" · "법학논총 34(2), 2010, 249-275면" · "Vol.11 No.3" */
export function citedVenue(citation: string): { journal?: string; volume?: string; issue?: string; fpage?: string } {
    // 제목(첫 따옴표 묶음)을 지운 나머지에서 찾는다.
    const rest = citation.replace(/^[^「『“"]*[「『“"][^」』”"]+[」』”"]/, '');
    const quoted = /[「『]([^」』]{2,40})[」』]/.exec(rest)?.[1];
    const plain = /^[\s,，]*([가-힣A-Za-z·\s]{2,30}?)\s*(?:\([^)]{1,12}\)\s*)?(?=제\s*\d+\s*[권집]|\d+\s*\(\s*\d+\s*\)|\d+\s*,|Vol\.?\s*\d|,\s*(?:19|20)\d{2})/i.exec(rest)?.[1];
    const journal = (quoted ?? plain)?.replace(/\s+/g, ' ').trim();
    const vi =
        /제\s*(\d+)\s*[권집](?:\s*(?:제\s*)?(\d+)\s*호)?/.exec(rest) ?? /(\d+)\s*\(\s*(\d+)\s*\)/.exec(rest) ?? /Vol\.?\s*(\d+)(?:\s*,?\s*No\.?\s*(\d+))?/i.exec(rest);
    const fpage = /(\d{1,4})\s*[-–~]\s*\d{1,4}\s*[면쪽]/.exec(rest)?.[1] ?? /pp?\.\s*(\d{1,4})/i.exec(rest)?.[1];
    return { ...(journal ? { journal } : {}), ...(vi?.[1] ? { volume: vi[1] } : {}), ...(vi?.[2] ? { issue: vi[2] } : {}), ...(fpage ? { fpage } : {}) };
}

const HANJA = /[一-鿿豈-﫿]/;
const HANGUL_SYL = /[가-힣]/;

/**
 * 한자 섞인 KCI 제목과 한글 인용 제목이 같은 제목인가. 한자 한 글자는 한글 한 음절이 된다(住民 → 주민).
 * 앞에서부터 짧은 쪽 길이만큼 한 글자씩 맞춘다 — 한자 자리는 한글 음절이면 되고, 나머지는 글자가 같아야 한다.
 * 인용이 부제를 뺐을 수 있으므로 짧은 쪽이 긴 쪽의 60% 이상이면 된다.
 */
export function hanjaTitleMatches(kciTitle: string, citedTitle: string): boolean {
    const k = [...normTitle(kciTitle)];
    const c = [...normTitle(citedTitle)];
    const n = Math.min(k.length, c.length);
    if (n < 6 || n < 0.6 * Math.max(k.length, c.length)) return false;
    // 맞춰 볼 한글이 두 자는 있어야 한다 — 전부 한자인 제목("刑法上 錯誤論 小考")은 같은 길이의 아무 한글 제목과도 맞는다.
    if (k.slice(0, n).filter((ch) => HANGUL_SYL.test(ch)).length < 2) return false;
    for (let i = 0; i < n; i++) {
        const kc = k[i]!;
        const cc = c[i]!;
        if (HANJA.test(kc)) {
            if (!HANGUL_SYL.test(cc)) return false;
        } else if (kc !== cc) return false;
    }
    return true;
}

/**
 * 제목으로 못 찾을 때 — 옛 논문은 KCI 에 제목이 한자로 저장돼 있다("住民登錄番號의 違憲性與否에 관한 考察").
 * 저자+학술지(없으면 저자+연도 범위)로 찾는다. 받는 조건:
 *  · 저자·연도가 맞고(kciMatchesCitation)
 *  · 게재지가 **어긋나지 않고**(권·호·시작 쪽이 둘 다 있는데 다르면 탈락)
 *  · 학술지명 또는 권·호(또는 시작 쪽)가 맞고
 *  · 제목이 맞는다(한자 제목은 글자 자리 맞춤, 한글이 거의 없는 한자 제목은 권·호나 시작 쪽까지 맞아야)
 * 여럿이면 가장 많이 맞는 것.
 */
async function kciByVenue(citation: string, title: string, so: { signal?: AbortSignal }): Promise<KciArticle | undefined> {
    const author = citedAuthors(citation)[0];
    if (!author || !/^[가-힣]{2,5}$/.test(author)) return undefined;
    const year = citedYear(citation);
    const v = citedVenue(citation);
    if (!v.journal && !(v.volume && v.issue) && !v.fpage) return undefined;
    const q = v.journal
        ? { author, journal: v.journal, displayCount: 100 }
        : year
          ? { author, dateFrom: `${Number(year) - 1}01`, dateTo: `${Number(year) + 1}12`, displayCount: 100 }
          : undefined;
    if (!q) return undefined;
    const res = await kciSearch(q, so);
    const nj = (s?: string) => (s ?? '').replace(/[\s「」『』]/g, '');
    const differs = (x?: string, y?: string) => Boolean(x && y && x !== y);
    let best: { a: KciArticle; score: number } | undefined;
    for (const a of res.articles) {
        if (!kciMatchesCitation(citation, a, title).ok) continue;
        if (differs(v.volume, a.volume) || differs(v.issue, a.issue) || differs(v.fpage, a.fpage)) continue;
        const journalOk = Boolean(v.journal && a.journal && (nj(a.journal).includes(nj(v.journal)) || nj(v.journal).includes(nj(a.journal))));
        const volOk = Boolean(v.volume && a.volume === v.volume && v.issue && a.issue === v.issue);
        const pageOk = Boolean(v.fpage && a.fpage === v.fpage);
        if (!journalOk && !volOk && !pageOk) continue;
        let titleOk: boolean;
        if (HANJA.test(a.title)) {
            const hangul = a.title.replace(/[^가-힣]/g, '').length;
            // 한글이 거의 없는 한자 제목은 글자 수가 비슷하고 권·호나 시작 쪽까지 맞아야 한다.
            const lenClose = Math.abs(normTitle(a.title).length - normTitle(title).length) <= 2;
            titleOk = hanjaTitleMatches(a.title, title) || (hangul < 2 && lenClose && (volOk || pageOk));
        } else titleOk = Boolean(bestKciMatch(title, [a]));
        if (!titleOk) continue;
        const score = (journalOk ? 1 : 0) + (volOk ? 2 : 0) + (pageOk ? 2 : 0);
        if (!best || score > best.score) best = { a, score };
    }
    return best?.a;
}

async function tryKci(ref: { title?: string; doi?: string }, citation: string, signal?: AbortSignal): Promise<SourceDoc> {
    const title = ref.title?.slice(0, 120);
    if (!title && !ref.doi) return { state: 'not_found', how: 'kci' };
    try {
        const so = { ...(signal ? { signal } : {}) };
        let hit: KciArticle | undefined;
        if (ref.doi) {
            const res = await kciSearch({ doi: ref.doi, displayCount: 5 }, so);
            hit = res.articles[0];
            // 모델이 쓴 DOI 가 실재하는 **다른** 논문의 것일 수 있다 — 따옴표 제목이 있고 같은 글자(한글·한자/로마자)로 적혀 있으면 제목도 맞아야 한다.
            const qt = quotedTitle(citation);
            const script = (s: string) => /[가-힣一-鿿]/.test(s);
            if (hit && qt && script(qt) === script(hit.title) && !bestKciMatch(qt, [hit]) && !hanjaTitleMatches(hit.title, qt)) hit = undefined;
        }
        // DOI 검색은 정확 일치뿐이다 — 못 찾으면 제목으로.
        let rejected: string | undefined;
        if (!hit && title) {
            const res = await kciSearch({ title, displayCount: 10 }, so);
            if (res.error && !res.articles.length) return { state: 'error', how: 'kci', error: res.error };
            // 제목이 맞는 후보 가운데 저자·연도까지 맞는 것만. 제목만 맞는 것은 다른 논문일 수 있다.
            const fits = res.articles.filter((x) => kciMatchesCitation(citation, x, title).ok);
            hit = bestKciMatch(title, fits);
            if (!hit) {
                const near = bestKciMatch(title, res.articles);
                if (near) rejected = `KCI에 제목이 비슷한 논문은 있으나 인용한 것과 다름 — ${kciMatchesCitation(citation, near, title).why} (${near.title.slice(0, 40)})`;
            }
        }
        // 제목으로 못 찾으면 저자·게재지로(한자 제목·표기 차이)
        if (!hit && title) {
            hit = await kciByVenue(citation, title, so);
            if (hit) rejected = undefined;
        }
        if (!hit) return { state: 'not_found', how: 'kci', error: rejected ?? 'KCI에서 일치 항목 없음' };
        const a = (await kciDetail(hit.id, so)) ?? hit;
        const page = a.url ?? kciArticlePage(a.id);
        // 원문 PDF — 논문 페이지의 "KCI 원문 내려받기".
        const full = await kciFullText(a.id, so);
        if (full.ok) {
            return { state: 'full_text', how: 'kci-pdf', url: page, title: a.title, fullText: full.text, chars: full.text.length };
        }
        const note = ['KCI', a.kciRegistration, a.journal, a.year].filter(Boolean).join(' ');
        const why =
            full.reason === 'no-button'
                ? `${full.detail}. 원문은 학회 사이트·기관구독 또는 필자 제공 필요`
                : `KCI 원문 내려받기 실패(${full.detail}). 논문 페이지에서 직접 받아 주시면 됩니다`;
        return {
            state: a.abstract ? 'abstract_only' : 'metadata_only',
            how: 'kci',
            url: page,
            title: a.title,
            chars: a.abstract?.length ?? 0,
            ...(a.abstract ? { abstractText: a.abstract.slice(0, 3000) } : {}),
            error: `${note} — ${why}`,
        };
    } catch (e) {
        // 사용자가 멈췄으면 멈춘다 — 실패로 삼켜 사다리를 계속 돌면 안 된다.
        if (signal?.aborted) throw e;
        return { state: 'error', how: 'kci', error: e instanceof Error ? e.message.slice(0, 160) : String(e) };
    }
}

async function tryArxiv(ref: { arxiv?: string; title?: string }, signal?: AbortSignal): Promise<SourceDoc> {
    try {
        if (ref.arxiv) {
            const pdf = await fetchUrl(`https://arxiv.org/pdf/${ref.arxiv}`, { signal });
            if (pdf.error || !pdf.text.trim()) return { state: 'error', how: 'arxiv', error: pdf.error ?? 'empty' };
            return { state: 'full_text', how: 'arxiv', url: `https://arxiv.org/abs/${ref.arxiv}`, fullText: pdf.text, chars: pdf.text.length, kind: pdf.kind };
        }
        const q = encodeURIComponent(`all:"${ref.title!.replace(/"/g, '')}"`);
        const res = await fetch(`https://export.arxiv.org/api/query?search_query=${q}&max_results=10`, { signal });
        const xml = await res.text();
        const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
            const body = m[1]!;
            return {
                id: /<id>https?:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/.exec(body)?.[1] ?? '',
                title: (/<title>([\s\S]*?)<\/title>/.exec(body)?.[1] ?? '').replace(/\s+/g, ' ').trim(),
            };
        });
        const best = bestTitleMatch(ref.title!, entries.filter((e) => e.id));
        if (!best) {
            return {
                state: entries.length ? 'metadata_only' : 'not_found',
                how: 'arxiv',
                ...(entries.length ? { title: entries[0]!.title, error: '제목이 일치하는 항목 없음' } : {}),
            };
        }
        const pdf = await fetchUrl(`https://arxiv.org/pdf/${best.id}`, { signal });
        if (pdf.error || !pdf.text.trim()) return { state: 'error', how: 'arxiv', error: pdf.error ?? 'empty' };
        return {
            state: 'full_text',
            how: 'arxiv',
            url: `https://arxiv.org/abs/${best.id}`,
            title: best.title,
            fullText: pdf.text,
            chars: pdf.text.length,
            kind: pdf.kind,
        };
    } catch (e) {
        return { state: 'error', how: 'arxiv', error: String(e) };
    }
}

function unabstract(inv: Record<string, number[]> | null | undefined): string | undefined {
    if (!inv) return undefined;
    const slots: string[] = [];
    for (const [word, positions] of Object.entries(inv)) for (const p of positions) slots[p] = word;
    return slots.filter(Boolean).join(' ') || undefined;
}

async function tryOpenAlex(ref: { title?: string; doi?: string }, signal?: AbortSignal): Promise<SourceDoc> {
    try {
        const url = ref.doi
            ? `https://api.openalex.org/works/https://doi.org/${ref.doi}`
            : `https://api.openalex.org/works?search=${encodeURIComponent(ref.title!)}&per_page=5`;
        const res = await fetch(url, { signal, headers: { 'user-agent': 'legal-agent-poc' } });
        if (!res.ok) return { state: 'error', how: 'openalex' };
        const j: any = await res.json();
        const works: any[] = ref.doi ? [j] : (j.results ?? []);
        if (!works.length) return { state: 'not_found', how: 'openalex' };
        const w = ref.doi
            ? works[0]
            : bestTitleMatch(ref.title!, works.filter((x) => x.display_name).map((x) => ({ ...x, title: x.display_name as string })));
        if (!w) return { state: 'metadata_only', how: 'openalex', title: works[0]?.display_name, error: '제목이 일치하는 항목 없음' };

        const abstractText = unabstract(w.abstract_inverted_index);
        const byline = bylineOf(w.publication_year, ((w.authorships ?? []) as any[]).map((x) => x?.author?.display_name).filter((n): n is string => typeof n === 'string'));
        const cands = [
            w.best_oa_location?.pdf_url,
            w.best_oa_location?.landing_page_url,
            w.open_access?.oa_url,
            w.primary_location?.pdf_url,
            w.primary_location?.landing_page_url,
        ].filter(Boolean) as string[];
        for (const u of cands) {
            const doc = classifyFetched(await fetchFollowingPdf(u, { signal }, w.display_name ? { hint: w.display_name } : {}));
            if (doc.state === 'full_text') {
                const out: SourceDoc = { ...doc, how: 'openalex', title: w.display_name ?? doc.title };
                if (byline) docByline.set(out, byline);
                return out;
            }
            await sleep(150);
        }
        const out: SourceDoc = {
            state: abstractText ? 'abstract_only' : 'metadata_only',
            how: 'openalex',
            ...(w.doi ? { url: w.doi } : {}),
            title: w.display_name ?? undefined,
            ...(abstractText ? { abstractText } : {}),
        };
        // 전문을 못 받아도 서지는 남긴다 — 사다리가 뒤의 「DOI 소개 페이지」 단계에 같은 저자·연도 대조를 건다.
        if (byline) docByline.set(out, byline);
        return out;
    } catch (e) {
        return { state: 'error', how: 'openalex', error: String(e) };
    }
}

async function tryCrossrefUnpaywall(ref: { title?: string; doi?: string }, signal?: AbortSignal): Promise<SourceDoc> {
    try {
        let doi = ref.doi;
        if (!doi && ref.title) {
            const res = await fetch(`https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(ref.title)}&rows=5`, { signal });
            if (!res.ok) return { state: 'error', how: 'crossref' };
            const j: any = await res.json();
            const items = (j?.message?.items ?? []).map((it: any) => ({ ...it, title: (it.title ?? [])[0] ?? '' }));
            const hit = ref.title ? bestTitleMatch(ref.title, items) : items[0];
            if (!hit?.DOI) return { state: 'not_found', how: 'crossref', error: '제목이 일치하는 항목 없음' };
            doi = hit.DOI;
        }
        if (!doi) return { state: 'not_found', how: 'crossref' };
        const email = process.env.LEGAL_AGENT_CONTACT_EMAIL;
        if (!email) return { state: 'metadata_only', how: 'crossref', url: `https://doi.org/${doi}`, title: ref.title };
        const res = await fetch(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`, { signal });
        if (!res.ok) return { state: 'metadata_only', how: 'crossref', url: `https://doi.org/${doi}` };
        const j: any = await res.json();
        const loc = j?.best_oa_location;
        const u = loc?.url_for_pdf ?? loc?.url;
        if (!u) return { state: 'metadata_only', how: 'crossref', url: `https://doi.org/${doi}`, title: j?.title };
        const byline = bylineOf(j?.year, ((j?.z_authors ?? []) as any[]).map((x) => [x?.given, x?.family].filter(Boolean).join(' ')).filter(Boolean));
        const doc = classifyFetched(await fetchFollowingPdf(u, { signal }, { ...(j?.title ? { hint: String(j.title) } : {}), doi }));
        const out: SourceDoc = doc.state === 'full_text' ? { ...doc, how: 'unpaywall', title: j?.title } : { ...doc, url: doc.url ?? `https://doi.org/${doi}` };
        if (byline) docByline.set(out, byline);
        const page = docPage.get(doc);
        if (page) docPage.set(out, page);
        return out;
    } catch (e) {
        return { state: 'error', how: 'crossref', error: String(e) };
    }
}

async function trySemanticScholar(ref: { title?: string }, signal?: AbortSignal): Promise<SourceDoc> {
    try {
        const res = await fetch(
            `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(ref.title!)}&limit=5&fields=title,openAccessPdf,abstract`,
            { signal },
        );
        // 키 없는 S2 는 429 를 자주 준다 — 이건 실패가 아니라 "이 경로는 못 씀"이다.
        if (!res.ok) return { state: 'error', how: 's2', error: `HTTP ${res.status}` };
        const j: any = await res.json();
        const items = (j?.data ?? []).filter((p: any) => p?.title);
        const p: any = bestTitleMatch(ref.title!, items);
        if (!p) return { state: 'not_found', how: 's2' };
        const u = p.openAccessPdf?.url;
        if (!u) return { state: p.abstract ? 'abstract_only' : 'metadata_only', how: 's2', title: p.title, ...(p.abstract ? { abstractText: p.abstract } : {}) };
        const doc = classifyFetched(await fetchFollowingPdf(u, { signal }, { hint: String(p.title) }));
        return doc.state === 'full_text' ? { ...doc, how: 's2', title: p.title } : { ...doc, title: p.title };
    } catch (e) {
        return { state: 'error', how: 's2', error: String(e) };
    }
}

/**
 * 사람이 준 경로/URL 을 읽는다. 사람이 제공한 자료는 **출처가 확실한 원문**이므로 그대로 쓴다.
 * 다만 파일을 읽지 못하면 조용히 넘어가지 않고 실패를 돌려준다 — "받았는데 못 읽었다"와
 * "받았다"는 다르고, 그 차이가 판정에 들어간다.
 */
/**
 * 필자가 준 것 — 경로, file:// URL, http(s) URL, 또는 그것들이 섞인 한 줄("A 및 B"). 전부 읽어 잇는다.
 *
 * 실제로 들어온 답: `file:///var/folders/…/T/KCI_FI003023720.pdf` (브라우저 다운로드를 끌어다 놓은 것, 한글 이름은
 * 퍼센트 인코딩), `https://law.go.kr/… 및 https://law.go.kr/…`. 전에는 file:// 을 경로로 resolve 해 "파일이 없습니다"가
 * 됐고, 필자는 원문을 줬는데 각주에는 ⚠ 원문 미확보가 찍혔다.
 */
export async function loadHumanProvided(
    note: string,
    opts: { type?: Authority['type'] } = {},
): Promise<{ text: string; source: string; warnings?: string[] } | { error: string }> {
    const targets = splitProvidedTargets(note);
    if (!targets.length) return { error: '경로가 비어 있음' };
    const texts: string[] = [];
    const sources: string[] = [];
    const errors: string[] = [];
    for (const t of targets) {
        const got = await loadOneProvided(t, opts.type);
        if ('error' in got) errors.push(got.error);
        else {
            texts.push(got.text);
            sources.push(got.source);
        }
    }
    if (!texts.length) return { error: errors.join('; ') };
    // 일부만 읽혔으면 읽힌 것으로 진행하되, 못 읽은 것을 숨기지 않는다.
    return { text: texts.join('\n\n'), source: sources.join(' ; '), ...(errors.length ? { warnings: errors } : {}) };
}

/** 끝의 문장부호를 뗀다. ')' 는 짝이 안 맞을 때만 — law.go.kr 한글주소는 "(공포일자,공포번호)" 로 끝난다. */
function trimUrl(u: string): string {
    // "https://a.b/c입니다" — 영숫자 바로 뒤에 붙은 한글은 URL 이 아니라 문장이다. "/법령/주민등록법" 처럼 '/' 뒤의 한글은 둔다.
    // "…(2000헌마25)에서" 처럼 닫는 괄호 뒤에 붙은 한글도 문장이다.
    let t = u.replace(/(?<=[A-Za-z0-9=&_\-)])[가-힣]+$/, '').replace(/[.,;\]]+$/, '');
    while (t.endsWith(')') && (t.match(/\(/g) ?? []).length < (t.match(/\)/g) ?? []).length) t = t.slice(0, -1);
    return t;
}

/** file:// · ~ · 퍼센트 인코딩 · 터미널 드래그의 "\ " 를 실제 경로로. 있는 파일이면 그 경로, 아니면 가장 그럴듯한 해석. */
function expandPath(p: string): string {
    // 터미널 드래그는 공백·괄호·&;!$#… 앞에 역슬래시를 붙인다. 그 ASCII 셸 특수문자 앞의 것만 뗀다 — 전에는 글자·숫자가 아닌 것 앞이면 다 뗐더니
    // 윈도우 경로 「C:\Users\김\논문.pdf」의 한글 이름 앞 역슬래시(경로 구분자)가 사라졌다. 드라이브 문자·UNC 로 시작하거나
    // 셸 특수문자가 아닌 글자 앞에 역슬래시가 있으면(구분자다) 윈도우 경로로 보고 손대지 않는다.
    const SHELL_ESC = /\\([ \t!"#$&'()*,;<=>?[\\\]^`{|}~])/g;
    let q = p.trim();
    const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(q) || q.replace(SHELL_ESC, '').includes('\\');
    if (!windows) q = q.replace(SHELL_ESC, '$1');
    if (/^file:\/\//i.test(q)) {
        const bare = q.replace(/^file:\/\/(?:localhost)?/i, '');
        const decoded = (() => {
            try {
                return decodeURIComponent(bare);
            } catch {
                return bare; // "%" 뒤에 16진수 두 자리가 아닌 이름 — 글자 그대로
            }
        })();
        try {
            q = fileURLToPath(q);
            // 「파일 선택」은 encodeURI 로 file:// 을 만들어 '#' '?' 가 그대로 남는다 — URL 로 읽으면 그 뒤가 조각·질의로 떨어져
            // "Kim #2 paper.pdf" 가 "Kim " 이 됐다. URL 로 읽은 것이 없고 글자 그대로 푼 것이 있으면 그것.
            if (/[#?]/.test(bare) && !existsSync(q) && existsSync(decoded)) q = decoded;
        } catch {
            q = decoded;
        }
    }
    q = q.startsWith('~') ? join(process.env.HOME ?? '', q.slice(1)) : q;
    // 상대 경로는 프로젝트 루트·references/ 기준도 본다 — 앱은 Finder 에서 띄우면 cwd 가 '/' 다.
    if (!q.startsWith('/')) {
        for (const base of [root(), join(root(), 'references'), process.cwd()]) {
            const c = resolve(base, q);
            if (existsSync(c)) return c;
        }
    }
    const r = resolve(q);
    if (existsSync(r)) return r;
    // 퍼센트 인코딩된 경로 — 디코딩한 것이 있으면 그것, 아니면 글자 그대로의 경로("%" 가 든 이름일 수 있다)
    if (/%[0-9A-Fa-f]{2}/.test(r)) {
        try {
            const d = decodeURIComponent(r);
            if (existsSync(d)) return d;
        } catch {
            /* 그대로 */
        }
    }
    return r;
}
/** 있는 **파일**인가 — '.' 같은 디렉터리 조각이 경로로 통과하지 않게 */
const existsPath = (p: string): boolean => {
    try {
        const q = expandPath(p);
        return existsSync(q) && statSync(q).isFile();
    } catch {
        return false;
    }
};

/**
 * 한 줄에서 자료의 위치들을 뽑는다 — URL·file://, 경로(공백·괄호 포함), 여러 개면 띄어 쓴 것, 지난 실행이 기억한 "A ; B".
 * 공백 든 파일명과 "경로 경로" 를 가르는 기준은 **실제로 있는 파일**이다.
 */
export function splitProvidedTargets(note: string): string[] {
    const s = note.trim();
    if (!s) return [];
    if (s.startsWith('answered:') || s.startsWith('unavailable:')) return [s];
    if (existsPath(s)) return [s]; // 이름에 " ; " 나 공백이 든 파일 하나
    if (/\s;\s/.test(s)) return [...new Set(s.split(/\s;\s/).flatMap(splitProvidedTargets))];
    // file:// 하나뿐이고 공백이 인코딩되지 않은 채 들어왔으면 줄 전체가 그 URL 이다.
    // 끝에 붙은 문장부호·조사("….pdf." "….pdf)" "….pdf에서")는 떼어 본다 — 뗀 첫 조각이 있는 파일이면 아래의 URL 나누기로 간다.
    const first = s.split(/\s+/)[0]!;
    if (/^file:\/\//i.test(s) && (s.match(/:\/\//g) ?? []).length === 1 && !existsPath(first) && !existsPath(trimUrl(first))) {
        const t = trimUrl(s);
        return [t !== s && existsPath(t) ? t : s];
    }
    const urls = [...new Set((s.match(/(?:https?|file):\/\/[^\s"'<>「」『』]+/g) ?? []).map(trimUrl))];
    let rest = s;
    for (const u of urls) rest = rest.split(u).join(' ');
    rest = rest.trim();
    const out: string[] = [...urls];
    if (rest) {
        if (existsPath(rest)) out.push(rest);
        else {
            // "경로 경로" — 공백으로 나눈 조각을 이어 붙여 가며 **있는 파일**이 되는 묶음을 찾는다("…/sp ace/a (1).pdf …/b.pdf").
            const toks = rest.split(/(?<!\\)\s+/).filter(Boolean);
            const found: string[] = [];
            let i = 0;
            while (i < toks.length) {
                let hit = -1;
                for (let j = Math.min(toks.length, i + 8); j > i; j--) {
                    if (existsPath(toks.slice(i, j).join(' '))) {
                        hit = j;
                        break;
                    }
                }
                if (hit > 0) {
                    found.push(toks.slice(i, hit).join(' '));
                    i = hit;
                } else {
                    // 경로처럼 보이는데 없는 것은 버리지 않고 넘겨 "파일이 없습니다"가 필자에게 보이게 한다.
                    if (/^(?:\/|~|\.{1,2}\/)/.test(toks[i]!)) found.push(toks[i]!);
                    i++;
                }
            }
            if (found.length) out.push(...found);
            else if (!urls.length) out.push(rest); // 하나로 보고 "파일이 없습니다"를 내게
        }
    }
    return out;
}

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.text', '.csv', '.json', '.xml', '.rtf']);

/** 200 으로 오는 오류 페이지 — law.go.kr 은 없는 주소에도 200 과 "오류페이지"를 준다. */
/**
 * 앱의 원문 찾기 브라우저가 「이 페이지 넣기」로 저장한 파일인가 — 머리(--- … ---) 안 어디에 표지가 있어도 된다.
 * 예전 파일은 표지가 제목·주소 뒤에 있어, 긴 한글 제목·퍼센트 인코딩 주소면 앞 400자 밖으로 밀려 검사를 피해 갔다.
 */
function isBrowserCapture(text: string): boolean {
    // 편집기가 앞에 붙인 BOM 도 넘긴다(메모장 등으로 다시 저장한 파일) — frontMatter
    const m = frontMatter(text);
    return m !== null && /(?:^|\n)captured_by:\s*nenene-browser\s*(?:$|\n)/.test(m);
}

const ERROR_PAGE = /오류\s*페이지|페이지를\s*찾을\s*수\s*없|요청하신\s*페이지|존재하지\s*않는\s*페이지|잘못된\s*(?:접근|요청)|서비스\s*이용에\s*불편|Page\s*Not\s*Found|404\s*Not\s*Found|Error\s*404/i;

/**
 * 1면짜리 PDF 를 초록면·미리보기로 볼 인용인가 — 논문(scholarship)만. 보도·실무 자료·보도자료·법령 발췌는 1면이 원문일 수 있다.
 * 종류를 모르면(부르는 쪽이 넘기지 않았다) 논문처럼 본다 — 미리보기를 원문으로 받는 쪽이 더 나쁘다.
 */
function onePageIsPreview(type: Authority['type'] | undefined): boolean {
    return type === undefined || type === 'scholarship';
}

async function loadOneProvided(target: string, type?: Authority['type']): Promise<{ text: string; source: string } | { error: string }> {
    try {
        // 지난 실행에서 필자가 글로 답한 것 — URL 이 들어 있으면 그것도 다시 읽는다.
        if (target.startsWith('answered:')) {
            const note = target.slice('answered:'.length).trim();
            const urls = note.match(/(?:https?|file):\/\/[^\s"'<>「」『』]+/g) ?? [];
            const parts: string[] = [note];
            for (const u of urls) {
                const got = await loadOneProvided(trimUrl(u), type);
                if (!('error' in got)) parts.push(got.text);
            }
            return { text: parts.join('\n\n'), source: 'answered' };
        }
        if (target.startsWith('unavailable:')) return { error: '필자가 원문 없음이라 답함' };
        if (/^https?:\/\//i.test(target)) {
            // 소개 페이지면 그 페이지가 단 원문 PDF 를 따라가 본다(사다리와 같다).
            // 운영 문서 거르기는 논문(또는 종류 모름)만 — 실무 자료·법령은 규정 PDF 가 원문일 수 있다(onePageIsPreview 와 같은 잣대).
            const d = await fetchFollowingPdf(target, {}, onePageIsPreview(type) ? {} : { rules: true });
            if (d.error) return { error: `${target}: ${d.error}` };
            if (d.status >= 400) return { error: `${target}: HTTP ${d.status}` };
            if (d.paywall || d.login) return { error: `${target}: 접근 차단/로그인 페이지` };
            const body = d.text.trim();
            if (body.length < 2000 && ERROR_PAGE.test(body)) return { error: `${target}: 오류 페이지(주소가 잘렸거나 없는 문서)` };
            // 300자 미만은 본문이 아니라 프레임·내비게이션 껍데기다.
            if (body.length < 300) return { error: `${target}: 본문이 거의 없음(${body.length}자)` };
            if (d.kind === 'pdf' && d.pages === 1 && onePageIsPreview(type)) return { error: `${target}: 1면짜리 PDF — 초록면·미리보기로 보입니다. 전문 PDF 를 주세요` };
            // 초록·서지뿐인 소개 페이지(KCI 논문 페이지 등)는 원문이 아니다 — 브라우저로 저장한 페이지와 같은 검사. 초록은 라벨로만 본다(abstractMarker —
            // 「초록우산」 같은 낱말은 아니다). 표 칸·정의 목록 꼴은 fetchUrl 이 칸을 줄로 나눠 본 것(abstractLabel)으로.
            if (d.kind === 'html' && (KCI_LANDING.test(d.url) || ((d.abstractLabel || abstractMarker(body)) && !looksLikeFullText(body, true))))
                return { error: `${target}: 초록·서지 페이지입니다 — 원문(PDF·본문)을 주세요` };
            return { text: d.text, source: d.url };
        }
        const p = expandPath(target);
        if (!existsSync(p)) return { error: `파일이 없습니다: ${p}` };
        if (statSync(p).isDirectory()) return { error: `폴더입니다(파일을 골라 주세요): ${p}` };
        let ext = extname(p).toLowerCase();
        if (!ext || !/^\.[a-z0-9]{1,5}$/.test(ext)) {
            // 확장자가 없거나 이상한 이름(…pdf.pdf 는 괜찮다) — 앞부분으로 형식을 본다.
            const head = readFileSync(p).subarray(0, 8);
            if (head.subarray(0, 5).toString() === '%PDF-') ext = '.pdf';
            else if (head[0] === 0x50 && head[1] === 0x4b) ext = '.docx';
        }
        let text: string | null;
        if (ext === '.pdf') {
            const buf = readFileSync(p);
            text = pdfToText(buf);
            if (text === null) return { error: `${basename(p)}: PDF 텍스트 추출 실패 — ${lastPdfError || 'PDF 를 읽지 못했습니다'}` };
            // URL 로 받은 답과 같은 검사 — 원문 찾기 브라우저로 받은 「KCI 원문 미리보기」는 1면짜리다. 쪽수는 추출 뒤에 센다(pdf.js 면 다시 열지 않는다).
            if (onePageIsPreview(type) && pdfPages(buf) === 1) return { error: `${basename(p)}: 1면짜리 PDF — 초록면·미리보기로 보입니다. 전문 PDF 를 주세요` };
        } else if (ext === '.docx') {
            text = docxToText(p);
            if (text === null) return { error: `${basename(p)}: DOCX 를 읽지 못함(손상됐거나 .doc 형식)` };
        } else if (ext === '.hwp' || ext === '.hwpx') return { error: `${basename(p)}: HWP 는 읽지 못합니다 — PDF 로 변환해 주세요` };
        else if (ext === '.html' || ext === '.htm') text = htmlToText(readFileSync(p, 'utf8'));
        else if (TEXT_EXT.has(ext) || !ext) {
            const buf = readFileSync(p);
            // NUL 바이트나 깨진 글자가 많으면 글이 아니다(.doc·.pptx·이미지를 텍스트로 읽은 것)
            if (buf.subarray(0, 4096).includes(0)) return { error: `${basename(p)}: 텍스트 파일이 아닙니다` };
            text = buf.toString('utf8');
            if ((text.match(/\uFFFD/g) ?? []).length > text.length / 50) return { error: `${basename(p)}: 인코딩을 읽지 못함(UTF-8 로 저장해 주세요)` };
        } else return { error: `${basename(p)}: 지원하지 않는 형식(${ext}) — PDF·DOCX·HTML·TXT 만 읽습니다` };
        if (!text || text.trim().length < 80) {
            return { error: ext === '.pdf' ? `${basename(p)}: 글자가 거의 없음(스캔 PDF 면 OCR 이 필요합니다)` : `${basename(p)}: 글자가 거의 없음` };
        }
        // 브라우저에서 저장한 웹 페이지 — URL 로 받은 답과 같은 검사(오류 페이지·껍데기·초록뿐인 소개 페이지)를 한다.
        if (isBrowserCapture(text)) {
            const body = text.replace(/^\uFEFF?---[\s\S]*?\n---\r?\n?/, '').trim();
            if (body.length < 2000 && ERROR_PAGE.test(body)) return { error: `${basename(p)}: 오류 페이지를 저장했습니다 — 원문을 띄운 뒤 다시 넣어 주세요` };
            if (body.length < 300) return { error: `${basename(p)}: 본문이 거의 없음(${body.length}자)` };
            if (abstractMarker(body) && !looksLikeFullText(body, true)) return { error: `${basename(p)}: 초록·서지 페이지입니다 — 원문(PDF·본문)을 넣어 주세요` };
        }
        return { text, source: keepProvidedCopy(p) };
    } catch (e) {
        return { error: `${target.slice(0, 120)}: ${e instanceof Error ? e.message : String(e)}` };
    }
}

/** 임시 폴더(/var/folders/…/T, ~/Downloads)의 파일은 사라진다. 복사해 두고 그 경로를 기억한다. */
function keepProvidedCopy(p: string): string {
    try {
        const dir = join(CACHE(), 'provided');
        if (resolve(p).startsWith(resolve(dir))) return p; // 이미 보관본이다 — 보관본의 보관본을 만들지 않는다
        mkdirSync(dir, { recursive: true });
        const dest = join(dir, `${createHash('sha1').update(p).digest('hex').slice(0, 8)}-${basename(p)}`);
        // 같은 경로에 다른 파일이 다시 내려왔을 수 있다(고친 PDF) — 크기나 수정 시각이 다르면 다시 복사한다.
        const src = statSync(p);
        const stale = existsSync(dest) && (statSync(dest).size !== src.size || statSync(dest).mtimeMs < src.mtimeMs);
        if (!existsSync(dest) || stale) copyFileSync(p, dest);
        return dest;
    } catch {
        return p;
    }
}

/**
 * DOCX → 텍스트. docx 는 ZIP 이고 본문은 `word/document.xml` 하나에 있다.
 *
 * 라이브러리를 들이지 않은 이유: 필요한 것은 문단 텍스트뿐이고, 그건 `unzip -p` + 태그 제거로
 * 충분하다. 참고문헌을 넣는 사람은 조판이 아니라 내용을 넣는 것이므로 서식은 버려도 된다.
 */
export function docxToText(path: string): string | null {
    try {
        const xml = execFileSync('unzip', ['-p', path, 'word/document.xml'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        return xml
            .replace(/<w:tab[^>]*\/>/g, '\t')
            .replace(/<\/w:p>/g, '\n')
            .replace(/<w:br[^>]*\/>/g, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    } catch {
        return null;
    }
}

export const sourceStatus = () => ({
    corpusDirs: corpusDirs(),
    corpusFiles: (() => {
        try {
            return loadCorpus().length;
        } catch {
            return 0;
        }
    })(),
    pdfjs: pdfjsAvailable(),
    pdftotext: (() => {
        try {
            execFileSync('pdftotext', ['-v'], { stdio: 'pipe' });
            return true;
        } catch {
            return false;
        }
    })(),
});

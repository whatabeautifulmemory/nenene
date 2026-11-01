// KCI — 한국 학술지 논문의 서지·초록(Open API)과 원문 PDF(논문 페이지의 "KCI 원문 내려받기").
//
// 왜 필요한가: 이 파이프라인의 사다리는 한국 법학 학설에서 거의 항상 실패했다. OpenAlex·
// Crossref 는 한국 학술지를 거의 담지 않는다. KCI 는 담는다. Open API 는 서지·초록·논문 페이지 URL 까지만
// 주지만, **논문 페이지의 "KCI 원문 내려받기" 버튼은 로그인 없이 전문 PDF 를 준다**(kciFullText).
// 버튼이 없는 논문(학술지 정책으로 제외)만 `abstract_only` 로 남아 사람에게 묻는다.
//
// 전에는 "원문 다운로드는 세션·orteFileId 가 필요해 불가능"이라고 보고 시도조차 하지 않았다. 확인해 보니
// 필요한 것은 파일 ID(논문 페이지에 그대로 있다)와, 요청이 논문 페이지에서 왔다는 Referer 뿐이었다 —
// 사람이 버튼을 누를 때 브라우저가 보내는 것과 같다. 주민등록 실행마다 "원문 없음"으로 끝난 김재광(2010)도
// 이렇게 29,341자 전문으로 들어온다.
//
// 인증: KCI Open API 는 `key` 파라미터를 요구한다. https://www.kci.go.kr/kciportal/po/openapi/
// 에서 인증키를 신청해 `KCI_API_KEY` 로 넣어야 하며, 없으면 KCI 검색을 건너뛴다.
//
// 응답은 XML 이다:
//   <MetaData><inputData/><outputData><result><total/></result><record>…</record>…</outputData></MetaData>
//   record = <journalInfo>…</journalInfo><articleInfo article-id="ART…">…</articleInfo>
import { record } from '../trace.ts';
import { lastPdfError, pdfPages, pdfToText } from './web.ts';

const ENDPOINT = 'https://open.kci.go.kr/po/openapi/openApiSearch.kci';

function apiKey(): string {
    const k = process.env.KCI_API_KEY?.trim();
    if (!k) throw new Error('KCI_API_KEY 가 설정되지 않았습니다. kci.go.kr에서 OpenAPI 인증키를 신청해 환경변수로 넣어 주세요.');
    return k;
}

export function kciConfigured(): boolean {
    return Boolean(process.env.KCI_API_KEY?.trim());
}

export interface KciArticle {
    /** Control Number (ART…) */
    id: string;
    title: string;
    titleEng?: string;
    authors: string[];
    institutions: string[];
    journal?: string;
    publisher?: string;
    kciRegistration?: string;
    year?: string;
    month?: string;
    volume?: string;
    issue?: string;
    fpage?: string;
    lpage?: string;
    doi?: string;
    url?: string;
    abstract?: string;
    keywords: string[];
    citationCount?: string;
}

export interface KciSearchResult {
    total: number;
    articles: KciArticle[];
    /** 실패했으면 사람이 읽을 수 있는 이유 */
    error?: string;
}

// ---- 아주 작은 XML 리더 ------------------------------------------------------------
// KCI 응답은 평평한 구조에 CDATA 만 섞여 있다. 의존성을 늘리지 않고 필요한 만큼만 읽는다.

function clean(s: string): string {
    return s
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

/** 첫 번째 <tag …>…</tag> 의 내부. */
function blockOf(xml: string, tag: string): string {
    const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`).exec(xml);
    return m?.[1] ?? '';
}

/** 첫 번째 <tag …> 의 속성 문자열. */
function attrsOf(xml: string, tag: string): string {
    const m = new RegExp(`<${tag}((?:\\s[^>]*)?)>`).exec(xml);
    return m?.[1] ?? '';
}

function attrOf(attrs: string, name: string): string | undefined {
    const m = new RegExp(`${name}="([^"]*)"`).exec(attrs);
    return m?.[1] ? clean(m[1]) : undefined;
}

/** tag 인스턴스 전부 (속성 포함). */
function allOf(xml: string, tag: string): { attrs: string; text: string }[] {
    const out: { attrs: string; text: string }[] = [];
    const re = new RegExp(`<${tag}((?:\\s[^>]*)?)>([\\s\\S]*?)<\\/${tag}>`, 'g');
    for (const m of xml.matchAll(re)) out.push({ attrs: m[1] ?? '', text: clean(m[2] ?? '') });
    return out;
}

/** lang="original" 같은 속성 조건으로 고른 텍스트. */
function langText(xml: string, tag: string, lang: string): string | undefined {
    const hit = allOf(xml, tag).find((t) => t.attrs.includes(`lang="${lang}"`));
    return hit?.text || undefined;
}

function parseRecord(rec: string): KciArticle {
    const journalInfo = blockOf(rec, 'journalInfo');
    const articleInfo = blockOf(rec, 'articleInfo');
    const titleGroup = blockOf(articleInfo, 'title-group');
    const authorGroup = blockOf(articleInfo, 'author-group');
    const abstractGroup = blockOf(articleInfo, 'abstract-group');
    const id = attrOf(attrsOf(rec, 'articleInfo'), 'article-id') ?? '';
    const authorBlocks = allOf(authorGroup, 'author');
    const names: string[] = [];
    const institutions: string[] = [];
    for (const b of authorBlocks) {
        // 상세 응답: <author><name>장응혁</name><institution>계명대학교</institution></author>
        const n = blockOf(b.text, 'name');
        const inst = blockOf(b.text, 'institution');
        if (n) {
            names.push(n);
            if (inst) institutions.push(inst);
            continue;
        }
        // 검색 응답: <author english="…">장응혁(계명대학교)</author>
        const m = /^(.+?)\s*\((.+)\)\s*$/.exec(b.text);
        if (m && m[1]) {
            names.push(m[1].trim());
            if (m[2]) institutions.push(m[2].trim());
        } else if (b.text) names.push(b.text);
    }
    return {
        id,
        title: langText(titleGroup, 'article-title', 'original') ?? clean(blockOf(titleGroup, 'article-title')),
        ...(langText(titleGroup, 'article-title', 'english') ? { titleEng: langText(titleGroup, 'article-title', 'english') } : {}),
        authors: names,
        institutions,
        ...(blockOf(journalInfo, 'journal-name') ? { journal: blockOf(journalInfo, 'journal-name') } : {}),
        ...(blockOf(journalInfo, 'publisher-name') ? { publisher: blockOf(journalInfo, 'publisher-name') } : {}),
        ...(blockOf(journalInfo, 'kci-registration') ? { kciRegistration: blockOf(journalInfo, 'kci-registration') } : {}),
        ...(blockOf(journalInfo, 'pub-year') ? { year: blockOf(journalInfo, 'pub-year') } : {}),
        ...(blockOf(journalInfo, 'pub-mon') ? { month: blockOf(journalInfo, 'pub-mon') } : {}),
        ...(blockOf(journalInfo, 'volume') ? { volume: blockOf(journalInfo, 'volume') } : {}),
        ...(blockOf(journalInfo, 'issue') ? { issue: blockOf(journalInfo, 'issue') } : {}),
        ...(blockOf(articleInfo, 'fpage') ? { fpage: blockOf(articleInfo, 'fpage') } : {}),
        ...(blockOf(articleInfo, 'lpage') ? { lpage: blockOf(articleInfo, 'lpage') } : {}),
        ...(blockOf(articleInfo, 'doi') ? { doi: clean(blockOf(articleInfo, 'doi')) } : {}),
        ...(blockOf(articleInfo, 'url') ? { url: clean(blockOf(articleInfo, 'url')) } : {}),
        ...(langText(abstractGroup, 'abstract', 'original') ? { abstract: langText(abstractGroup, 'abstract', 'original') } : {}),
        keywords: allOf(blockOf(articleInfo, 'keyword-group'), 'keyword').map((k) => k.text).filter(Boolean),
        ...(attrsOf(articleInfo, 'citation-count').includes('kci')
            ? { citationCount: attrOf(attrsOf(articleInfo, 'citation-count'), 'kci') }
            : {}),
    };
}

function resultMessage(xml: string): string | undefined {
    const msg = blockOf(xml, 'resultMsg');
    return msg ? clean(msg) : undefined;
}

async function call(params: Record<string, string>, signal?: AbortSignal): Promise<{ xml: string; error?: string }> {
    const qs = new URLSearchParams({ ...params, key: apiKey() });
    // Referer 가 없으면 KCI 가 키를 거부한다("등록되지 않은 key"). 사이트 내 요청으로 보이게 한다.
    const res = await fetch(`${ENDPOINT}?${qs.toString()}`, {
        signal: signal ?? AbortSignal.timeout(30_000),
        headers: {
            'user-agent': 'nenene (KCI OpenAPI)',
            referer: 'https://www.kci.go.kr/kciportal/po/openapi/openApiConnSearch.kci',
            origin: 'https://www.kci.go.kr',
        },
    });
    const xml = await res.text();
    if (!res.ok) return { xml, error: `KCI HTTP ${res.status}` };
    const msg = resultMessage(xml);
    if (msg) return { xml, error: msg };
    return { xml };
}

/**
 * 논문 검색. keyword·title·author·journal·doi 중 하나 이상을 준다.
 * displayCount 는 최대 100.
 */
export async function kciSearch(
    q: { title?: string; author?: string; journal?: string; keyword?: string; doi?: string; dateFrom?: string; dateTo?: string; displayCount?: number },
    opts: { signal?: AbortSignal } = {},
): Promise<KciSearchResult> {
    const started = Date.now();
    const params: Record<string, string> = { apiCode: 'articleSearch', page: '1', displayCount: String(Math.min(100, Math.max(1, q.displayCount ?? 10))) };
    for (const [k, v] of Object.entries({ title: q.title, author: q.author, journal: q.journal, keyword: q.keyword, doi: q.doi, dateFrom: q.dateFrom, dateTo: q.dateTo })) {
        if (v) params[k] = v;
    }
    try {
        const { xml, error } = await call(params, opts.signal);
        // "No Data" 는 오류가 아니라 0건이다 — 오류로 돌려주면 호출자가 대체 검색(저자·게재지)을 건너뛴다.
        if (error && /^no\s*data$/i.test(error.trim())) {
            record({ kind: 'acquire', name: 'kci', subject: q.keyword ?? q.title ?? q.author ?? '', ok: false, ms: Date.now() - started, detail: '0건' });
            return { total: 0, articles: [] };
        }
        if (error) {
            record({ kind: 'acquire', name: 'kci', subject: q.keyword ?? q.title ?? '', ok: false, ms: Date.now() - started, detail: error });
            return { total: 0, articles: [], error };
        }
        const total = Number(clean(blockOf(xml, 'total'))) || 0;
        const articles = [...xml.matchAll(/<record>([\s\S]*?)<\/record>/g)].map((m) => parseRecord(m[1] ?? '')).filter((a) => a.title);
        record({ kind: 'acquire', name: 'kci', subject: q.keyword ?? q.title ?? '', ok: articles.length > 0, ms: Date.now() - started, detail: `${articles.length}건${total ? ` / 전체 ${total}` : ''}` });
        return { total, articles };
    } catch (e) {
        if (opts.signal?.aborted) throw e; // 멈춘 것은 실패가 아니다
        const msg = e instanceof Error ? e.message.slice(0, 160) : String(e);
        record({ kind: 'acquire', name: 'kci', subject: q.keyword ?? q.title ?? '', ok: false, ms: Date.now() - started, detail: msg });
        return { total: 0, articles: [], error: msg };
    }
}

/** 논문 상세 — Control Number(ART…)로 조회. */
export async function kciDetail(id: string, opts: { signal?: AbortSignal } = {}): Promise<KciArticle | null> {
    const started = Date.now();
    try {
        const { xml, error } = await call({ apiCode: 'articleDetail', id }, opts.signal);
        if (error) {
            record({ kind: 'acquire', name: 'kci:detail', subject: id, ok: false, ms: Date.now() - started, detail: error });
            return null;
        }
        const rec = /<record>([\s\S]*?)<\/record>/.exec(xml)?.[1];
        if (!rec) return null;
        const a = parseRecord(rec);
        record({ kind: 'acquire', name: 'kci:detail', subject: id, ok: Boolean(a.title), ms: Date.now() - started, detail: `${a.journal ?? ''} ${a.year ?? ''} ${a.fpage ?? ''}-${a.lpage ?? ''}`.trim() });
        return a.title ? a : null;
    } catch (e) {
        if (opts.signal?.aborted) throw e;
        return null;
    }
}

const PORTAL = 'https://www.kci.go.kr';
const PORTAL_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 legal-agent-poc/0.1 (research)';
const FULL_TEXT_TIMEOUT_MS = 45_000;
const FULL_TEXT_MAX_BYTES = 40 * 1024 * 1024;

/** 논문 페이지 URL. Open API 가 주는 url 과 같은 꼴이다. */
export function kciArticlePage(artiId: string): string {
    return `${PORTAL}/kciportal/ci/sereArticleSearch/ciSereArtiView.kci?sereArticleSearchBean.artiId=${encodeURIComponent(artiId)}`;
}

/** 논문 페이지의 "KCI 원문 내려받기" 버튼이 넘기는 파일 ID(`fncDown('KCI_FI003023720')`). 버튼이 없으면 null. */
export function kciOrteFileId(html: string): string | null {
    return /fncDown\(\s*['"](KCI_FI\d+)['"]\s*\)/.exec(html)?.[1] ?? null;
}

export type KciFullText =
    | { ok: true; text: string; fileId: string; pages?: number; bytes: number }
    | { ok: false; reason: 'no-button' | 'not-pdf' | 'preview' | 'empty' | 'error'; detail: string };

/**
 * KCI 원문 PDF. 논문 페이지를 열어 버튼의 파일 ID 를 읽고, 버튼이 부르는 주소를 논문 페이지를 Referer 로 해서 부른다.
 *
 * Referer 가 없으면 KCI 는 PDF 대신 "원문 직접 열람이 불가능합니다. KCI 홈페이지에서 열람하세요." 경고 페이지를 준다
 * (444바이트 HTML). 로그인·세션 쿠키는 필요 없다.
 * 버튼이 없는 논문은 학술지가 원문 공개를 막은 것이다 — 그때는 사람에게 묻는다.
 */
export async function kciFullText(artiId: string, opts: { signal?: AbortSignal } = {}): Promise<KciFullText> {
    const started = Date.now();
    const page = kciArticlePage(artiId);
    const done = (r: KciFullText): KciFullText => {
        record({
            kind: 'acquire',
            name: 'kci:pdf',
            subject: artiId,
            ok: r.ok,
            ms: Date.now() - started,
            detail: r.ok ? `전문 ${r.text.length.toLocaleString()}자 · ${r.fileId}${r.pages ? ` · ${r.pages}면` : ''}` : `${r.reason} · ${r.detail}`,
            input: page,
        });
        return r;
    };
    // 이미 멈춘 신호에는 abort 이벤트가 다시 오지 않는다 — 먼저 확인한다.
    opts.signal?.throwIfAborted();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FULL_TEXT_TIMEOUT_MS);
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
        const res = await fetch(page, { headers: { 'user-agent': PORTAL_UA, 'accept-language': 'ko' }, signal: ctrl.signal });
        if (!res.ok) return done({ ok: false, reason: 'error', detail: `논문 페이지 HTTP ${res.status}` });
        const fileId = kciOrteFileId(await res.text());
        if (!fileId) return done({ ok: false, reason: 'no-button', detail: 'KCI가 이 논문의 원문 내려받기를 제공하지 않음(학술지 정책으로 제외)' });
        const dl = `${PORTAL}/kciportal/ci/sereArticleSearch/ciSereArtiOrteServHistIFrame.kci?sereArticleSearchBean.artiId=${encodeURIComponent(artiId)}&sereArticleSearchBean.orteFileId=${fileId}`;
        // 사람이 버튼을 누를 때와 같은 요청 — 논문 페이지에서 왔다는 Referer 를 붙인다.
        const r2 = await fetch(dl, { headers: { 'user-agent': PORTAL_UA, referer: page, 'accept-language': 'ko' }, redirect: 'follow', signal: ctrl.signal });
        const len = Number(r2.headers.get('content-length') ?? 0);
        if (len > FULL_TEXT_MAX_BYTES) return done({ ok: false, reason: 'error', detail: `PDF 가 너무 큼(${Math.round(len / 1048576)}MB)` });
        const buf = Buffer.from(await r2.arrayBuffer());
        // 잘라 읽으면 PDF 끝의 목차(xref)가 없어 읽히지 않는다 — 크면 받지 않는다.
        if (buf.length > FULL_TEXT_MAX_BYTES) return done({ ok: false, reason: 'error', detail: `PDF 가 너무 큼(${Math.round(buf.length / 1048576)}MB)` });
        if (buf.subarray(0, 5).toString() !== '%PDF-') {
            const alert = /alert\(\s*["']([^"']{0,120})/.exec(buf.toString('utf8'))?.[1]?.replace(/\\n/g, ' ').trim();
            return done({ ok: false, reason: 'not-pdf', detail: `PDF 대신 ${r2.headers.get('content-type') ?? '알 수 없는 응답'}${alert ? ` — "${alert}"` : ''}` });
        }
        // 글을 먼저 뽑고 쪽수는 그 뒤에 센다 — pdf.js 로 읽었으면 pdfPages 가 방금 센 쪽수를 다시 쓴다(거꾸로 하면 PDF 마다 pdf.js 를 두 번 돌린다).
        const text = pdfToText(buf);
        const pages = pdfPages(buf) ?? undefined;
        if (pages === 1) return done({ ok: false, reason: 'preview', detail: '1면짜리 PDF — 초록면·미리보기로 보임' });
        if (text === null) return done({ ok: false, reason: 'empty', detail: `PDF 텍스트 추출 실패 — ${lastPdfError || 'PDF 를 읽지 못했습니다'}` });
        if (text.trim().length < 2000) return done({ ok: false, reason: 'empty', detail: `PDF 에 글자가 거의 없음(${text.trim().length}자) — 스캔본이면 OCR 이 필요합니다` });
        return done({ ok: true, text, fileId, ...(pages ? { pages } : {}), bytes: buf.length });
    } catch (e) {
        if (opts.signal?.aborted) throw e;
        const msg = (e as { name?: string })?.name === 'AbortError' ? `시간 초과(${FULL_TEXT_TIMEOUT_MS / 1000}초)` : e instanceof Error ? e.message : String(e);
        return done({ ok: false, reason: 'error', detail: msg.slice(0, 160) });
    } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
    }
}

/** KCI 서지 → 한국 법학 인용 형식. */
export function kciCitation(a: KciArticle): string {
    const who = a.authors.length ? `${a.authors.slice(0, 3).join('·')}${a.authors.length > 3 ? ' 외' : ''}` : '저자 미상';
    const where = [a.journal, a.volume ? `${a.volume}${a.issue ? `(${a.issue})` : ''}` : undefined].filter(Boolean).join(' ');
    const pages = a.fpage ? `${a.fpage}${a.lpage && a.lpage !== a.fpage ? `-${a.lpage}` : ''}면` : undefined;
    return `${who}, 「${a.title}」, ${[where, a.year, pages].filter(Boolean).join(', ')}`;
}

/**
 * 문장형 질의 → KCI 키워드. 조사·일반어를 떼고 앞의 3개 어절만 남긴다.
 * (KCI keyword 검색은 긴 문장을 그대로 넣으면 관련 없는 논문을 돌려준다.)
 */
const PARTICLES = /(의|을|를|에|과|와|은|는|이|가|로|으로|에서|에게|도|만|으로서|으로써|부터|까지)$/u;
const STOP = new Set([
    '법적', '성격', '연구', '검토', '고찰', '의의', '문제', '분석', '관한', '대한', '위한', '통한', '관련', '현황', '과제', '방안',
    '그리고', '그러나', '따라서', '하는', '되는', '있는', '없는', '않은', '축으로', '따른', '도입', '절차적', '구조적', '결함', '비판',
    '등록되지', '위반', '적용', '검토의', '그', '및', '위', '때', '것', '수', '등', '중',
]);

/** 문장에서 KCI 검색에 쓸 만한 어절만 뽑는다. */
export function kciTokens(text: string): string[] {
    return text
        .replace(/[「」『』"“”'‘’()\[\],.;:!?·…\-–—]/g, ' ')
        .split(/\s+/)
        .map((t) => t.replace(PARTICLES, ''))
        .filter((t) => t.length >= 2 && !STOP.has(t));
}

export function kciQuery(text: string): string {
    return kciTokens(text).slice(0, 3).join(' ');
}

/**
 * 문장·제목으로 논문을 찾는다. **title 우선** — KCI 의 title 검색은 문장형 질의에도
 * 관련 논문을 정확히 돌려준다("원격 압수수색의 법적 성격" → 1건, 정확히 그 논문).
 * 없으면 키워드로 폴백한다.
 */
export async function kciFindByText(text: string, opts: { limit?: number; signal?: AbortSignal } = {}): Promise<KciArticle[]> {
    const limit = opts.limit ?? 4;
    const t = text.trim();
    if (!t) return [];
    // 1) 전체 문장을 title 로 — 정확히 그 논문이 있으면 1콜로 끝난다.
    const byTitle = await kciSearch({ title: t.slice(0, 120), displayCount: Math.max(limit, 4) }, opts);
    if (byTitle.articles.length) return byTitle.articles.slice(0, limit);

    // 2) 어절별 title 검색 + **희소성 가중** 점수.
    //    "휴대폰"(수천 건)과 "안면인증"(수십 건)은 같은 무게가 아니다. 가장 희소한 핵심어가
    //    제목·키워드에 있는 것만 채택한다 — 그렇지 않으면 "개통"으로 KTX 논문이 온다.
    const tokens = kciTokens(t).slice(0, 4);
    if (!tokens.length) return [];
    const perToken: { tok: string; total: number; articles: KciArticle[] }[] = [];
    for (const tok of tokens) {
        const r = await kciSearch({ title: tok, displayCount: 5 }, opts);
        perToken.push({ tok, total: Math.max(1, r.total || r.articles.length), articles: r.articles });
    }
    const weight = (total: number) => 1 / Math.log2(2 + total);
    const rarest = [...perToken].sort((a, b) => a.total - b.total)[0]!;
    const hayOf = (a: KciArticle) => normTitle(`${a.title} ${(a.keywords ?? []).join(' ')}`);
    const seen = new Map<string, { a: KciArticle; score: number }>();
    for (const pt of perToken) {
        for (const a of pt.articles) {
            const hay = hayOf(a);
            if (!hay.includes(normTitle(rarest.tok))) continue; // 핵심어 미포함은 버린다
            const score = perToken.reduce((sum, x) => sum + (hay.includes(normTitle(x.tok)) ? weight(x.total) : 0), 0);
            const cur = seen.get(a.id);
            if (!cur || score > cur.score) seen.set(a.id, { a, score });
        }
    }
    return [...seen.values()]
        .sort((x, y) => y.score - x.score || Number(y.a.citationCount ?? 0) - Number(x.a.citationCount ?? 0))
        .map((x) => x.a)
        .slice(0, limit);
}

/** 제목 비교용 정규화 — 조사·공백·기호 제거. */
export function normTitle(s: string): string {
    return s.replace(/\s+/g, '').replace(/[「」『』"“”'‘’<>《》〈〉.,:;?!·…\-–—()[\]]/g, '').toLowerCase();
}

/** 후보 중 인용된 제목과 가장 잘 맞는 것. 정규화 부분일치, 길이 비율 확인. */
export function bestKciMatch(title: string, articles: KciArticle[]): KciArticle | undefined {
    const t = normTitle(title);
    if (t.length < 6) return undefined;
    let best: { a: KciArticle; score: number } | undefined;
    const toks = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
    const tt = toks(title);
    for (const a of articles) {
        const c = normTitle(a.title);
        if (!c) continue;
        const shorter = Math.min(t.length, c.length);
        const longer = Math.max(t.length, c.length);
        const ratio = longer ? shorter / longer : 0;
        // 인용은 대개 부제를 생략한다("원격 압수수색의 법적 성격"). 접두 일치는 길이가
        // 충분하면 강한 신호로 본다 — 그렇지 않으면 제목 매칭이 전부 실패한다.
        const prefix = c.startsWith(t) || t.startsWith(c);
        // 길이만 비슷한 것은 일치가 아니다 — 낱말이 대부분 겹쳐야 한다("디지털증거 압수수색에 관한 연구" ≠ "주민등록제도의 문제점…").
        const ct = new Set(toks(a.title));
        const overlap = tt.length ? tt.filter((x) => ct.has(x)).length / tt.length : 0;
        const score = c === t ? 150 : prefix && shorter >= 10 ? 100 : (c.includes(t) || t.includes(c)) && ratio >= 0.5 ? 80 : ratio >= 0.7 && overlap >= 0.8 ? 60 : 0;
        if (score >= 60 && (!best || score > best.score)) best = { a, score };
    }
    return best?.a;
}

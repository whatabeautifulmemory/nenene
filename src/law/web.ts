// URL → 텍스트. 기존 구현 의 page-fetch.ts 에서 **direct 경로만** 가져왔다.
//
// 브라우저가 아니라 Node 이므로 CORS 가 없고, 기존 구현 가 데스크톱 main 프로세스에서 direct 를
// 쓰는 것과 같은 입장이다. 다만 기존 구현 가 그 경로를 안전하게 만든 이유(사설망으로 통하는
// 호스트가 공격자 지정 URL 을 가져오면 안 된다)는 여기에도 그대로 적용되므로, 사설·루프백·
// 링크로컬 주소는 거부한다. 이 프로젝트는 로컬에서 연구자가 돌리는 도구지만, 인용 문자열은
// 결국 외부 데이터에서 온 값이고 그게 URL 이 될 수 있다.
//
// reader(r.jina.ai) 경로는 일부러 넣지 않았다. 읽는 논문이 제3자에게 노출되는 것과,
// 초록만 돌려주는 reader 가 "전문을 읽었다"고 착각하게 만드는 것이 이 맥락에서는 더 나쁘다.
import { execFileSync, spawnSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 legal-agent-poc/0.1 (research)';

export interface Fetched {
    url: string;
    status: number;
    kind: 'html' | 'pdf' | 'text' | 'other';
    text: string;
    bytes: number;
    /** PDF 쪽수. 1면짜리 미리보기(초록면)를 전문으로 착각하지 않기 위해 필요하다. */
    pages?: number;
    /** 원문이 아니라 접근 차단 페이지로 보인다 — 초록/서지가 아니라 이것도 "못 읽음"이다. */
    paywall?: boolean;
    login?: boolean;
    error?: string;
    /** 논문 소개(랜딩) 페이지가 가리키는 원문 PDF — citation_pdf_url 등. 사람에게 묻기 전에 따라가 본다. pdfLinks 의 첫 후보. */
    pdfLink?: string;
    /** pdfLink 를 페이지가 스스로 「이 글의 PDF」라고 밝혔는가(citation_pdf_url 같은 메타·<link type=application/pdf>). 아니면 본문의 <a> 링크다. */
    pdfLinkMeta?: boolean;
    /** 원문 PDF 후보 전부, 따라갈 순서대로(findPdfLinks). 첫 후보가 그 글이 아니면 다음 것을 본다. */
    pdfLinks?: PdfLink[];
    /** HTML 이 초록·서지 페이지의 표지(초록·Abstract 라벨)를 달았는가 — 표 칸·정의 목록을 줄로 나눠 본 것(abstractMarker). */
    abstractLabel?: boolean;
    /** HTML 페이지가 스스로 밝힌 제목(citation_title·DC.title·og:title, 없으면 <title>). */
    title?: string;
    /** 따라간 PDF 가 그 글인지 대조할 이 페이지의 글 제목(articleTitleIn) — 사이트·학술지 이름은 아니다. */
    articleTitle?: string;
    /** 소개 페이지가 그 글의 것인지 볼 제목 자리(pageHeadsIn) — 맞춰 볼 곳(heads: 메타·<title>·h1, subheads: h2·h3)과 페이지가 제 글의 제목으로 내건 것(declared). */
    heads?: string[];
    subheads?: string[];
    declared?: string[];
    /** 관련·추천·인용 논문 목록과 참고문헌을 뺀 페이지 글(relatedFree) — 소개 페이지가 그 글의 것인지 제목을 찾는 자리. text 와 같으면 없다. */
    landText?: string;
    /** 본문만 남긴 페이지 글(mainOnly: 관련 목록·<aside>·<nav>·<footer>·<header>·링크 목록을 뺀 것) — 짧은 제목을 글자 그대로 찾는 자리. */
    mainText?: string;
    /** HTML 페이지가 **스스로** 밝힌 DOI(pageDoisIn) — citation_doi·dc.identifier·prism.doi·og 메타. 본문에 인용된 남의 DOI 는 아니다. */
    dois?: string[];
}

/** <meta name|property=…> 의 content. 속성 순서는 어느 쪽이든. */
const metaContent = (html: string, name: string): string | undefined =>
    new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']+)["']`, 'i').exec(html)?.[1] ??
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:name|property)=["']${name}["']`, 'i').exec(html)?.[1];

const cleanTitle = (t: string | undefined): string | undefined =>
    t
        ?.replace(/&middot;/g, '·')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim() || undefined;

/** 페이지가 밝힌 글 제목 — 학술 메타가 먼저, 없으면 <title>. */
export function pageTitleIn(html: string): string | undefined {
    const meta = (name: string) => metaContent(html, name);
    return cleanTitle(meta('citation_title') ?? meta('DC\\.title') ?? meta('og:title') ?? /<title[^>]*>([\s\S]{1,500}?)<\/title>/i.exec(html)?.[1]);
}

/** 제목으로 대조에 쓸 수 있을 만큼 긴가 — 글자·숫자 10자 이상(「JDL」 같은 약칭은 mentionsTitle 이 「모름」으로 보고 아무 PDF 나 받았다). */
const titleLong = (t: string | undefined): t is string => Boolean(t && t.replace(/[^\p{L}\p{N}]/gu, '').length >= 10);

/** <title> 의 구분자 — 「글 | 사이트」「사이트 :: 글」「글 - 사이트」「글 – 사이트」「글 · 사이트」. 띄어 쓴 것만 — 「압수·수색」「검토-역외 …」 는 한 제목이다. */
const TITLE_SEP = /\s+(\||｜|::|–|-|·)\s+/;
const titleTag = (html: string) => cleanTitle(/<title[^>]*>([\s\S]{1,500}?)<\/title>/i.exec(html)?.[1]);
const letters = (t: string) => t.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

/** 사이트 틀 요소의 class·id(로고·브랜드·사이트·배너·머리띠) — 그 안의 제목은 사이트 이름이다. */
const BANNER_ATTR = /\b(?:class|id)\s*=\s*["'][^"']*(?:logo|brand|site|banner|header)/i;
/** 사이트 이름에 붙는 틀 낱말 — 「… 온라인 저널 시스템」「… 홈페이지」「… Journal System」. */
const FRAME_WORD = /시스템|온라인|홈페이지|journal\s*system|online/i;
/** 사이트·학술지 이름(og:site_name·citation_journal_title) — 글자만. */
const siteNamesIn = (html: string) => [metaContent(html, 'og:site_name'), metaContent(html, 'citation_journal_title')].map((t) => letters(cleanTitle(t) ?? '')).filter(Boolean);
/** 사이트 틀 안인가 — <header>·<nav> 요소의 자리. */
const shellAt = (html: string) => {
    const shell = elementRanges(html, 'header|nav');
    return (i: number) => shell.some(([a, b]) => i >= a && i < b);
};

/**
 * <h1> 이 사이트 틀 안인가 — <nav> 안, 또는 글 구획(<article>·<main>·class 가 article·content·post·entry 인 <section>) **밖의** <header> 안.
 * 글 구획 안의 <header> 는 그 글 자신의 머리(HTML5 <article><header><h1>글</h1>)다 — <header> 안이면 모두 배너로 보던 때는 글 제목 <h1> 이 버려져
 * 「RISS … - 글」 의 사이트 조각이 글 제목이 되고 필자가 준 맞는 PDF 를 거절했다(8차 K8.1).
 * <aside> 안은 글 구획이 있어도 틀이다(관련 글 카드 <aside><article><header><h1>다른 글</h1>) — 글 구획 안이라 글 머리로 보던 때는 본문 앞 카드의
 * 다른 글 제목이 글 제목이 되어 필자가 준 맞는 PDF 를 거절했다(8차 뒤따름 K8.1, 본문 대조 mainOnly 도 <aside> 를 틀로 뺀다).
 */
const h1ShellAt = (html: string) => {
    const box = elementRanges(html, 'article|main|section', (tag) => !/^<section/i.test(tag) || /\bclass\s*=\s*["'][^"']*(?:article|content|post|entry)/i.test(tag));
    const inBox = (i: number) => box.some(([a, b]) => i >= a && i < b);
    const shell = [...elementRanges(html, 'nav|aside'), ...elementRanges(html, 'header').filter(([a]) => !inBox(a))];
    return (i: number) => shell.some(([a, b]) => i >= a && i < b);
};
/**
 * <h1> 의 class·id 가 배너인가 — 로고·브랜드·사이트·배너는 그대로, 머리띠(header)는 그 값에 글 제목 낱말(title·article·entry·post·headline)이 없을 때만.
 * 「header」 가 든 값을 모두 배너로 보던 때는 BEM 이름 「article-header__title」 의 글 제목 <h1> 이 배너가 됐다(8차 K8.1). 「site-title」 은 여전히 배너다.
 */
const h1BannerAttr = (tag: string) =>
    [...tag.matchAll(/\b(?:class|id)\s*=\s*["']([^"']*)["']/gi)].some(
        ([, v]) => /logo|brand|site|banner/i.test(v!) || (/header/i.test(v!) && !/title|article|entry|post|headline/i.test(v!)),
    );

/**
 * 배너가 아닌 <h1> 들 — 사이트 배너 <h1> 은 그 페이지 글의 제목이 아니다: 사이트 틀(h1ShellAt — <nav>·<aside>, 글 구획 밖의 <header>) 안의 것,
 * class·id 가 로고·브랜드·사이트·배너·머리띠인 것(h1BannerAttr), 사이트·학술지 이름(og:site_name·citation_journal_title)을 담고 틀 낱말(시스템·온라인·홈페이지…)이 붙은 것.
 * 배너 <h1> 을 글 조각의 근거로 보던 때는 「글 · 형사법연구」 의 사이트 조각이 배너 「한국형사법학회 형사법연구 온라인 저널 시스템」 에 담겨 **글**이 되고 배너가 글 제목이 되어,
 * 같은 이름을 첫머리에 단 사이드바의 투고규정 PDF 가 필자의 원문으로 들어왔다.
 */
function h1sIn(html: string): string[] {
    const inShell = h1ShellAt(html);
    const names = siteNamesIn(html);
    return [...html.matchAll(/<h1\b[^>]*>([\s\S]{0,600}?)<\/h1>/gi)]
        .filter((m) => {
            const t = cleanTitle(m[1]!.replace(/<[^>]+>/g, ' ')) ?? '';
            const banner = inShell(m.index!) || h1BannerAttr(/^<h1\b[^>]*>/i.exec(m[0])![0]) || (FRAME_WORD.test(t) && names.some((n) => letters(t).includes(n)));
            return !banner;
        })
        .map((m) => cleanTitle(m[1]!.replace(/<[^>]+>/g, ' ')))
        .filter((t): t is string => Boolean(t));
}

/** 글 제목을 담는 자리 — h2·h3 와 class 에 title 이 든 요소(<div class="title">). 사이트 틀 안(<header>·<nav>)·배너 class 의 것은 뺀다. */
function titleSlotsIn(html: string): string[] {
    const inShell = shellAt(html);
    const out: string[] = [];
    for (const m of html.matchAll(/<(h[23]|[a-z][a-z0-9]*(?=[^>]*\bclass\s*=\s*["'][^"']*title))\b([^>]*)>([\s\S]{0,600}?)<\/\1>/gi)) {
        if (inShell(m.index!) || BANNER_ATTR.test(m[2]!)) continue;
        const t = letters(m[3]!.replace(/<[^>]+>/g, ' '));
        if (t) out.push(t);
    }
    return out;
}

/** 학술지·학회 이름으로 끝나는 조각 — 「형사법연구」「한국형사법학회」「Journal of Digital Law」「Maritime Law Review」. */
const JOURNAL_WORD = /(?:학회지?|연구|법학|논총|논집|학보|저널|journal|review|quarterly)$/i;
/** 제목 토씨 — 이것이 든 조각은 학술지 이름이 아니라 글 제목이다(「원격 압수수색에 관한 비교법적 연구」). */
const TITLE_PARTICLE = /에\s*관한|에\s*대한|에\s*있어서|에서의|[을를]\s*위한|[의과와및~:] /;
/**
 * 학술지 낱말 규칙(siteParts 셋째 단계)에 쓸 조각인가 — 20자 이하이고 제목 토씨가 없으며 학술지·학회 낱말로 끝난다. 길이·토씨를 보지 않던 때는
 * 제목을 <p class="tit"> 에 단 「…에 관한 비교법적 연구 - RISS …」「… 연구 | DBpia」 의 글 조각이 사이트가 되어 필자가 준 맞는 PDF 를 거절했다(8차 K8.2).
 */
const journalSegment = (p: string) => p.trim().length <= 20 && !TITLE_PARTICLE.test(p) && JOURNAL_WORD.test(p.replace(/[^\p{L}\p{N}]+$/u, ''));

/**
 * 사이트·학술지 이름들과 <title> 의 글 조각. 이름은 og:site_name·application-name·citation_journal_title, 그리고 <title> 의 구분자 조각. 이름과 같은 조각이 있으면 그 조각이 사이트다.
 *  · 「 | 」 가 있으면 **마지막** 「 | 」 로 먼저 가른다 — 뒤가 사이트, 앞이 글(「글 - 부제 | 학술지」 의 띄운 줄표는 부제다). 맨 앞 구분자로 가르던 때는
 *    부제가 붙은 <title> 에서 「부제 | 학술지」 가 사이트 이름이 되어, 사이트 이름 머리 <h1> 이 글 제목으로 쓰였다(투고규정 PDF 가 필자의 원문으로).
 *  · 그 밖(「 - 」「 – 」「 · 」)은 og:site_name 이 없으면 **<h1>(배너가 아닌 것 — h1sIn)에 담긴(<h1> 과 같거나 그 일부인) 조각이 글**이다 — 「사이트 - 글」
 *    (RISS 가 쓰는 순서)에서 뒤 조각을 사이트로 보던 때는 글 제목 <h1> 이 사이트 이름으로 버려지고 학술지 이름이 글 제목이 되었다. <h1> 이 <title> 전체를 담으면
 *    사이트 조각이 없다(사이트 없는 「주제목 - 부제」).
 *  · 그래도 못 가르면(두 조각일 때) h2·h3·class 에 title 이 든 요소와 **같은** 조각이 글이다(<h1> 이 배너뿐이거나 없는 「한국형사법학회 형사법연구 - 글」 + <div class="title">) —
 *    이것 없이 끝 조각을 사이트로 보던 때는 글이 사이트 이름으로 버려지고 학술지 이름이 글 제목이 되어 투고규정 PDF 가 원문으로 들어왔다.
 *    그다음은 학술지·학회 낱말(…학회·연구·법학·논총·논집·학보·저널·Journal·Review·Quarterly)로 끝나는 조각 하나가 사이트다(<h1> 에 담긴 조각은 빼고 — 「…에 관한 연구」 는 글이다).
 *    그 조각은 20자 이하이고 제목 토씨(에 관한·에 대한·의 ·과 ·및 …)가 없어야 한다(journalSegment).
 *  · 끝까지 못 가르면 「사이트 :: 글」 은 앞 조각, 나머지는 뒤 조각이 사이트다.
 */
function siteParts(html: string): { sites: string[]; article?: string } {
    const sites = [metaContent(html, 'og:site_name'), metaContent(html, 'application-name'), metaContent(html, 'citation_journal_title')]
        .map(cleanTitle)
        .filter((t): t is string => Boolean(t));
    const raw = titleTag(html);
    if (!raw) return { sites };
    const pipes = raw.split(/\s+[|｜]\s+/).filter(Boolean);
    const sep = pipes.length >= 2 ? '|' : TITLE_SEP.exec(raw)?.[1];
    if (!sep) return { sites };
    const parts = sep === '|' ? pipes : raw.split(new RegExp(String.raw`\s+${sep.replace(/[|]/g, '\\|')}\s+`)).filter(Boolean);
    if (parts.length < 2) return { sites };
    let at = parts.findIndex((p) => siteLike(p, sites));
    const hs = h1sIn(html).map(letters).filter(Boolean);
    if (at < 0 && sep !== '::' && sep !== '|') {
        if (hs.some((h) => h.includes(letters(raw)))) return { sites };
        // 두 조각 중 하나만 <h1> 에 담겼으면 그 조각이 글, 다른 조각이 사이트
        const inH1 = parts.map((p) => letters(p).length >= 3 && hs.some((h) => h.includes(letters(p))));
        if (parts.length === 2 && inH1[0] !== inH1[1]) at = inH1[0] ? 1 : 0;
    }
    if (at < 0 && parts.length === 2) {
        const slots = titleSlotsIn(html);
        const isSlot = parts.map((p) => letters(p).length >= 3 && slots.includes(letters(p)));
        if (isSlot[0] !== isSlot[1]) at = isSlot[0] ? 1 : 0;
        else {
            const journal = parts.map((p) => journalSegment(p) && !hs.some((h) => h.includes(letters(p))));
            if (journal[0] !== journal[1]) at = journal[0] ? 0 : 1;
        }
    }
    if (at < 0) at = sep === '::' ? 0 : parts.length - 1;
    return { sites: [...sites, parts[at]!], article: parts.filter((_, i) => i !== at).join(sep === '|' ? ' | ' : ` ${sep} `) };
}

/**
 * 일반 머리말 — 「논문 상세정보 보기」「국내학술지 논문 상세정보」「상세보기」「Article details」 처럼 이 낱말들 밖의 말이 없는 것. 소개 페이지 틀의 <h1> 이지
 * 그 글의 제목이 아니다 — 그런 <h1> 을 페이지가 내건 제목으로 보던 때는 제목을 div 에 단 맞는 소개 페이지를 「다른 글」로 버렸다. 화면 틀 낱말(「상세페이지」「상세조회 화면」)도
 * 같다 — 목록에 없던 때는 「국내학술지 논문 상세페이지」「학술논문 상세조회 화면」 h1 이 내건 제목이 되어 맞는 소개 페이지를 버렸다.
 * 틀 낱말을 다 지우고 **남는 말이 없으면** 일반 머리말이다 — 「초록」「및」「내용」「KCI」「등재(후보)」 가 목록에 없던 때는 「학술논문 초록 및 서지정보」
 * 「국내학술지 논문 상세내용」「KCI 등재 학술지 논문 상세정보」「학술논문 상세 내용 보기」 h1 이 내건 제목이 되어 맞는 소개 페이지를 버렸다(빈칸은 letters 가 지운다).
 */
const GENERIC_HEAD =
    /국내|국외|해외|학술지|학술|학위|논문|상세|정보|보기|검색|결과|서지|페이지|조회|화면|초록|내용|및|kci|등재후보지?|등재지?|articles?|details?|papers?|pages?|records?|view|information|info/gi;
const genericHead = (t: string) => !letters(t.replace(GENERIC_HEAD, ''));

/** <title> 의 글 조각에서 띄운 줄표 뒤의 부제를 뗀 주제목 — 따라간 PDF 첫머리에 부제가 없을 수 있다. 주제목이 10자 미만이면 그대로. */
const mainTitle = (t: string) => {
    const head = t.split(/\s+[-–]\s+/)[0]!;
    return head !== t && titleLong(head) ? head : t;
};

/**
 * 사이트 이름인가 — 이름과 같거나 이름을 담거나 이름에 담긴다(「한국형사법학회 형사법연구 온라인 저널 시스템」 은 「형사법연구」 를 담는다),
 * 또는 이름이 그 머리글자다(<title> 「… | JDL」 과 <h1> 「Journal of Digital Law」).
 */
function siteLike(t: string, sites: string[]): boolean {
    const l = letters(t);
    const initials = t.split(/[^A-Za-z]+/).filter((w) => /^[A-Z]/.test(w)).map((w) => w[0]).join('');
    return Boolean(l) && sites.some((s) => {
        const k = letters(s);
        return Boolean(k) && ((k.length >= 3 && l.includes(k)) || k.includes(l) || (/^[A-Z]{2,8}$/.test(s.trim()) && initials === s.trim()));
    });
}

/**
 * 따라간 PDF 를 대조할 이 페이지의 글 제목 — **사이트·학술지 이름과는 대조하지 않는다.** 그 이름은 같은 사이트의 투고규정·지침 PDF 첫머리에도 적혀 있어,
 * 사이트 이름 <title>(「Journal of Digital Law」)로 대조하던 때는 그 PDF 가 원문으로 들어왔고, 머리 <h1> 을 먼저 보게 하자 <h1> 이 사이트 이름인 곳
 * (「한국형사법학회 형사법연구 온라인 저널 시스템」, <title> 은 「원격 압수수색의 법적 쟁점 | 형사법연구」)에서 같은 일이 났다(투고규정 PDF 가 필자의 원문으로).
 * 순서: 학술 메타(citation_title·DC.title) → 사이트 이름이 아닌 첫 <h1>(소개 페이지의 <h1> 은 대개 그 글의 제목이다 — 「Maritime Law Review | Volume 3」 의
 * 앞 조각은 학술지 이름이다) → <title> 의 글 조각(구분자가 있을 때 — 사이트 조각을 뗀 것, 띄운 줄표 뒤 부제는 뗀다) → 구분자 없는 og:title·<title>.
 * 어느 자리든 사이트 이름·일반 머리말(「논문 상세정보 보기」「Article details」)은 글 제목이 아니고, 10자 미만은 대조에 못 쓰므로 없는 것으로 본다.
 */
export function articleTitleIn(html: string): string | undefined {
    const meta = cleanTitle(metaContent(html, 'citation_title') ?? metaContent(html, 'DC\\.title'));
    if (titleLong(meta)) return meta;
    const { sites, article } = siteParts(html);
    const usable = (t: string | undefined): t is string => titleLong(t) && !siteLike(t, sites) && !genericHead(t);
    const h1 = h1sIn(html).find(usable);
    if (h1) return h1;
    if (usable(article)) return mainTitle(article);
    return [cleanTitle(metaContent(html, 'og:title')), titleTag(html)].find((t): t is string => usable(t) && !TITLE_SEP.test(t));
}

/**
 * 소개 페이지가 그 글의 것인지 볼 제목 자리(sources.ts vetFullText) — heads 는 맞춰 볼 곳(학술 메타·og:title·<title>·h1), subheads 는 그다음(h2·h3),
 * declared 는 페이지가 **제 글의 제목으로 내건 것**(학술 메타, 사이트 이름도 일반 머리말도 아닌 첫 <h1>). 내건 제목이 h2·h3 보다 먼저다 — 다른 논문의 소개 페이지도
 * 「관련 논문」 목록(h3 머리일 수 있다)에 인용한 제목을 담는다.
 */
export function pageHeadsIn(html: string): { heads: string[]; subheads: string[]; declared: string[] } {
    const meta = [metaContent(html, 'citation_title'), metaContent(html, 'DC\\.title')].map(cleanTitle).filter((t): t is string => Boolean(t));
    const hs = (re: RegExp, src = html) => [...src.matchAll(re)].map((m) => cleanTitle(m[2]!.replace(/<[^>]+>/g, ' '))).filter((t): t is string => Boolean(t));
    const { sites } = siteParts(html);
    const h1 = h1sIn(html).find((t) => titleLong(t) && !siteLike(t, sites) && !genericHead(t));
    return {
        heads: [...meta, cleanTitle(metaContent(html, 'og:title')), titleTag(html), ...hs(/<h(1)\b[^>]*>([\s\S]{0,600}?)<\/h1>/gi)].filter((t): t is string => Boolean(t)),
        // h2·h3 은 관련 목록(relatedFree) 밖에서만 — 「관련 논문」 머리말 아래 h3 의 인용 제목은 그 페이지의 제목 자리가 아니다.
        subheads: hs(/<h([23])\b[^>]*>([\s\S]{0,600}?)<\/h\1>/gi, relatedFree(html)),
        declared: [...meta.filter(titleLong), ...(h1 ? [h1] : [])],
    };
}

/**
 * 페이지가 **스스로** 밝힌 DOI — citation_doi·bepress_citation_doi·dc.identifier·prism.doi 메타, og 메타(og:url 이 doi.org 주소 등). 소문자로.
 * 메타 값이 통째로 DOI(앞에 doi: · https://doi.org/ 정도)일 때만 — 본문이나 설명 문장에 인용된 남의 DOI 는 그 페이지의 식별자가 아니다.
 */
export function pageDoisIn(html: string): string[] {
    const out = new Set<string>();
    for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
        const name = /(?:name|property)=["']([^"']+)["']/i.exec(m[0])?.[1] ?? '';
        if (!/^(?:citation_doi|bepress_citation_doi|dc\.identifier(?:\.doi)?|dcterms\.identifier|prism\.doi|og:[\w:.]+)$/i.test(name)) continue;
        const content = /content=["']([^"']+)["']/i.exec(m[0])?.[1] ?? '';
        const doi = /^\s*(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*|info:doi\/)?(10\.\d{4,9}\/[^\s"'<>]+)\s*$/i.exec(content)?.[1];
        if (doi) out.add(doi.replace(/[.,;:]+$/, '').toLowerCase());
    }
    return [...out];
}

/**
 * 랜딩 페이지에서 원문 PDF 주소를 찾는다. 학술지·출판사 페이지 대부분이 구글 학술검색용 메타(citation_pdf_url)를 단다.
 * 그 밖에 bepress·eprints 메타, <link rel=alternate type=application/pdf>, 그리고 같은 사이트의 .pdf 링크(「PDF·원문·Full text」 라고 쓴 것이 먼저).
 * 첫 후보만 — 후보 전부는 findPdfLinks(fetchUrl 의 pdfLinks). 찾지 못하면 undefined.
 */
export function pdfLinkIn(html: string, base: string): string | undefined {
    return findPdfLinks(html, base)[0]?.url;
}

/**
 * 원문 PDF 후보 하나. meta 면 페이지가 그 글의 PDF 라고 밝힌 것, 아니면 본문의 <a>(사이트 공통 PDF 일 수 있다 — 맞춰 볼 것이 없으면 받지 않는다).
 */
export interface PdfLink {
    url: string;
    meta: boolean;
}

/** 링크 글이 운영 문서(투고규정·연구윤리·양식·안내·저작권…)를 가리키는가 — 원문·전문·본문·Full text 라고도 쓰지 않았을 때만. 순서만 정한다(건너뛰지 않는다). */
const OPERATING_LABEL = /투고|규정|양식|서식|지침|윤리|안내|guidelines?|polic(?:y|ies)|ethics|instructions?|templates?|author\s*information|copyright/i;
const FULL_TEXT_LABEL = /원문|전문|본문|full\s*text/i;

/**
 * pdfLinkIn 과 같되 후보 전부를 따라갈 순서대로. 메타가 먼저, 다음이 본문의 <a>.
 * <a> 는 사이트 공통 자료를 **주소(파일 이름·폴더)** 로만 건너뛴다(isSiteWidePdf). 링크 글은 순서만 정한다 — 「원문·전문·PDF·Full text」,
 * 다음 「다운로드」, 그 밖(제목을 링크 글로 쓴 원문 등), 맨 끝이 운영 문서를 가리키는 링크 글(「투고규정 PDF」「Author guidelines (PDF)」 — 「PDF」라고 써도).
 * 링크 글로 건너뛰면 「Data Retention Policy … (PDF)」 같은 원문이 빠졌고, 첫 후보 하나만 돌려주면 사이드바의 「투고규정 다운로드」(/files/rule.pdf)가
 * 본문의 「원문 PDF」를 가려 원문을 놓쳤다. 「투고규정 PDF」를 「원문 PDF」와 같은 순위로 두던 때는 페이지 순서(사이드바가 먼저)로 그 규정 PDF 가 먼저 따라가졌다.
 */
function findPdfLinks(html: string, base: string): PdfLink[] {
    const out: PdfLink[] = [];
    const add = (l: PdfLink | undefined) => {
        if (l && !out.some((x) => x.url === l.url)) out.push(l);
    };
    const abs = (u: string | undefined) => {
        if (!u) return undefined;
        try {
            const r = new URL(u.replace(/&amp;/g, '&').trim(), base);
            return /^https?:$/.test(r.protocol) ? r.toString() : undefined;
        } catch {
            return undefined;
        }
    };
    for (const n of ['citation_pdf_url', 'bepress_citation_pdf_url', 'eprints\\.document_url', 'wkhealth_pdf_url']) {
        const u = abs(metaContent(html, n));
        if (u) add({ url: u, meta: true });
    }
    const alt = abs(/<link[^>]+type=["']application\/pdf["'][^>]*href=["']([^"']+)["']/i.exec(html)?.[1] ?? /<link[^>]+href=["']([^"']+)["'][^>]*type=["']application\/pdf["']/i.exec(html)?.[1]);
    if (alt) add({ url: alt, meta: true });
    // 본문의 링크 — 같은 사이트의 .pdf.
    let host = '';
    try {
        host = new URL(base).hostname.replace(/^www\./, '');
    } catch {
        /* */
    }
    const anchors: { url: string; rank: number }[] = [];
    for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
        const u = abs(m[1]);
        if (!u || !/\.pdf(?:$|[?#])/i.test(u)) continue;
        if (new URL(u).hostname.replace(/^www\./, '') !== host) continue;
        // 사이트 공통 자료(투고규정·양식·필드 설명…)는 그 글의 원문이 아니다 — KCI 논문 페이지의 첫 「다운로드」 링크는
        // /kciportal/resources/kci_data_filed.pdf(「필드명 설명 자료 다운로드」)여서, 그 PDF 가 논문 대신 들어왔다.
        if (isSiteWidePdf(u)) continue;
        const label = m[2]!.replace(/<[^>]+>/g, ' ');
        const rank = OPERATING_LABEL.test(label) && !FULL_TEXT_LABEL.test(label) ? 3 : /원문|전문|본문|pdf|full\s*text/i.test(label) ? 0 : /download|다운로드|내려받기/i.test(label) ? 1 : 2;
        anchors.push({ url: u, rank });
    }
    // 같은 순위 안에서는 페이지에 나온 순서(sort 는 안정 정렬이다).
    for (const a of anchors.sort((x, y) => x.rank - y.rank)) add({ url: a.url, meta: false });
    return out;
}

/**
 * 사이트 공통 자료의 **파일 이름**(확장자 뺀 것). 링크 글은 보지 않는다 — 법학 논문은 주제어가 곧 제목이라
 * 「Data Retention Policy … (PDF)」「약관 해석론 원문 PDF」 같은 원문 링크가 걸려 그 페이지의 원문을 놓쳤다.
 * 영문은 **이름 전체**(+ 판·날짜 꼬리)가 운영 문서 이름일 때만 — 「Guidelines-for-Authors」「author-information」「copyright-transfer-agreement」
 * 「Instructions_for_Authors_2024」「author-guidelines-and-ethics」. 앞부분만 맞춰 보던 때는 「guidelines-for-authors-of-ai-generated-works」
 * 「information-for-authors-and-inventors-under-patent-law」 같은 제목까지 건너뛰었다. 저자 안내·저작권 양도서 꼴은 앞에 학술지 약칭 하나(「JDL_」「jlt-」「KLR_」)가
 * 붙어도 운영 문서다 — 이름 머리에 붙박던 때는 「JDL_Author_Guidelines」「KLR_Guide_for_Authors_2024」 가 원문 후보로 남았다. kci_data_filed 는 어디에 있어도 본다.
 * 학술지 약칭(EN_JOURNAL_HEAD·EN_JOURNAL_TAIL)은 **약칭 꼴만** — 3~6자, 모두 대문자이거나 모두 소문자(「JDL」「jlt」「KLR」, 숫자가 붙어도 된다), 이름 앞이나
 * 뒤(「Author_Guidelines_KLR」)에. 아무 낱말 하나를 약칭으로 보던 때는 제목이 이름인 원문(「Rethinking_Copyright_Transfer_Agreements」
 * 「Standard_Copyright_License_Agreement」)까지 저작권 양도서로 건너뛰었다. 두 자도 약칭으로 보던 때는 「Copyright_Licence_Agreement_EU」 의 「_EU」,
 * 「on_copyright_assignment_agreements」 의 「on_」 이 떼어져 인용하는 계약서·글이 건너뛰어졌다(8차 K8.8).
 * 대소문자를 가려야 해서 약칭은 따로 떼고 맞춰 본다(SITE_WIDE_PDF 는 대소문자를 가리지 않는다).
 * 한글은 koSiteWide.
 */
const OP_TAIL = '(?:[-_ .()\\[\\]\\d]|개정|최종|수정|확정|본|안|판|v\\d+|ver\\.?\\s*\\d+|final|draft|rev\\d*)*';
const EN_OP_WORD = 'guide(?:lines?)?|instructions?|templates?|forms?|checklist|ethics|polic(?:y|ies)|information|info';
const EN_AND_OP = String.raw`(?:[-_ ](?:and|&)[-_ ](?:${EN_OP_WORD}))?`;
const SITE_WIDE_PDF = new RegExp(
    [
        String.raw`^(?:guidelines?|guide|instructions?|templates?|forms?|manual|brochure|notice|terms|polic(?:y|ies)|ethics|submissions?|copyright)${OP_TAIL}$`,
        'kci_data_filed',
        String.raw`^(?:(?:publication|research)[-_ ]?ethics|(?:privacy|ethics|editorial|peer[-_ ]?review|open[-_ ]?access)[-_ ]?polic(?:y|ies))${OP_TAIL}$`,
    ].join('|'),
    'i',
);
/** 저자 안내·저작권 양도서 꼴 — 앞뒤의 학술지 약칭을 뗀 이름으로도 본다(enAuthorDoc). */
const EN_AUTHOR_DOC = new RegExp(
    [
        String.raw`^(?:author|submission|contributor)s?[-_ ]?(?:guide(?:lines?)?|instructions?|templates?|forms?|checklist)${EN_AND_OP}${OP_TAIL}$`,
        String.raw`^(?:guide(?:lines?)?|instructions?|information|info)[-_ ]?(?:for|to)[-_ ]?(?:authors?|contributors?)${EN_AND_OP}${OP_TAIL}$`,
        String.raw`^(?:authors?|contributors?)[-_ ]?(?:information|info)${OP_TAIL}$`,
        String.raw`^copyright(?:[-_ ]?(?:transfer|assignment|license|licence))?[-_ ]?(?:agreement|form|statement)s?${OP_TAIL}$`,
    ].join('|'),
    'i',
);
const EN_JOURNAL_HEAD = /^(?:[A-Z]{3,6}|[a-z]{3,6})\d*[-_ ]/;
const EN_JOURNAL_TAIL = /[-_ ](?:[A-Z]{3,6}|[a-z]{3,6})\d*$/;
const enAuthorDoc = (name: string) => [name, name.replace(EN_JOURNAL_HEAD, ''), name.replace(EN_JOURNAL_TAIL, '')].some((n) => EN_AUTHOR_DOC.test(n));

/**
 * 한글 운영 문서의 파일 이름 — 판·날짜 꼬리(_최종본·(개정)·_v2·_2024·final…)를 뗀 이름이 **문서 종류로 끝나고 운영 주체로 시작할 때**
 * (「연구윤리위원회규정」「논문심사위원위촉규정」「학회비납부안내」「국문초록작성요령」「심사의견서양식」「저작권이용허락동의서」「원고작성요령」「윤리강령」「학회정관」).
 * 주체 앞에는 연도, 「_」 로 이은 학술지 이름 하나(「정보법학_논문심사규정」), 「국문·영문·논문·학술지」 같은 꾸밈말만 온다. 「투고」는 어디에 있어도 본다 — 법령 예외보다 먼저
 * (「법률행정논총_투고규정」「대한법의학회지_투고안내」「논문투고방법의안내」).
 * 이름 **전체**가 「주체 + 종류」여야 하던 때는 주체 목록 밖의 말(「위원위촉」「납부」「처리」「작성」「수집이용」)이 끼면 운영 문서가 원문 후보로 남아,
 * 사이드바의 규정 PDF 셋이 따라갈 몫(PDF_TRIES)을 다 쓰고 본문의 원문 PDF 는 보지도 못했다. 이름 끝만 보던 때는 제목이 파일 이름인 원문
 * (「형법상몰수규정」「전자금융감독규정」)까지, 주체가 이름 어디에 있어도 세던 때는 인용하는 행정규칙(「불공정거래행위심사지침」「부당한표시광고행위의심사지침」
 * 「표준개인정보보호지침」)까지 건너뛰었다 — 그래서 끝(종류)과 머리(주체)를 함께 본다. 같은 까닭에 「윤리」「이용안내」를 주체에 넣어도 「AI윤리지침」
 * 「공공데이터이용지침」 같은 인용 대상은 남는다. 법령 이름 + 「상·의·에서」(「개인정보보호법상동의규정」「EU인공지능법의고위험AI규정」「저작권법에서의공정이용지침」)가 든
 * 이름은 법령을 다루는 글의 제목이다 — 「방법의」「기법의」「작성법의」 같은 낱말은 법령이 아니다(substring 으로 보던 때는 「논문투고방법의안내」가, 「작성법」을
 * 법령으로 보던 때는 「원고작성법의안내」가 제목이 됐다).
 * 머리말·빈칸: 판·날짜 꼬리를 떼고, 앞의 붙임·서식 표지(「[붙임]」「붙임1.」「(별지 제1호서식)」「제25회」「정기」)를 떼고, 앞의 학회 이름 한 낱말
 * (「한국형사법학회 」「한국정보법학회_」 — …학회·학회지·연구회, KO_SOCIETY)은 머리말로 떼고, **빈칸을 지운 이름**으로 본다. 띄어 쓴 이름을 그대로 보던 때는
 * 「논문 저작권 양도 동의서」「원고 작성 요령」「연구 윤리 규정」 이, 머리말을 떼지 않던 때는 「[붙임] 연구윤리규정」「한국형사법학회 정관」 이 원문 후보로 남았다.
 * 뜻이 하나뿐인 주체(KO_OP_ANYWHERE — 원고작성·논문심사·게재신청·저작권양도·이용허락동의…)는 이름 어디에 있어도 본다(「형사법연구 원고작성요령」
 * 「저작물 이용허락 동의서」). 뜻이 여럿인 주체(윤리·심사·저작권·이용)는 머리에서만 — 「기업결합 심사지침」「형사법연구 윤리규정」 은 남는다(뒤의 것은 알려진 값).
 */
/** 운영 문서의 주체 — 뜻이 여럿인 것(KO_OP_MULTI: 인용하는 규정·지침의 주체이기도 하다)과 뜻이 하나뿐인 것(KO_OP_ONE). 둘 다 이름 머리에서만 본다. */
const KO_OP_MULTI = '윤리|심사|저작권|이용(?=안내)|개인정보';
const KO_OP_ONE = '연구윤리|윤리위원회|투고|편집|발간|논문작성|원고작성|초록작성|이용허락|학회|회원|연구부정|학술대회|발표|게재';
/**
 * 「_」 로 이은 학술지 이름 머리말 — 학술지·학회 낱말(…학회·학회지·학술지·연구회·연구·법학·논총·논집·학보·저널)로 끝나는 낱말이나 3~6자 로마자 약칭(「JDL_」).
 * 아무 낱말이나 머리말로 보던 때는 「불공정거래행위_심사지침」 처럼 인용하는 행정규칙의 앞 낱말이 떼어져 「심사지침」 이 되어 건너뛰었다(8차 K8.9 — 「형사법연구_윤리규정」 은 그대로).
 * 이 좁힘은 뜻이 여럿인 주체(KO_OP_MULTI — 윤리·심사·저작권·이용안내, 그리고 인용하는 「표준개인정보보호지침」 의 개인정보) 앞에서만이다. 뜻이 하나뿐인 주체
 * (연구윤리·편집·게재…) 앞의 「_」 머리말은 여전히 아무 낱말이다 — 모든 주체 앞에서 좁히던 때는 「저스티스_연구윤리규정」「법학연구원_연구윤리규정」 처럼
 * 학술지 낱말로 끝나지 않는 학술지·발행 기관 이름을 단 운영 문서가 원문 후보로 남았다(8차 뒤따름 K8.9).
 */
const KO_JOURNAL_PREFIX = '[^\\s_]*(?:학회지|학회|학술지|연구회|연구|법학|논총|논집|학보|저널)|[A-Za-z]{3,6}\\d*';
const KO_OP_LEAD = '(?:국문|영문|한글|논문|학술지|학회지)?';
const KO_OP_HEAD = new RegExp(
    `^(?:\\d{4}\\s*(?:학?년도?)?[\\s_.-]*)?(?:(?:[^\\s_]+_)?${KO_OP_LEAD}(?:${KO_OP_ONE})|(?:(?:${KO_JOURNAL_PREFIX})_)?${KO_OP_LEAD}(?:${KO_OP_MULTI}))`,
);
const KO_OP_ANYWHERE = /원고작성|논문심사|게재신청|발표신청|저작권양도|저작권이용허락|이용허락동의|심사신청|논문제출/;
const KO_OP_KIND = /(?:규정|지침|안내|양식|서식|강령|동의서|회칙|정관|방침|요령|신청서|의견서|허락서|서약서|확인서|세칙|내규)$/;
const KO_STATUTE_TOPIC = /(?<=[가-힣])(?<![방기작문어용요화수필편])(?<!작성)법률?(?:상|의|에서)/;
const KO_TAIL = new RegExp(`${OP_TAIL}$`, 'i');
const KO_ATTACH = /^(?:[\s_]*(?:[[［(（【]\s*붙임\s*\d*\s*[\]］)）】]|붙임\s*\d*\s*[.)]?|[(（]\s*별지\s*(?:제?\s*\d+\s*호?)?\s*(?:서식)?\s*[)）]|제\s*\d+\s*회|정기))+[\s_]*/;
/**
 * 학회 이름 머리말(「한국형사법학회 」「한국정보법학회_」) — 학술 단체만(…학회·학회지·연구회). 협회·연구소·위원회는 머리말로 떼지 않는다 — 떼던 때는
 * 「한국기자협회 윤리강령」 처럼 학회 밖 단체가 낸, 인용하는 강령이 「윤리강령」 만 남아 운영 문서로 건너뛰었다(8차 K8.8).
 */
const KO_SOCIETY = /^[^\s_]*(?:학회지|학회|연구회)[\s_]+/;
/** 문서 종류 낱말 하나뿐인 이름(「정관」「회칙」) — 학회·기관 이름 머리말 뒤에 이것만 남으면 그 학회의 문서다(「한국형사법학회 정관」 = 「학회정관」). */
const KO_OP_KIND_ONLY = new RegExp(`^${KO_OP_KIND.source.replace(/\$$/, '')}$`);
function koSiteWide(name: string): boolean {
    if (name.includes('투고')) return true;
    if (KO_STATUTE_TOPIC.test(name)) return false;
    const head = name.replace(KO_TAIL, '').replace(/[\s_·-]+$/, '').replace(KO_ATTACH, '');
    // 학회·기관 이름은 「_」 로 이은 학술지 이름처럼 **머리말**이다 — 떼고 나머지가 운영 문서 이름이어야 한다. 그 이름을 주체 「학회」 로 바꿔 넣던 때는
    // 「대한변호사협회 변호사 광고에 관한 규정」「대한의사협회 의사윤리지침」 처럼 기관이 낸 규정(인용 대상)까지 운영 문서로 건너뛰었다.
    // 머리말 뒤에 문서 종류 낱말만 남을 때만(「한국형사법학회 정관」) 그 학회가 주체다.
    const society = KO_SOCIETY.exec(head);
    let core = (society ? head.slice(society[0].length) : head).replace(/\s+/g, '');
    if (society && KO_OP_KIND_ONLY.test(core)) core = `학회${core}`;
    return KO_OP_KIND.test(core) && (KO_OP_HEAD.test(core) || KO_OP_ANYWHERE.test(core));
}

/** 사이트 공통 자료를 담는 **폴더**(경로 조각) — 투고 안내·저자 안내 폴더. 일반 낱말 폴더(/forms/·/files/)는 원문도 담으므로 보지 않는다. */
const SITE_WIDE_DIR = /^(?:\S*투고\S*|submissions?|author[-_ ]?(?:guide(?:lines?)?|instructions?)|instructions?[-_ ]for[-_ ]authors?)$/i;

/** 사이트 공통 PDF 를 가리키는 주소인가 — 파일 이름과 폴더를 본다. 퍼센트 인코딩을 푼다(pathname 은 「투고규정.pdf」를 %ED%88%AC… 로 준다). */
export function isSiteWidePdf(u: string): boolean {
    let segs: string[];
    try {
        segs = new URL(u).pathname.split('/').filter(Boolean);
    } catch {
        return false;
    }
    const dec = (s: string) => {
        try {
            return decodeURIComponent(s);
        } catch {
            return s; // 글자 그대로
        }
    };
    const name = dec(segs.pop() ?? '').replace(/\.pdf$/i, '');
    const named = (n: string) => SITE_WIDE_PDF.test(n) || enAuthorDoc(n) || koSiteWide(n);
    // 「_」 를 다 지운 이름으로도 본다 — 「_」 로 띄운 운영 문서(「원고_작성_요령」「원고_작성요령(2024)」)를 빈칸만 지운 이름으로 보던 때는 원문 후보로 남았다.
    // 지운 이름만 보지 않는 것은 「_」 학술지 머리말(「형사법연구_윤리규정」)이 지우면 붙어 버려서다 — 둘 중 하나가 운영 문서면 건너뛴다(8차 K8.9).
    return named(name) || (name.includes('_') && named(name.replace(/_/g, ''))) || segs.some((s) => SITE_WIDE_DIR.test(dec(s)));
}

/**
 * 초록·서지 페이지의 표지가 있는가 — 필자가 준 원문(HITL URL·브라우저 저장)을 거부하는 데 쓴다. 「초록」을 **라벨**로 쓴 자리만 본다.
 * 칸 머리(줄 머리·탭 뒤)에, 꾸밈(■ [ 【 # …)·「국문/영문」 다음으로 초록·Abstract·요약이 오고, 그 뒤가
 *  (가) 줄 끝·탭·쌍점 — 라벨 그 자체(<h3>초록</h3>, <th>초록</th>, 「초록 :」「Abstract:」「국문 초록 (Abstract)」)
 *  (나) 닫는 괄호·줄표(—·–·띄운 -)·마침표·라벨 덧말(「(Abstract)」「(English)」「(Korean)」「(국문)」「(영문)」「(요약)」「(Summary)」) + 본문 — 「[초록] 이 논문은」
 *      「Abstract—We」「Abstract. We」「Abstract – We」(IEEE 꼴) 「초록(Abstract) 이 논문은」. 덧말은 이 라벨 낱말만 — 아무 라틴 낱말이나 덧말로 보던 때는
 *      보도 「초록(Green) 성장 정책은 …」 이 기사를 거부했고 「초록(PDF) 내려받기」「Abstract (PDF) download」 링크가 라벨이 됐다. 한자 덧말(「초록(草綠)은 …」)도 낱말이다.
 *  (다) 띄어 쓴 본문 — **그 줄(칸)의 나머지가 60자 이상**이고 **그 글에 학술 서지의 흔적(scholarlySign)이 있을 때**만(<span>초록</span> <span>…</span>,
 *      <b>Abstract</b> We …). 띄어 쓴 다음이면 무엇이든 라벨로 보던 때는 사이드바 「초록 뉴스 더보기」, 해시태그 줄 「#초록 #환경」, 「요약 보기」 단추가,
 *      60자만 보던 때는 「초록 물결이 넘실대는 …」「Abstract Expressionism, the post-war movement …」 로 시작하는 보도 문단이 기사를 거부했다.
 *  · 학술 DB 단추·항목 — 「초록보기」(RISS 목록) 「초록 열기/닫기」(KCI) 「국문초록」「영문 초록」「다국어 초록」(RISS 학위논문)
 * 낱말이 이어지면(「초록우산」「초록색」「초록빛」) 라벨이 아니다. 영문은 띄어 쓴 다음 낱말이 대문자일 때만(「Abstract art」 는 낱말이다),
 * 붙임표로 이은 「Abstract-based」 도 낱말이다(띄운 「-」만 줄표).
 * 「요약」은 뉴스의 요약 단추·상자에도 쓰이므로 학술 서지의 흔적(scholarlySign)이 같이 있을 때만 센다.
 */
export function abstractMarker(text: string): boolean {
    const sp = '[ \u00a0]';
    const head = String.raw`(?:^|\n|\t)${sp}*(?:[\[【〈<(「『■□▶▷►●○◆◇◎※•·*#\-–]${sp}*)*(?:(?:국문|영문|외국어|다국어|한글|한국어)${sp}*)?`;
    const close = '[\\]】〉>)」』]';
    // (가) 라벨 그 자체 — 줄 끝·탭·쌍점 앞. 닫는 괄호·「(Abstract)」 같은 덧말은 넘긴다.
    const gloss = String.raw`\((?:(?:[A-Za-z]+ )?(?:Abstract|ABSTRACT)|English|Korean|국문|영문|요약|Summary)\)`;
    const bare = String.raw`${sp}*${close}?\.?${sp}*(?:${gloss}${sp}*)?(?=\r?\n|\t|$|[:：])`;
    // (나) 닫는 괄호·줄표·마침표·라벨 덧말 다음 본문
    const punct = String.raw`(?:${sp}*${close}|${sp}*[—–]|${sp}+-|-(?=${sp})|\.|${sp}*${gloss})${sp}*(?=\S)`;
    // (다) 띄어 쓴 본문 — 그 줄(탭 칸)의 나머지가 60자 이상
    const long = String.raw`${sp}+(?=[^\n\t]{60})`;
    const ko = `초${sp}{0,4}록`;
    const en = '(?:Abstract|ABSTRACT)';
    if (new RegExp(`${head}(?:${ko}|${en})(?:${bare}|${punct})`).test(text)) return true;
    if (/(?:국문|영문|외국어|다국어)[ \t]*초[ \t]*록|초록[ \t]*(?:보기|열기|닫기|더\s*보기)/.test(text)) return true;
    if (!scholarlySign(text, head, bare)) return false;
    return new RegExp(`${head}(?:${ko}${long}|${en}${long}(?=[A-Z0-9“"‘'(])|요${sp}{0,4}약(?:${bare}|${punct}|${long}))`).test(text);
}

/**
 * 학술 서지의 **굳은** 흔적 — DOI, 권호 짝(제N권 제N호·N권 N호·제N집 제N호·Vol. N No. N·Vol. N, No. N·Volume N, Issue N·v.N no.N(RISS)·Vol.N(N)),
 * 주제어·Keywords **라벨 줄**, ISSN 과 권(제N권·Vol. N)이 함께. 권호 짝을 「제N권 제N호」「Vol. N No. N」 꼴로만 보던 때는 「v.33 no.2」「Volume 5, Issue 2」
 * 「33권 2호」 를 단 초록·서지 페이지가 필자의 원문으로 들어왔다. 「Vol.N(N)」 의 괄호는 호(두 자리까지)다 — 「Vol. 12 (2024)」 의 연도는 아니다.
 * 「키워드」(뉴스 태그 상자)·「학술지」(연구를 다룬 기사)·ISSN 하나(신문 꼬리말)로 세던 때는 보도 기사·실무 뉴스레터가 「초록·서지 페이지」로 거부됐고,
 * 권 하나(「백서 제3권」「조선왕조실록 제3권」「Legal Update 2024 Vol. 12」)로 세던 때도 그랬다. 학회지 소개 페이지는 「형사법연구 제33권 제2호」처럼 권호를 짝으로 단다.
 */
function scholarlySign(text: string, head: string, bare: string): boolean {
    if (/\bdoi\b/i.test(text)) return true;
    if (/(?<!\d)(?:제\s*)?\d+\s*[권집]\s*(?:제\s*)?\d+\s*호|\bvol(?:ume)?\.?\s*\d+\s*[,.]?\s*(?:no|num(?:ber)?|iss(?:ue)?)\.?\s*\d|\bv\.\s*\d+\s*,?\s*no\.?\s*\d|\bvol\.?\s*\d+\s*\(\s*\d{1,2}\s*\)/i.test(text)) return true;
    if (/\bISSN\b/i.test(text) && /제\s*\d+\s*[권집]|\bvol\.?\s*\d/i.test(text)) return true;
    return new RegExp(`${head}(?:주[ \u00a0]?제[ \u00a0]?어|Key[ \u00a0]?words?|KEYWORDS?)${bare}`, 'i').test(text);
}

/**
 * 공개 인터넷이 아닌 주소 — 사설망·루프백·링크로컬·ULA·멀티캐스트·예약 대역.
 * 호스트 이름의 글자만 보면 [::ffff:127.0.0.1](IPv4 를 담은 IPv6)이나 127.0.0.1 로 풀리는 공개 DNS 이름(localtest.me 등)이 그대로 통과했다.
 * 198.18.0.0/15(벤치마크 대역)와 100.64.0.0/10(CGNAT)은 막지 않는다 — Clash·Surge 같은 fake-ip 프록시는 **모든** 이름을 198.18.x.x 로 풀고,
 * 통신사·캠퍼스망은 100.64.x.x 를 쓴다. 이 둘을 막으면 그런 망의 필자는 원문을 하나도 못 받는다. 노리는 것(이 컴퓨터·공유기·사내망)은 아래 대역이다.
 */
const PRIVATE_NETS = (() => {
    const b = new BlockList();
    const v4: [string, number][] = [
        ['0.0.0.0', 8],
        ['10.0.0.0', 8],
        ['127.0.0.0', 8],
        ['169.254.0.0', 16],
        ['172.16.0.0', 12],
        ['192.0.0.0', 24],
        ['192.168.0.0', 16],
        ['224.0.0.0', 4],
        ['240.0.0.0', 4],
    ];
    for (const [a, p] of v4) b.addSubnet(a, p, 'ipv4');
    // ::/96 은 ::·::1·옛 IPv4 호환 주소. ::ffff:0:0/96(IPv4 매핑)은 아래에서 IPv4 로 풀어 본다.
    for (const [a, p] of [['::', 96], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as [string, number][]) b.addSubnet(a, p, 'ipv6');
    return b;
})();

/** IPv6 → 16비트 여덟 칸. 끝이 점 표기(::ffff:1.2.3.4)여도 읽는다. 못 읽으면 null. */
function v6Words(ip: string): number[] | null {
    let s = ip.toLowerCase();
    const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
    if (dotted) {
        const o = dotted.slice(1).map(Number);
        s = `${s.slice(0, dotted.index)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
    }
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const h = halves[0] ? halves[0].split(':') : [];
    const t = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const words = [...h, ...Array<string>(halves.length === 2 ? Math.max(0, 8 - h.length - t.length) : 0).fill('0'), ...t].map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN));
    return words.length === 8 && words.every((w) => !Number.isNaN(w)) ? words : null;
}

/** 사설·루프백 주소인가. IPv4 매핑(::ffff:a.b.c.d)·NAT64(64:ff9b::a.b.c.d)는 안에 든 IPv4 로 판정한다. 읽을 수 없는 주소는 막는다. */
export function privateAddress(ip: string): boolean {
    const fam = isIP(ip);
    if (fam === 4) return PRIVATE_NETS.check(ip, 'ipv4');
    if (fam !== 6) return true;
    const w = v6Words(ip);
    if (!w) return true;
    const mapped = w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff;
    const nat64 = w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0);
    if (mapped || nat64) return PRIVATE_NETS.check(`${w[6]! >> 8}.${w[6]! & 255}.${w[7]! >> 8}.${w[7]! & 255}`, 'ipv4');
    return PRIVATE_NETS.check(ip, 'ipv6');
}

/**
 * 가져와도 되는 주소인가. 이름은 **풀어서** 나온 주소를 전부 본다 — 리다이렉트·따라간 PDF 링크도 홉마다 다시 부른다.
 * (풀이와 접속 사이에 DNS 가 바뀌는 경우까지 막으려면 접속 주소를 고정해야 하는데, 내장 fetch 로는 할 수 없다.)
 * 이름을 풀지 못하면 막지 않고 fetch 에 맡긴다 — 풀리지 않는 이름은 fetch 도 접속하지 못하고 그쪽 오류가 그대로 보인다.
 * 여기서 막으면 잠깐의 DNS 장애·사내 DNS 의 다른 답이 「거부」로 바뀌어, 열리는 주소까지 원문 없음으로 끝났다.
 * signal 로 멈춘다 — getaddrinfo 는 취소되지 않으므로 기다림만 끊는다(시간 제한·사용자의 멈춤이 DNS 에서 걸리지 않게).
 */
async function guardHost(url: string, signal?: AbortSignal): Promise<string | null> {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return 'URL 이 아님';
    }
    if (!/^https?:$/.test(u.protocol)) return `허용되지 않는 프로토콜: ${u.protocol}`;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (/^localhost$|\.localhost$/i.test(host)) return `사설·루프백 주소 거부: ${host}`;
    if (isIP(host)) return privateAddress(host) ? `사설·루프백 주소 거부: ${host}` : null;
    let addrs: { address: string }[];
    try {
        addrs = await untilAborted(lookup(host, { all: true, verbatim: true }), signal);
    } catch (e) {
        if (signal?.aborted) throw e;
        return null;
    }
    const bad = addrs.find((a) => privateAddress(a.address));
    return bad ? `사설·루프백 주소 거부: ${host} → ${bad.address}` : null;
}

/** p 를 기다리되 signal 이 오면 그 자리에서 AbortError 로 끝낸다. */
function untilAborted<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return p;
    if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
    return new Promise<T>((res, rej) => {
        const onAbort = () => rej(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
        p.then(
            (v) => {
                signal.removeEventListener('abort', onAbort);
                res(v);
            },
            (e: unknown) => {
                signal.removeEventListener('abort', onAbort);
                rej(e);
            },
        );
    });
}

const PAYWALL_MARKERS = [
    'access this article',
    'purchase this article',
    'buy article',
    'sign in to read',
    'log in to read',
    'subscribe to read',
    'institutional access',
    'get access',
    'rent this article',
    'check access',
    '로그인이 필요',
    '로그인 후 이용',
    '구독 후',
    '원문보기',
    '유료회원',
    '소장기관',
];

const LOGIN_MARKERS = ['sign in', 'log in', '로그인', 'create an account', '회원가입'];

function looksBlocked(text: string): { paywall: boolean; login: boolean } {
    const lower = text.toLowerCase();
    const paywall = PAYWALL_MARKERS.filter((m) => lower.includes(m.toLowerCase())).length >= 2;
    const login = LOGIN_MARKERS.filter((m) => lower.includes(m.toLowerCase())).length >= 2;
    return { paywall, login };
}

/** HTML → 문단이 살아 있는 텍스트. 링크·스크립트·스타일은 버린다. */
export function htmlToText(html: string): string {
    let t = html;
    t = t.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
    t = t.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
    t = t.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ');
    t = t.replace(/<!--[\s\S]*?-->/g, ' ');
    // 문단 경계를 남긴다 — extract 가 문단 단위로 관련 부분을 고르기 때문에 이게 중요하다.
    t = t.replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote)>/gi, '\n\n');
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<[^>]+>/g, ' ');
    t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    t = t.replace(/[ \t\u00a0]+/g, ' ');
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
}

/**
 * 고른 요소의 자리(elementRanges)·고른 요소를 짝 맞춰 지운 HTML(dropElements) — 여는 태그가 open 에 맞고 요소 전체(닫는 태그까지)가 whole 에 맞는 것,
 * 여는 태그부터 그 짝 닫는 태그까지(같은 이름이 안에 겹쳐도 센다). 짝이 없으면 끝까지. 고른 요소 안은 다시 보지 않는다. 짝은 open 이 맞을 때만 찾는다(큰 페이지).
 */
function elementRanges(html: string, tags: string, open: (tag: string) => boolean = () => true, whole: (el: string) => boolean = () => true): [number, number][] {
    const re = new RegExp(`<(/?)(${tags})\\b[^>]*>`, 'gi');
    const out: [number, number][] = [];
    for (let m = re.exec(html); m; m = re.exec(html)) {
        if (m[1] || !open(m[0])) continue;
        const name = m[2]!.toLowerCase();
        const pair = new RegExp(`<(/?)${name}\\b[^>]*>`, 'gi');
        pair.lastIndex = re.lastIndex;
        let depth = 1;
        let end = html.length;
        for (let n = pair.exec(html); n; n = pair.exec(html)) {
            depth += n[1] ? -1 : 1;
            if (!depth) {
                end = pair.lastIndex;
                break;
            }
        }
        if (!whole(html.slice(m.index, end))) continue;
        out.push([m.index, end]);
        re.lastIndex = end;
    }
    return out;
}
function dropElements(html: string, tags: string, open?: (tag: string) => boolean, whole?: (el: string) => boolean): string {
    let out = '';
    let last = 0;
    for (const [a, b] of elementRanges(html, tags, open, whole)) {
        out += `${html.slice(last, a)} `;
        last = b;
    }
    return out + html.slice(last);
}

/** 관련 목록을 단 요소의 class·id — 관련·추천·비슷한·인용한·인용된 논문, 참고문헌. */
const RELATED_ATTR = /\b(?:class|id)\s*=\s*["'][^"']*(?:related|recommend|similar|cited|citing|reference|참고)/i;
/**
 * 관련 목록의 머리말(글자만 남긴 것의 앞부분). 인용 안내(「Recommended Citation」「How to Cite」「인용 방법」)는 관련 목록이 아니다 — bepress 의
 * 「Recommended Citation」 h4 를 「Recommended」 머리말로 보던 때는 그 아래 글 제목·초록이 잘려 맞는 소개 페이지를 not_found 로 버렸다(8차 K8.7).
 */
const RELATED_HEAD = /^(?!recommendedcitation|howtocite|인용방법)(?:관련논문|추천논문|함께본논문|이논문을인용한논문|참고문헌|relatedarticles?|recommended|references)/;

/**
 * 관련 목록을 뺀 HTML — class·id 가 관련·추천·인용·참고문헌인 요소, 그리고 「관련 논문」「추천 논문」「함께 본 논문」「이 논문을 인용한 논문」「참고문헌」
 * 「Related articles」「Recommended」「References」 머리말부터 같은 급 이상의 다음 머리말이나 그 머리말을 담은 요소의 끝(sectionEnd) 가운데 먼저 오는 곳까지.
 * 다른 논문의 소개 페이지도 그 목록에 인용한 제목을 담는다 —
 * 목록의 머리(h3)·링크까지 제목 자리로 보던 때는 일반 머리말 h1 을 단 **다른** 논문의 소개 페이지가 그 글의 초록으로 들어왔다.
 */
function relatedFree(html: string): string {
    const h = dropElements(html, 'div|section|aside|nav|ul|ol|dl|table|article', (tag) => RELATED_ATTR.test(tag));
    const heads = [...h.matchAll(/<h([1-6])\b[^>]*>([\s\S]{0,300}?)<\/h\1>/gi)];
    const cut: [number, number][] = [];
    heads.forEach((m, i) => {
        if (!RELATED_HEAD.test(letters(m[2]!.replace(/<[^>]+>/g, ' ')))) return;
        const next = heads.slice(i + 1).find((n) => Number(n[1]) <= Number(m[1]));
        // 머리말을 담은 요소(<aside>·<section>·<nav>·<article>·<div>·<ul>)가 먼저 닫히면 목록은 거기서 끝난다 — 다음 머리말까지만 보던 때는 본문 **앞**의
        // 사이드바 「관련 논문」 h2 가 그 아래 같은 급 머리말이 없는 본문(div 제목·h3 초록)까지 지워 맞는 소개 페이지를 not_found 로 버렸다.
        cut.push([m.index!, Math.min(next ? next.index! : h.length, sectionEnd(h, m.index!))]);
    });
    let out = '';
    let last = 0;
    for (const [a, b] of cut) {
        if (b <= last) continue;
        out += `${h.slice(last, Math.max(a, last))} `;
        last = b;
    }
    return out + h.slice(last);
}

/**
 * at 을 담은 가장 안쪽 요소(<section>·<aside>·<nav>·<article>·<div>·<ul>, 없으면 <body>)의 끝. 머리말의 목록은 그 머리말을 담은 요소가 닫히면 끝난다.
 * <div> 를 보지 않던 때는 <div class="side"><h2>관련 논문</h2>…</div> 뒤에 같은 급 머리말이 없으면 글 끝까지 잘려 본문의 제목·초록이 사라졌다(8차 K8.7).
 * 그 요소가 머리말 뒤에 글자 열 자도 안 담으면(「더보기」·건수뿐인 제목 상자 <div class="box-tit"><h3>관련 논문</h3><a>더보기</a></div>) 목록은 그 밖에 있다 —
 * 한 겹 바깥 요소의 끝으로 넓힌다. 제목 상자의 끝에서 자르던 때는 상자 뒤 <ul>·<ol> 목록에 인용한 제목을 담은 **다른** 논문의 소개 페이지가 그 글의 초록이 됐다(8차 뒤따름 K8.7).
 */
function sectionEnd(html: string, at: number): number {
    const re = /<(\/?)(section|aside|nav|article|div|ul|body)\b[^>]*>/gi;
    const open: string[] = [];
    for (let m = re.exec(html); m && m.index < at; m = re.exec(html)) {
        const name = m[2]!.toLowerCase();
        if (!m[1]) open.push(name);
        else if (open.includes(name)) open.splice(open.lastIndexOf(name), 1);
    }
    const headEnd = /<\/h[1-6]\s*>/gi;
    headEnd.lastIndex = at;
    const from = headEnd.exec(html) ? headEnd.lastIndex : at;
    for (let k = open.length - 1; k >= 0; k--) {
        const name = open[k]!;
        const pair = new RegExp(`<(/?)${name}\\b[^>]*>`, 'gi');
        pair.lastIndex = at;
        let depth = open.slice(k).filter((n) => n === name).length;
        let close = html.length;
        for (let n = pair.exec(html); n; n = pair.exec(html)) {
            depth += n[1] ? -1 : 1;
            if (!depth) {
                close = n.index;
                break;
            }
        }
        if (k === 0 || letters(html.slice(from, close).replace(/<[^>]+>/g, ' ')).length >= 10) return close;
    }
    return html.length;
}

/**
 * 본문만 남긴 HTML — 관련 목록(relatedFree)과 <aside>·<nav>·<footer>·<header>, 항목이 거의 다 링크인 목록(<ul>·<ol>)을 뺀 것. 짧은 제목(10자 미만)을
 * 글자 그대로 찾는 자리다 — 글 전체에서 찾던 때는 다른 실무 글 끝의 「인기 글」 상자 링크(「딥페이크 처벌법」)가 그 글의 제목으로 맞았다.
 */
function mainOnly(html: string): string {
    let h = dropElements(relatedFree(html), 'aside|nav|footer|header');
    h = dropElements(h, 'ul|ol', undefined, (el) => {
        const items = el.split(/<li\b/i).slice(1);
        return items.length > 0 && items.filter((it) => /<a\b/i.test(it)).length * 2 > items.length;
    });
    return h;
}

/**
 * pdf.js 추출기(pdf-extract.mjs)의 자리. CLI 에서는 이 파일 옆(src/law), 앱 번들에서는 main 번들 옆(out/main — 빌드가 복사한다).
 * 패키지 앱에서는 asar 밖(app.asar.unpacked)에 풀어 둔 것을 쓴다 — 자식 프로세스가 asar 안의 ESM 을 못 읽을 수 있다.
 */
function extractorPath(): string | null {
    const here = join(import.meta.dirname, 'pdf-extract.mjs');
    const unpacked = here.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
    if (unpacked !== here && existsSync(unpacked)) return unpacked;
    return existsSync(here) ? here : null;
}

/** pdf.js 가 이미 센 쪽수 — pdfToText 다음에 pdfPages 를 부르면 같은 PDF 를 두 번 열지 않는다(실패도 기억한다: -1). */
const pdfjsPages = new WeakMap<Buffer, number>();

/** pdf.js 추출기를 쓸 수 있는가 — 준비 점검용. */
export const pdfjsAvailable = (): boolean => extractorPath() !== null;

/** 마지막으로 PDF 를 읽지 못한 이유 — 필자에게 보일 문장(플랫폼마다 다른 설치 안내를 하지 않는다: pdf.js 가 기본이다). */
export let lastPdfError = '';

/** pdf.js 로 읽기(자식 프로세스). 앱에서는 Electron 바이너리를 node 로 돌린다. */
function viaPdfjs(pdf: string, pagesOnly = false): { pages: number; text?: string } | null {
    const script = extractorPath();
    if (!script) {
        lastPdfError = 'PDF 읽기 도구(pdf.js)가 설치되지 않았습니다';
        return null;
    }
    const r = spawnSync(process.execPath, [script, ...(pagesOnly ? ['--pages'] : []), pdf], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        timeout: 120_000,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    if (r.status !== 0 || !r.stdout) {
        const why = (r.stderr || r.error?.message || '').trim();
        lastPdfError = /password|encrypt/i.test(why) ? '암호가 걸린 PDF 입니다' : /Invalid PDF|corrupt|xref/i.test(why) ? 'PDF 파일이 손상됐거나 PDF 가 아닙니다' : `PDF 를 읽지 못했습니다${why ? ` (${why.slice(0, 160)})` : ''}`;
        return null;
    }
    try {
        return JSON.parse(r.stdout) as { pages: number; text?: string };
    } catch {
        lastPdfError = 'PDF 읽기 결과를 해석하지 못했습니다';
        return null;
    }
}

/** pdftotext(poppler) — 있으면 먼저 쓴다(2단 조판의 읽기 순서를 이것으로 맞춰 왔다). 없거나 실패하면 null. */
function viaPoppler(pdf: string, txt: string): string | null {
    // -layout 을 쓰지 않는다 — 2단 조판 학술지(한국치안행정논집 등)에서 왼쪽 단과 오른쪽 단을 한 줄로 붙여
    // 문장이 뒤섞인다. 기본 모드(읽기 순서)는 단을 따로 읽는다.
    // 기본 모드는 줄 끝 '-' 를 지우고 줄을 잇는다(35-\n63 → 3563, 「…-\n부제」 → 붙음). 끈다 — 옛 poppler 에는 옵션이 없다.
    const opts = { stdio: 'pipe' as const, timeout: 60_000, windowsHide: true };
    try {
        try {
            execFileSync('pdftotext', ['-enc', 'UTF-8', '-remove-hyphens', 'none', pdf, txt], opts);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
            execFileSync('pdftotext', ['-enc', 'UTF-8', pdf, txt], opts);
        }
        // cat 으로 읽지 않는다 — 윈도우에는 cat 이 없어서 poppler 를 깔아도 늘 실패했다.
        return readFileSync(txt, 'utf8');
    } catch {
        return null;
    }
}

export function pdfToText(buf: Buffer): string | null {
    // 못 읽으면 null — 조용히 빈 문자열을 돌려주면 "읽었는데 내용이 없다"로 읽힌다. 이유는 lastPdfError 에.
    let dir: string | null = null;
    lastPdfError = '';
    try {
        dir = mkdtempSync(join(tmpdir(), 'legal-pdf-'));
        const pdf = join(dir, 'in.pdf');
        writeFileSync(pdf, buf);
        const poppler = viaPoppler(pdf, join(dir, 'out.txt'));
        if (poppler !== null) return poppler;
        const r = viaPdfjs(pdf);
        pdfjsPages.set(buf, r?.pages ?? -1);
        return r?.text ?? null;
    } catch (e) {
        lastPdfError = `PDF 를 읽지 못했습니다 (${e instanceof Error ? e.message.slice(0, 160) : String(e)})`;
        return null;
    } finally {
        if (dir) rmSync(dir, { recursive: true, force: true });
    }
}

/** PDF 쪽수. pdfinfo 가 없으면 pdf.js 로. 둘 다 실패하면 null (모르면 "전문"이라 단정하지 않는다). */
export function pdfPages(buf: Buffer): number | null {
    const known = pdfjsPages.get(buf);
    if (known !== undefined) return known > 0 ? known : null;
    let dir: string | null = null;
    try {
        dir = mkdtempSync(join(tmpdir(), 'legal-pdf-'));
        const pdf = join(dir, 'in.pdf');
        writeFileSync(pdf, buf);
        try {
            const out = execFileSync('pdfinfo', [pdf], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
            const m = /^Pages:\s+(\d+)/m.exec(out);
            if (m) return Number(m[1]);
        } catch {
            /* pdf.js 로 */
        }
        const pages = viaPdfjs(pdf, true)?.pages ?? null;
        pdfjsPages.set(buf, pages ?? -1);
        return pages;
    } catch {
        return null;
    } finally {
        if (dir) rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * 본문을 MAX_BYTES 까지만 읽는다. 전부 받은 뒤 자르면 수 GB 를 흘려보내는 주소 하나가 앱(main 프로세스)의 메모리를 다 먹는다.
 * 넘쳤는지(truncated)를 함께 돌려준다 — 잘린 PDF 는 끝의 목차(xref)가 없어 읽히지 않으므로 쓰지 않는다.
 */
async function readCapped(res: Response): Promise<{ buf: Buffer; truncated: boolean }> {
    if (!res.body) return { buf: Buffer.alloc(0), truncated: false };
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let n = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const room = MAX_BYTES - n;
        if (value.byteLength > room) {
            chunks.push(Buffer.from(value.subarray(0, room)));
            await reader.cancel().catch(() => undefined);
            return { buf: Buffer.concat(chunks), truncated: true };
        }
        chunks.push(Buffer.from(value));
        n += value.byteLength;
    }
    return { buf: Buffer.concat(chunks), truncated: false };
}

export async function fetchUrl(url: string, opts: { signal?: AbortSignal; noFrame?: boolean } = {}): Promise<Fetched> {
    // 시간 제한과 멈춤을 **주소 검사(DNS)보다 먼저** 건다 — 검사가 앞에 있으면 걸린 DNS 는 30초에 묶이지 않았고, 그동안 누른 멈춤은
    // 들리지 않아 요청이 그대로 나갔다. 이미 멈춘 신호에 단 리스너는 불리지 않으므로 그 경우는 바로 끊는다.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener('abort', onAbort);
    if (opts.signal?.aborted) ctrl.abort();
    try {
        const denied = await guardHost(url, ctrl.signal);
        if (denied) return { url, status: 0, kind: 'other', text: '', bytes: 0, error: denied };
        const headers = {
            'user-agent': UA,
            accept: 'text/html,application/pdf,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
            'accept-language': 'ko,en;q=0.8',
        };
        // 리다이렉트를 직접 따라간다 — 매 홉마다 내부망 주소 차단(guardHost)을 다시 건다.
        let cur = url;
        let res = await fetch(cur, { redirect: 'manual', signal: ctrl.signal, headers });
        for (let hop = 0; res.status >= 300 && res.status < 400 && res.headers.get('location') && hop < 6; hop++) {
            const next = new URL(res.headers.get('location')!, cur).toString();
            const blocked = await guardHost(next, ctrl.signal);
            if (blocked) return { url, status: res.status, kind: 'other', text: '', bytes: 0, error: `리다이렉트 차단: ${blocked}` };
            cur = next;
            res = await fetch(cur, { redirect: 'manual', signal: ctrl.signal, headers });
        }
        const ct = (res.headers.get('content-type') ?? '').toLowerCase();
        // 404·500 페이지도 글자는 있다 — 그걸 "제공받은 원문"으로 삼지 않게 상태코드를 본다.
        if (res.status >= 400) {
            await res.body?.cancel().catch(() => undefined);
            return { url, status: res.status, kind: 'other', text: '', bytes: 0, error: `HTTP ${res.status}` };
        }
        const declared = Number(res.headers.get('content-length') ?? 0);
        const pdfByName = ct.includes('pdf') || url.toLowerCase().endsWith('.pdf');
        if (pdfByName && declared > MAX_BYTES) {
            await res.body?.cancel().catch(() => undefined);
            return { url, status: res.status, kind: 'pdf', text: '', bytes: 0, error: `PDF 가 너무 큼(${Math.round(declared / 1048576)}MB)` };
        }
        const { buf, truncated } = await readCapped(res);
        const isPdf = pdfByName || buf.subarray(0, 5).toString() === '%PDF-';

        if (isPdf) {
            if (truncated) return { url, status: res.status, kind: 'pdf', text: '', bytes: buf.length, error: `PDF 가 너무 큼(${MAX_BYTES / 1048576}MB 넘음)` };
            const text = pdfToText(buf);
            // 쪽수는 "전문인가"의 판정에 쓰인다. 1면짜리 미리보기(초록면)를 전문으로 착각하면 안 된다.
            const pages = pdfPages(buf) ?? undefined;
            if (text === null) {
                return { url, status: res.status, kind: 'pdf', text: '', bytes: buf.length, ...(pages ? { pages } : {}), error: lastPdfError || 'PDF 를 읽지 못했습니다' };
            }
            return { url, status: res.status, kind: 'pdf', text, bytes: buf.length, ...(pages ? { pages } : {}) };
        }

        const raw = buf.toString('utf8');
        if (ct.includes('html') || /<html/i.test(raw.slice(0, 2000))) {
            const text = htmlToText(raw);
            // 본문 없는 프레임 페이지(law.go.kr 한글주소 → iframe lawService)는 iframe 을 한 번 따라간다. 같은 호스트만.
            if (text.trim().length < 300 && !opts.noFrame) {
                const src = /<iframe[^>]+src=["']([^"']+)["']/i.exec(raw)?.[1]?.replace(/&amp;/g, '&');
                if (src) {
                    try {
                        const inner = new URL(src, cur);
                        const bare = (h: string) => h.replace(/^www\./, '');
                        if (bare(inner.hostname) === bare(new URL(cur).hostname)) {
                            const d = await fetchUrl(inner.toString(), { ...opts, noFrame: true });
                            if (!d.error && d.text.trim().length >= 300) return { ...d, url };
                        }
                    } catch {
                        /* 프레임 추적 실패 — 원래 결과로 */
                    }
                }
            }
            const links = findPdfLinks(raw, cur).filter((l) => l.url !== url);
            const title = pageTitleIn(raw);
            const articleTitle = articleTitleIn(raw);
            const { heads, subheads, declared } = pageHeadsIn(raw);
            const dois = pageDoisIn(raw);
            const landText = htmlToText(relatedFree(raw));
            const mainText = htmlToText(mainOnly(raw));
            // 초록 라벨은 표 칸·정의 목록을 줄로 나눈 글에서 본다 — htmlToText 는 <th>초록</th><td>…</td>·<dt>Abstract</dt><dd>…</dd> 를 한 줄로 이어
            // 「초록」이 줄 가운데에 묻혔다(학회지 소개 페이지에 흔한 꼴). 브라우저 innerText 가 칸을 탭·줄로 나누는 것과 같은 자리다.
            const cells = /초\s*록|요\s*약|abstract/i.test(text) ? htmlToText(raw.replace(/<\/(?:t[hd]|d[td]|caption|legend)\s*>/gi, '$&<br>')) : '';
            return {
                url,
                status: res.status,
                kind: 'html',
                text,
                bytes: buf.length,
                ...looksBlocked(text),
                ...(links.length ? { pdfLink: links[0]!.url, pdfLinkMeta: links[0]!.meta, pdfLinks: links } : {}),
                ...(title ? { title } : {}),
                ...(articleTitle ? { articleTitle } : {}),
                ...(heads.length ? { heads } : {}),
                ...(subheads.length ? { subheads } : {}),
                ...(declared.length ? { declared } : {}),
                ...(dois.length ? { dois } : {}),
                ...(landText !== text ? { landText } : {}),
                ...(mainText !== text ? { mainText } : {}),
                ...(cells && abstractMarker(cells) ? { abstractLabel: true } : {}),
            };
        }
        return { url, status: res.status, kind: 'text', text: raw, bytes: buf.length };
    } catch (e: any) {
        return { url, status: 0, kind: 'other', text: '', bytes: 0, error: e?.message ?? String(e) };
    } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
    }
}

export const consts = { MAX_BYTES, TIMEOUT_MS };

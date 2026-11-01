// 연쇄 탐색(snowball). 확보한 원문의 **참고문헌·참조판례·참조조문**을 따라간다.
//
// 왜: 집필은 선형이 아니다. 판결문을 읽으면 그 판결이 원용한 선례가 필요해지고, 논문을 읽으면 그
// 논문이 비판한 선행연구가 필요해진다. 원문을 보기 전에는 그 존재를 알 수 없으므로, 원문을 확보한
// **뒤에** 한 번 더 찾아야 한다. 무엇을 따라갈지는 모델이 고르고(논지에 비추어), 찾는 것은 코드가 한다.
import { RefPickList } from '../schemas.ts';
import { COMMON } from '../prompts.ts';
import { normalizeKey } from './cite.ts';

export interface RefCandidate {
    citation: string;
    kind: 'scholarship' | 'precedent' | 'statute';
    /** 어느 원문에서 나왔는가 */
    from: string;
}

const COURT_ABBR: Record<string, string> = {
    헌재: '헌법재판소',
    대판: '대법원',
    대결: '대법원',
    서울행법: '서울행정법원',
    서울고법: '서울고등법원',
    서울중앙지법: '서울중앙지방법원',
};

// 인용표준의 "대판 2009. 3. 12, 2008도763"(날짜 뒤 쉼표), 특허법원, "대전지방법원 천안지원" 도 잡는다.
// 사건번호의 연도는 네 자리가 보통이지만 옛 사건은 두 자리다(99헌마513, 83도3161). 두 자리는 [6-9]\d 에 한하고 띄어쓰기 없이.
const CASE_RE =
    /(대법원|헌법재판소|헌재|대판|대결|[가-힣]{2,6}(?:고등|지방|행정|가정|회생)법원(?:\s*[가-힣]{2,4}지원)?|특허법원|서울행법|서울고법|서울중앙지법|[가-힣]{2,4}지법)\s*(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})\s*[.,]?\s*(선고|자)?\s*((?:\d{4}\s*|(?<!\d)[6-9]\d)(?![년월일건명차조항호])[가-힣]{1,3}\s*\d+)((?:\s*,\s*\d{3,6}(?![\d.]))*)(?:\s*(?:등|·[^\s)]{3,20})?)?\s*(판결|결정)?/g;

/** "자"로 고지된 것(대결 2010. 1. 1.자 2010마123)은 선고가 아니라 결정이다 — '선고 … 판결'로 바꿔 쓰면 틀린 인용이 된다. */
export function formalCase(court: string, y: string, m: string, d: string, caseNo: string, kind?: string, by?: string): string {
    const c = COURT_ABBR[court] ?? court.replace(/지법$/, '지방법원');
    const no = caseNo.replace(/\s+/g, '').replace(/,/g, ', ');
    const isCC = c === '헌법재판소' || /헌[가-힣]/.test(no);
    // 결정·명령 사건부호(마·모·라·바·카·그·스·즈·초·재·감·르·브)는 연도 바로 뒤에 온다 — 99헌마513 의 '마'가 아니다.
    const isOrder = by === '자' || court === '대결' || /^\d{2,4}(?:마|모|라|바|카|그|스|즈|초|재|감|르|브)\d/.test(no);
    if (isOrder) return `${c} ${y}. ${Number(m)}. ${Number(d)}.자 ${no} ${kind ?? '결정'}`;
    return `${c} ${y}. ${Number(m)}. ${Number(d)}. 선고 ${no} ${kind ?? (isCC ? '결정' : '판결')}`;
}

/** 본문에서 "참조조문"·"참고문헌" 절을 잘라낸다. 없으면 빈 문자열. */
function section(text: string, heads: RegExp): string {
    const m = heads.exec(text);
    if (!m) return '';
    const start = m.index + m[0].length;
    // 다음 절 머리까지. 판결문은 【 】, 코퍼스 md 는 "## ", 논문은 빈 줄 둘.
    const rest = text.slice(start);
    const end = rest.search(/\n\s*(?:【[^】]{1,12}】|##\s|#{1,2}\s)/);
    return (end < 0 ? rest : rest.slice(0, end)).trim();
}

/** 참고문헌 절은 보통 **마지막**에 있다. 마지막 등장을 찾는다. */
function lastSection(text: string, head: RegExp): string {
    let last: RegExpExecArray | null = null;
    const re = new RegExp(head.source, 'g');
    for (const m of text.matchAll(re)) last = m as unknown as RegExpExecArray;
    if (!last) return '';
    const rest = text.slice((last.index ?? 0) + last[0].length);
    // KCI 논문은 참고문헌 뒤에 영문 Abstract·주제어가 온다 — 거기 문장을 문헌으로 보지 않게 끊는다.
    // 〈단행본〉·〈논문〉 같은 참고문헌 안의 소제목에서 끊지 않는다. 한글 뒤 \b 는 JS 에서 듣지 않으므로 뒤를 직접 본다.
    const end = rest.search(/\n\s*(?:#{1,3}\s|【[^】]{1,20}】|[<〈\[]?\s*(?:Abstract|ABSTRACT|국문\s*초록|영문\s*초록|주제어|주\s*제\s*어|Key\s*[Ww]ords|Keywords|KEYWORDS)\s*[>〉\]]?\s*(?:[:：]|\n|$))/);
    return (end < 0 ? rest : rest.slice(0, end)).trim();
}

/**
 * HWP 에서 만든 PDF 는 『』 대신 사설 영역 글자(U+F0854/U+F0855, 화면에 󰡔󰡕)를, 「」 대신 반각 ｢｣ 를 쓴다.
 * 그대로 두면 제목·학술지명이 따옴표로 보이지 않아 문헌이 하나도 안 잡힌다(김재광 2010: 참고문헌 22건 중 3건).
 */
function normalizeRefText(t: string): string {
    return t.replace(/\u{F0854}/gu, '『').replace(/\u{F0855}/gu, '』').replace(/｢/g, '「').replace(/｣/g, '」').replace(/\f/g, '\n');
}

/** 감긴 줄을 잇는다. 한글끼리면 붙이고(PDF 는 낱말 가운데서도 줄을 바꾼다) 아니면 띄운다. */
const joinWrapped = (a: string, b: string) => (/[가-힣]$/.test(a) && /^[가-힣]/.test(b) ? `${a}${b}` : `${a} ${b}`);

/** 참고문헌 절을 항목으로. 한 항목이 여러 줄에 감겨 있다 — 앞 항목이 마침표로 끝나지 않았거나 들여 쓴 줄은 이어 붙인다. */
function refEntries(block: string): string[] {
    const out: string[] = [];
    for (const raw of block.split('\n')) {
        const t = raw.trim();
        if (!t) continue;
        // 쪽 머리·쪽 번호("272 法學論叢 第34卷 第2號", "275", "90 ｢한국치안행정논집｣ 제20권 제4호(통권 제67호)")
        const runningHead = /^\d{1,4}\s+[「『][^」』]{2,40}[」』]\s*(?:제\s*\d+\s*[권집호]|第\s*\d+\s*[卷輯號]|Vol)/;
        if (/^\d{1,4}$/.test(t) || (/^\d{1,4}\s+\S/.test(t) && t.length < 40 && (!/[「『“"]/.test(t) || runningHead.test(t)))) continue;
        // 기본 모드 pdftotext 는 쪽 번호와 쪽 머리를 다른 줄로 낸다 — 학술지명·권호만 있는 짧은 줄도 쪽 머리다.
        if (t.length < 40 && /^[^,，「『“"]{2,30}\s*(?:제\s*\d+\s*[권집]|第\s*\d+\s*[卷輯])/.test(t) && !/(?:19|20)\d{2}/.test(t)) continue;
        // 참고문헌 안의 소제목("〈단행본〉", "[논문]", "1. 국내문헌", "가. 단행본") — 항목 경계로만 쓴다.
        if (/^(?:[〈<\[【(]\s*[가-힣A-Za-z ]{2,12}\s*[〉>\]】)]|(?:\d{1,2}|[가-하]|[ⅠⅡⅢⅣⅤ]{1,3})\s*[.)]\s*[가-힣A-Za-z ]{2,12})$/.test(t)) {
            out.push('');
            continue;
        }
        const prev = out[out.length - 1];
        // APA 항목은 저자·제목 뒤 마침표에서 줄이 바뀌기도 한다. 다음 줄이 "(연도)"로 시작하거나(앞에 연도가 없을 때),
        // 「학술지」로 시작하면(앞에 연도는 있고 따옴표는 없을 때) 앞 항목의 계속이다.
        const prevYear = !!prev && /\((?:19|20)\d{2}[a-z]?[,)]/.test(prev);
        const cont = !!prev && ((/^\((?:19|20)\d{2}[a-z]?[,)]/.test(t) && !prevYear) || (/^[「『]/.test(t) && prevYear && !/[「『]/.test(prev)));
        const isNew = !prev || (/[.。]\s*$/.test(prev) && !/^\s{2,}/.test(raw) && !cont) || /^(?:\[\d+\]|\d+[.)])\s/.test(t);
        if (isNew) out.push(t);
        else out[out.length - 1] = joinWrapped(prev!, t);
    }
    return out.filter(Boolean);
}

/**
 * APA 꼴("박한호. (2023). 제목. 「치안정책연구」, 37(1): 7-46.")을 법학 인용 꼴("박한호, 「제목」, 치안정책연구 37(1), 2023, 7-46면")로.
 * 사회과학 계열 학술지는 APA 를 쓴다. 제목에 따옴표가 없으면 사다리가 제목을 못 뽑는다.
 */
function fromApa(line: string): string {
    const head = /^(.{2,80}?)\.\s*\(((?:19|20)\d{2})[a-z]?\)\.\s*(.+)$/.exec(line);
    if (!head) return line;
    const [, author, year, body] = head;
    // 논문: "제목. 「학술지」, 37(1): 7-46" — 학술지는 **마지막** 「」 다(제목에 「개인정보 보호법」 같은 법령명이 들 수 있다).
    const art = /^(.+)\.\s*[「『]([^」』]+)[」』]\s*,?\s*([^「『」』]*?)\.?$/.exec(body!);
    if (art) {
        const [, title, journal, rest] = art;
        const vp = /^(\d+(?:\s*\(\s*\d+\s*\))?)\s*[:,]\s*(\d+\s*[-–]\s*\d+)/.exec(rest ?? '');
        const t = title!.replace(/「([^」]+)」/g, '‘$1’'); // 제목 안 겹낫표는 홑따옴표로 — 제목 자체를 「」 로 감싸므로
        return vp
            ? `${author}, 「${t}」, ${journal} ${vp[1]!.replace(/\s+/g, '')}, ${year}, ${vp[2]!.replace(/\s+/g, '')}면`
            : `${author}, 「${t}」, ${journal}${rest ? ` ${rest}` : ''}, ${year}`;
    }
    // 단행본: "『제목』. 출판사." — 뒤에 또 겹낫표가 있으면 단행본이 아니다.
    const book = /^[『「]([^』」]+)[』」]\.?\s*([^「『」』]*?)\.?$/.exec(body!);
    if (book) return `${author}, 『${book[1]}』${book[2] ? `, ${book[2]}` : ''}, ${year}`;
    return line;
}

export function extractReferences(text0: string, opts: { maxCases?: number; maxStatutes?: number; maxScholarship?: number } = {}): RefCandidate[] {
    const text = normalizeRefText(text0);
    const out: RefCandidate[] = [];
    const seen = new Set<string>();
    /** 문헌은 제목으로도 중복을 본다 — 참고문헌 줄과 본문 각주의 같은 책이 저자 표기만 달리 두 번 들어오지 않게 */
    const seenTitles = new Set<string>();
    /** 같은 제목의 다른 책이 흔하다 — 참고문헌 줄끼리는 첫 저자까지 본다. 본문 인라인 조각은 저자가 잘려 나오기 쉬워 제목만 본다. */
    const seenAuthorTitles = new Set<string>();
    const titleOf = (c: string) => normalizeKey(/[「『“"]([^」』”"\n]{2,160})[」』”"]/.exec(c)?.[1] ?? '');
    const authorOf = (c: string) => {
        const i = c.search(/[「『“"]/);
        return i > 0 ? (/^([가-힣A-Za-z]{2,})/.exec(c.slice(0, i))?.[1] ?? '') : '';
    };
    /** 넣었으면 true. 중복은 false — 개수 제한은 **새로 넣은 것**만 센다(중복으로 예산을 태우면 본문 인용이 밀린다). */
    const push = (citation: string, kind: RefCandidate['kind'], inline = false): boolean => {
        let c = citation.replace(/\s+/g, ' ').trim();
        // "제목"·“제목” 은 「제목」 으로. cite.ts classify 는 겹낫표만 문헌 표지로 보므로, 곧은따옴표를 그대로 두면
        // 제목에 '판결'·'제N조' 가 든 논문이 재인용 단계에서 판례·법령 사다리를 탄다.
        if (kind === 'scholarship' && !/[「『]/.test(c)) c = c.replace(/[“"]([^”"\n]{2,160})[”"]/, '「$1」');
        // 신문 기사는 문헌이 아니다("…, 디지털데일리, 2008.4.25. 기사.") — 연쇄 탐색이 고를 대상에서 뺀다.
        if (kind === 'scholarship' && (/기사\s*(?:참조)?\.?$/.test(c) || /(?:일보|신문|뉴스|데일리|타임스|타임즈|투데이|한겨[레례]|news)(?![」』])\s*,?\s*(?:19|20)\d{2}/i.test(c))) return false;
        const k = normalizeKey(c);
        if (!k || seen.has(k)) return false;
        if (kind === 'scholarship') {
            const t = titleOf(c);
            const at = `${authorOf(c)}:${t}`;
            if (t && (inline ? seenTitles.has(t) : seenAuthorTitles.has(at))) return false;
            if (t) {
                seenTitles.add(t);
                seenAuthorTitles.add(at);
            }
        }
        seen.add(k);
        out.push({ citation: c, kind, from: '' });
        return true;
    };

    // 1) 판례·결정 — 본문 어디에서나. 참조판례 절이 있으면 그것이 먼저 잡힌다.
    const prio = section(text, /(?:【\s*참조판례\s*】|##\s*참조판례)/);
    let n = 0;
    for (const src of [prio, text]) {
        for (const m of src.matchAll(CASE_RE)) {
            // 병합 사건(2013다41431, 41448)은 두 번째 번호까지 쓴다.
            const no = `${m[6]!}${m[7] ? m[7].replace(/\s+/g, '') : ''}`;
            if (push(formalCase(m[1]!, m[2]!, m[3]!, m[4]!, no, m[8], m[5]), 'precedent') && ++n >= (opts.maxCases ?? 25)) break;
        }
        if (n >= (opts.maxCases ?? 25)) break;
    }

    // 2) 참조조문 — "헌법 제12조 제1항, 제3항, 형사소송법 제114조 제1항, 제215조" 처럼 법령명이 앞 항목에만 있다.
    // law.go.kr 의 쟁점별 묶음 "[1] 헌법 제12조 제1항, 제3항, 형사소송법 제114조 / [2] …" — 묶음 표지를 벗기고,
    // 법령명은 앞 항목에서, 조는 "제3항"처럼 항·호만 있는 항목을 위해 앞 항목에서 이어받는다.
    const arts0 = section(text, /(?:【\s*참조조문\s*】|##\s*참조조문)/);
    // 괄호는 쪼개기 **전에** 벗긴다 — "(2012. 1. 17. 법률 제11182호로 개정되기 전의 것, 이하 '구법')" 의 쉼표가 항목을 가른다.
    // 다만 (가)목 같은 한 글자 괄호는 둔다.
    const arts = arts0.replace(/\((?![가-힣]\))[^()]*\)/g, '');
    if (arts) {
        let law = '';
        let art = '';
        let k = 0;
        const tidy = (s: string) =>
            s
                .replace(/\s+/g, '')
                .replace(/(조(?:의\d+)?)(제)/g, '$1 $2')
                .replace(/(항)(제\d+호)/g, '$1 $2')
                .replace(/(조(?:의\d+)?|항|호)(단서|본문|각호|별표|전단|후단)/g, '$1 $2')
                .replace(/각호/g, '각 호')
                .replace(/(호)(\(?[가-힣]\)?목)/g, '$1 $2');
        /** 조 뒤에 붙은 것 가운데 항·호·목·단서만 — law.go.kr 은 참조조문에 조문 본문까지 싣는다. */
        const tailOf = (rest: string) => /^((?:\s*제\s*\d+\s*(?:항|호)|\s*\(?[가-힣]\)?목|\s*(?:단서|본문|전단|후단|각\s*호))*)/.exec(rest)?.[1] ?? '';
        const unresolved = (l: string) => /^(?:같은|동)\s*법/.test(l);
        // "같은 법"·"동법"(시행령)은 앞 항목의 법령이다. "구 ○○법"의 '구'는 떼고 찾는다(개정 전 조문은 필자가 확인할 몫).
        const resolveLaw = (name: string, prev: string): string => {
            const n = name.replace(/\s+/g, ' ').trim().replace(/^구\s+/, '');
            const same = /^(?:같은|동)\s*법(?:률)?(\s*시행령|\s*시행규칙)?$/.exec(n);
            if (same && prev) return `${prev.replace(/\s*시행(?:령|규칙)$/, '')}${same[1] ? ` ${same[1].trim()}` : ''}`;
            return n;
        };
        for (const raw of arts.split(/[,，/\n]/)) {
            const grouped = /^\s*\[\d+\]/.test(raw);
            const item = raw.replace(/^\s*\[\d+\]\s*/, '').trim();
            if (grouped) {
                law = '';
                art = '';
            }
            if (!item) continue;
            const m = /^([가-힣·ㆍ・\s]{1,40}?)\s*(제\s*\d+\s*조(?:\s*의\s*\d+)?)(.*)$/.exec(item);
            const a = m ? null : /^(제\s*\d+\s*조(?:\s*의\s*\d+)?)(.*)$/.exec(item);
            let added = false;
            if (m) {
                law = resolveLaw(m[1]!, law);
                art = m[2]!.replace(/\s+/g, '');
                if (unresolved(law)) {
                    // 묶음 첫 항목이 "같은 법" — 가리킬 법령이 없다. 찾을 수 없는 후보를 만들지 않는다.
                    law = '';
                    art = '';
                    continue;
                }
                added = push(`${law} ${tidy(art + tailOf(m[3]!))}`, 'statute');
            } else if (law && a) {
                art = a[1]!.replace(/\s+/g, '');
                added = push(`${law} ${tidy(art + tailOf(a[2]!))}`, 'statute');
            } else if (law && art && /^제\s*\d+\s*[항호]/.test(item)) {
                added = push(`${law} ${tidy(art + item)}`, 'statute');
            }
            if (added && ++k >= (opts.maxStatutes ?? 15)) break;
        }
    }

    // 3) 문헌 — 참고문헌 절의 줄, 그리고 본문·각주의 "저자, 「제목」, … 연도" 꼴.
    // 머리는 "참고문헌" 하나만이 아니다 — "## 참고문헌", "〈참고문헌〉", "[참고문헌]", "Ⅵ. 참고문헌", "【참고문헌】".
    const refs = lastSection(
        text,
        /\n[ \t]*(?:#{1,3}[ \t]*|[【〈<\[▣■□◆◇●○※〔≪][ \t]*|(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩIVX]{1,4}|\d{1,2})[ \t]*\.[ \t]*)?(?:참\s*고\s*문\s*헌|參考文獻|参考文献|References|REFERENCES|Bibliography)[ \t]*[】〉>\]▣■□◆◇●○〕≫]?[ \t]*\n/,
    );
    let s = 0;
    if (refs) {
        for (const entry of refEntries(refs)) {
            const line = fromApa(entry.replace(/^\s*(?:\[\d+\]|\d+[.)]|[-•·])\s*/, '').trim());
            if (line.length < 12 || line.length > 300) continue;
            // 겹낫표가 있으면 쉼표 없는 "저자 『제목』 출판사 연도" 꼴도 서지다. 곧은따옴표만 있으면 쉼표까지 있어야(영문 산문 배제).
            if (!/(19|20)\d{2}/.test(line)) continue;
            if (!(/[「『]/.test(line) || (/[“"]/.test(line) && /[,，]/.test(line)))) continue;
            if (push(line, 'scholarship') && ++s >= (opts.maxScholarship ?? 40)) break;
        }
    }
    if (s < (opts.maxScholarship ?? 40)) {
        // 저자는 어절 머리에서 시작(「헌법재판소」가 「법재판소」로 잘리지 않게), 제목 닫는 따옴표 뒤에는 쉼표 —
        // 판결문의 '피고인은, "그런 사실이 없다"라고 2008도763 …' 같은 산문 조각을 문헌으로 보지 않기 위해서다.
        // 연도 뒤에 바로 한글이 오면(2008도763) 사건번호다.
        const inline =
            /(?<![가-힣])[가-힣]{2,12}(?:\s*[·ㆍ・]\s*[가-힣]{2,12}){0,5}(?:\s*(?:외|등))?\s*,\s*[「『“"][^」』”"\n]{2,120}[」』”"](?:\s*,|\s*\(|\s+[「『]|\s+[가-힣A-Za-z]{2,20}\s*,)[^\n]{0,100}?(?:19|20)\d{2}(?![가-힣\d])(?:\s*,\s*\d{1,4}\s*[-–~]?\s*\d{0,4}\s*면)?\)?/g;
        // 각주는 여러 줄에 감긴다 — 줄을 이어 놓고 찾는다(본문 문단은 띄어서 잇는다: 저자명이 앞 낱말에 붙지 않게).
        // 다음 줄이 새 각주("12) …")면 잇지 않는다 — 이으면 앞 각주의 저자·제목에 뒤 각주의 연도가 붙는다.
        const flat = text.replace(/([^\n])\n[ \t]*(?=[^\n\s])(?!\d{1,3}\)\s)/g, '$1 ');
        for (const m of flat.matchAll(inline)) {
            if (push(m[0], 'scholarship', true) && ++s >= (opts.maxScholarship ?? 40)) break;
        }
    }
    return out;
}

const PICK_PROMPT = `${COMMON}

과제: 확보한 원문(판결문·논문)에서 뽑은 **참조판례·참조조문·참고문헌 후보**를 보고, 이 논문의 논지와 주장에 비추어 **꼭 읽어야 할 것**만 고른다.

규칙:
- 후보 목록에 있는 문자열을 **그대로** citation 에 쓴다. 없는 것을 만들지 않는다.
- 고르는 기준은 "이 논문의 어느 주장을 세우거나 반박하는 데 필요한가"다. 원문이 그냥 인용한 것은 고르지 않는다.
- 판례는 선례·후속결정처럼 논지의 법리를 직접 다루는 것, 조문은 논지의 요건·효과를 정하는 것, 문헌은 같은 쟁점의 유력한 선행연구를 우선한다.
- 최대 지정 개수까지만. 적으면 적은 대로.`;

export async function pickReferences(
    args: { thesis: string; claims: string[]; candidates: RefCandidate[]; max?: number },
    ask: <T>(schema: unknown, o: { name: string; description: string; system: string; user: string }) => Promise<T>,
): Promise<(RefCandidate & { why: string })[]> {
    const max = typeof args.max === 'number' && Number.isFinite(args.max) && args.max > 0 ? Math.floor(args.max) : 6;
    if (!args.candidates.length) return [];
    const byKey = new Map(args.candidates.map((c) => [normalizeKey(c.citation), c]));
    const user = [
        '## 논문 설계',
        args.thesis,
        '',
        '## 장별 주장',
        ...args.claims.slice(0, 40).map((c) => `- ${c}`),
        '',
        '## 후보 (확보한 원문에서 뽑은 것)',
        ...args.candidates.slice(0, 60).map((c, i) => `${i + 1}. [${c.kind}] ${c.citation}${c.from ? `  ← ${c.from.slice(0, 50)}` : ''}`),
        '',
        `꼭 읽어야 할 것을 최대 ${max}개 고른다.`,
    ].join('\n');
    try {
        const out = await ask<{ picks: { citation: string; kind: RefCandidate['kind']; why: string }[] }>(RefPickList, {
            name: 'ref_pick',
            description: '확보한 원문의 참조판례·참고문헌 중 이 논문에 필요한 것을 고른다',
            system: PICK_PROMPT,
            user,
        });
        const picked: (RefCandidate & { why: string })[] = [];
        for (const p of out.picks ?? []) {
            const c = byKey.get(normalizeKey(p.citation));
            if (!c || picked.some((x) => x.citation === c.citation)) continue;
            picked.push({ ...c, why: p.why });
            if (picked.length >= max) break;
        }
        return picked;
    } catch (e) {
        // 실패는 호출자에게 — "고를 것 없음"과 구별해야 한다.
        throw e;
    }
}

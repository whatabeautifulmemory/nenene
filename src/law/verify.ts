// 인용 검증 — LLM 이 아니라 원문 대조로 판정한다.
//
// 이것이 이 파이프라인의 유일한 hard gate 다. adversarial review 는 인용 날조를 걸러내지
// 못한다: 회의론자도 같은 모델이고, 없는 판례를 "없어 보인다"고 말할 근거가 없다. 그래서
// 인용은 모델 밖에서 결정한다 — 파일이 있으면 실재하고, 없으면 없다.
//
// 판정이 넷으로 갈리는 이유:
//   not_found        사건번호가 인덱스에 없다        → 없는 판례 (또는 번호 오기)
//                    다른 법원의 판결로만 있다       → 인용한 그 판결은 코퍼스에 없다 (note 에 「법원 불일치」)
//   date_mismatch    사건번호는 있는데 선고일이 다르다 → 실재하는 판례, 날짜만 틀림
//   article_missing  법령은 있는데 그 조문이 없다      → 개정으로 삭제됐거나 조번호 오기
//   verified         원문에서 확인
// 이 넷은 서로 다른 사건이고, 대응도 다르다. 하나로 뭉개면 "날짜를 잘못 쓴 좋은 인용"이
// "없는 판례"와 같이 취급되어 논문에서 통째로 사라진다.
//
// 단서(note)가 붙는 verified 도 있다 — 대조한 원문의 한계를 필자가 알아야 한다:
//   시행 전 판본(공포 …, 시행 …)과 대조   legalize-kr HEAD 의 판본이 아직 시행 전이다(직전 판본을 받지 못함)
//   현행 판본(시행 …)과 대조. 공포된 개정…  시행 중인 직전 판본을 GitHub 이력에서 받아 그것과 대조했다
//   코퍼스 선고일 미상                       판례 파일의 선고일이 0000-00-00 이라 법원·사건번호로만 정했다
// 폐지 기록뿐인 법령(폐지 스텁)은 조문이 없다고 단정하지 않고 unverifiable 이다.
// 원문이 이 컴퓨터에 없고 GitHub 접근을 허용하지 않았으면(legalize 의 로컬만) 그 인용도 unverifiable 이다 — 없는 법령·조문·판례가 아니다
// (목록만으로 드러나는 판례의 선고일·법원 불일치는 원문 없이도 그대로 date_mismatch·not_found 다).
import {
    LegalizeOffline,
    UNKNOWN_DATE,
    articleNosIn,
    caseNosOfPart,
    courtCovered,
    findPrecedent,
    getArticle,
    getLawDoc,
    getPrecedent,
    isRepealStub,
    legalizeConsent,
    normalizeLawName,
    precedents,
    prefetchInForce,
    repealNote,
    resolveLawPath,
    versionedLawDoc,
    type PrecHit,
} from './legalize.ts';
import type { Authority, CitationCheck } from '../schemas.ts';
import { record } from '../trace.ts';

const COURT_WORDS = ['대법원', '헌법재판소', '헌재', '고등법원', '지방법원', '특허법원', '가정법원', '행정법원', '회생법원'];

/** "대법원 2022. 6. 30. 선고 2022도1452 판결" → { court, date, caseNo } */
export function parsePrecedentCitation(citation: string): { court?: string; date?: string; caseNo: string } | null {
    // 사건번호: 2022도1452 · 2018헌바1234 · 2020마1234 · 2019헌마1
    const caseNo = /(?:\b(\d{4})\s*|(?<!\d)([6-9]\d))(?![년월일건명차조항호])([가-힣]{1,3})\s*(\d+)\b/.exec(citation);
    if (!caseNo) return null;
    const num = `${caseNo[1] ?? caseNo[2]}${caseNo[3]}${caseNo[4]}`;
    const dateM = /(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})\s*\./.exec(citation);
    const date = dateM
        ? `${dateM[1]}-${String(Number(dateM[2])).padStart(2, '0')}-${String(Number(dateM[3])).padStart(2, '0')}`
        : undefined;
    const word = COURT_WORDS.map((w) => (citation.includes(w) ? w : '')).find(Boolean);
    // "2004헌마644" 처럼 번호만 적어도 '헌' 부호는 헌법재판소다. 법원명이 없다고 대법원 코퍼스에서
    // 찾아 not_found(차단)로 떨어뜨리면 안 된다 — decisions.ts 와 같은 판단이어야 한다.
    const court = word ? (word === '헌재' ? '헌법재판소' : word) : /^헌/.test(caseNo[3]!) ? '헌법재판소' : undefined;
    return {
        caseNo: num,
        ...(date ? { date } : {}),
        ...(court ? { court } : {}),
    };
}

/** "「형사소송법」 제215조" → { law: '형사소송법', articles: ['제215조'] } */
export function parseStatuteCitation(citation: string): { law: string; articles: string[] } | null {
    const articles = articleNosIn(citation);
    if (!articles.length) return null;
    const firstArticleAt = citation.search(/제?\s*\d+\s*조/);
    let head = citation.slice(0, firstArticleAt).trim();
    head = head.replace(/[「」『』]/g, '').replace(/[,\s]+$/, '').trim();
    // "같은 법", "동법", "위 법" 은 스스로 법령명이 아니다 — 추측하지 않는다.
    if (!head || /^(같은|동|위)\s*법$/.test(head)) return { law: '', articles };
    // "대법원 2022. 6. 30. 선고 2022도1452 판결" 처럼 판례 인용이 섞인 경우 법령명이 아니다.
    // 다만 "헌법재판소법"·"법원조직법"처럼 법원 이름으로 시작하는 **법령명**은 법령이다.
    if (COURT_WORDS.some((w) => head.startsWith(w)) && !/(?:법|법률|시행령|시행규칙|규칙)$/.test(head)) return { law: '', articles };
    return { law: normalizeLawName(head), articles };
}

/**
 * 줄인 법원 이름(「서울고법」「수원지법 성남지원」)의 **자리** — 본원·고등법원이 있는 지명(옛 서울민사·형사지법 포함)과 지원 이름. 이 지명 + 지법·고법·행법·가법만
 * 줄인 법원으로 본다. 아무 글자 뒤의 「…지법」「…행법」을 법원으로 보던 때는 법률 이름(「경찰관직무집행법」「민사집행법」「테러방지법」, 「…보호법」 꼴도)이
 * 법원이 됐고, 그래서 날짜·「선고」·사건번호 **바로 앞**일 때만 세게 하자 「대구지법, 2010. …」「서울고법 제2형사부 …」「서울고법(2010. …)」「서울북부지법 형사1부 …」 의
 * 법원이 사라져 코퍼스 검증(verifyAuthority)이 **다른 법원의 판결**을 그 판결로 확인했다(법원 대조가 사건번호·날짜만 남는다). 지명 목록이면 뒤에 쉼표·재판부·괄호가
 * 오든 끝이든 법원이고, 법률 이름은 어느 지명도 아니다. 온 이름(…고등법원·지방법원·행정법원·가정법원·회생법원·특허법원)은 법원 종류 낱말로 안다.
 * 지원 이름도 그 자체로 자리다(「마산지법」 같은 옛 법원 이름) — 「…지원」 자리에서만 보던 때는 「마산지법 2010. …」 이 법원 없는 인용이 되어 법원 대조가 빠지고
 * 같은 사건번호의 다른 법원(창원지방법원) 판결이 그 판결로 확인됐다.
 * 「중앙」 도 자리다(「중앙지법」 은 서울중앙지법의 흔한 줄임) — 없던 때는 「중앙지법 … 2099노8」 이 법원 없는 인용이 되어 서울북부지방법원의 판결이 그 판결로 들어왔다.
 * 앞에 지명 없는 「<지원>지원」(「성남지원 2010. …」「진주지원, …」)도 법원이다 — 「X지법 Y지원」 꼴만 보던 때는 법원 없는 인용이 되어 사건번호·날짜만 맞는
 * 다른 법원(서울북부지방법원)의 판결이 그 판결로 확인됐다.
 */
const COURT_SEAT = '서울\\s?(?:중앙|동부|남부|북부|서부|민사|형사)?|중앙|의정부|인천|수원|춘천|대전|청주|대구|부산|울산|창원|광주|전주|제주';
const COURT_BRANCH =
    '성남|여주|안산|안양|평택|고양|부천|남양주|강릉|원주|속초|영월|천안|홍성|공주|논산|서산|충주|제천|영동|안동|경주|포항|김천|상주|의성|영덕|서부|동부|남부|북부|의정부|마산|진주|통영|밀양|거창|목포|장흥|순천|해남|군산|정읍|남원|가정';
/**
 * 지원의 본원(지방법원 자리) — 앞에 지명 없이 적은 「성남지원」 은 그 지원이나 본원(수원지방법원)의 판결만 그 판결일 수 있다. 「동부지원」「서부지원」 은
 * 본원 없이는 어느 쪽인지 모른다 — 그런 지원을 둔 본원(부산·대구) 어느 것과도, 옛 서울지방법원의 동부·서부지원(오늘의 서울동부·서울서부지방법원, sameCourt)과도
 * 맞는다고 본다. 울산·제주는 지원이 없다.
 * 옛 서울지방법원의 남부·북부·의정부지원은 오늘의 지방법원으로 맞춘다(courtKey).
 */
const BRANCH_PARENT: Record<string, string[]> = {
    ...Object.fromEntries(['성남', '여주', '평택', '안산', '안양'].map((b) => [b, ['수원']])),
    ...Object.fromEntries(['고양', '남양주'].map((b) => [b, ['의정부']])),
    부천: ['인천'],
    ...Object.fromEntries(['강릉', '원주', '속초', '영월'].map((b) => [b, ['춘천']])),
    ...Object.fromEntries(['천안', '홍성', '공주', '논산', '서산'].map((b) => [b, ['대전']])),
    ...Object.fromEntries(['충주', '제천', '영동'].map((b) => [b, ['청주']])),
    ...Object.fromEntries(['안동', '경주', '포항', '김천', '상주', '의성', '영덕'].map((b) => [b, ['대구']])),
    서부: ['대구', '부산'],
    동부: ['부산'],
    ...Object.fromEntries(['마산', '진주', '통영', '밀양', '거창'].map((b) => [b, ['창원']])),
    ...Object.fromEntries(['목포', '장흥', '순천', '해남'].map((b) => [b, ['광주']])),
    ...Object.fromEntries(['군산', '정읍', '남원'].map((b) => [b, ['전주']])),
};
const BARE_BRANCH = [...Object.keys(BRANCH_PARENT), '남부', '북부', '의정부'].join('|');
/**
 * 옛 서울지방법원의 지원을 붙여 쓴 이름(「서울동부지원」「서울남부지원」「서울의정부지원」) — 본원(서울)을 단 지원이라 엄격하다(courtKey 가 오늘의 법원으로 맞춘다).
 * 맨 지원 이름 자리(앞에 한글 없음)만 보던 때는 「서울동부지원 … 2099노42」 가 법원 없는 인용이 되어 같은 사건번호의 부산지방법원 동부지원 판결이 그 판결로 들어왔다(8차 뒤따름 K8.10).
 */
const SEOUL_OLD_BRANCH = '서울\\s?(?:동부|서부|남부|북부|의정부)지원';
const COURT_RE = new RegExp(
    `대법원|헌법재판소|헌재|[가-힣]{0,8}(?:고등|지방|행정|가정|회생|특허)법원(?:\\s*[가-힣]{2,4}지원)?|(?<![가-힣])(?:${COURT_SEAT}|${COURT_BRANCH})(?:지법|고법|행법|가법)(?:\\s*(?:${COURT_BRANCH})지원)?|(?<![가-힣])${SEOUL_OLD_BRANCH}|(?<![가-힣])(?:${BARE_BRANCH})지원`,
    'g',
);
const CASE_NO_AT = /(?:\b\d{4}\s*|(?<!\d)[6-9]\d)(?![년월일건명차조항호])[가-힣]{1,3}\s*\d+\b/;

/**
 * 덧말로 적힌 법원인가 — 「원심」「원심인」「원심:」「원심법원」「원심판결」 바로 뒤의 법원, 그리고 다른 법원 이름 바로 뒤 괄호 속의 법원(「대법원(원심 서울고법)」).
 * 그 법원은 선고한 법원이 아니다 — 날짜 앞의 가장 가까운 법원으로 보던 때는 「대법원(원심 서울고법) 2010. …」「대법원은 원심인 서울고법의 판단을 …(2010. …」 의
 * 서울고법이 선고한 법원이 되어 대법원 판결을 버렸다. 법원 **뒤의** 괄호(「서울고법(2010. 1. 14. …)」)는 그 법원의 날짜다 — 덧말이 아니다.
 */
function courtNote(citation: string, m: RegExpMatchArray, all: RegExpMatchArray[]): boolean {
    const before = citation.slice(0, m.index!);
    // 「원심 법원인」「원심 판결」 처럼 띄어 써도 같은 말이다 — 붙여 쓴 꼴만 보던 때는 띄어 쓴 원심 법원이 선고한 법원이 되어 대법원 판결을 버렸다.
    if (/원심\s*(?:법원|판결)?(?:인|은)?\s*[:：]?\s*$/.test(before)) return true;
    const open = Math.max(before.lastIndexOf('('), before.lastIndexOf('（'));
    if (open < 0 || /[)）]/.test(before.slice(open))) return false;
    const end = before.slice(0, open).trimEnd().length;
    return all.some((o) => o !== m && o.index! + o[0].length === end);
}

/**
 * 인용이 선고한 법원으로 적은 이름 그대로(대법원·헌법재판소 포함) — **사건번호 앞의 가장 가까운** 법원 이름(사건번호가 없으면 끝 앞 — decisions.ts 는 이름만 넘긴다).
 * 맨 앞의 것을 보던 때는 「대법원 판례의 법리를 따른 수원지법 2010. … 2099노7」 의 덧말 「대법원」이 선고한 법원이 되어 머리 대조가 돌지 않았다.
 * 사건번호 뒤의 덧말(「(원심: 서울고법 2009노100)」)과 원심 덧말(courtNote)은 선고한 법원이 아니다. 사건번호 앞에 법원이 없으면 맨 앞의 것.
 */
export function citedCourtIn(citation: string): string | undefined {
    const at = CASE_NO_AT.exec(citation)?.index ?? citation.length;
    const all = [...citation.matchAll(COURT_RE)];
    // 법원이 덧말뿐이면 그 법원이 인용한 판결의 법원이다(「원심인 서울중앙지법 … 2099노11」 은 원심 판결 그 자체를 인용한다) — 덧말을 다 빼던 때는
    // 법원 없는 인용이 되어 법원 대조가 빠지고, 사건번호·날짜만 맞는 다른 법원(서울동부·서울북부)의 판결이 그 판결로 들어왔다.
    const notes = all.filter((m) => courtNote(citation, m, all));
    const named = notes.length < all.length ? all.filter((m) => !notes.includes(m)) : all;
    const m = named.filter((x) => x.index! + x[0].length <= at).at(-1) ?? named[0];
    return m && withSeat(citation, m);
}

/**
 * 지명을 띄어 앞에 둔 지원·서울 줄임(「부산 서부지원」「부산 동부지법」)은 그 지명의 법원이다 — 앞에 한글 없는 맨 이름만 지원의 본원표·서울의 줄임으로 본다.
 * 바로 앞 글자만 보던 때는 「부산 동부지법」 이 서울동부지방법원, 「부산 서부지원」 이 본원 모를 서부지원(대구 서부지원과도 맞는다)이 되어 다른 법원의 판결이 들어왔다.
 * 지원은 「부산지방법원 서부지원」 으로, 지법은 지명을 붙여(「부산동부지방법원」 — 서울동부와 다르고 부산지방법원과는 지명의 앞부분이 같다) 넘긴다.
 */
const SEAT_BEFORE = /(?<![가-힣])(서울|의정부|인천|수원|춘천|대전|청주|대구|부산|울산|창원|광주|전주|제주)\s+$/;
function withSeat(citation: string, m: RegExpMatchArray): string {
    const name = m[0];
    const seat = SEAT_BEFORE.exec(citation.slice(0, m.index!))?.[1];
    if (!seat) return name;
    if (new RegExp(`^(?:${BARE_BRANCH})지원$`).test(name)) return `${seat}지방법원 ${name}`;
    if (/^(?:중앙|동부|남부|북부|서부)(?:지법|지방법원)$/.test(name)) return `${seat} ${name}`;
    return name;
}

/**
 * 인용에 적힌 법원 이름 그대로 — "서울고등법원", "수원지방법원 성남지원", "서울중앙지법", "대법원"(citedCourtIn). 헌법재판소는 코퍼스의 법원과 가르지 않는다(undefined).
 * decisions.ts citedLowerCourt 와 같은 잣대.
 */
function citedCourtName(citation: string): string | undefined {
    const c = citedCourtIn(citation);
    return c && !/^(?:헌법재판소|헌재)$/.test(c) ? c : undefined;
}

/** 법원 이름을 온 이름으로(공백을 빼고 「지법·고법·행법·가법」을 풀어서) — 줄인 이름과 온 이름을 같은 글자로 맞춰 본다. */
export const fullCourt = (c: string) =>
    c
        .replace(/\s+/g, '')
        .replace(/지법/g, '지방법원')
        .replace(/고법/g, '고등법원')
        .replace(/행법/g, '행정법원')
        .replace(/가법/g, '가정법원');

/**
 * 대조할 법원 이름 — 온 이름(fullCourt)에 서울의 옛 이름·줄임을 오늘의 법원으로 맞춘다.
 *  · 옛 「서울지방법원」 은 본원만 오늘의 서울중앙지방법원이다. 그 지원(남부·북부·동부·서부지원)은 오늘의 서울남부·북부·동부·서부지방법원,
 *    의정부지원은 의정부지방법원이다 — 「서울」 을 지명의 앞부분으로만 보던 때는 「서울지법 남부지원」 이 서울중앙지방법원 판결과 맞았다.
 *    앞에 지명 없는 「남부지원」「북부지원」「의정부지원」 도 그 옛 지원뿐이다(다른 본원에는 그런 지원이 없다). 「동부지원」「서부지원」 은 BRANCH_PARENT 와 옛 서울 지원 둘 다로 본다(sameCourt).
 *  · 앞에 지명 없는 「중앙·동부·남부·북부·서부지법(지방법원)」 은 서울의 그 지방법원이다 — 「북부」 를 서울북부의 앞부분으로 보지 못하던 때는 맞는 「북부지법」 인용이 늘 막혔다.
 */
const courtKey = (name: string): string => {
    const c = fullCourt(name)
        .replace(/^서울(?:지방법원)?(남부|북부|동부|서부)지원$/, '서울$1지방법원')
        .replace(/^(?:서울지방법원)?(남부|북부)지원$/, '서울$1지방법원')
        .replace(/^서울(?:지방법원)?의정부지원$|^의정부지원$/, '의정부지방법원')
        .replace(/^(중앙|동부|남부|북부|서부)지방법원/, '서울$1지방법원');
    return c === '서울지방법원' ? '서울중앙지방법원' : c;
};

/**
 * 인용의 법원과 코퍼스 판례의 법원이 같은 법원일 수 있는가. 대법원·하급심이 갈리면 다르다. 하급심은 법원 종류(고등·지방…)가 같고
 * 지명이 한쪽의 앞부분이면 같다고 본다 — 지명 없이 "고등법원"만 쓴 인용은 가르지 않는다. 서울의 옛 이름·줄임은 courtKey 로 오늘의 법원에 맞춘다.
 * 앞에 지명 없는 「성남지원」 은 같은 지원을 단 법원이나 그 본원(BRANCH_PARENT)과만 같다 — 그 밖은 다른 법원이다.
 */
function sameCourt(cited: string, found: string): boolean {
    const c = courtKey(cited);
    const f = courtKey(found);
    if (c === f) return true;
    if ((c === '대법원') !== (f === '대법원')) return false;
    const parts = (x: string) => /^([가-힣]*?)(고등|지방|행정|가정|회생|특허)법원(?:([가-힣]{2,4})지원)?$/.exec(x);
    const bare = (x: string) => /^([가-힣]{2,3})지원$/.exec(x)?.[1];
    const bc = bare(c);
    const bf = bare(f);
    if (bc || bf) {
        if (bc && bf) return false; // 둘 다 지원 이름뿐이고 글자가 다르다
        const branch = (bc ?? bf)!;
        const other = parts(bc ? f : c);
        if (!other) return true; // 모르는 이름은 가르지 않는다
        const parents = BRANCH_PARENT[branch] ?? [];
        if (other[3]) return other[3] === branch && (!parents.length || !other[1] || parents.includes(other[1]));
        // 본원 없는 「동부지원」「서부지원」 은 옛 서울지방법원 동부·서부지원(오늘의 서울동부·서울서부지방법원)일 수도 있다 — 본원표(부산·대구)만 보던 때는
        // 옛 「동부지원」 인용이 서울동부지방법원 판결과 맞지 않았다(8차 K8.10). 지명을 띄어 앞에 둔 「부산 동부지원」 은 withSeat 가 본원을 붙여 여기 오지 않는다.
        if ((branch === '동부' || branch === '서부') && other[2] === '지방' && other[1] === `서울${branch}`) return true;
        return other[2] === '지방' && parents.includes(other[1]!);
    }
    const pc = parts(c);
    const pf = parts(f);
    if (!pc || !pf) return true; // 모르는 이름은 가르지 않는다
    if (pc[2] !== pf[2]) return false;
    if (pc[3] && pf[3] && pc[3] !== pf[3]) return false;
    return !pc[1] || !pf[1] || pc[1].startsWith(pf[1]) || pf[1].startsWith(pc[1]);
}

/**
 * 인용의 법원과 **다른 법원**의 판결인가 — 다르면 인용한 법원 이름, 같거나 가를 수 없으면(인용에 법원이 없다) undefined.
 * 사다리(sources.ts)가 캐시·웹에서 받은 판결문에 verifyAuthority 와 같은 잣대를 대는 데 쓴다.
 */
export function courtConflict(citation: string, found: string): string | undefined {
    const cited = citedCourtName(citation);
    return cited && found && !sameCourt(cited, found) ? cited : undefined;
}

/**
 * 판결문 머리의 법원 — 그 사건번호 바로 앞의 「<법원> 2010. 1. 14. 선고」(코퍼스 제목은 「대법원 2010-01-14 선고 …」).
 * 원심을 적은 「원심판결 서울고등법원 … 선고 2009노…」는 사건번호가 달라 걸리지 않는다. 못 찾으면 undefined.
 */
export function decisionCourtIn(text: string, caseNo: string): string | undefined {
    const no = caseNo.replace(/^(\d+)([가-힣]+)(\d+)$/, '$1\\s*$2\\s*$3');
    const court = '(대법원|[가-힣]{0,8}(?:고등|지방|행정|가정|회생|특허)법원(?:\\s*[가-힣]{2,4}지원)?|[가-힣]{2,6}(?:지법|고법|행법|가법)(?:\\s*[가-힣]{2,4}지원)?)';
    const date = '(?:\\d{4}\\s*[.-]\\s*\\d{1,2}\\s*[.-]\\s*\\d{1,2}\\s*\\.?\\s*)?';
    return new RegExp(`${court}\\s*${date}(?:선고|자)?\\s*${no}(?!\\d)`).exec(text)?.[1];
}

/**
 * 인용이 가리키는 판례 파일 — 사건번호로 찾고, 같은 번호가 여러 법원에 있으면(하급심 2010노361 은 부산지법·의정부지법에 다 있다)
 * 인용한 법원의 것, 그 안에서 선고일이 맞는 것. 날짜로 먼저 좁히지 않는다 — 날짜만 맞는 다른 법원의 판결을 집지 않게.
 */
function pickPrecedent(p: { caseNo: string; date?: string; court?: string }, citation: string): { hit: PrecHit; court?: string } | null {
    // 파일 이름의 숫자만 있는 칸으로 맞춘 것(partial)은 원문 머리의 사건번호로 확인한다 — 판례일련번호(「91도2241_601693」 의 601693)를
    // 이어 쓴 사건번호(91도601693)로 읽어 다른 판결을 그 판결로 집지 않게. 못 읽으면 남겨 둔다(검증이 원문 읽기 실패로 알린다).
    const hits = findPrecedent({ caseNo: p.caseNo, ...(p.court ? { court: p.court } : {}) }).filter((h) => !h.partial || caseNoConfirmed(h.path, p.caseNo));
    if (!hits.length) return null;
    const court = citedCourtName(citation);
    const same = court ? hits.filter((h) => sameCourt(court, h.court)) : [];
    const pool = same.length ? same : hits;
    // 선고일이 맞는 것, 없으면 선고일을 아는 것(→ date_mismatch), 그래도 없을 때만 선고일을 모르는 것(0000-00-00 — 틀렸다고 할 수 없다).
    // 미상 파일을 날짜를 아는 파일보다 먼저 고르던 때는, 같은 법원·사건번호를 날짜를 아는 파일로도 가진 사건(대법원 2018두53238 — 2022-10-27 과 0000-00-00)에서
    // 틀린 날짜가 미상 파일로 verified 됐다. 코퍼스가 그 사건의 선고일을 알면 그 날짜와 견준다 — 미상은 날짜를 모를 때만이다(L6b).
    const known = pool.filter((h) => h.date !== UNKNOWN_DATE);
    return { hit: (p.date && pool.find((h) => h.date === p.date)) || known[0] || pool[0]!, ...(court ? { court } : {}) };
}

/** 판례 원문 머리의 사건번호 필드(「92다39334, 39341(병합)」)가 이 사건번호를 통째로 담는가. 필드가 없거나 못 읽으면 가르지 않는다(true). */
function caseNoConfirmed(path: string, caseNo: string): boolean {
    try {
        const field = getPrecedent(path).meta['사건번호'];
        return !field || caseNosOfPart(field).some((x) => x.no === caseNo);
    } catch {
        return true;
    }
}

export function verifyAuthority(a: Authority): CitationCheck {
    if (a.type === 'precedent') {
        const p = parsePrecedentCitation(a.citation);
        if (!p) return { citation: a.citation, type: a.type, state: 'unverifiable', note: '사건번호를 찾지 못함' };
        if (!courtCovered(p.court)) {
            return {
                citation: a.citation,
                type: a.type,
                state: 'unverifiable',
                note: `이 코퍼스에는 ${p.court} 결정이 수록되어 있지 않습니다(대법원·하급심만). 실재 여부를 판정할 수 없습니다.`,
            };
        }
        const picked = pickPrecedent(p, a.citation);
        if (!picked) {
            return {
                citation: a.citation,
                type: a.type,
                state: 'not_found',
                // 건수는 지금 읽은 인덱스에서 센다 — 박아 둔 숫자는 받을 때마다 낡는다.
                note: `사건번호 ${p.caseNo} 가 legalize precedent-kr 인덱스(${precedents().length.toLocaleString()}건)에 없습니다. 다만 이 인덱스는 대법원 판례의 전부가 아니므로, "코퍼스에 없음"이지 "존재하지 않음"은 아닙니다.`,
            };
        }
        const { hit } = picked;
        // 원문은 인용문(quote)에만 쓴다 — 법원·선고일 대조는 목록으로 한다. 원문이 이 컴퓨터에 없어도(GitHub 접근을 허용하지 않음) 그 대조는 그대로 한다:
        // 원문 읽기를 대조 전체와 함께 감쌌을 때는 목록만으로 드러난 선고일·법원 불일치(차단)가 「검증 불가」로 덮여 그대로 지나갔다.
        let quote: string | undefined;
        let offline: string | undefined;
        try {
            const doc = getPrecedent(hit.path);
            quote = (doc.body.split('## 판시사항')[1] ?? doc.body).slice(0, 700).trim();
        } catch (e) {
            if (!(e instanceof LegalizeOffline)) return { citation: a.citation, type: a.type, state: 'unverifiable', note: `원문 읽기 실패: ${String(e)}` };
            offline = e.message;
        }
        // 파일 이름의 숫자 칸으로만 맞춘 것(partial)은 원문 머리로 확인해야 그 판결이다 — 원문이 없으면 확인하지 못했으니 선고일·법원도 견주지 않는다
        // (다른 판결의 날짜로 date_mismatch 를 내지 않게).
        if (offline && hit.partial) return { citation: a.citation, type: a.type, state: 'unverifiable', note: offline };
        const q = quote === undefined ? {} : { quote };
        // 법원도 대조한다 — 사건번호가 다른 법원의 판결로만 있으면 인용한 그 판결이 아니다(대법원 2009도10845 를 「서울고등법원」으로 쓴 인용).
        // 새 상태를 만들지 않고 not_found(차단)로 둔다: 각주·화면이 아는 상태이고, 인용한 법원의 판결이 코퍼스에 없다는 것은 사실이다.
        if (picked.court && !sameCourt(picked.court, hit.court)) {
            return {
                citation: a.citation,
                type: a.type,
                state: 'not_found',
                resolved: hit.path,
                ...q,
                note: `법원 불일치 — 사건번호 ${p.caseNo} 는 ${hit.court} ${hit.date} 선고로 있고, 인용한 법원(${picked.court})의 판결은 코퍼스에 없습니다.`,
            };
        }
        // 코퍼스가 선고일을 모르면(0000-00-00 — 29,180건) 날짜를 대조하지 않는다(아래에서 법원·사건번호로 정하고 그렇다고 적는다) —
        // 맞게 적은 날짜가 「선고일이 0000-00-00」 과 달라 date_mismatch(차단)가 되던 것(대법원 2008두18014).
        if (hit.date !== UNKNOWN_DATE && p.date && hit.date !== p.date) {
            return {
                citation: a.citation,
                type: a.type,
                state: 'date_mismatch',
                resolved: hit.path,
                ...q,
                note: `실재하는 판례. 다만 선고일이 ${hit.date} 이고 인용은 ${p.date} 입니다.`,
            };
        }
        // 목록으로는 맞는데 원문이 이 컴퓨터에 없다(GitHub 접근을 허용하지 않음) — 원문으로 확인하지 못했으니 검증 불가(차단 아님), 이유를 그대로 적는다
        if (offline) return { citation: a.citation, type: a.type, state: 'unverifiable', note: offline };
        if (hit.date === UNKNOWN_DATE) {
            return { citation: a.citation, type: a.type, state: 'verified', resolved: hit.path, ...q, note: '코퍼스 선고일 미상 — 날짜는 대조하지 못함' };
        }
        return { citation: a.citation, type: a.type, state: 'verified', resolved: hit.path, ...q };
    }

    if (a.type === 'statute') {
        const s = parseStatuteCitation(a.citation);
        if (!s) return { citation: a.citation, type: a.type, state: 'unverifiable', note: '조번호를 찾지 못함' };
        if (!s.law) {
            return { citation: a.citation, type: a.type, state: 'unverifiable', note: '"같은 법" 등 지시 표현이라 법령명을 특정할 수 없음' };
        }
        const chosen = getLawDoc(s.law);
        // 원문이 이 컴퓨터에 없다(GitHub 접근을 허용하지 않음) — 법령은 목록에 있으므로 not_found 가 아니다. 차단하지 않는다.
        if ('error' in chosen && chosen.offline) return { citation: a.citation, type: a.type, state: 'unverifiable', note: chosen.error };
        if ('error' in chosen) {
            return {
                citation: a.citation,
                type: a.type,
                state: 'not_found',
                note: [chosen.error, chosen.suggestions?.length ? `후보: ${chosen.suggestions.join(', ')}` : ''].filter(Boolean).join(' — '),
            };
        }
        // 대조할 판본 — 시행 전이면 캐시해 둔 직전(현행) 판본, 없으면 시행 전 판본 그대로(그렇다고 note 에 적는다).
        const v = versionedLawDoc(chosen);
        const doc = v.doc;
        const at = `${doc.path}${v.sha ? `@${v.sha.slice(0, 7)}` : ''}`;
        const withVersion = (n: string) => [n, v.note].filter(Boolean).join(' — ');
        // 폐지 기록만 남은 법령 — 조문이 「없다」(article_missing)가 아니라 대조할 본문이 없다. 차단하지 않는다.
        if (isRepealStub(doc.body)) {
            return { citation: a.citation, type: a.type, state: 'unverifiable', resolved: at, note: withVersion(repealNote(doc)) };
        }
        const found = s.articles.map((no) => ({ no, art: getArticle(doc, no) }));
        const missing = found.filter((f) => !f.art);
        if (missing.length) {
            // 직전 판본에는 없고 공포된 개정(시행 전)에만 있는 조문이면 그렇다고 적는다 — 아직 효력이 없는 조문이다.
            const later = v.pending ? missing.filter((m) => getArticle(v.pending!, m.no)).map((m) => m.no) : [];
            return {
                citation: a.citation,
                type: a.type,
                state: 'article_missing',
                resolved: at,
                quote: found.find((f) => f.art)?.art?.text.slice(0, 400),
                note: withVersion(
                    `${doc.name} 에 ${missing.map((m) => m.no).join(', ')} 가 없습니다 (개정으로 삭제됐거나 조번호 오기).${later.length ? ` ${later.join(', ')} 는 공포된 개정(시행 ${v.pending!.meta['시행일자']})에만 있음 — 아직 시행 전.` : ''}`,
                ),
            };
        }
        return {
            citation: a.citation,
            type: a.type,
            state: 'verified',
            resolved: `${at} ${found.map((f) => f.no).join(', ')}`,
            quote: found.map((f) => f.art!.text).join('\n\n').slice(0, 900),
            ...(v.note ? { note: v.note } : {}),
        };
    }

    return { citation: a.citation, type: a.type, state: 'unverifiable', note: '원문 코퍼스가 없는 인용 종류' };
}

/**
 * 검증 전에 기다릴 수 있는 자리(인용 확보·보강·재검증)에서 부른다 — 시행 전 법령의 직전(현행) 판본을 받아 캐시한다(prefetchInForce).
 * verifyAuthority 는 동기라 받지 않고 캐시만 읽는다. 던지지 않는다: 받지 못한 것은 failed 로 돌려주고, 검증은 시행 전 판본 표시로 한다.
 */
export async function prefetchStatutes(authorities: Authority[], opts: { signal?: AbortSignal } = {}): Promise<{ citation: string; state: string; requests: number; error?: string }[]> {
    const out: { citation: string; state: string; requests: number; error?: string }[] = [];
    if (!legalizeConsent()) return out; // 동의가 없으면 법령명을 풀 필요도 없다
    for (const a of authorities) {
        if (a.type !== 'statute') continue;
        try {
            const s = parseStatuteCitation(a.citation);
            const path = s?.law ? resolveLawPath(s.law) : null;
            if (!path) continue;
            out.push({ citation: a.citation, ...(await prefetchInForce(path, opts)) });
        } catch (e) {
            out.push({ citation: a.citation, state: 'failed', requests: 0, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
        }
    }
    return out;
}

export function verifyAll(authorities: Authority[]): CitationCheck[] {
    return authorities.map((a) => {
        const started = Date.now();
        const r = verifyAuthority(a);
        record({
            kind: 'verify',
            name: r.state,
            subject: a.citation,
            ok: r.state === 'verified',
            ms: Date.now() - started,
            ...(r.note ? { detail: r.note.slice(0, 200) } : {}),
            ...(r.resolved ? { input: r.resolved } : {}),
        });
        return r;
    });
}

export interface ResolvedDocument {
    /** 사람이 읽을 출처 표시 */
    provenance: string;
    title: string;
    /** 원문 전체 — 관련 부분 추출의 입력이 된다 */
    body: string;
}

/**
 * 법령·판례의 **원문 전체**를 돌려준다. verifyAuthority 와 같은 해석 경로를 쓰되, 인용 검증에
 * 필요한 700자 발췌가 아니라 전문을 준다 — 논문 인용은 전문에서 관련 부분을 뽑아 써야 하고,
 * 발췌는 그 추출을 하기 전에 이미 잘라 버린 것이다.
 */
export function resolveDocument(a: Authority): ResolvedDocument | null {
    if (a.type === 'precedent') {
        const p = parsePrecedentCitation(a.citation);
        if (!p) return null;
        const picked = pickPrecedent(p, a.citation);
        if (!picked) return null;
        // verifyAuthority 와 같은 판단 — 인용한 법원의 판결이 코퍼스에 없으면 원문도 없다. 다른 법원의 판결을 전문(full_text)으로 주면
        // 검증은 not_found(법원 불일치)인데 사다리는 그 판결을 근거로 읽혔다.
        const { hit } = picked;
        if (picked.court && !sameCourt(picked.court, hit.court)) return null;
        try {
            const doc = getPrecedent(hit.path);
            return { provenance: hit.path, title: `${doc.court} ${doc.date === UNKNOWN_DATE ? '(선고일 미상)' : doc.date} 선고 ${doc.caseNo}`, body: doc.body };
        } catch {
            return null;
        }
    }
    if (a.type === 'statute') {
        const s = parseStatuteCitation(a.citation);
        if (!s || !s.law) return null;
        const chosen = getLawDoc(s.law);
        if ('error' in chosen) return null;
        // verifyAuthority 와 같은 판본 — 검증은 현행 판본으로 하고 근거 원문은 시행 전 판본을 주면 둘이 어긋난다.
        const v = versionedLawDoc(chosen);
        const doc = v.doc;
        const arts = s.articles.map((no) => getArticle(doc, no)).filter(Boolean);
        if (!arts.length) return null;
        return {
            provenance: `${doc.path}${v.sha ? `@${v.sha.slice(0, 7)}` : ''} ${arts.map((x) => x!.no).join(', ')}`,
            title: `${doc.name} ${arts.map((x) => x!.heading).join('; ')}`,
            body: arts.map((x) => x!.text).join('\n\n'),
        };
    }
    return null;
}

/**
 * 반대측·판정자에게 주는 **원문 발췌**. 찬성측의 해석이 아니라 원문만 준다 —
 * 이 비대칭이 기존 구현 의 "회의론자는 한 줄 주장과 여섯 개 필드만 본다"에 대응한다.
 */
export function sourcePack(checks: CitationCheck[], perItem = 700): string {
    return checks
        .filter((c) => c.quote)
        .map((c) => `### ${c.citation} — ${c.state}\n${c.quote!.slice(0, perItem)}`)
        .join('\n\n');
}

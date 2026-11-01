// 판례 검색 인덱스.
//
// 왜 필요한가: 이 앱은 12.5만 건의 판례를 가지고 있으면서 **찾지 못했다**. 인용은 모델이
// 떠올린 사건번호로만 이루어졌고, 그게 틀리면 "코퍼스에 없음"이 될 뿐이었다. 조문은 지목해서
// 가져오는 경로가 있었지만(planner.provisions) 판례에는 그런 경로가 없었다.
//
// 인덱스는 사건명·판시사항·판결요지를 담는다. 전문은 담지 않는다 — 검색은 요지로 하고,
// 인용이 결정되면 그때 전문을 읽는다.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = () => join(CLONES(), 'precedent-kr');
import { CACHE, CLONES } from './legalize.ts';

export interface CaseHit {
    path: string;
    caseNo: string;
    name: string;
    court: string;
    date: string;
    /** 판시사항 (짧게) */
    summary: string;
    score: number;
}

interface Row {
    p: string;
    n: string; // 사건번호
    t: string; // 사건명
    c: string; // 법원
    d: string; // 선고일
    s: string; // 판시사항
    j?: string; // 판결요지
}

export const INDEX_PATH = () => join(CACHE(), 'case-index.jsonl');

const FIELD = (text: string, key: string) => text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.replace(/^['"]|['"]$/g, '').trim() ?? '';

function section(text: string, head: string): string {
    const m = text.match(new RegExp(`##\\s*${head}\\s*\\n+([\\s\\S]*?)(?=\\n##\\s|$)`));
    return (m?.[1] ?? '').replace(/\s+/g, ' ').trim();
}

/** 한 문서에서 색인 행을 뽑는다. */
function rowOf(path: string, text: string): Row {
    return {
        p: path,
        n: FIELD(text, '사건번호'),
        t: FIELD(text, '사건명') || section(text, '사건명'),
        c: FIELD(text, '법원명'),
        d: FIELD(text, '선고일자'),
        s: section(text, '판시사항').slice(0, 400),
        j: section(text, '판결요지').slice(0, 1200),
    };
}

/**
 * 인덱스 구축. `git cat-file --batch` 로 한 번에 읽는다 — 문서마다 git 을 부르면 12만 번
 * 프로세스를 띄우게 된다.
 */
export async function buildIndex(opts: { prefix?: string; onProgress?: (done: number, total: number) => void } = {}): Promise<{ rows: number; path: string }> {
    const paths = readFileSync(join(CACHE(), 'precedent-index.txt'), 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((p) => p.endsWith('.md') && (!opts.prefix || p.startsWith(opts.prefix)));

    // 스트리밍으로 읽는다. 12.5만 건을 한 번에 버퍼에 올리면 500MB 가 필요하고, 디스크가
    // 빠듯한 기계에서는 임시파일 생성이 실패한다(실제로 그랬다).
    const child = spawn('git', ['-C', REPO(), 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'inherit'] });

    const path_ = INDEX_PATH();
    mkdirSync(CACHE(), { recursive: true });
    const out = createWriteStream(path_, { encoding: 'utf8' });

    let buffer: Buffer = Buffer.alloc(0) as Buffer;
    let i = 0;
    let rows = 0;
    let pending = '';

    const onData = (chunk: Buffer) => {
        buffer = (buffer.length ? Buffer.concat([buffer, chunk]) : chunk) as Buffer;
        for (;;) {
            const nl = buffer.indexOf(0x0a);
            if (nl < 0) break;
            const header = buffer.subarray(0, nl).toString('utf8');
            if (header.endsWith(' missing')) {
                buffer = buffer.subarray(nl + 1);
                i++;
                continue;
            }
            const size = Number(header.split(' ')[2]);
            if (!Number.isFinite(size)) {
                buffer = buffer.subarray(nl + 1);
                continue;
            }
            if (buffer.length < nl + 1 + size + 1) break; // 본문이 아직 다 안 왔다
            const body = buffer.subarray(nl + 1, nl + 1 + size).toString('utf8');
            buffer = buffer.subarray(nl + 1 + size + 1);
            const row = rowOf(paths[i] ?? '', body);
            if (row.n || row.t) {
                out.write(JSON.stringify(row) + '\n');
                rows++;
            }
            i++;
            if (opts.onProgress && i % 5000 === 0) opts.onProgress(i, paths.length);
        }
    };

    await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', onData);
        child.on('error', reject);
        child.on('close', () => resolve());
        // stdin 이 가득 차면 멈추므로 drain 을 기다린다.
        let idx = 0;
        const pump = () => {
            while (idx < paths.length) {
                const ok = child.stdin.write(`HEAD:${paths[idx]}\n`);
                idx++;
                if (!ok) {
                    child.stdin.once('drain', pump);
                    return;
                }
            }
            child.stdin.end();
        };
        pump();
    });

    await new Promise<void>((r) => out.end(r));
    return { rows, path: path_ };
}

let cache: Row[] | null = null;
/** 문서빈도. 흔한 말(금전·지급)로 걸린 남의 사건을 걸러내는 데 쓴다. */
let df: Map<string, number> | null = null;

function load(): Row[] {
    if (cache) return cache;
    const p = INDEX_PATH();
    if (!existsSync(p)) return (cache = []);
    cache = readFileSync(p, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
            try {
                return JSON.parse(l) as Row;
            } catch {
                return null;
            }
        })
        .filter((r): r is Row => Boolean(r));
    // 문서빈도 계산 — 한 번만. 12.5만 건 × 수십 토큰이라 2~3초.
    const f = new Map<string, number>();
    for (const r of cache) {
        for (const t of tokenize(`${r.t} ${r.s} ${r.j ?? ''}`)) f.set(t, (f.get(t) ?? 0) + 1);
    }
    df = f;
    return cache;
}

export const indexSize = () => load().length;

const STOP = new Set(['법', '죄', '것', '수', '등', '및', '경우', '관한', '대한', '위한', '하는', '있는', '없는', '그', '이', '저', '때']);

/**
 * 조사·어미 제거.
 *
 * 한국어 법률문은 "함정수사에 대한"처럼 조사가 붙어 있어서, 그대로 부분문자열 매칭을 하면
 * 질의어 "함정수사"가 "함정수사에"에 걸리긴 하지만 토큰 경계가 어긋나 순위가 망가진다.
 * 형태소 분석기 없이 할 수 있는 가장 값싼 개선이다.
 */
const JOSA = [
    '으로서', '으로써', '에서는', '에게서', '이라고', '라는', '이라는', '에서', '에게', '으로', '부터', '까지',
    '보다', '처럼', '라고', '하며', '하고', '한테', '께서', '이란', '란', '인', '한', '하는', '되는', '있는',
    '없는', '경우', '때문', '대해', '관해', '의', '가', '이', '은', '는', '을', '를', '에', '와', '과', '도',
    '만', '로', '나', '며', '서', '야', '요',
].sort((a, b) => b.length - a.length);

export function stem(t: string): string {
    for (const j of JOSA) {
        if (t.length > j.length + 1 && t.endsWith(j)) return t.slice(0, -j.length);
    }
    return t;
}

/**
 * 동의어. 코퍼스의 어휘와 질의의 어휘가 다를 때 검색이 통째로 실패한다 —
 * "위장수사"는 판례에서 "함정수사"로만 등장하고, "보이스피싱"은 "전기통신금융사기"가 정식 명칭이다.
 */
const SYNONYMS: Record<string, string[]> = {
    위장수사: ['함정수사', '위장'],
    함정수사: ['위장수사'],
    보이스피싱: ['전기통신금융사기', '전기통신금융'],
    전기통신금융사기: ['보이스피싱'],
    크롤링: ['스크래핑', '수집'],
    스크래핑: ['크롤링'],
    침입: ['침해'],
    침해: ['침입'],
    보호조치: ['접근권한', '보안조치'],
    접근권한: ['보호조치', '접근권'],
    랜섬웨어: ['몸값', '랜섬'],
    위장거래소: ['가상자산', '거래소'],
    개인정보: ['개인정보보호'],
    영장주의: ['압수수색', '영장'],
    압수수색: ['압수', '수색'],
};

const aliasesOf = (t: string): string[] => [t, ...(SYNONYMS[t] ?? [])];

/**
 * 사건번호 부호로 사건 유형을 판별한다.
 *
 * 형사 명제에 민사 판례가 붙는 것을 막는 결정적 필터다. 리랭커도 이건 못 막는다 —
 * 판시사항 문장이 비슷하면 "관련 있다"고 판단하기 때문이다. 부호는 추측이 아니라 사실이다.
 */
const CRIMINAL = new Set(['도', '노', '고', '모', '초', '재', '감', '인', '허', '마', '므', '드', '드합', '오']);
const CIVIL = new Set(['다', '가', '나', '카', '라', '가합', '가단', '나합', '다합', '카합', '구단', '가소']);
const ADMIN = new Set(['두', '누', '구합', '구']);

export function caseKind(caseNo: string): 'criminal' | 'civil' | 'admin' | 'other' {
    const m = /^\d{4}([가-힣]+)\d+$/.exec(caseNo.replace(/\s+/g, ''));
    if (!m) return 'other';
    const code = m[1]!;
    if (CRIMINAL.has(code)) return 'criminal';
    if (CIVIL.has(code)) return 'civil';
    if (ADMIN.has(code)) return 'admin';
    return 'other';
}

/** 한글·라틴 토큰. 2자 이상. */
export function tokenize(text: string): string[] {
    const raw = text.toLowerCase().match(/[가-힣]{2,}|[a-z][a-z0-9-]{2,}/g) ?? [];
    return [...new Set(raw.map(stem).filter((t) => t.length >= 2 && !STOP.has(t)))];
}

/**
 * 판례 검색.
 *
 * 점수는 사건명 일치에 가중치를 준다 — 판시사항은 길어서 우연히 겹치기 쉽다. 사건명이
 * "정보통신망 침입" 같은 쟁점 어휘와 맞는 것이 실제로 그 쟁점의 판례일 확률이 높다.
 */
export function searchCases(query: string, opts: { limit?: number; court?: string; maxTerms?: number; minCoverage?: number } = {}): CaseHit[] {
    const rows = load();
    if (!rows.length) return [];
    const N = rows.length;
    const idf = (t: string) => Math.log(N / (1 + (df?.get(t) ?? 0)));
    // 긴 질의(쟁점 문장)는 그대로 쓰면 커버리지를 못 넘는다. 변별력 있는 토큰 몇 개로 줄인다.
    const maxTerms = opts.maxTerms ?? 6;
    const all = tokenize(query);
    if (!all.length) return [];
    // 코퍼스에 **없는** 단어는 idf 가 최대가 되지만, 그것으로는 아무것도 못 찾는다.
    // 실제로 존재하는 단어 중 변별력 있는 것만 고른다.
    const usable = all.filter((t) => (df?.get(t) ?? 0) > 0);
    if (!usable.length) return [];
    const terms = usable.length > maxTerms ? [...usable].sort((a, b) => idf(b) - idf(a)).slice(0, maxTerms) : usable;
    const limit = opts.limit ?? 5;
    const hits: CaseHit[] = [];
    // 질의의 정보량 대비 얼마나 덮였는가. 흔한 말 몇 개로 걸린 남의 사건을 이걸로 거른다.
    const totalIdf = terms.reduce((a, t) => a + idf(t), 0) || 1;

    for (const r of rows) {
        if (opts.court && !r.c.includes(opts.court)) continue;
        const name = r.t.toLowerCase();
        const body = r.s.toLowerCase();
        const judgment = (r.j ?? '').toLowerCase();
        let score = 0;
        let matched = 0;
        let idfMatched = 0;
        let minMatchedDf = Number.POSITIVE_INFINITY;
        for (const t of terms) {
            const alts = aliasesOf(t);
            const inName = alts.some((a) => name.includes(a));
            const inBody = alts.some((a) => body.includes(a));
            // 판결요지는 가장 길어서 우연히 겹치기 쉽다 — 가중치를 낮춘다.
            const inJudgment = !inBody && alts.some((a) => judgment.includes(a));
            if (!inName && !inBody && !inJudgment) continue;
            matched++;
            idfMatched += idf(t);
            minMatchedDf = Math.min(minMatchedDf, df?.get(t) ?? 0);
            score += idf(t) * (inName ? 3 : inBody ? 1.5 : 0.7);
        }
        // 한 토큰만 걸린 문서는 버린다 — 그건 검색이 아니라 우연이다.
        // 질의가 한 토큰이면 그 하나로 충분하다. 둘 이상일 때만 "우연히 하나 걸린 것"을 거른다.
        if (terms.length >= 2 && matched < 2) continue;
        // 질의 정보량의 절반 이상을 덮어야 한다. "랜섬웨어" 없이 "금전·지급"만 걸린 민사
        // 판례는 정보량의 10% 도 못 덮는다.
        if (idfMatched / totalIdf < (opts.minCoverage ?? 0.3)) continue;
        // 질의어가 **사건명**에 하나도 안 걸리면 버린다. 사건명은 죄명·사건 유형을 담고 있어서,
        // 요지에만 스친 문서는 대개 다른 사건이다(보호조치를 논한 행정법 판례가 그랬다).
        if (!terms.some((t) => name.includes(t))) continue;
        // 걸린 토큰 중 **희귀한 것**이 하나는 있어야 한다. 흔한 말("지불"·"금전")만 맞은
        // 문서는 다른 사건이다 — 근거가 없는 것보다 나쁘다.
        if (minMatchedDf / N > 0.05) continue;
        // 대법원 판례를 우선하되 하급심도 배제하지 않는다.
        if (r.c.includes('대법원')) score *= 1.35;
        hits.push({ path: r.p, caseNo: r.n, name: r.t, court: r.c, date: r.d, summary: r.s, score });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
}

/** 사건번호로 직접 찾기 — 모델이 사건번호를 댔을 때 코퍼스에 있는지 확인한다. */
export function findByCaseNo(caseNo: string): CaseHit | null {
    const norm = caseNo.replace(/\s+/g, '');
    for (const r of load()) {
        if (r.n.replace(/\s+/g, '') === norm) return { path: r.p, caseNo: r.n, name: r.t, court: r.c, date: r.d, summary: r.s, score: 100 };
    }
    return null;
}

/**
 * 인용 문자열 만들기 — 검증기(parsePrecedentCitation)가 알아듣는 형태.
 * 날짜는 반드시 "YYYY. M. D." 형식이어야 한다. ISO(2024-12-19)로 쓰면 파서가 날짜를
 * 놓치고, 날짜 없이는 코퍼스에서 문서를 찾지 못해 인용이 조용히 사라진다.
 */
export const citationOf = (h: CaseHit) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(h.date);
    const d = m ? `${m[1]}. ${Number(m[2])}. ${Number(m[3])}.` : h.date;
    return `${h.court} ${d} 선고 ${h.caseNo} 판결`;
};

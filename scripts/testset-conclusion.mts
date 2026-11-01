// 테스트셋 결론 비교 — 원 논문에서 **입력에서 제외한** 결론(정답지)과 생성 논문의 결론을 비교한다.
//
//   정답지: testset/papers/<id>/expected.json — conclusionSection(본문 결론 절) 또는 resultSentences(초록의 결과 문장)
//   생성:   ledger.paper.thesis.position + 마지막 장(결론)의 revised/draft 앞 4,000자 (+ 포괄에는 논지도 더한다)
//
// 지표:
//   conclusionSim       생성 결론 ↔ 정답지의 2-gram Jaccard
//   conclusionCoverage  정답지 2-gram이 생성 결론(입장·마지막 장·논지)에 들어 있는 비율. 글자 2-gram은 기능어 쌍이 많아
//                       관계없는 글도 상당 부분을 덮는다 — 재현의 하한이 아니다. 그래서 다른 논문의 생성 결론으로 잰
//                       기준선(coverageBaseline)과 그 차이(coverageLift)를 함께 남긴다.
//   resultSim           생성 입장 ↔ 초록 결과 문장의 Jaccard
//   leak                연구 단계가 원 논문을 찾아왔는가 — 인용(raw·display·url)·dossier 발견·sources/ 파일에서
//                       원 제목(2-gram 80% 이상)·DOI·KCI ID·영문 제목(따옴표 안은 양쪽 대조 — 원 저자가 그 줄에 없으면 더 엄격히,
//                       따옴표가 없으면 줄 전체 80%)을 찾고,
//                       원문 초록·결론이 그대로 들어 있는지 본다(leakBy).
//                       DOI·영문 제목은 전처리가 meta.json 에 남긴 값이다 — 그 칸이 없는 옛 meta면 멈춘다(--allow-old-meta).
//                       leakLevel: 'content' = 원문(전문·초록·결론 발췌)이 자료에 들어갔다 — 결론 유사도가 독립적이지 않다.
//                                  'meta'    = 서지(제목·DOI)만 찾았다(Crossref "서지 확인" 등) — 원문 내용은 들어가지 않았다.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'testset');

const norm = (s: string) => s.normalize('NFC').replace(/\s+/g, '').replace(/[「」『』"“”'‘’<>《》〈〉.,:;?!·…\-–—()[\]]/g, '').toLowerCase();
const bigrams = (s: string) => {
    const t = norm(s);
    const out = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    return out;
};
const jac = (a: Set<string>, b: Set<string>) => {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
};
const coverage = (needle: Set<string>, hay: Set<string>) => {
    if (!needle.size) return 0;
    let hit = 0;
    for (const x of needle) if (hay.has(x)) hit++;
    return hit / needle.size;
};

// 원 제목 2-gram 중 이 비율 이상이 한 서지에 있으면 원 논문이다. 같은 주제의 다른 논문은 50~60%에 그친다
// (클라우드: 「핸드폰 압수ㆍ수색영장으로 행한 클라우드 압수ㆍ수색의 타당성」 56%).
const TITLE_MATCH = 0.8;
// 원문 대조 — 정규화한 글자 20자가 그대로 겹치는 부분을 센다. 법조문 인용 같은 우연한 겹침은 4% 남짓이다.
const VERBATIM = 20;
const VERBATIM_FRAC = 0.08;
const VERBATIM_MIN = 60;
const VERBATIM_ABS = 400;

/** 정답지 글자 중 후보 글에 VERBATIM자 이상 그대로 들어 있는 글자 수와 비율. */
function verbatim(truth: string, cand: string): { chars: number; frac: number } {
    const T = norm(truth);
    const C = norm(cand);
    if (T.length < VERBATIM || C.length < VERBATIM) return { chars: 0, frac: 0 };
    const at = new Map<string, number[]>();
    for (let i = 0; i + VERBATIM <= T.length; i++) {
        const k = T.slice(i, i + VERBATIM);
        const a = at.get(k);
        if (a) a.push(i);
        else at.set(k, [i]);
    }
    const hit = new Uint8Array(T.length);
    for (let j = 0; j + VERBATIM <= C.length; j++) {
        const a = at.get(C.slice(j, j + VERBATIM));
        if (a) for (const p of a) hit.fill(1, p, p + VERBATIM);
    }
    let n = 0;
    for (const x of hit) n += x;
    return { chars: n, frac: n / T.length };
}

/** 영문 제목 낱말(4자 이상) 중 후보에 든 비율. */
function englishCoverage(titleEn: string, cand: string): number {
    const words = [...new Set(titleEn.toLowerCase().match(/[a-z]{4,}/g) ?? [])];
    if (words.length < 4) return 0;
    const c = cand.toLowerCase();
    return words.filter((w) => c.includes(w)).length / words.length;
}

interface Ident {
    title: string;
    titleEn: string;
    doi: string;
    kciId: string;
    /** 원 논문의 로마자 저자(전처리 meta.json authorsEn). 옛 meta에는 없다. */
    authorsEn?: string[];
}

// 원 저자가 그 줄에 없을 때 요구하는 원 제목 낱말 비율 — 낱말 다섯 개 제목에서 하나가 빠진 다른 문헌(80%)을 원 논문으로 보지 않는다.
const TITLE_EN_NO_AUTHOR = 0.9;
// 거꾸로 — 줄의 제목 부분 낱말 중 원 제목 낱말이어야 하는 비율(전처리 isTitleEnText 와 같은 값).
const TITLE_EN_BACK = 0.75;

/**
 * 원 저자 이름 낱말(정규식) — 성, 그리고 이름은 통째로('Young-Sung' → young-sung·young sung·youngsung, 'Hakkyong')나 머리글자('Y.-S.')로만.
 * 3차는 하이픈·띄어쓰기로 이름을 음절까지 갈라 썼다 — 'Park, Da-On'의 on 이 다른 Kim 의 「Legal Issues on …」을, 'Min, Young-Sung'의
 * young 이 Henrichs 의 '… in: Young Scholars …'를 원 저자가 있는 줄로 만들었다.
 *   "Min, Young-Sung"·"Ryu, Bu Gon"   쉼표 앞이 성, 뒤가 이름
 *   "Oh SoJung, Jang JiHye, Kim Gibum"·"Chan-Ju Moon, Gi-Bum Kim"   쉼표가 사람을 가른다(조각마다 낱말 둘 이상)
 *   쉼표 없는 두 낱말("Changwon Baek"·"Kim Gibum")   어느 쪽이 성인지 꼴로 알 수 없다 — 둘 다 통째 낱말이라 함께 쓴다
 *   세 낱말("Geun Hye Kim"·"Kim Geun Hye")   한국식 순서(첫 낱말이 성)면 첫 낱말이 성, 아니면 끝 낱말이 성 — 이름은 나머지 둘을 통째로만.
 *     5차는 늘 끝 낱말을 성으로 보아 'Kim Geun Hye' 의 'hye', 'Oh So Jung' 의 'jung'(독일어 낱말이기도 하다) 같은 이름 음절 하나를 낱말로 썼다.
 *     한국식 순서는 첫 낱말이 이름 첫 음절로 드문 성(KO_SURNAME_FIRST)이거나, 첫 낱말은 흔한 성(KO_SURNAME)이고 끝 낱말은 성이 아닐 때다
 *     ('Jung Ji Hoon'). 끝 낱말도 흔한 성이면('Min Jung Kim'·'So Jung Oh') 서양식으로 본다.
 *   네 낱말 이상   끝 낱말이 성, 앞이 이름
 */
function nameTokens(authors: string[] = []): RegExp[] {
    const KO_SURNAME = new Set(
        ('kim gim lee yi rhee park pak bak choi choe jung jeong chung cheong kang gang cho jo yoon yun jang chang lim im han oh seo suh shin sin ' +
            'kwon gwon hwang ahn an song ryu yoo yu hong jeon jun chun ko go moon mun yang son sohn bae baek paik baik heo huh nam sim shim noh roh ' +
            'ha kwak gwak sung seong cha joo ju woo koo gu min na jin ji eom uhm chae won cheon bang kong gong hyun hyeon ham byun byeon yeom yeo ' +
            'choo chu do so seok seol ma gil yeon pyo ban ra wang geum maeng tak kook').split(' '),
    );
    // 이름 첫 음절로는 드문 성 — 첫 낱말이 이것이면 끝 낱말과 관계없이 한국식 순서다('Oh So Jung').
    const KO_SURNAME_FIRST = new Set(
        ('kim gim lee yi rhee park pak bak choi choe cho jang chang lim oh shin kwon gwon hwang ahn ryu hong jeon ko moon mun bae baek paik baik ' +
            'heo huh kwak gwak cha koo eom uhm chae byun byeon yeom choo pyo maeng tak').split(' '),
    );
    // 이름 조각 — 하이픈·띄어쓰기·대문자 경계('SoJung')로 가른 음절. 음절은 하나씩 쓰지 않고 통째로 이어 붙여만 쓴다.
    const unit = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s-]+/).filter((x) => /^[a-z'’]+$/.test(x));
    const word = (parts: string[]) => (parts.join('').length >= 2 ? new RegExp(`(?<![a-z])${parts.join('[-\\s]?')}(?![a-z])`) : null);
    // 머리글자는 음절이 둘 이상인 이름만 — 'Y.-S.'·'Y. S.'(한 글자 'H.'는 아무 이름에나 걸린다).
    const initials = (parts: string[]) => (parts.length >= 2 ? new RegExp(`(?<![a-z])${parts.map((p) => `${p[0]}\\.`).join('\\s?-?\\s?')}`) : null);
    const out: (RegExp | null)[] = [];
    for (const a of authors) {
        const parts = a.split(',').map((x) => x.trim()).filter((x) => /[A-Za-z]/.test(x));
        const persons = parts.length > 1 && parts.every((x) => x.split(/\s+/).length >= 2) ? parts : [a.trim()];
        for (const p of persons) {
            const comma = p.indexOf(',');
            if (comma > 0) {
                const given = unit(p.slice(comma + 1));
                out.push(word(unit(p.slice(0, comma))), word(given), initials(given));
                continue;
            }
            const ws = p.split(/\s+/).filter(Boolean);
            const low = ws.map((w) => w.toLowerCase());
            const koreanOrder =
                ws.length === 3 && (KO_SURNAME_FIRST.has(low[0]!) || (KO_SURNAME.has(low[0]!) && !KO_SURNAME.has(low[2]!)));
            if (ws.length === 2) for (const w of ws) out.push(word(unit(w)), initials(unit(w)));
            else if (koreanOrder) out.push(word(unit(ws[0]!)), word(ws.slice(1).flatMap(unit)), initials(ws.slice(1).flatMap(unit)));
            else if (ws.length > 2) out.push(word(unit(ws[ws.length - 1]!)), word(ws.slice(0, -1).flatMap(unit)), initials(ws.slice(0, -1).flatMap(unit)));
            else if (ws.length === 1) out.push(word(unit(ws[0]!)));
        }
    }
    return out.filter((x): x is RegExp => !!x);
}

/**
 * 줄이 원 논문의 영문 제목을 가리키는가.
 *   따옴표 부분(「」·『』·“”·‘’·""·''·„“) 중 원 제목 낱말의 80% 이상을 담은 것이 있으면 그 부분으로 가른다 — 양쪽으로 본다.
 *     앞: 원 제목 낱말의 90% 이상. 원 논문 저자의 이름(nameTokens)이 그 줄에 있으면 80%(TITLE_MATCH).
 *     뒤: 그 부분 낱말의 75% 이상이 원 제목 낱말이다. 부제가 붙은 원 논문(전처리 titleEn 에는 부제가 빠졌다 — 역외 「… Digital Evidence
 *         - A Focus on Discussions and Legislation in Japan -」)은 부제 앞 본제목이 원 제목 낱말로만 되어 있으면 된다.
 *   따옴표 부분이 없으면 줄 전체 — 2차 규칙(원 제목 낱말 80% 이상) 그대로다. 줄 전체에는 저자·학술지·사이트 이름이 붙어 뒤쪽 검사를 하면
 *   따옴표 없는 원 논문 서지(APA "Song, Y.-J., … (2024). Legislative Review of … . Korean Criminological Review …", 웹 페이지 제목)를
 *   놓친다(3차) — DOI 없는 3편(비닉성·포트스캔·간첩통신)은 영문 제목이 국문 제목 말고는 유일한 길이다.
 * 2차 판정은 앞쪽만 보아, 독일 논문(Verdeckte personale und technische Ermittlungen im Internet)의 참고문헌에 있는 다른 문헌
 * Henrichs “Verdeckte personale Ermittlungen im Internet”(원 제목 낱말 4/5, 저자 다름)을 원 논문으로 잡았다. 원 제목을 품은 더 긴
 * 제목(Müller „… im Internet und im Darknet: …“)은 뒤쪽 검사에서 걸러진다. 실제 23편 실행에서 영문 제목으로 잡힌 서지는 모두
 * "저자, 「영문 제목」, 연도" 꼴이고 그 제목이 원 제목과 낱말까지 같다 — 양쪽 다 100%라 그대로 잡힌다.
 */
function titleEnIn(id: Ident, line: string): boolean {
    const t = id.titleEn.toLowerCase();
    const title = [...new Set(t.match(/[a-z]{4,}/g) ?? [])];
    if (title.length < 4) return false;
    const low = line.toLowerCase();
    const byAuthor = nameTokens(id.authorsEn).some((x) => x.test(low));
    const need = byAuthor ? TITLE_MATCH : TITLE_EN_NO_AUTHOR;
    const fwd = (part: string) => title.filter((w) => part.toLowerCase().includes(w)).length / title.length;
    const back = (part: string) => {
        const words = [...new Set(part.toLowerCase().match(/[a-z]{4,}/g) ?? [])];
        return words.length ? words.filter((w) => t.includes(w)).length / words.length : 0;
    };
    const quoted = [...line.matchAll(/「([^」]+)」|『([^』]+)』|“([^”]+)”|‘([^’]+)’|"([^"]+)"|'([^']+)'|„([^“”]+)[“”]/g)].map((m) => m.slice(1).find(Boolean) ?? '');
    const holding = quoted.filter((q) => fwd(q) >= TITLE_MATCH);
    if (!holding.length) return fwd(line) >= TITLE_MATCH;
    const main = (q: string) => q.split(/\s+[-–—―]\s+|\s*:\s+/)[0] ?? q;
    return holding.some((q) => fwd(q) >= need && (back(q) >= TITLE_EN_BACK || (fwd(main(q)) >= need && back(main(q)) === 1)));
}

/**
 * 글에 원 논문의 DOI가 있는가. 뒤에 숫자·글자가 이어지면 다른 논문이다 — 같은 호의 논문은 DOI가 앞부분까지 같다
 * (랜섬웨어 "…kdfs.2025.19.1.1"과 철도사고 "…kdfs.2025.19.1.14"). 빗금 둘레의 공백("10.22798 / kdfs…")도 같은 DOI로 본다.
 */
function hasDoi(text: string, doi: string): boolean {
    if (!doi) return false;
    const esc = doi.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('/', '\\s*/\\s*');
    return new RegExp(`${esc}(?![0-9a-z])`).test(text.toLowerCase());
}

/** 서지 한 줄(인용·dossier 발견·sources 파일 이름/머리)이 원 논문을 가리키는가. 긴 본문 덩어리에는 쓰지 않는다. */
function identifies(id: Ident, line: string): string {
    if (!line) return '';
    if (hasDoi(line, id.doi)) return 'DOI';
    if (id.kciId && line.includes(id.kciId)) return 'KCI ID';
    if (line.length <= 600) {
        const tg = bigrams(id.title);
        const c = coverage(tg, bigrams(line));
        if (tg.size >= 6 && c >= TITLE_MATCH) return `제목 ${Math.round(c * 100)}%`;
        if (id.titleEn && englishCoverage(id.titleEn, line) >= TITLE_MATCH && titleEnIn(id, line)) return '영문 제목';
    }
    return '';
}

/** 누출 근거 목록과 수준. 목록이 비어 있으면 누출 아님. */
function leakOf(id: Ident, truth: string, ledger: any, runDir: string): { by: string[]; level: 'content' | 'meta' | '' } {
    const by: string[] = [];
    let content = false;
    const verbatimHit = (text: string) => {
        const v = verbatim(truth, text);
        return (v.frac >= VERBATIM_FRAC && v.chars >= VERBATIM_MIN) || v.chars >= VERBATIM_ABS ? v : null;
    };
    const short = (s: string) => String(s).replace(/\s+/g, ' ').trim().slice(0, 50);
    // 인용 — raw가 dossier ID('R2')면 실제 서지는 display에 있다. 원문에서 확인되지 않아 본문에서 뺀 인용(withheld:true)도 본다:
    // 그 표지가 생기기 전에는 같은 인용이 ✗ 각주로 paper.cites 에 있었고(기존 판정과 같은 정의), 뺐어도 연구 단계가 원 논문을
    // 찾아왔다는 사실은 같다. 표지 전의 중간 원장은 paper.withheld 에만 있어 합친다.
    const listed: any[] = ledger.paper?.cites ?? [];
    const keys = new Set(listed.map((c) => c.key ?? c.raw));
    const cites = [...listed, ...(ledger.paper?.withheld ?? []).filter((c: any) => !keys.has(c.key ?? c.raw)).map((c: any) => ({ ...c, withheld: true }))];
    for (const c of cites) {
        for (const f of [c.raw, c.display, c.url]) {
            const why = identifies(id, String(f ?? ''));
            if (why) {
                by.push(`인용${c.withheld ? '(본문에서 뺌)' : ''} ${why}: ${short(c.display ?? c.raw)}`);
                break;
            }
        }
    }
    // dossier 발견 — 인용하지 않았어도 발췌(quote)가 수정 프롬프트에 '보강 자료'로 들어간다.
    for (const f of ledger.dossier?.findings ?? []) {
        const why = identifies(id, String(f.citation ?? '')) || identifies(id, String(f.url ?? ''));
        const v = verbatimHit(`${f.quote ?? ''} ${f.summary ?? ''}`);
        if (v) content = true;
        if (why) by.push(`조사 ${f.id} ${why}${v ? ` · 발췌에 원문 ${Math.round(v.frac * 100)}%` : ''}: ${short(f.citation)}`);
        else if (hasDoi(String(f.quote ?? ''), id.doi)) by.push(`조사 ${f.id} 발췌에 DOI`);
        else if (v) by.push(`조사 ${f.id} 발췌에 원문 ${Math.round(v.frac * 100)}%`);
    }
    // sources/ — 받아 온 원문 파일. 이름·머리(citation/title)·조사 노트의 '## 서지' 줄과 본문을 본다.
    const dir = path.join(runDir, 'sources');
    if (fs.existsSync(dir)) {
        for (const name of fs.readdirSync(dir)) {
            const body = fs.readFileSync(path.join(dir, name), 'utf8');
            const nameNfc = name.normalize('NFC');
            const heads = [nameNfc.replace(/-/g, ' '), ...body.split('\n').filter((l) => /^(citation|title|source):|^## /.test(l))];
            const why = heads.map((h) => identifies(id, h)).find(Boolean) || (hasDoi(body, id.doi) ? 'DOI' : '');
            const v = verbatimHit(body);
            // 조사 노트(research-*.md)가 아닌 파일이 원 논문이면 원문을 받아 온 것이다.
            if (v || (why && !nameNfc.startsWith('research-'))) content = true;
            if (why || v) by.push(`sources ${why || '원문'}${v ? ` · 원문 ${Math.round(v.frac * 100)}%` : ''}: ${short(nameNfc)}`);
        }
    }
    return { by, level: by.length ? (content ? 'content' : 'meta') : '' };
}

// manifest에 있는 편만 본다 — results/ 에는 ID가 바뀌기 전의 옛 결과가 남아 있을 수 있다.
const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8')) as { papers: { id: string; title: string }[] };
const readMeta = (id: string) => {
    const f = path.join(OUT, 'papers', id, 'meta.json');
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as { titleEn?: string; doi?: string; kciId?: string; authorsEn?: string[] }) : {};
};
// 누출 판정은 전처리가 meta.json 에 남긴 원 논문 DOI·영문 제목에 기댄다. 옛 전처리(v2)의 meta에는 그 칸이 없어서
// 영문 제목·DOI로만 찾아온 편을 조용히 놓쳤다(같은 실행에서 누출 16편 → 8편). 칸이 없으면 멈춘다.
const oldMeta = manifest.papers.filter((p) => { const m = readMeta(p.id); return !('titleEn' in m) || !('doi' in m); });
if (oldMeta.length) {
    console.error(
        `⚠ meta.json 에 원 논문 DOI·영문 제목 칸이 없는 편이 ${oldMeta.length}/${manifest.papers.length}편이다 — 옛 전처리 결과다.\n` +
            `  이대로 재면 영문 제목·DOI로 원 논문을 찾아온 누출을 놓친다. 먼저 전처리를 다시 돌리십시오:\n` +
            `    npx tsx scripts/testset-prep.mts --dir <PDF 폴더> --out testset\n` +
            `  (누출을 덜 센다는 것을 알고도 지금 meta로 재려면 --allow-old-meta)`,
    );
    if (!process.argv.includes('--allow-old-meta')) process.exit(1);
    console.error('  --allow-old-meta: 계속한다 — 누출 수는 하한이다.');
}
const rows: {
    r: any;
    resultFile: string;
    truthGrams: Set<string>;
    genGrams: Set<string>;
    genAllGrams: Set<string>;
    expected: any;
    position: string;
    leakBy: string[];
    leakLevel: 'content' | 'meta' | '';
    truth: string;
    genConclusion: string;
}[] = [];
for (const { id } of manifest.papers) {
    const resultFile = path.join(OUT, 'results', `${id}.json`);
    if (!fs.existsSync(resultFile)) continue;
    const r = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    if (r.error) continue;
    const expectedFile = path.join(OUT, 'papers', r.id, 'expected.json');
    const runDir = path.join(OUT, 'runs', r.id);
    const ledgerFile = path.join(runDir, 'ledger.json');
    if (!fs.existsSync(expectedFile) || !fs.existsSync(ledgerFile)) {
        console.log(`SKIP(자료 없음): ${r.title?.slice(0, 40)}`);
        continue;
    }
    const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8')) as {
        abstract?: string;
        resultSentences: string[];
        conclusionSection: string;
        conclusionSource: 'section' | 'abstract' | 'none';
    };
    const meta = readMeta(r.id);
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    const paper = ledger.paper ?? {};
    const sections: { revised?: string; draft?: string }[] = paper.sections ?? [];
    const last = sections[sections.length - 1];
    const lastText = (last?.revised?.trim() || last?.draft?.trim() || '').slice(0, 4000);
    const position = String(paper.thesis?.position ?? '');
    const thesis = String(paper.thesis?.thesis ?? '');
    const genConclusion = `${position} ${lastText}`;
    const truth = expected.conclusionSection || expected.resultSentences.join(' ');
    // 원문 대조에는 초록도 넣는다 — 원 논문의 KCI 초록 페이지만 받아 온 경우도 원 논문을 읽은 것이다.
    const leak = leakOf(
        { title: String(r.title ?? ''), titleEn: meta.titleEn ?? '', doi: meta.doi ?? '', kciId: meta.kciId ?? '', authorsEn: meta.authorsEn },
        `${truth} ${expected.abstract ?? ''}`,
        ledger,
        runDir,
    );
    rows.push({
        r,
        resultFile,
        truthGrams: bigrams(truth),
        genGrams: bigrams(genConclusion),
        genAllGrams: bigrams(`${genConclusion} ${thesis}`),
        expected,
        position,
        leakBy: leak.by,
        leakLevel: leak.level,
        truth,
        genConclusion,
    });
}

for (const x of rows) {
    const { r, expected } = x;
    const cov = coverage(x.truthGrams, x.genAllGrams);
    // 기준선 — 같은 정답지를 **다른 논문의** 생성 결론으로 잰 포괄의 평균. 이보다 높아야 이 논문을 재현한 것이다.
    const others = rows.filter((y) => y !== x).map((y) => coverage(x.truthGrams, y.genAllGrams));
    const baseline = others.length ? others.reduce((a, b) => a + b, 0) / others.length : undefined;
    r.conclusion = {
        source: expected.conclusionSource,
        truthChars: x.truth.length,
        genChars: x.genConclusion.length,
        sim: jac(x.genGrams, x.truthGrams),
        coverage: cov,
        ...(baseline !== undefined && x.truthGrams.size ? { coverageBaseline: baseline, coverageLift: cov - baseline } : {}),
        resultSim: jac(bigrams(x.position), bigrams(expected.resultSentences.join(' '))),
        leak: x.leakBy.length > 0,
        leakLevel: x.leakLevel,
        leakBy: x.leakBy,
    };
    fs.writeFileSync(x.resultFile, JSON.stringify(r, null, 2), 'utf8');
    const lift = r.conclusion.coverageLift;
    console.log(
        `${(r.conclusion.sim * 100).toFixed(0)}% (포괄 ${(cov * 100).toFixed(0)}%${typeof lift === 'number' ? ` · 기준선 대비 ${lift >= 0 ? '+' : ''}${(lift * 100).toFixed(0)}%p` : ''}) · ${expected.conclusionSource} · ${r.title?.slice(0, 34)}${x.leakBy.length ? ` · LEAK ${x.leakLevel === 'content' ? '원문' : '서지'}(${x.leakBy[0]}${x.leakBy.length > 1 ? ` 외 ${x.leakBy.length - 1}` : ''})` : ''}`,
    );
}
const nContent = rows.filter((x) => x.leakLevel === 'content').length;
const nMeta = rows.filter((x) => x.leakLevel === 'meta').length;
console.log(`\n결론 비교 ${rows.length}편 완료 · 누출 ${nContent + nMeta}편(원문 ${nContent} · 서지만 ${nMeta})`);

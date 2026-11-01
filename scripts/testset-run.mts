// 테스트셋 자동 실행 — 전처리된 입력(testset/papers/*/input.md)으로 파이프라인을 돌리고,
// 원 논문(입력)과 산출물을 비교한다.
//
//   npx tsx scripts/testset-run.mts [--limit 1] [--only 클라우드] [--scale short] [--quality] [--force] [--dry]
//
// 비교 지표(모두 결정적):
//   - titleSim       생성 제목 ↔ 원 제목(파일명에서 뽑은 메인 제목)의 2-gram Jaccard
//   - titleCoverage  원 제목의 낱말이 생성 제목·논지·입장에 들어 있는 비율
//   - bgCoverage     원 배경(초록에서 결과 제외)의 2-gram이 생성 논지·입장에 들어 있는 비율
//   - caseRecall     원 참고문헌의 사건번호를 생성 인용이 확보한 비율
//   - lawRecall      원 참고문헌의 법령명을 생성 인용이 확보한 비율
//   - titleRecall    원 참고문헌의 문헌 제목을 생성 인용이 확보한 비율(2-gram 0.45 이상)
// 생성 인용은 raw와 display를 함께 본다 — raw가 dossier ID('R5')인 인용은 실제 서지가 display에만 있다.
// 인용 수·재현에는 본문에서 뺀 인용(withheld)도 든다(기존 결과와 같은 정의). 각주가 있는 인용만의 값은 inBody 에 따로 남긴다.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name: string, fallback?: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? (args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1]! : '') : fallback;
};
const has = (name: string) => args.includes(name);

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'testset');
const LIMIT = Number(argOf('--limit', '0')) || 0;
const START = Number(argOf('--start', '0')) || 0;
const NO_INDEX = has('--no-index');
const ONLY = argOf('--only', '');
const SCALE = argOf('--scale', 'short')!;
const QUALITY = has('--quality');
const FORCE = has('--force');
const DRY = has('--dry');

const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8')) as {
    papers: { id: string; title: string; source: string; items: number; refsChars: number; selfCheck?: string[] }[];
};

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
const coverage = (needle: string, hay: Set<string>) => {
    const n = bigrams(needle);
    if (!n.size) return 0;
    let hit = 0;
    for (const x of n) if (hay.has(x)) hit++;
    return hit / n.size;
};

const STOP = new Set(['연구', '검토', '고찰', '분석', '법적', '관한', '대한', '위한', '통한', '그리고', '그러나', '따라서', '하는', '되는', '있는', '없는', '경우', '문제', '대상', '내용', '방안', '제도', '기준', '의미', '필요', '가능', '중심', '관련']);
const termsOf = (s: string) => [...new Set(s.normalize('NFC').match(/[가-힣]{2,}|[A-Za-z]{3,}/g) ?? [])].filter((t) => !STOP.has(t));

function splitInput(md: string) {
    const title = /^# (.+)$/m.exec(md)?.[1]?.trim() ?? '';
    const bg = /## 배경·문제의식\n\n([\s\S]*?)\n\n## /m.exec(md)?.[1]?.trim() ?? '';
    const refs = /## 참고문헌\n([\s\S]*)$/m.exec(md)?.[1]?.trim() ?? '';
    return { title, bg, refs };
}

// 법령명 — '법' 뒤에 한글이 붙으면(성균관법학·서울중앙지방법원·토지공법연구) 학술지·법원 이름이다. 조사(상·은·의 …)만 허용한다.
// 방법·기법·입법 같은 낱말과 형사법·공법 같은 분야 이름은 뺀다. 두 글자는 기본법(형법·헌법·민법·상법)만 넣는다.
const LAW_CORE = new Set(['형법', '헌법', '민법', '상법']);
const NOT_LAW = /(?:기|방|수|입|위|불|적|합|편|문|화|용|해|공|사|형사|국제|행정|비교)법$/;

function refKeys(refs: string) {
    const cases = [...new Set((refs.match(/\d{2,4}(?:헌[가-힣]|도|다|두|누|마|모|라|바|카|그|재|초|구|가|나|고|합|단|소)\s*\d+/g) ?? []).map((s) => s.replace(/\s+/g, '')))];
    const laws = [...new Set(refs.match(/[가-힣]{1,25}(?:법률|시행령|시행규칙|법)(?=[^가-힣]|[상은는이의을과와에및]|$)/g) ?? [])].filter((x) =>
        x.length === 2 ? LAW_CORE.has(x) : !NOT_LAW.test(x),
    );
    // APA 꼴: "저자. (연도). 제목. 학술지, 권(호), 면." — 제목은 (연도). 뒤부터 다음 마침표까지.
    const titles: string[] = [];
    for (const line of refs.split('\n')) {
        const m = /\(\d{4}\)\.\s*(.+?)(?:\.\s|\.$)/.exec(line);
        if (m && m[1] && m[1].length >= 8) titles.push(m[1].trim());
        // 저자, "제목", 『학술지』 꼴도 잡는다.
        const q = /["“](.{8,})["”]/.exec(line);
        if (q?.[1]) titles.push(q[1].trim());
    }
    return { cases, laws, titles: [...new Set(titles)] };
}

/** 해시가 없는 옛 결과의 입력 — cli는 input.md를 다듬어(trim) ledger.context 에 통째로 넣는다. 읽지 못하면 undefined. */
function legacyInput(runDir: string): string | undefined {
    try {
        const c = JSON.parse(fs.readFileSync(path.join(runDir, 'ledger.json'), 'utf8')).context;
        return typeof c === 'string' ? c.trim() : undefined;
    } catch {
        return undefined;
    }
}

const results: unknown[] = [];
let ran = 0;
let selected = 0;
let seen = 0;
for (const p of manifest.papers) {
    if (ONLY && !p.title.includes(ONLY) && !p.id.includes(ONLY)) continue;
    seen++;
    if (seen <= START) continue;

    const dir = path.join(OUT, 'papers', p.id);
    const inputMd = fs.readFileSync(path.join(dir, 'input.md'), 'utf8');
    const inputHash = createHash('sha1').update(inputMd).digest('hex').slice(0, 16);
    const input = splitInput(inputMd);
    const runDir = path.join(OUT, 'runs', p.id);
    const resultFile = path.join(OUT, 'results', `${p.id}.json`);
    let stale = '';
    if (!FORCE && fs.existsSync(resultFile)) {
        const prev = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as { inputHash?: string };
        // 전처리를 다시 돌려 입력이 바뀌었으면 끝난 것이 아니다. 해시가 없는 옛 결과는 ledger.context(실행 때의 input.md)와 비교한다.
        // 실행 폴더(ledger.json)가 없는 결과도 끝난 것이 아니다 — 결론 비교·방향 판정이 읽을 원고가 없고, 옛 결과는 입력을 확인할 수도 없다.
        const legacy = legacyInput(runDir);
        if (!fs.existsSync(path.join(runDir, 'ledger.json'))) stale = '실행 폴더 없음';
        else if (prev.inputHash ? prev.inputHash !== inputHash : legacy !== undefined && legacy !== inputMd.trim()) stale = '입력 바뀜';
        if (!stale) {
            console.log(`SKIP(done): ${p.title.slice(0, 40)}`);
            continue;
        }
    }
    // 건너뛴 편은 --limit 에 세지 않는다 — 앞의 편이 끝나 있으면 '--limit 3'이 아무것도 돌리지 않았다.
    // STALE 알림은 한도 검사 뒤에 찍는다 — 앞에 찍으면 '다시 돌린다'고 해 놓고 돌리지 않고 끝났다.
    if (LIMIT && selected >= LIMIT) break;
    if (stale) console.log(`STALE(${stale}) — 다시 돌린다: ${p.title.slice(0, 40)}`);
    selected++;
    console.log(`\n=== ${p.title}`);
    if (p.selfCheck?.length) console.log(`  ⚠ 입력 자기검사 경고 ${p.selfCheck.length}건 — manifest.json selfCheck 를 확인하십시오`);
    if (DRY) {
        console.log('dry — 실행 생략');
        continue;
    }

    // 다시 돌리기 전에 이전 실행을 옆으로 옮긴다 — cli는 출력 폴더를 비우지 않는다(calls·tools·transcript는 이어 쓰고
    // sources/ 도 남는다). 그대로 두면 실패한 재실행이 옛 ledger로 지표를 만들고, 옛 sources/가 누출 판정에 섞인다.
    // 실행 폴더 없이 결과만 남은 경우에도 결과를 옮긴다 — 남겨 두면 이번 실행이 실패해도 다음 실행이 옛 결과를 '끝남'으로 본다.
    const hasRun = fs.existsSync(runDir) && fs.readdirSync(runDir).length > 0;
    if (hasRun || fs.existsSync(resultFile)) {
        const base = `${runDir}.prev-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
        let prevDir = base;
        for (let k = 2; fs.existsSync(prevDir); k++) prevDir = `${base}-${k}`;
        if (hasRun) fs.renameSync(runDir, prevDir);
        else fs.mkdirSync(prevDir, { recursive: true });
        if (fs.existsSync(resultFile)) fs.renameSync(resultFile, path.join(prevDir, 'result.json'));
        console.log(`  이전 ${hasRun ? '실행' : '결과'} → ${path.basename(prevDir)}`);
    }
    fs.mkdirSync(runDir, { recursive: true });
    const logFile = path.join(runDir, 'run.log');
    const cli = path.join(ROOT, 'node_modules', '.bin', 'tsx');
    const cliArgs = ['src/cli.ts', '-t', input.title, '--context-file', path.join(dir, 'input.md'), '--scale', SCALE, '--assume-unavailable', '--out', runDir];
    if (!QUALITY) cliArgs.push('--no-quality');
    console.log(`run: ${SCALE}${QUALITY ? ' · quality' : ' · no-quality'}`);
    let exit = 0;
    const started = Date.now();
    try {
        const out = execFileSync(cli, cliArgs, {
            cwd: ROOT,
            env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ''}` },
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 60 * 60_000,
            maxBuffer: 200 * 1024 * 1024,
        });
        fs.writeFileSync(logFile, String(out), 'utf8');
    } catch (e) {
        exit = (e as { status?: number }).status ?? 1;
        const anyErr = e as { stdout?: Buffer | string; stderr?: Buffer | string };
        fs.writeFileSync(logFile, `${anyErr.stdout ?? ''}\n${anyErr.stderr ?? ''}`, 'utf8');
        console.error(`  exit ${exit} — ${logFile}`);
    }
    const ms = Date.now() - started;
    ran++;

    const ledgerFile = path.join(runDir, 'ledger.json');
    // 실패한 실행은 지표를 만들지 않는다 — cli는 실패하면 ledger.json을 쓰지 않고 끝나므로, 남은 ledger는 이번 실행의 것이 아니다.
    const fresh = fs.existsSync(ledgerFile) && fs.statSync(ledgerFile).mtimeMs >= started;
    if (exit !== 0 || !fresh) {
        const error = exit !== 0 ? `exit ${exit}` : 'ledger 없음';
        results.push({ id: p.id, title: p.title, exit, ms, error });
        console.error(`  ${error} — 지표를 만들지 않음`);
        continue;
    }
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    const paper = ledger.paper ?? {};
    const t = paper.thesis ?? {};
    type Cite = { key?: string; raw: string; display?: string; kind?: string; check?: string; source?: string; withheld?: true };
    // paper.cites 에는 원문에서 확인되지 않아 본문에서 뺀 인용(withheld:true — 각주 없음)도 들어 있다. 그 표지가 생기기 전(10-29 1차 수정 전)
    // 에는 같은 인용이 ✗ 각주로 본문에 남아 paper.cites 에 있었다 — 기존 결과(10-28 실행)와 같은 정의로 세려면 그대로 센다.
    // 표지 전의 중간 원장은 뺀 인용이 paper.withheld 에만 있으므로 합친다(앱 runState 의 citesOf 와 같은 규칙). 논문에 실제로 남은
    // 인용만의 수·재현은 따로(inBody) 남긴다.
    const listed: Cite[] = paper.cites ?? [];
    const listedKeys = new Set(listed.map((c) => c.key ?? c.raw));
    const cites: Cite[] = [...listed, ...((paper.withheld ?? []) as Cite[]).filter((c) => !listedKeys.has(c.key ?? c.raw)).map((c) => ({ ...c, withheld: true as const }))];
    const citeOf = (c: Cite) => (c.display && c.display !== c.raw ? `${c.raw} ${c.display}` : c.raw);
    const citeText = cites.map(citeOf).join('\n');

    const gen = `${t.title ?? ''} ${t.thesis ?? ''} ${t.position ?? ''}`;
    const genGrams = bigrams(gen);
    const titleTerms = termsOf(input.title);
    const rk = refKeys(input.refs);
    const recallOf = (list: Cite[]) => {
        const text = norm(list.map(citeOf).join('\n'));
        const caseHit = rk.cases.filter((c) => text.includes(norm(c)));
        const lawHit = rk.laws.filter((l) => text.includes(norm(l)));
        const titleHit = rk.titles.filter((x) => {
            const xb = bigrams(x);
            return list.some((c) => {
                const cb = bigrams(citeOf(c));
                let inter = 0;
                for (const z of xb) if (cb.has(z)) inter++;
                return xb.size ? inter / xb.size >= 0.45 : false;
            });
        });
        return {
            caseRecall: { hit: caseHit.length, total: rk.cases.length },
            lawRecall: { hit: lawHit.length, total: rk.laws.length },
            titleRecall: { hit: titleHit.length, total: rk.titles.length },
        };
    };
    const recall = recallOf(cites);
    const inBody = cites.filter((c) => !c.withheld);
    const checkCount = (k: string) => cites.filter((c) => c.check === k).length;
    const sourceCount = (k: string) => cites.filter((c) => c.source === k).length;
    const result = {
        id: p.id,
        title: p.title,
        generatedTitle: t.title,
        generatedThesis: t.thesis,
        generatedPosition: t.position,
        exit,
        ms,
        scale: SCALE,
        quality: QUALITY,
        model: ledger.model,
        // 이 결과를 만든 입력 — 전처리를 다시 돌리면 집계가 옛 입력 결과를 알아본다.
        inputHash,
        sections: (paper.sections ?? []).length,
        // 인용 수·검증 수·재현은 본문에서 뺀 인용을 포함한다(위 — 기존 결과와 같은 정의).
        cites: cites.length,
        citesWithheld: cites.length - inBody.length,
        citesVerified: checkCount('verified'),
        citesNotFound: checkCount('not_found'),
        citesFullText: sourceCount('full_text'),
        citesAbstract: sourceCount('abstract_only'),
        titleSim: jac(bigrams(input.title), bigrams(t.title ?? '')),
        titleCoverage: titleTerms.length ? titleTerms.filter((x) => gen.includes(x)).length / titleTerms.length : 0,
        bgCoverage: coverage(input.bg, genGrams),
        ...recall,
        // 논문에 실제로 남은(각주가 있는) 인용만으로 잰 수·재현 — 확인되지 않아 뺀 인용은 원 참고문헌을 '확보'했다고 보기 어렵다.
        inBody: { cites: inBody.length, ...recallOf(inBody) },
        refsParsed: { cases: rk.cases.length, laws: rk.laws.length, titles: rk.titles.length },
        generatedRefs: citeText.slice(0, 3000),
    };
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), 'utf8');
    results.push(result);
    console.log(
        `  완료 ${Math.round(ms / 1000)}초 · 장 ${result.sections} · 인용 ${result.cites} (검증 ${result.citesVerified} / 전문 ${result.citesFullText}${result.citesWithheld ? ` / 본문에서 뺌 ${result.citesWithheld}` : ''})`,
    );
    console.log(
        `  제목 유사 ${(result.titleSim * 100).toFixed(0)}% · 제목어 ${(result.titleCoverage * 100).toFixed(0)}% · 배경 ${(result.bgCoverage * 100).toFixed(0)}%`,
    );
    console.log(
        `  재현: 판례 ${result.caseRecall.hit}/${result.caseRecall.total} · 법령 ${result.lawRecall.hit}/${result.lawRecall.total} · 문헌 ${result.titleRecall.hit}/${result.titleRecall.total}`,
    );
}

if (results.length && !NO_INDEX) {
    fs.mkdirSync(path.join(OUT, 'results'), { recursive: true });
    // 이번 실행분만이 아니라 manifest의 모든 결과로 다시 쓴다 — 한 편만 --force 로 돌려도 전체 집계가 남는다.
    const all = manifest.papers.flatMap((p) => {
        const now = results.find((r) => (r as { id: string }).id === p.id);
        if (now) return [now];
        const f = path.join(OUT, 'results', `${p.id}.json`);
        return fs.existsSync(f) ? [JSON.parse(fs.readFileSync(f, 'utf8')) as unknown] : [];
    });
    fs.writeFileSync(path.join(OUT, 'results', 'index.json'), JSON.stringify({ generatedAt: new Date().toISOString(), results: all }, null, 2), 'utf8');
    const rows = all
        .map((r) => {
            const x = r as Record<string, unknown>;
            if (x.error) return `| ${x.title} | — | — | — | — | ${x.error} |`;
            // 디스크의 옛 결과는 필드가 빠져 있을 수 있다.
            const rc = (v: unknown) => (v ? `${(v as { hit: number }).hit}/${(v as { total: number }).total}` : '—');
            const pc = (v: unknown) => (typeof v === 'number' ? `${(v * 100).toFixed(0)}%` : '—');
            return `| ${x.title} | ${x.sections ?? '—'} | ${x.cites ?? '—'} | ${pc(x.titleSim)} | ${pc(x.bgCoverage)} | ${rc(x.caseRecall)} · ${rc(x.lawRecall)} · ${rc(x.titleRecall)} |`;
        })
        .join('\n');
    fs.writeFileSync(
        path.join(OUT, 'results', 'summary.md'),
        `# 테스트셋 실행 결과\n\n| 논문 | 장 | 인용 | 제목 유사 | 배경 포괄 | 재현(판례·법령·문헌) |\n|---|---|---|---|---|---|\n${rows}\n`,
        'utf8',
    );
    console.log(`\n요약: ${path.join(OUT, 'results', 'summary.md')}`);
}

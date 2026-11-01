// 논문 조립.
//
// 두 조립기가 있다:
//   assemblePaper    — 초고→검증→수정 파이프라인(compose.ts)의 산출물. **모델 호출 없음.**
//                      각주 번호·참고문헌·검증 부록을 코드가 만든다. 차단 인용은 지금 코퍼스로 다시 대조한 뒤 뺀다.
//   composeManuscript — 원자 명제 파이프라인(pipeline.ts)의 장별 집필. 실험 비교용으로 남겨 둔다.
import type { Ledger } from './pipeline.ts';
import type { Usage } from './llm.ts';
import type { CiteStatus } from './compose.ts';
import { blockingStates } from './schemas.ts';
import { verifyAuthority } from './law/verify.ts';
import { CiteBook, bibliography, extractCites, normalizeKey, renderFootnotes, renderMarkers, statusMark, stripMarkers, type CiteStatusLike } from './law/cite.ts';

const VERDICT_KO: Record<string, string> = { supported: '지지', weak: '박약', refuted: '반박', unresolved: '미결' };

/** 판정자 절차 답에 맞춰 코드가 등급을 바꾼 항목(compose applyJudgment 의 '판정자 절차에 맞춰 …' 표지). */
const procedureAdjusted = (it: { changes?: string[] }): boolean => it.changes?.some((c) => c.startsWith('판정자 절차에 맞춰')) ?? false;

/**
 * 키가 keys 에 든 인용 마커만 뺀다(문장은 그대로). 마커 앞 공백도 함께 — "…요구하였다 ⟦X⟧." → "…요구하였다.".
 * 확인되지 않은 인용을 각주로 달지 않기 위해 compose(조립 전)와 assemblePaper(예전 원장)가 같이 쓴다.
 */
export function withoutCites(text: string, keys: Set<string>): string {
    return text.replace(/[ \t]*⟦([^⟦⟧]{1,400})⟧/g, (m, raw: string) => (keys.has(normalizeKey(raw.trim())) ? '' : m));
}

/**
 * 원장에 차단(✗)으로 적힌 법령·판례 인용을 지금 코퍼스로 다시 대조한다. 풀리면 새 판정, 여전히 차단이거나 대조할 수 없으면 null.
 * 원장의 판정은 그 실행 때 검증기가 낸 것이다(실측: 10-27 실행의 약칭 「금융실명법 시행령 제3조」는 그때 법령명을 못 찾아 not_found,
 * 지금 검증기로는 verified). 예전 원장(--from)을 다시 조립하면서 그대로 믿으면 지금은 확인되는 인용까지 본문에서 뺀다.
 * 모델 호출 없이 로컬 코퍼스만 읽는다. compose 가 막 만든 원장은 같은 코퍼스라 같은 판정이 나온다.
 */
function recheckBlocked(c: CiteStatus): { state: string; note?: string } | null {
    if (c.kind !== 'statute' && c.kind !== 'precedent' && c.kind !== 'constitutional') return null;
    try {
        const fresh = verifyAuthority({ type: c.kind === 'statute' ? 'statute' : 'precedent', citation: c.display ?? c.raw, holding: '' });
        return blockingStates.has(fresh.state) ? null : { state: fresh.state, ...(fresh.note ? { note: fresh.note } : {}) };
    } catch {
        return null; // 코퍼스가 없으면 원장의 판정대로(뺀다)
    }
}

export interface ManuscriptResult {
    markdown: string;
    diagnostics: { newCitations: string[]; chapters: { id: string; chars: number }[]; unverified: number; flagged: number };
}

// ---- 초고→검증→수정 파이프라인 ---------------------------------------------------------

/**
 * 원장(ledger.paper)에서 논문을 조립한다. 모델 호출 없음 — 다시 돌려도 같은 결과(차단 인용의 재대조만 로컬 코퍼스를 읽는다).
 *
 * 각주는 논문 전체에서 첫 등장 순으로 한 번만 매긴다. 각 각주에는 검증 상태가 붙는다:
 *   ✓ 원문 확인 · ◐ 웹/공개자료 확인 · ⚠ 원문 미확보 · ✗ 코퍼스에 없음
 * 필자는 ⚠·✗ 만 보면 무엇을 직접 확인해야 하는지 안다.
 */
export function assemblePaper(ledger: Ledger): ManuscriptResult {
    const paper = ledger.paper;
    if (!paper) throw new Error('이 원장에는 논문 설계(paper)가 없습니다 — 원자 파이프라인 원장은 composeManuscript 로 조립합니다.');
    const book = new CiteBook();
    const byKey = new Map((paper.cites ?? []).map((c) => [c.key, c]));
    // 확인되지 않은 인용(✗)은 각주로 달지 않는다 — compose 가 조립 전에 빼지만, 그보다 앞서 만든 원장(--from)도 같은 규칙으로 조립한다.
    // 본문에 마커가 남은 차단 인용은 빼기 전에 지금 코퍼스로 다시 대조한다(recheckBlocked). 풀린 것은 각주로 남기고 지난 판정을 적는다.
    // 이미 compose 가 뺀 것(withheld 표지)은 본문에 마커가 없으니 다시 대조하지 않는다. 예전 원장의 상태표에는 수정 단계가 이미 지운
    // 인용이 남아 있기도 하다 — 본문에 없는 것은 뺄 것도 「본문에서 뺀 인용」으로 적을 것도 없다(적으면 원고에 없던 인용을 뺐다고 말한다).
    const inBody = new Set(paper.sections.flatMap((s) => extractCites(s.revised ?? s.draft ?? '').map((c) => c.key)));
    const blocked: CiteStatus[] = [];
    for (const c of paper.cites ?? []) {
        if (!blockingStates.has(c.check as never)) continue;
        if (!c.withheld && !inBody.has(c.key)) continue;
        const fresh = c.withheld ? null : recheckBlocked(c);
        if (!fresh) {
            blocked.push(c);
            continue;
        }
        const was = statusMark(c).label;
        byKey.set(c.key, { ...c, check: fresh.state, note: `원장의 판정 「${was}」은 지금 코퍼스로 다시 대조해 풀림${fresh.note ? ` — ${fresh.note}` : ''}` });
    }
    const blockedKeys = new Set(blocked.map((c) => c.key));
    const withheld = [...new Map([...(paper.withheld ?? []), ...blocked].map((c) => [c.key, c])).values()];
    const numberOf = new Map(paper.sections.map((s) => [s.id, s.number]));

    const out: string[] = [];
    out.push(`# ${paper.thesis.title}`);
    out.push('');
    out.push(`[저자명] · [소속] · ${new Date().toISOString().slice(0, 7).replace('-', '. ')}.`);
    out.push('');
    if (paper.abstract) {
        out.push('## 국문초록');
        out.push('');
        out.push(stripMarkers(paper.abstract).trim());
        out.push('');
        if (paper.keywords?.length) {
            out.push(`**주제어:** ${paper.keywords.join(', ')}`);
            out.push('');
        }
    }
    out.push('---');
    out.push('');

    const chapters: { id: string; chars: number }[] = [];
    for (const s of paper.sections) {
        const body = withoutCites((s.revised ?? s.draft ?? '').trim(), blockedKeys);
        out.push(`## ${s.number}. ${s.title}`);
        out.push('');
        out.push(body ? renderMarkers(body, book) : '_이 장은 생성되지 않았습니다._');
        out.push('');
        chapters.push({ id: s.id, chars: body.length });
    }

    // 각주 — 번호부 순서. 상태표에 없는 인용(수정 단계에서 새로 들어온 것)은 미확보로.
    const cites: CiteStatusLike[] = book.entries().map((e) => {
        const st = byKey.get(e.key);
        return st
            ? { ...st, n: e.n }
            : { key: e.key, raw: e.raw, kind: e.kind, n: e.n, check: 'unverifiable', source: 'not_found', note: '본문에 있으나 검증 단계를 거치지 않음' };
    });
    const flagged = cites.filter((c) => {
        const m = statusMark(c);
        return m.tone === 'bad' || m.tone === 'neutral';
    });

    out.push('---');
    out.push('');
    out.push('## 각주');
    out.push('');
    out.push(renderFootnotes(cites) || '(없음)');
    out.push('');
    const bib = bibliography(cites);
    if (bib) {
        out.push('## 참고문헌');
        out.push('');
        out.push(bib);
        out.push('');
    }

    // 검증 부록 — 이 논문이 무엇을 확인했고 무엇을 못 했는가. 숨기지 않는다.
    const items = ledger.issues.flatMap((x) => x.items);
    const dist: Record<string, number> = {};
    for (const it of items) dist[it.judgment.verdict] = (dist[it.judgment.verdict] ?? 0) + 1;
    // 기호로 센다 — 톤(bad)에는 "코퍼스에 없음"(✗)과 "필자가 없다고 확인"(⚠)이 함께 들어 있어 라벨이 어긋난다.
    const marks = { ok: 0, partial: 0, neutral: 0, bad: 0 };
    for (const c of cites) {
        const m = statusMark(c).mark;
        if (m === '✓') marks.ok++;
        else if (m === '◐') marks.partial++;
        else if (m === '✗') marks.bad++;
        else marks.neutral++;
    }
    out.push('## 부록. 검증 기록');
    out.push('');
    out.push(`> 이 논문은 LLM이 초고를 쓰고, 인용 ${cites.length}건의 원문을 확보·대조하고, 주장 ${items.length}개를 적대적으로 검토한 뒤 그 결과를 반영해 수정한 것이다.`);
    out.push(`> 모델: \`${ledger.model}\` · 인용 — ✓ 원문 확인 ${marks.ok} · ◐ 웹/공개자료 ${marks.partial} · ⚠ 미확보 ${marks.neutral} · ✗ 코퍼스에 없음 ${marks.bad}${withheld.length ? ` · 확인되지 않아 본문에서 뺀 인용 ${withheld.length}` : ''} · 판정 — ${Object.entries(dist)
        .map(([k, v]) => `${VERDICT_KO[k] ?? k} ${v}`)
        .join(' · ') || '(검토 없음)'}`);
    out.push('');
    if (flagged.length) {
        out.push('### 필자가 직접 확인할 것');
        out.push('');
        for (const c of flagged) {
            const m = statusMark(c);
            out.push(`- [^${c.n}] ${c.display ?? c.raw} — ${m.mark} ${m.label}${c.note ? ` (${c.note.slice(0, 140)})` : ''}`);
        }
        out.push('');
    }
    if (withheld.length) {
        out.push('### 본문에서 뺀 인용 (원문에서 확인되지 않음)');
        out.push('');
        out.push('확인되지 않은 인용은 각주로 달지 않는다. 문장은 필자의 주장으로 남기고 인용 표시만 뺐다 — 실재하는 권위라면 원문을 확인한 뒤 다시 넣는다.');
        out.push('');
        for (const c of withheld) {
            const m = statusMark(c);
            // 본문에는 표시가 남지 않으므로 어느 장에서 뺐는지 적는다 — 필자가 그 문장을 찾아 원문을 확인할 수 있게.
            const where = c.sections?.length ? ` · ${c.sections.map((id) => numberOf.get(id) ?? id).join('·')}장` : '';
            out.push(`- ${c.display ?? c.raw} — ${m.mark} ${m.label}${where}${c.note ? ` (${c.note.slice(0, 140)})` : ''}`);
        }
        out.push('');
    }
    if (items.length) {
        out.push('### 주장별 판정');
        out.push('');
        out.push('| 장 | 주장 | 판정 | 살아남은 반대 |');
        out.push('|---|---|---|---|');
        for (const { issue, items: its } of ledger.issues) {
            for (const it of its) {
                const surv = it.judgment.surviving.length ? it.judgment.surviving.map((x) => x.replace(/\|/g, '\\|').replace(/\n+/g, ' ').slice(0, 160)).join('; ') : '—';
                const re = it.changes?.includes('수정본 재검증') ? ' ↻' : '';
                out.push(`| ${issue.question.split('.')[0] ?? issue.id} | ${it.claim.proposition.replace(/\|/g, '\\|').replace(/\n+/g, ' ').slice(0, 140)} | ${VERDICT_KO[it.judgment.verdict] ?? it.judgment.verdict}${procedureAdjusted(it) ? ' ⇄' : ''}${it.downgrade ? ' ⬇' : ''}${re} | ${surv} |`);
            }
        }
        out.push('');
        if (items.some((it) => it.downgrade || procedureAdjusted(it) || it.changes?.includes('수정본 재검증'))) {
            out.push('⇄ 판정자 자신의 절차 답(전제·추론·대안)에 맞춰 코드가 등급을 조정 · ⬇ 근거 부족 등으로 코드가 강등 · ↻ 수정본에서 다시 반대·판정한 주장');
            out.push('');
        }
        const surviving = items.flatMap((it) => it.judgment.surviving);
        if (surviving.length) {
            out.push('### 살아남은 반대 (결론이 답해야 할 것)');
            out.push('');
            for (const s of [...new Set(surviving)].slice(0, 20)) out.push(`- ${s}`);
            out.push('');
        }
    }
    // 인용 대조 — 각주 문장이 원문 발췌에 뒷받침되는가(모델), 숫자·날짜가 원문에 있는가(코드).
    const checks = ledger.paper?.citeCheck ?? [];
    const firstPass = checks.filter((c) => !c.recheck);
    if (firstPass.length) {
        const n = (v: string) => firstPass.filter((c) => c.verdict === v).length;
        const nums = firstPass.filter((c) => c.numbers?.length).length;
        const fixedN = firstPass.filter((c) => c.fixed).length;
        const re = checks.filter((c) => c.recheck);
        out.push('### 인용 대조');
        out.push('');
        out.push(
            `각주 문장 ${firstPass.length}건 — 뒷받침 ${n('supported')} · 일부 ${n('partial')} · 뒷받침 안 됨 ${n('unsupported')}${n('unchecked') ? ` · 대조 못 함 ${n('unchecked')}` : ''} · 원문에 없는 숫자·날짜 ${nums}건. 걸린 문장 중 ${fixedN}건을 고쳤다${re.length ? `(고친 문장 다시 대조: 뒷받침 ${re.filter((c) => c.verdict === 'supported').length} · 일부 ${re.filter((c) => c.verdict === 'partial').length} · 아님 ${re.filter((c) => c.verdict === 'unsupported').length})` : ''}.`,
        );
        out.push('');
        const flaggedChecks = firstPass.filter((c) => c.verdict === 'unsupported' || c.verdict === 'partial' || c.numbers?.length);
        for (const c of flaggedChecks.slice(0, 30)) {
            const tag = c.verdict === 'unsupported' ? '뒷받침 안 됨' : c.verdict === 'partial' ? '일부' : '숫자';
            out.push(`- **${tag}${c.fixed ? ' → 고침' : ''}** ⟦${c.cite.slice(0, 60)}⟧ "${c.sentence.replace(/⟦[^⟧]*⟧/g, '').slice(0, 120)}" — ${c.reason.slice(0, 160)}${c.numbers?.length ? ` (원문에 없음: ${c.numbers.join(', ')})` : ''}`);
        }
        if (flaggedChecks.length > 30) out.push(`- … 외 ${flaggedChecks.length - 30}건`);
        if (re.length) {
            out.push('');
            out.push('고친 문장을 다시 대조한 결과:');
            for (const c of re.slice(0, 20)) {
                const tag = c.verdict === 'supported' ? '뒷받침' : c.verdict === 'partial' ? '일부' : c.verdict === 'unsupported' ? '뒷받침 안 됨' : '대조 못 함';
                out.push(`- **${tag}** ⟦${c.cite.slice(0, 60)}⟧ "${c.sentence.replace(/⟦[^⟧]*⟧/g, '').slice(0, 120)}" — ${c.reason.slice(0, 160)}${c.numbers?.length ? ` (원문에 없음: ${c.numbers.join(', ')})` : ''}`);
            }
        }
        out.push('');
    }
    if (ledger.human?.length) {
        out.push('### 필자에게 물은 것');
        out.push('');
        for (const h of ledger.human) out.push(`- ${h.question} → **${h.answer.action}**${h.answer.note ? ` ${h.answer.note.slice(0, 120)}` : ''}`);
        out.push('');
    }

    return {
        markdown: out.join('\n'),
        diagnostics: { newCitations: [], chapters, unverified: marks.neutral + marks.bad, flagged: flagged.length + withheld.length },
    };
}

// ---- 원자 명제 파이프라인 (실험 비교용) --------------------------------------------------

/** 장 산문을 쓰는 함수. 구조화 출력이 아니라 plain completion 이다 — 긴 산문은 JSON 으로 받지 않는다. */
export type Writer = (req: { system: string; user: string; maxTokens?: number }) => Promise<string>;

const SYSTEM = `당신은 대한민국 법학 학술지에 투고할 논문의 한 장(章)을 쓰는 연구자다.

지켜야 할 것:
- 문체는 학술논문체(~이다/~한다)로, 3인칭으로 쓴다. "저는", "제가"를 쓰지 않는다.
- **주어진 재료 밖의 사실·조문·판례·학설을 쓰지 않는다.** 기억으로 인용을 보태지 않는다. 이것이 가장 중요한 규칙이다.
- 인용은 재료에 붙은 번호를 그대로 써서 \`[^3]\` 형식으로만 표시한다. 번호를 새로 만들지 않는다. **각주 정의(\`[^3]: …\`)를 쓰지 않는다** — 정의는 시스템이 붙인다.
- **본문에 조문 번호를 직접 쓰지 않는다.** 조문을 가리켜야 할 때는 재료에 주어진 각주 번호(\`[^n]\`)만 쓰고, 본문에서는 "위 조문", "동법의 해당 조항"처럼 지시한다.
- 판정이 weak 인 명제는 단정하지 말고 "…라고 볼 여지가 있다", "…와 양립한다"처럼 강도를 낮춰 쓴다.
- 판정이 refuted 이거나 철회된 명제는 논거로 쓰지 않는다.
- 살아남은 반대가 있으면 반드시 서술한다. 반대를 다 이긴 것처럼 쓰지 않는다.
- 소제목을 쓰지 않는다. 장의 본문만 쓴다.`;

const CHAPTERS = [
    { id: 'I', title: '서론', min: 400, max: 700 },
    { id: 'II', title: '규범 구조', min: 700, max: 1200 },
    { id: 'III', title: '찬성 논거', min: 1400, max: 2400 },
    { id: 'IV', title: '반대 논거', min: 1000, max: 1800 },
    { id: 'V', title: '검토', min: 1200, max: 2200 },
    { id: 'VI', title: '결론', min: 300, max: 600 },
] as const;

type ChapterId = (typeof CHAPTERS)[number]['id'];

class Footnotes {
    private map = new Map<string, number>();
    private order: { n: number; text: string; detail: string }[] = [];

    num(citation: string, detail: string): number {
        const hit = this.map.get(citation);
        if (hit) return hit;
        const n = this.order.length + 1;
        this.map.set(citation, n);
        this.order.push({ n, text: citation, detail });
        return n;
    }

    render(): string {
        return this.order.map((f) => `[^${f.n}]: ${f.text}${f.detail ? ` — ${f.detail}` : ''}`).join('\n');
    }
}

interface ChapterMaterial {
    id: ChapterId;
    title: string;
    facts: string;
}

function materialFor(ledger: Ledger, id: ChapterId, fn: Footnotes): ChapterMaterial {
    const items = ledger.issues.flatMap((x) => x.items);
    const usable = items.filter((it) => it.evidence.grade !== 'fabricated' && it.evidence.grade !== 'none');
    const note = (citation: string, detail: string) => `[^${fn.num(citation, detail)}]`;
    const lines: string[] = [];

    if (id === 'I') {
        lines.push('## 주제', ledger.topic, '');
        if (ledger.context) lines.push('## 필자가 준 배경·맥락', ledger.context, '', '(서론은 이 맥락에서 출발한다. 맥락에 없는 문제의식을 지어내지 않는다.)', '');
        lines.push('## 쟁점');
        for (const { issue } of ledger.issues) {
            lines.push(`- ${issue.question}`, `  - 다투어지는 이유: ${issue.why_contested}`, `  - 존재하는 견해: ${issue.positions.join(' / ')}`);
        }
        lines.push('', '## 검증된 핵심 명제 (요약)');
        for (const it of usable.slice(0, 6)) lines.push(`- [${VERDICT_KO[it.judgment.verdict]}] ${it.claim.proposition}`);
    }
    if (id === 'II') {
        lines.push('## 확보된 법령 원문 (코퍼스에서 직접 읽은 것)');
        const seen = new Set<string>();
        for (const it of usable) {
            for (const s of it.sources) {
                if (s.authority.type !== 'statute' && s.authority.type !== 'precedent') continue;
                if (!s.usable || seen.has(s.authority.citation)) continue;
                seen.add(s.authority.citation);
                lines.push(`### ${s.authority.citation} ${note(s.authority.citation, s.doc.url ?? '')}`, '```', (s.doc.fullText ?? '').slice(0, 1400), '```', '');
            }
        }
    }
    if (id === 'III') {
        lines.push('## 찬성측 명제와 그 근거');
        for (const it of usable) {
            if (it.judgment.verdict === 'refuted') continue;
            lines.push(`### 명제 (${it.claim.id}) — 판정: ${VERDICT_KO[it.judgment.verdict]}`, `주장: ${it.claim.proposition}`, `전제: ${it.claim.premise}`, `도약: ${it.claim.step}`, '근거:');
            for (const s of it.sources) {
                if (!s.usable) continue;
                lines.push(`- ${s.authority.citation} ${note(s.authority.citation, s.doc.url ?? '')} — 찬성측이 주장한 취지: ${s.authority.holding}`);
            }
            lines.push('');
        }
    }
    if (id === 'IV') {
        lines.push('## 반대측 논거');
        for (const it of usable) {
            lines.push(`### ${it.claim.id} 에 대한 반대 — 공격 유형: ${it.objection.attack}`, `반대 대상 명제: ${it.claim.proposition}`, `반대 논거: ${it.objection.objection}`, `대안: ${it.objection.alternative}`, `반대측이 밝힌, 자신을 죽일 조건: ${it.objection.defeat}`);
            for (const a of it.objection.authority) lines.push(`- 반대측 인용: ${a.citation} ${note(a.citation, '')}`);
            lines.push('');
        }
    }
    if (id === 'V') {
        lines.push('## 판정과 그 이유');
        for (const it of items) {
            lines.push(`### ${it.claim.id} — ${VERDICT_KO[it.judgment.verdict]}`, `명제: ${it.claim.proposition}`, `판정 이유: ${it.judgment.reasoning}`);
            if (it.judgment.surviving.length) lines.push('살아남은 반대:', ...it.judgment.surviving.map((s) => `- ${s}`));
            if (it.downgrade) lines.push(`※ 코드 강등: ${it.downgrade.from} → ${it.downgrade.to} (${it.downgrade.why})`);
            lines.push('');
        }
    }
    if (id === 'VI') {
        lines.push('## 살아남은 반대 (결론에서 반드시 언급)');
        for (const it of items) for (const s of it.judgment.surviving) lines.push(`- ${s}`);
        lines.push('', '## 지지된 명제');
        for (const it of items.filter((x) => x.judgment.verdict === 'supported')) lines.push(`- ${it.claim.proposition}`);
    }
    return { id, title: CHAPTERS.find((c) => c.id === id)!.title, facts: lines.join('\n') };
}

/** 산문이 몰래 들여온 인용을 잡는다. */
export function newCitations(text: string, allowed: Set<string>): string[] {
    const found = new Set<string>();
    for (const m of text.matchAll(/제\s*\d+\s*조(?:\s*의\s*\d+)?/g)) found.add(m[0].replace(/\s+/g, ''));
    for (const m of text.matchAll(/\d{4}[가-힣]{1,3}\d+/g)) found.add(m[0].replace(/\s+/g, ''));
    return [...found].filter((c) => !allowed.has(c));
}

export async function composeManuscript(ledger: Ledger, write: Writer): Promise<ManuscriptResult> {
    const fn = new Footnotes();
    const chapters: { id: string; title: string; body: string; chars: number }[] = [];
    for (const spec of CHAPTERS) {
        const mat = materialFor(ledger, spec.id, fn);
        const user = [`## 장: ${spec.id}. ${spec.title}`, `분량: ${spec.min}~${spec.max}자.`, '', mat.facts, '', '이 재료만으로 이 장을 쓴다. 재료에 없는 인용을 만들지 않는다.'].join('\n');
        let body = '';
        try {
            body = await write({ system: SYSTEM, user, maxTokens: Math.min(8192, spec.max * 3) });
        } catch (e) {
            body = `_(이 장 생성 실패: ${e instanceof Error ? e.message.slice(0, 160) : String(e)})_`;
        }
        let b = body.trim();
        while (/^#{1,6}\s*\S/.test(b)) b = b.slice(b.indexOf('\n') + 1).trim();
        // 모델이 각주 정의를 스스로 쓰면 걷어낸다 — 조립기의 번호와 충돌한다.
        b = b.replace(/^\[\^\d+\]:.*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
        chapters.push({ id: spec.id, title: spec.title, body: b, chars: b.length });
    }
    const allowed = new Set<string>();
    const addFrom = (text: string) => {
        for (const m of text.matchAll(/제\s*\d+\s*조(?:\s*의\s*\d+)?/g)) allowed.add(m[0].replace(/\s+/g, ''));
        for (const m of text.matchAll(/\d{4}[가-힣]{1,3}\d+/g)) allowed.add(m[0]);
    };
    for (const it of ledger.issues.flatMap((x) => x.items)) {
        for (const s of it.sources) {
            addFrom(s.authority.citation);
            if (s.doc.fullText) addFrom(s.doc.fullText);
        }
        for (const a of it.claim.authority) addFrom(a.citation);
        for (const a of it.objection.authority) addFrom(a.citation);
    }
    const suspicious = newCitations(chapters.map((c) => c.body).join('\n'), allowed);

    const out: string[] = [];
    out.push(`# ${ledger.topic}`, '', `> 이 논문은 LLM이 작성하고, 원문 대조·적대적 검토·판정을 거쳐 조립되었다.`, `> 모델: \`${ledger.model}\` · 검토 명제 ${ledger.coverage.claims}개 · 인용 ${ledger.coverage.citations}건(원문확인 ${ledger.coverage.verified})`, '');
    for (const c of chapters) out.push(`## ${c.id}. ${c.title}`, '', c.body || '_이 장은 생성되지 않았습니다._', '');
    out.push('---', '', '## 각주', '', fn.render() || '(없음)', '');
    if (suspicious.length) {
        out.push('### ⚠ 본문에서 발견된, 원장에 없는 인용', '', suspicious.map((s) => `- \`${s}\``).join('\n'), '');
    }
    return { markdown: out.join('\n'), diagnostics: { newCitations: suspicious, chapters: chapters.map(({ id, chars }) => ({ id, chars })), unverified: 0, flagged: suspicious.length } };
}

export type { Usage };

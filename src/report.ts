// 원장을 사람이 읽는 보고서로. 이 파일이 PoC 의 산출물이다.
//
// 일부러 본문에 드러내는 것들 — 숫자로만 두면 조용히 사라지는 것들이다:
//   · **원문을 못 구한 인용** — 표에 상태를 적는다. "검토했으나 문제없음"과 구별되지 않으면 안 된다.
//   · **코드가 내린 강등** — 모델이 supported 라고 했는데 원문이 없어서 내렸다면, 그 사실이 보여야 한다.
//   · **사람에게 물은 것과 답** — 이 실행이 어디서 멈췄고 누가 무엇을 말했는지. 이게 감사 기록이다.
//   · **살아남은 반대** — 반대가 하나도 안 남은 논증은 검토가 아니라 변호다.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Ledger, LedgerItem, SourceResolution } from './pipeline.ts';

const VERDICT_LABEL: Record<string, string> = {
    supported: '지지',
    weak: '박약',
    refuted: '반박',
    unresolved: '미결',
};

const STATE_LABEL: Record<string, string> = {
    verified: '원문확인',
    not_found: '코퍼스밖',
    article_missing: '조문없음',
    date_mismatch: '선고일불일치',
    misread: '오독',
    unverifiable: '검증불가',
};

const SOURCE_LABEL: Record<string, string> = {
    full_text: '전문',
    provided: '제공받음',
    abstract_only: '초록만',
    metadata_only: '서지만',
    paywalled: '페이월',
    login_required: '로그인월',
    not_found: '못 찾음',
    user_declined: '없음(사용자)',
    error: '오류',
    offline: '이 컴퓨터에 없음',
    corpus_gap: '코퍼스미수록',
};

const GRADE_LABEL: Record<string, string> = {
    full_text: '전문',
    partial: '일부',
    abstract_only: '**초록만**',
    metadata_only: '**서지만**',
    unavailable: '**없음**',
    fabricated: '**미확인**',
    none: '—',
};

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function uniqueSources(l: Ledger): { citation: string; r: SourceResolution }[] {
    const seen = new Map<string, SourceResolution>();
    for (const { items } of l.issues) for (const it of items) for (const r of it.sources) if (!seen.has(r.authority.citation)) seen.set(r.authority.citation, r);
    return [...seen.entries()].map(([citation, r]) => ({ citation, r }));
}

function citationLine(it: LedgerItem): string {
    return it.citations.map((c) => STATE_LABEL[c.state] ?? c.state).join(' · ');
}

/** 판정자 절차 맞춤 표지(compose applyJudgment) → 판정자가 원래 낸 등급. */
const PROCEDURE_FROM = new Map<string, string>([
    ['판정자 절차에 맞춰 박약→지지', 'weak'],
    ['판정자 절차에 맞춰 지지→박약', 'supported'],
    ['판정자 절차에 맞춰 반박→박약', 'refuted'],
]);

/**
 * 강등의 from 을 판정자가 냈는가. 절차 맞춤(박약→지지)이 낸 지지를 내린 경우 판정자의 등급은 따로 있다 —
 * downgrade.judged 가 없던 원장은 절차 표지로 되짚는다.
 */
function judgeVerdictOf(it: LedgerItem): string | undefined {
    if (!it.downgrade) return undefined;
    if (it.downgrade.judged) return it.downgrade.judged;
    const label = it.changes?.find((c) => PROCEDURE_FROM.has(c));
    return label ? PROCEDURE_FROM.get(label) : it.downgrade.from;
}

function renderItem(it: LedgerItem): string[] {
    const o: string[] = [];
    const p = (s = '') => o.push(s);

    p(`#### ${it.claim.id} [${it.claim.role}] ${it.judgment.verdict.toUpperCase()} — ${it.claim.proposition}`);
    p();
    if (it.downgrade) {
        const d = it.downgrade;
        const judged = judgeVerdictOf(it) ?? d.from;
        p(`> ⬇ **코드 강등 ${d.from} → ${d.to}** — ${d.why}`);
        // 판정자가 낸 등급을 그대로 적는다 — 절차 맞춤이 올린 지지를 내린 것을 "판정자가 지지를 냈다"고 쓰면 위 줄과 어긋난다.
        if (judged !== d.from)
            p(`> 판정자는 \`${judged}\` 를 냈고, 판정자 자신의 절차 답(전제·추론·대안)에 맞춰 코드가 \`${d.from}\` 로 바꿨지만 근거가 그 등급을 지탱하지 못해 파이프라인이 내렸습니다.`);
        else if (d.from === 'refuted')
            p(`> 판정자가 \`refuted\` 를 냈지만 반박의 요건(실질적인 반대 · 권위의 모순·오독)을 갖추지 못해 파이프라인이 내렸습니다.`);
        else p(`> 판정자가 \`${d.from}\` 를 냈지만 근거가 그 판정을 지탱하지 못해 파이프라인이 내렸습니다.`);
        p();
    }
    if (it.original) {
        p(`> ✎ **원문 대조 후 보정** — 이 명제는 원문을 보기 전에 쓰였고, 원문을 본 뒤 고쳐졌습니다.`);
        if (it.changes?.length) for (const c of it.changes) p(`> - ${c}`);
        p(`> 이전 명제: ${it.original.proposition}`);
        p();
    } else if (it.changes?.length) {
        // 논문 파이프라인 항목에는 original 이 없다 — 그래도 코드가 바꾼 것(절차 맞춤 박약↔지지, 공격 유형 정정, 재검증)은 보여야 한다.
        // 숨기면 코드가 올린 지지가 판정자의 지지처럼 읽힌다.
        p(`> **파이프라인이 바꾼 것**`);
        for (const c of it.changes) p(`> - ${c}`);
        p();
    }
    p(`**근거 등급**: ${GRADE_LABEL[it.evidence.grade] ?? it.evidence.grade} — ${it.evidence.reason}`);
    p();
    p(`**전제**: ${it.claim.premise}`);
    p();
    p(`**도약**: ${it.claim.step}`);
    p();

    p(`**인용과 원문 확보**`);
    for (let i = 0; i < it.claim.authority.length; i++) {
        const a = it.claim.authority[i]!;
        const c = it.citations[i];
        const s = it.sources[i];
        // 인용 검증·원문 확보 기록이 짝을 이루지 못하는 경우가 있다(권위만 있고 해석이 없는 경우).
        // 리포트가 그 하나 때문에 죽으면 원장 전체를 잃는다 — 빠진 줄만 남기고 계속한다.
        if (!c || !s || !s.doc) {
            p(`- \`[${a.type} / 기록 없음]\` ${a.citation}`);
            continue;
        }
        p(`- \`[${a.type} / 인용 ${STATE_LABEL[c.state] ?? c.state} / 원문 ${SOURCE_LABEL[s.doc.state] ?? s.doc.state}]\` ${a.citation}`);
        p(`  - 찬성측 주장: ${a.holding}`);
        p(
            `  - 원문: ${
                s.usable
                    ? `확보 (${(s.doc.chars ?? s.doc.fullText?.length ?? 0).toLocaleString()}자, 관련 대목 ${s.passages.length}개, 경로 \`${s.doc.how}\`)`
                    : `**없음** — ${s.why ?? s.doc.state}`
            }`,
        );
        if (s.doc.url) p(`  - 출처: \`${s.doc.url}\``);
        if (c.note) p(`  - 인용 검증: ${c.note}`);
    }
    p();

    if (it.human.length) {
        p(`**사람이 확인해 준 것**`);
        for (const h of it.human) p(`- Q: ${h.question}\n  A: ${h.answer.note ?? '(없음)'} _(${h.answer.by})_`);
        p();
    }

    p(`**반대** (${it.objection.attack})`);
    p();
    p(`> ${it.objection.objection}`);
    p();
    p(`*대안*: ${it.objection.alternative}`);
    p();
    p(`*반대가 성립하려면*: ${it.objection.premise}`);
    p();
    p(`*이 반대를 죽이는 것*: ${it.objection.defeat}`);
    p();
    const conf = typeof it.judgment.confidence === 'number' ? ` (확신 ${it.judgment.confidence.toFixed(2)})` : '';
    p(`**판정**: ${VERDICT_LABEL[it.judgment.verdict] ?? it.judgment.verdict}${conf}`);
    p();
    p(it.judgment.reasoning);
    p();
    p(it.judgment.surviving.length ? `*살아남은 반대*:` : `*살아남은 반대*: 없음`);
    for (const s of it.judgment.surviving) p(`- ${s}`);
    p();
    if (it.judgment.discriminators.length) {
        p(`*이 판정을 뒤집을 수 있는 것*:`);
        for (const d of it.judgment.discriminators) p(`- ${d}`);
        p();
    }

    const usablePassages = it.sources.flatMap((s) => s.passages);
    if (usablePassages.length) {
        p(`<details><summary>판정자가 실제로 읽은 원문 대목 (${usablePassages.length}개)</summary>`);
        p();
        for (const ps of usablePassages) {
            p(`> ${ps.text.replace(/\n/g, ' ').slice(0, 700)}`);
            p(`> — 일치어: ${ps.matched.slice(0, 8).join(', ')}`);
            p();
        }
        p(`</details>`);
        p();
    }
    return o;
}

export function renderReport(l: Ledger): string {
    const out: string[] = [];
    const p = (s = '') => out.push(s);

    if (/mock|fake/i.test(l.model)) {
        p(`> ⚠ **테스트 응답으로 만든 원장입니다** (\`${l.model}\`). 배관의 정확성을 보여주는 것이지 판정 품질의 증거가 아닙니다.`);
        p();
    }
    p(`# LLM 저자 · 적대적 검토 파이프라인 — 실행 원장`);
    p();
    p(`- 주제: **${l.topic}**`);
    p(`- 모델: \`${l.model}\``);
    p(`- 실행: ${l.startedAt} → ${l.finishedAt ?? '(미완료)'}`);
    p(
        `- 규모: 쟁점 ${l.issues.length}개 · 명제 ${l.coverage.claims}개 · 인용 ${l.coverage.citations}건 ` +
            `(원문확인 ${l.coverage.verified}, 검증불가 ${l.coverage.unverifiable}, **차단 ${l.coverage.blocking}**)`,
    );
    p(`- 원문 확보: 전문 ${l.coverage.fullText}건 / 전문 아님 ${l.coverage.notFullText}건 · **코드 강등 ${l.coverage.downgraded}건**`);
    p(`- 원문 대조 후 수정: **${l.coverage.revised}건** · 철회: **${l.coverage.withdrawn}건** (문자열 비교로 세므로 재서술도 포함될 수 있다 — 실제 변경은 ✎ 표시의 전후 문장으로 확인)`);
    p(`- 사람에게 물은 것: **${l.human.length}건**`);
    p(`- 호출: ${l.usage.calls}회 · 토큰 ${l.usage.prompt + l.usage.completion} (prompt ${l.usage.prompt} / completion ${l.usage.completion})`);
    p();

    // ── 1. 판정 요약 ───────────────────────────────────────────────────────────
    p(`## 1. 판정 요약`);
    p();
    p(`| 쟁점 | 명제 | 판정 | 근거 | 인용검증 | 사람 |`);
    p(`|---|---|---|---|---|---|`);
    for (const { issue, items } of l.issues) {
        for (const it of items) {
            p(
                `| ${esc(issue.id)} | ${esc(trunc(it.claim.proposition, 64))} | ${VERDICT_LABEL[it.judgment.verdict] ?? it.judgment.verdict}` +
                    `${it.changes?.some((c) => c.startsWith('판정자 절차에 맞춰')) ? ' ⇄' : ''}${it.downgrade ? ' ⬇' : ''}${it.original ? ' ✎' : ''} | ${GRADE_LABEL[it.evidence.grade] ?? it.evidence.grade} | ${citationLine(it)} | ${it.human.length || '—'} |`,
            );
        }
    }
    p();
    p(
        `⬇ = 코드가 등급을 내린 항목 — 근거(원문)가 그 등급을 지탱하지 못하거나, 반박이 요건(실질적인 반대 · 권위의 모순·오독)을 갖추지 못했다. ` +
            `⇄ 와 함께 있으면 내린 등급은 판정자가 낸 것이 아니라 절차 맞춤이 바꾼 것일 수 있다(상세의 ⬇ 줄에 판정자의 등급을 적는다). ` +
            `⇄ = 판정자 자신의 절차 답(전제·추론·대안)에 맞춰 코드가 등급을 바꾼 항목. ✎ = 원문을 본 뒤 명제를 고친 항목.`,
    );
    p();

    // ── 2. 분포 ────────────────────────────────────────────────────────────────
    const counts: Record<string, number> = {};
    for (const { items } of l.issues) for (const it of items) counts[it.judgment.verdict] = (counts[it.judgment.verdict] ?? 0) + 1;
    p(`## 2. 판정 분포`);
    p();
    p(Object.entries(counts).map(([k, v]) => `- ${VERDICT_LABEL[k] ?? k}: ${v}`).join('\n') || '- (없음)');
    if (Object.keys(counts).length === 1) {
        p();
        p(
            `> **경고**: 판정이 한 등급으로만 나왔습니다. 검토가 아니라 형식일 가능성이 높습니다 — 회의론자는 모든 것을 weak 라고도, 모든 것을 supported 라고도 말해서는 안 됩니다.`,
        );
    }
    p();

    // ── 3. 원문 확보 현황 ──────────────────────────────────────────────────────
    p(`## 3. 원문 확보 현황`);
    p();
    p(`| 인용 | 원문 상태 | 경로 | 분량 | 관련 대목 |`);
    p(`|---|---|---|---|---|`);
    for (const { citation, r } of uniqueSources(l)) {
        p(
            `| ${esc(trunc(citation, 58))} | ${SOURCE_LABEL[r.doc.state] ?? r.doc.state} | ${r.doc.how} | ` +
                `${(r.doc.chars ?? r.doc.fullText?.length ?? 0).toLocaleString() || '—'} | ${
                    r.authority.type === 'statute' || r.authority.type === 'precedent'
                        ? r.usable
                            ? '전문'
                            : '—'
                        : r.passages.length || '—'
                } |`,
        );
    }
    p();
    p(`> **"초록만" 은 근거가 아닙니다.** 이 파이프라인은 초록만 확보한 인용에 기대는 명제를 지지로 두지 않습니다 — 판정 모델이 지지를 냈더라도 코드가 내립니다.`);
    p();

    // ── 4. 사람에게 물은 것 ────────────────────────────────────────────────────
    p(`## 4. 사람에게 물은 것 (human-on-the-loop)`);
    p();
    if (!l.human.length) {
        p(`이 실행에서는 묻지 않았습니다 — 모든 인용의 원문을 확보했고 미결 항목도 없었습니다.`);
    } else {
        for (const h of l.human) {
            p(`### ${h.kind === 'source' ? '원문 요청' : '확인 질문'} · \`${h.id}\``);
            p();
            p(`**Q**: ${h.question}`);
            p();
            p(`*왜 물었나*: ${h.detail.split('\n')[0]}`);
            if (h.tried?.length) p(`*시도한 경로*: ${h.tried.join(', ')}`);
            p();
            p(
                `**A**: ${
                    h.answer.action === 'provided'
                        ? `제공 — \`${h.answer.note ?? '(경로 없음)'}\``
                        : h.answer.action === 'answered'
                          ? `답변 — ${h.answer.note ?? '(내용 없음)'}`
                          : `**없음** — 그 상태로 진행`
                } _(${h.answer.by})_`,
            );
            p();
        }
    }
    p();

    // ── 5. 쟁점별 상세 ─────────────────────────────────────────────────────────
    p(`## 5. 쟁점별 상세`);
    for (const { issue, items, withdrawn } of l.issues) {
        p();
        p(`### ${issue.id}. ${issue.question}`);
        p();
        p(`*왜 다투어지는가*: ${issue.why_contested}`);
        p();
        p(`*현재 견해*: ${issue.positions.join(' / ')}`);
        for (const it of items) {
            p();
            out.push(...renderItem(it));
        }
        if (withdrawn.length) {
            p();
            p(`#### 철회된 명제 (원문 대조 후 찬성측이 스스로 철회)`);
            p();
            p(`철회는 판정이 아니라 **찬성측이 자기 명제를 내려놓은 것**이다. 판정자가 반박한 것과 구별된다 — 이 구별이 없으면 "모델이 자기 주장을 검증했다"는 인상만 남는다.`);
            p();
            for (const w of withdrawn) {
                p(`- **${w.claim.id}** — ${w.why}`);
                p(`  - 원래 명제: ${w.originalProposition}`);
                for (const c of w.changes) p(`  - 이유: ${c}`);
            }
        }
    }

    // ── 6. 인용 원문 대조 ──────────────────────────────────────────────────────
    p(`---`);
    p();
    p(`## 6. 인용 원문 대조 (도구가 뽑은 실제 텍스트)`);
    p();
    const seen = new Set<string>();
    for (const { items } of l.issues) {
        for (const it of items) {
            for (const c of it.citations) {
                if (!c.quote || seen.has(c.citation)) continue;
                seen.add(c.citation);
                p(`### ${c.citation} \`${STATE_LABEL[c.state] ?? c.state}\``);
                if (c.resolved) p(`\`${c.resolved}\``);
                p();
                p('```');
                p(c.quote.slice(0, 900));
                p('```');
                p();
            }
        }
    }

    // ── 7. 한계 ────────────────────────────────────────────────────────────────
    p(`---`);
    p();
    p(`## 7. 이 실행이 말하지 않는 것`);
    p();
    p(
        `- **반대의 독립성**: 찬성측과 반대측은 같은 모델의 두 호출이다. 절차적으로는 독립이지만(정보 비대칭), 통계적으로는 독립이 아니다 — 같은 코퍼스, 같은 편향, 같은 실패 양식을 공유한다.`,
    );
    p(`- **판정의 정당성**: 판정은 모델의 판단이다. 인용이 원문에서 확인되었다는 사실은 그 인용이 명제를 지지한다는 것을 뜻하지 않는다.`);
    p(
        `- **관련 대목 추출은 어휘 기반이다**: 명제의 용어 빈도로 문단을 고른다. 다른 단어로 논증된 반대 논거는 놓칠 수 있다. 놓친 것은 "관련 없음"으로 처리되므로, 이 추출기는 검증기를 엄격한 쪽으로 틀리게 만든다(거짓 음성).`,
    );
    p(`- **커버리지**: 명제 ${l.coverage.claims}개. 이 주제의 쟁점 전부가 아니다.`);
    p(
        `- **검증불가 인용 ${l.coverage.unverifiable}건**: 학설·비교법은 서지 코퍼스가 없어 "그 인용이 실재하는가"를 확인하지 못했다. 사람이 제공한 원문은 **내용을 읽게** 해 주지만, 그 파일이 정말 인용된 그 논문인지는 확인하지 못한다 — 제공자의 보증에 기대는 부분이다.`,
    );
    p(
        `- **판정자가 그 대목을 실제로 읽었는지는 코드가 확인할 수 없다**: 원문 대목을 프롬프트에 넣는 것까지가 강제이고, 그것을 근거로 삼았는지는 판정문을 읽어야 안다. 그래서 판정마다 원문 대목을 함께 남긴다 — 확인은 사람이 한다.`,
    );
    p(
        `- **PDF 텍스트 추출 품질**: 2단 조판 PDF 는 띄어쓰기가 깨진다(\`압 수수색\`). 관련 대목 추출은 어휘 기반이므로 이 잡음에 민감하다. 이 실행에서 뽑힌 대목은 육안으로 확인하라.`,
    );
    p(
        `- **보정은 판정이 아니다**: 찬성측이 원문을 보고 스스로 고친 것이고, 고친 뒤에도 반대측의 공격과 판정자의 판정을 다시 거친다. 보정이 있었다는 사실은 "모델이 틀렸다가 고쳤다"는 뜻이며, 최종 판정의 근거가 아니다.`,
    );
    p(`- **어떤 명제도 자동으로 본문에 들어가지 않았다**. 이 원장은 논문이 아니라 논문의 재료다.`);
    p();

    return out.join('\n');
}

export function writeOutputs(ledger: Ledger, dir: string): { report: string; ledger: string } {
    mkdirSync(dir, { recursive: true });
    const reportPath = join(dir, 'report.md');
    const ledgerPath = join(dir, 'ledger.json');
    writeFileSync(reportPath, renderReport(ledger));
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
    return { report: reportPath, ledger: ledgerPath };
}

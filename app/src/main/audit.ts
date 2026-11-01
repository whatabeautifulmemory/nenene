// 프로젝트 작업 기록 내보내기 — 감사(audit)용.
//
// 한 프로젝트에서 무엇이 실제로 오갔는지를 파일 하나에 편다: 구상 대화(턴마다 무엇을 검색했고 무엇이 자료로
// 남았나), 조사 자료, 설계, 그리고 실행마다 진행 기록·검토 판정·필자의 답·LLM 요청과 응답 원문·원고.
//
// 원칙:
//   - **요약하지 않는다.** 긴 것은 접어 둘 뿐 자르지 않는다(LLM 요청·응답은 기록 단계에서 이미 40k 로 잘려 있다).
//   - 기록(record)을 먼저 데이터로 모으고 HTML 은 그것을 펴기만 한다. JSON 으로 내보내면 같은 기록이 그대로 나간다.
//   - HTML 은 파일 하나로 완결된다 — 외부 자원·스크립트가 없다(CSP 로 막는다). 모든 글은 이스케이프한다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STAGES, type ChatMessage, type ProjectFile, type ResearchNote } from '../shared/ipc.ts';

export interface AuditRun {
    name: string;
    dir: string;
    /** transcript.jsonl — 일어난 순서대로의 이벤트 */
    transcript: any[];
    /** ledger.json — 검토 판정·필자의 답·사용량 */
    ledger: any | null;
    /** calls.jsonl — LLM 요청과 응답 */
    calls: any[];
    paper?: string;
}

export interface AuditRecord {
    format: 'nenene.audit';
    version: 1;
    exportedAt: string;
    timeZone: string;
    app: { version: string };
    project: { id: string; dir: string; file: ProjectFile | null };
    /** 내보낼 때의 앱 설정(키 없음)과 법령·판례 목록 기준 */
    settings: unknown;
    corpus: unknown;
    dossier: any | null;
    /** conceive-calls.jsonl — 구상 단계(대화·조사 검색어·설계 뽑기)의 LLM 요청과 응답 */
    conceiveCalls: any[];
    references: string[];
    runs: AuditRun[];
}

const readJson = (p: string): any | null => {
    try {
        return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
        return null;
    }
};

const readJsonl = (p: string): any[] => {
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
            try {
                return JSON.parse(l);
            } catch {
                return { type: 'raw', text: l };
            }
        });
};

/** 프로젝트 폴더에서 기록을 모은다. 실행은 오래된 것부터(일어난 순서). */
export function collectAudit(args: { id: string; dir: string; settings: unknown; corpus: unknown; appVersion: string }): AuditRecord {
    const runsDir = join(args.dir, 'runs');
    const runs: AuditRun[] = existsSync(runsDir)
        ? readdirSync(runsDir)
              .filter((n) => !n.startsWith('.'))
              .sort()
              .map((name) => {
                  const d = join(runsDir, name);
                  const paperPath = join(d, 'paper.md');
                  return {
                      name,
                      dir: d,
                      transcript: readJsonl(join(d, 'transcript.jsonl')),
                      ledger: readJson(join(d, 'ledger.json')),
                      calls: readJsonl(join(d, 'calls.jsonl')),
                      ...(existsSync(paperPath) ? { paper: readFileSync(paperPath, 'utf8') } : {}),
                  };
              })
        : [];
    const refsDir = join(args.dir, 'references');
    return {
        format: 'nenene.audit',
        version: 1,
        exportedAt: new Date().toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        app: { version: args.appVersion },
        project: { id: args.id, dir: args.dir, file: readJson(join(args.dir, 'project.json')) },
        settings: args.settings,
        corpus: args.corpus,
        dossier: readJson(join(args.dir, 'dossier.json')),
        conceiveCalls: readJsonl(join(args.dir, 'conceive-calls.jsonl')),
        references: existsSync(refsDir) ? readdirSync(refsDir).filter((n) => !n.startsWith('.')).sort() : [],
        runs,
    };
}

// ---- HTML ------------------------------------------------------------------

const esc = (s: unknown) =>
    String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

/** 표시는 지역 시각, <time> 에는 원래 ISO. */
const time = (iso: unknown, withDate = false) => {
    const s = String(iso ?? '');
    const d = new Date(s);
    if (!s || Number.isNaN(d.getTime())) return '';
    const shown = d.toLocaleString('ko-KR', { ...(withDate ? { year: 'numeric', month: '2-digit', day: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    return `<time datetime="${esc(s)}">${esc(shown)}</time>`;
};

const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('ko-KR') : esc(n ?? ''));
const pre = (s: unknown, cls = '') => `<pre${cls ? ` class="${cls}"` : ''}>${esc(s)}</pre>`;
const json = (v: unknown) => pre(JSON.stringify(v, null, 2), 'json');
/** 접어 두는 상자. open 이면 펼친 채로. */
const fold = (summary: string, body: string, open = false, cls = '') => `<details${open ? ' open' : ''}${cls ? ` class="${cls}"` : ''}><summary>${summary}</summary><div class="fold">${body}</div></details>`;
const link = (url: unknown) => {
    const u = String(url ?? '');
    return /^https?:\/\//.test(u) ? `<a href="${esc(u)}" rel="noreferrer noopener">${esc(u)}</a>` : esc(u);
};
const STAGE_KO = Object.fromEntries(STAGES.map((s) => [s.id, s.label])) as Record<string, string>;
const SOURCE_KO: Record<string, string> = { url: '링크', web: '웹', wiki: '백과', kci: 'KCI', crossref: 'Crossref' };
const ANGLE_KO: Record<string, string> = { fact: '사실', law: '법령', ruling: '판례', scholarship: '학설', critique: '비판' };
const angle = (a: unknown) => esc(ANGLE_KO[String(a ?? '')] ?? a ?? '');
/** 그 시각의 UTC 차이(일광절약 반영) — 예: UTC+09:00 */
const utcOffset = (iso: string) => {
    const m = -new Date(iso).getTimezoneOffset();
    return `UTC${m >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(m) / 60)).padStart(2, '0')}:${String(Math.abs(m) % 60).padStart(2, '0')}`;
};
const VERDICT_KO: Record<string, string> = { supported: '지지', weak: '약함', refuted: '반박됨', unresolved: '미결' };
const ACTION_KO: Record<string, string> = { provided: '제공', unavailable: '없음', answered: '직접 답함' };

function usageText(u: any): string {
    if (!u) return '';
    const p = u.prompt ?? 0;
    const c = u.completion ?? 0;
    return `입력 ${num(p)} · 출력 ${num(c)} 토큰${u.calls !== undefined ? ` · 호출 ${num(u.calls)}회` : ''}`;
}

function researchHtml(note: ResearchNote): string {
    const searches = note.searches ?? [];
    const items = note.items ?? [];
    const failed = note.failed ?? [];
    const sent = searches.reduce((n, x) => n + (x.times ?? 1), 0);
    const head = `${note.scope === 'initial' ? '프로젝트 조사' : '이 발언으로 더 찾은 것'} — 자료 ${num(note.count)}건${sent ? ` · 검색 ${sent}회` : ''}${failed.length ? ` · 못 읽은 링크 ${failed.length}건` : ''}`;
    if (!note.items) {
        return fold(esc(head), `<p class="muted">이전 버전의 기록이라 앞의 몇 건만 있습니다.</p><ul>${note.sample.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`, false, 'research');
    }
    const sTable = searches.length
        ? `<table><thead><tr><th>출처</th><th>검색어</th><th>각도</th><th>공급자</th><th class="r">결과</th><th class="r">남김</th></tr></thead><tbody>${searches
              .map((x) => `<tr><td>${esc(SOURCE_KO[x.source] ?? x.source)}</td><td>${esc(x.q)}${x.times && x.times > 1 ? ` <span class="muted">(${num(x.times)}회)</span>` : ''}</td><td>${angle(x.angle)}</td><td>${esc(x.provider ?? '')}</td><td class="r">${num(x.results ?? '')}</td><td class="r">${num(x.kept)}</td></tr>`)
              .join('')}</tbody></table>`
        : '';
    const iTable = items.length ? findingsTable(items) : '<p class="muted">남은 자료 없음</p>';
    const fList = failed.length ? `<h5>못 읽은 링크</h5><ul class="bad">${failed.map((f) => `<li>${link(f.url)}${f.error ? ` — ${esc(f.error)}` : ''}</li>`).join('')}</ul>` : '';
    return fold(esc(head), `${sTable ? `<h5>검색</h5>${sTable}` : ''}<h5>자료</h5>${iTable}${fList}`, false, 'research');
}

/** 조사 자료 표 — 발췌는 행마다 접어 둔다. */
function findingsTable(items: any[]): string {
    return `<table class="findings"><thead><tr><th>#</th><th>출처</th><th>검색어</th><th>자료</th></tr></thead><tbody>${items
        .map((f) => {
            const excerpt = [f.summary && f.quote && f.summary !== f.quote ? `<p class="muted">${esc(f.summary)}</p>` : '', `<blockquote>${esc(f.quote || f.summary || '')}</blockquote>`, `<p class="muted">${[f.kind ? `종류 ${esc(f.kind)}` : '', f.provider ? `공급자 ${esc(f.provider)}` : '', f.authority !== undefined ? `신뢰도 ${esc(f.authority)}/4` : '', f.fetchedAt ? `수집 ${time(f.fetchedAt, true)}` : ''].filter(Boolean).join(' · ')}</p>`].join('');
            return `<tr><td class="id">${esc(f.id ?? '')}</td><td>${esc(SOURCE_KO[f.source] ?? f.source ?? '')}</td><td>${esc(f.query ?? '')}</td><td>${fold(esc(f.citation), `${f.url ? `<p>${link(f.url)}</p>` : ''}${excerpt}`)}</td></tr>`;
        })
        .join('')}</tbody></table>`;
}

function chatHtml(chat: ChatMessage[]): string {
    if (!chat.length) return '<p class="muted">대화가 없습니다.</p>';
    return chat
        .map((m, i) => {
            const who = m.role === 'user' ? '필자' : '파트너(모델)';
            const meta = [time(m.at, true), m.model ? esc(m.model) : '', m.usage ? usageText(m.usage) : ''].filter(Boolean).join(' · ');
            return `<article class="turn ${m.role === 'user' ? 'user' : 'assistant'}" id="chat-${i + 1}"><header><span class="who">${i + 1}. ${who}</span><span class="muted">${meta}</span></header>${pre(m.content, 'text')}${m.research ? researchHtml(m.research) : ''}</article>`;
        })
        .join('');
}

function dossierHtml(d: any): string {
    if (!d) return '<p class="muted">조사 자료가 없습니다.</p>';
    const searches: any[] = d.searches ?? [];
    const fetched: any[] = d.fetched ?? [];
    return [
        `<p>주제: ${esc(d.topic)} · 조사 방식 ${esc(d.v ?? '')} · 자료 ${num((d.findings ?? []).length)}건</p>`,
        d.queries?.length ? `<p class="muted">맥락의 단서: ${esc(d.queries.join(' · '))}</p>` : '',
        searches.length
            ? `<h4>검색</h4><table><thead><tr><th>출처</th><th>검색어</th><th>각도</th><th>공급자</th><th class="r">결과</th><th class="r">남김</th></tr></thead><tbody>${searches.map((x) => `<tr><td>${esc(SOURCE_KO[x.source] ?? x.source)}</td><td>${esc(x.q)}${x.times && x.times > 1 ? ` <span class="muted">(${num(x.times)}회)</span>` : ''}</td><td>${angle(x.angle)}</td><td>${esc(x.provider ?? '')}</td><td class="r">${num(x.results ?? '')}</td><td class="r">${num(x.kept)}</td></tr>`).join('')}</tbody></table>`
            : '<p class="muted">검색 기록 없음(이전 버전에서 만든 자료).</p>',
        fetched.length ? `<h4>직접 읽은 페이지</h4><table><thead><tr><th>주소</th><th>결과</th></tr></thead><tbody>${fetched.map((f) => `<tr class="${f.ok ? '' : 'bad'}"><td>${link(f.url)}</td><td>${f.ok ? `읽음 ${num(f.chars ?? '')}자` : `실패 ${esc(f.error ?? '')}`}</td></tr>`).join('')}</tbody></table>` : '',
        `<h4>자료</h4>${findingsTable(d.findings ?? [])}`,
    ].join('');
}

/** 진행 기록 한 줄. 형태를 아는 이벤트는 읽기 좋게, 모르는 것은 JSON 그대로 — 버리지 않는다. */
function eventRow(r: any): string {
    const t = r?.type;
    const at = `<td class="ts">${time(r?.at)}</td>`;
    const row = (kind: string, body: string, cls = '') => `<tr class="ev ${cls}">${at}<td class="kind">${kind}</td><td>${body}</td></tr>`;
    switch (t) {
        case 'run-start':
            return row('시작', `${esc(r.model)} · 규모 ${esc(r.scale)} · ${esc(r.mode)}${fold('설정·배경·설계', json({ settings: r.settings, corpus: r.corpus, context: r.context, plan: r.plan }))}`, 'major');
        case 'progress':
            return row('진행', esc(r.line));
        case 'stage':
            return row('단계', `<b>${esc(STAGE_KO[r.stage] ?? r.stage)}</b> ${esc({ start: '시작', done: '완료', skip: '건너뜀', error: '오류' }[r.status as string] ?? r.status)}${r.detail ? ` — ${esc(r.detail)}` : ''}`, r.status === 'error' ? 'bad' : '');
        case 'tool': {
            const e = r.event ?? {};
            const extra = e.input || e.output ? fold('입력·출력', `${e.input ? `<h5>입력</h5>${pre(e.input)}` : ''}${e.output ? `<h5>출력</h5>${pre(e.output)}` : ''}`) : '';
            return row('도구', `<b>${esc(e.name)}</b> ${e.ok ? '✓' : '✗'} ${esc(e.subject)} <span class="muted">${esc(e.kind)} · ${num(e.ms)}ms${e.detail ? ` · ${esc(e.detail)}` : ''}</span>${extra}`, e.ok ? '' : 'bad');
        }
        case 'plan':
            return row('설계', `${esc(r.plan?.thesis?.title ?? r.plan?.title ?? '')} · 장 ${num((r.plan?.sections ?? []).length)}개${fold('설계 전체', json(r.plan))}`);
        case 'section':
            return row('장', `${esc(r.phase === 'revised' ? '수정본' : '초고')} — ${esc(r.section?.title ?? r.section?.id)} <span class="muted">(기록에는 앞 400자만)</span>${fold('미리보기', pre(r.phase === 'revised' ? r.section?.revised : r.section?.draft))}`);
        case 'cites':
            return row('인용', `인용 상태 ${num((r.cites ?? []).length)}건${fold('표', json(r.cites))}`);
        case 'review': {
            const it = r.item ?? {};
            return row('판정', `[${esc(r.sectionId)}] <b>${esc(VERDICT_KO[it.judgment?.verdict] ?? it.judgment?.verdict)}</b> ${esc(it.claim?.proposition ?? '')}${fold('주장·반대·판정', itemHtml(it))}`, it.judgment?.verdict === 'refuted' ? 'bad' : '');
        }
        case 'reviews':
            return row('판정 갱신', `[${esc(r.sectionId)}] ${num((r.items ?? []).length)}건으로 바꿈${fold('목록', json((r.items ?? []).map((x: any) => ({ id: x.claim?.id, verdict: x.judgment?.verdict, claim: x.claim?.proposition }))))}`);
        case 'asks':
            return row('질문', `<ol>${(r.asks ?? []).map((a: any) => `<li><code>${esc(a.id)}</code> <b>${esc(a.kind === 'source' ? '원문 요청' : '확인 질문')}</b> ${esc(a.question)}${a.detail ? `<div class="muted">${esc(a.detail)}</div>` : ''}${a.tried?.length ? `<div class="muted">시도한 경로: ${a.tried.map((t: unknown) => `<code>${esc(t)}</code>`).join(' ')}</div>` : ''}${a.consequence ? `<div class="muted">답이 없으면: ${esc(a.consequence)}</div>` : ''}</li>`).join('')}</ol>${fold('질문 원문(JSON)', json(r.asks))}`, 'major');
        case 'answers':
            return row('필자의 답', `<ol>${Object.entries(r.answers ?? {}).map(([id, a]: [string, any]) => `<li><code>${esc(id)}</code> → <b>${esc(ACTION_KO[a?.action] ?? a?.action)}</b>${a?.by ? ` <span class="muted">(${esc(a.by)})</span>` : ''}${a?.note ? ` ${esc(a.note)}` : ''}${a?.path ? ` <code>${esc(a.path)}</code>` : ''}${a?.url ? ` ${link(a.url)}` : ''}</li>`).join('')}</ol>`, 'major');
        case 'done':
            return row('완료', `${usageText(r.summary?.usage)}${fold('요약', json(r.summary))}`, 'major ok');
        case 'error':
            return row('오류', pre(r.message), 'major bad');
        case 'cancelled':
            return row('중단', `${r.message ? pre(r.message) : ''}${r.summary ? `${usageText(r.summary.usage)}${fold('요약', json(r.summary))}` : ''}`, 'major bad');
        default:
            return row(esc(t ?? '기타'), json(r));
    }
}

/** 검토 원장의 한 항목 — 주장, 근거, 반대, 판정. */
function itemHtml(it: any): string {
    const j = it.judgment ?? {};
    const o = it.objection ?? {};
    const c = it.claim ?? {};
    return [
        `<p><b>${esc(c.id)}</b> ${esc(c.proposition)}</p>`,
        c.premise || c.step ? `<p class="muted">전제: ${esc(c.premise ?? '')}<br>추론: ${esc(c.step ?? '')}</p>` : '',
        c.authority?.length ? `<p class="muted">근거: ${esc(c.authority.map((a: any) => a.citation ?? a.cite ?? JSON.stringify(a)).join(' · '))}</p>` : '',
        `<h5>반대${o.strength ? ` (${esc(o.strength)})` : ''}${o.attack ? ` · ${esc(o.attack)}` : ''}</h5><p>${esc(o.objection ?? '')}</p>${o.alternative ? `<p class="muted">대안: ${esc(o.alternative)}</p>` : ''}`,
        `<h5>판정 — ${esc(VERDICT_KO[j.verdict] ?? j.verdict)} · 확신 ${esc(j.confidence ?? '')}${j.objection_quality ? ` · 반대의 성격 ${esc(j.objection_quality)}` : ''}</h5><p>${esc(j.reasoning ?? '')}</p>`,
        j.surviving?.length ? `<p class="muted">남는 반대: ${esc(j.surviving.join(' / '))}</p>` : '',
        it.downgrade ? `<p class="bad">코드 강등: ${esc(JSON.stringify(it.downgrade))}</p>` : '',
        it.changes?.length ? `<p class="muted">고친 것: ${esc(it.changes.join(' / '))}</p>` : '',
        fold('원장 항목 전체(JSON)', json(it)),
    ].join('');
}

function ledgerHtml(l: any): string {
    if (!l) return '<p class="muted">원장이 없습니다(실행이 끝나기 전에 멈췄을 수 있습니다).</p>';
    const issues: any[] = l.issues ?? [];
    const head = `<p>${time(l.startedAt, true)} → ${time(l.finishedAt, true)} · ${esc(l.model)} · ${usageText(l.usage)}</p>${l.coverage ? `<p class="muted">주장 ${num(l.coverage.claims)} · 인용 ${num(l.coverage.citations)}(원문 확인 ${num(l.coverage.verified)}) · 강등 ${num(l.coverage.downgraded)} · 수정 ${num(l.coverage.revised)} · 철회 ${num(l.coverage.withdrawn)}</p>` : ''}`;
    const body = issues
        .map((g) => {
            const items: any[] = g.items ?? [];
            const rows = items
                .map((it) => `<tr class="${it.judgment?.verdict === 'refuted' ? 'bad' : ''}"><td class="id">${esc(it.claim?.id)}</td><td>${esc(VERDICT_KO[it.judgment?.verdict] ?? it.judgment?.verdict)}</td><td>${fold(esc(it.claim?.proposition ?? ''), itemHtml(it))}</td></tr>`)
                .join('');
            const withdrawn = (g.withdrawn ?? []).length ? fold(`철회된 주장 ${num(g.withdrawn.length)}건`, json(g.withdrawn)) : '';
            return `<h5>${esc(g.issue?.title ?? g.issue?.question ?? g.issue?.id ?? '')}</h5><table><thead><tr><th>#</th><th>판정</th><th>주장</th></tr></thead><tbody>${rows}</tbody></table>${withdrawn}`;
        })
        .join('');
    const human = (l.human ?? []).length
        ? `<h4>필자에게 물은 것과 답</h4><ol>${l.human.map((h: any) => `<li>${esc(h.question)} → <b>${esc(ACTION_KO[h.answer?.action] ?? h.answer?.action)}</b>${h.answer?.note ? ` ${esc(h.answer.note)}` : ''}</li>`).join('')}</ol>`
        : '';
    const quality = l.paper?.quality ? fold('품질 점검 기록(반대 근거·보강·재검증·인용 대조)', json(l.paper.quality)) : '';
    return `${head}${body}${human}${quality}`;
}

function callsHtml(calls: any[]): string {
    if (!calls.length) return '<p class="muted">LLM 호출 기록이 없습니다.</p>';
    const total = calls.reduce((a, c) => ({ p: a.p + (c.usage?.prompt ?? 0), c: a.c + (c.usage?.completion ?? 0), ms: a.ms + (c.ms ?? 0) }), { p: 0, c: 0, ms: 0 });
    return `<p class="muted">${num(calls.length)}회 · 입력 ${num(total.p)} · 출력 ${num(total.c)} 토큰 · 합계 ${num(Math.round(total.ms / 1000))}초. 요청·응답은 기록할 때 4만 자에서 잘렸습니다.</p>${calls
        .map(
            (c, i) =>
                c?.type === 'raw'
                    ? `<details class="call bad"><summary><span class="id">${i + 1}</span> 읽지 못한 기록 줄(끊긴 기록)</summary><div class="fold">${pre(c.text)}</div></details>`
                    : `<details class="call${c.error ? ' bad' : ''}"><summary><span class="id">${i + 1}</span> ${time(c.at)} · <b>${esc(c.role)}</b> · ${esc(c.model)} · ${esc(c.route)} · ${num(c.ms)}ms${c.usage ? ` · ${num(c.usage.prompt)}→${num(c.usage.completion)}` : ''}${c.attempt ? ` · 대체 프로파일 ${esc(c.attempt)}` : ''}${c.retry ? ` · 재시도 ${esc(c.retry)}` : ''}${c.error ? ` · <span class="bad">${esc(c.error)}</span>` : ''}</summary><div class="fold"><p class="muted">${esc(c.baseUrl)}${c.status ? ` · HTTP ${esc(c.status)}` : ''}</p><h5>요청</h5>${pre(c.request)}<h5>응답</h5>${pre(c.response)}</div></details>`,
        )
        .join('')}`;
}

function runHtml(r: AuditRun, i: number): string {
    const end = [...r.transcript].reverse().find((x) => x?.type === 'done' || x?.type === 'error' || x?.type === 'cancelled');
    const outcome = end ? ({ done: '완료', error: '오류', cancelled: '중단' } as Record<string, string>)[end.type] : r.ledger?.finishedAt ? '완료' : '기록 없음';
    return `<section class="run" id="run-${i + 1}"><h3>${i + 1}. ${esc(r.name)} <span class="pill ${end?.type ?? ''}">${esc(outcome)}</span></h3>
<p class="muted"><code>${esc(r.dir)}</code></p>
${fold(`진행 기록 — ${num(r.transcript.length)}줄`, r.transcript.length ? `<table class="events"><tbody>${r.transcript.map(eventRow).join('')}</tbody></table>` : '<p class="muted">진행 기록(transcript.jsonl)이 없습니다.</p>', true)}
${fold('검토 원장 — 주장·반대·판정', ledgerHtml(r.ledger))}
${fold(`LLM 요청·응답 — ${num(r.calls.length)}회`, callsHtml(r.calls))}
${r.paper ? fold(`원고 — ${num(r.paper.length)}자`, pre(r.paper, 'text')) : ''}
</section>`;
}

const CSS = `
:root{color-scheme:light dark;--bg:#fbfaf7;--panel:#fff;--ink:#1c1b18;--muted:#6f6b63;--line:#e4e1d9;--accent:#1f6f5f;--soft:#e3efea;--bad:#b23b2e;--bad-soft:#fbe9e6;--ok:#2f7a4e;--code:#f1f0ec}
@media (prefers-color-scheme:dark){:root{--bg:#17171a;--panel:#1f1f23;--ink:#e8e6e1;--muted:#a19d95;--line:#34343a;--accent:#6cc0a8;--soft:#21332e;--bad:#ef8a7c;--bad-soft:#3a2522;--ok:#7cc79a;--code:#2a2a30}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:13.5px/1.6 -apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif}
main{max-width:1080px;margin:0 auto;padding:28px 20px 80px}
h1{font-size:20px;margin:0 0 6px} h2{font-size:16px;margin:36px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)} h3{font-size:14.5px;margin:22px 0 6px} h4{font-size:13.5px;margin:16px 0 6px} h5{font-size:12.5px;margin:10px 0 4px;color:var(--muted)}
a{color:var(--accent);overflow-wrap:anywhere}
.muted{color:var(--muted)} .bad{color:var(--bad)}
.meta{display:grid;grid-template-columns:max-content 1fr;gap:2px 14px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.meta dt{color:var(--muted)} .meta dd{margin:0;overflow-wrap:anywhere}
nav.toc{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin-top:14px} nav.toc ol{margin:4px 0;padding-left:20px}
pre{margin:4px 0;white-space:pre-wrap;word-break:break-word;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);border-radius:6px;padding:8px 10px;max-height:520px;overflow:auto}
pre.text{font:13.5px/1.7 -apple-system,'Apple SD Gothic Neo',sans-serif;background:transparent;padding:0;max-height:none}
code{font:12px ui-monospace,Menlo,monospace;background:var(--code);padding:1px 4px;border-radius:4px;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;margin:4px 0;font-size:12.5px} th,td{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top} th{color:var(--muted);font-weight:600} td.r,th.r{text-align:right;white-space:nowrap}
td.id,span.id{color:var(--muted);font-weight:700;white-space:nowrap} td.ts{color:var(--muted);white-space:nowrap;font:11.5px ui-monospace,Menlo,monospace;width:70px} td.kind{white-space:nowrap;font-weight:600;width:70px}
tr.bad td{color:var(--bad)} tr.major td{background:var(--soft)} tr.major.bad td{background:var(--bad-soft)}
details{margin:4px 0} summary{cursor:pointer;overflow-wrap:anywhere} .fold{padding:4px 0 6px 14px;border-left:2px solid var(--line);margin:4px 0 8px 4px}
blockquote{margin:4px 0;padding:4px 10px;border-left:3px solid var(--accent);color:var(--ink)}
.turn{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--line);border-radius:8px;padding:10px 14px;margin:10px 0} .turn.user{border-left-color:var(--accent)} .turn.assistant{border-left-color:var(--muted)}
.turn header{display:flex;gap:10px;flex-wrap:wrap;align-items:baseline;margin-bottom:4px} .who{font-weight:700}
details.research{background:var(--soft);border-radius:8px;padding:6px 10px}
details.call{border-bottom:1px solid var(--line);padding:2px 0} details.call.bad summary{color:var(--bad)}
.run{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:4px 16px 12px;margin:14px 0}
.pill{font-size:11.5px;font-weight:600;padding:1px 8px;border-radius:999px;background:var(--code);color:var(--muted);vertical-align:2px} .pill.done{background:var(--soft);color:var(--ok)} .pill.error,.pill.cancelled{background:var(--bad-soft);color:var(--bad)}
ol{margin:2px 0;padding-left:20px}
:target{outline:2px solid var(--accent);outline-offset:4px}
@media (max-width:640px){main{padding:16px 12px 60px} td.ts,td.kind{width:auto}}
@media print{body{background:#fff;color:#000} details{break-inside:avoid} pre{max-height:none}}
`;

/** 기록 → 자기완결 HTML. 스크립트가 없다(CSP 로 막는다) — JS 를 꺼도 전부 읽힌다. */
export function auditHtml(rec: AuditRecord): string {
    const p = rec.project.file;
    const chat = p?.chat ?? [];
    const runs = rec.runs;
    const calls = runs.reduce((a, r) => a + r.calls.length, 0);
    const tokens = runs.reduce((a, r) => ({ p: a.p + (r.ledger?.usage?.prompt ?? 0), c: a.c + (r.ledger?.usage?.completion ?? 0) }), { p: 0, c: 0 });
    const chatTokens = chat.reduce((a, m) => ({ p: a.p + (m.usage?.prompt ?? 0), c: a.c + (m.usage?.completion ?? 0) }), { p: 0, c: 0 });
    const searches = chat.reduce((a, m) => a + (m.research?.searches ?? []).reduce((n, x) => n + (x.times ?? 1), 0), 0);
    const title = p?.topic || rec.project.id;
    const meta: [string, string][] = [
        ['프로젝트', `${esc(rec.project.id)}<br><code>${esc(rec.project.dir)}</code>`],
        ['내보낸 때', `${time(rec.exportedAt, true)} (${esc(rec.timeZone)}, ${esc(utcOffset(rec.exportedAt))}) — 이 문서의 시각은 모두 이 시간대로 적었고, 원래 값(UTC)은 각 시각에 들어 있습니다`],
        ['앱', `Nenene ${esc(rec.app.version)}`],
        ['구상 대화', `${num(chat.length)}턴 · 조사 검색 ${num(searches)}회 · ${usageText({ prompt: chatTokens.p, completion: chatTokens.c })}`],
        ['실행', `${num(runs.length)}회 · LLM 호출 ${num(calls)}회 · ${usageText({ prompt: tokens.p, completion: tokens.c })}`],
        ['구상 단계 LLM 호출', `${num(rec.conceiveCalls.length)}회`],
        ['참고문헌 파일', `${num(rec.references.length)}개`],
    ];
    const toc = [
        `<li><a href="#setup">주제·배경·설정</a></li>`,
        `<li><a href="#chat">구상 대화</a> (${num(chat.length)}턴)</li>`,
        `<li><a href="#dossier">조사 자료</a></li>`,
        `<li><a href="#plan">설계</a></li>`,
        `<li><a href="#runs">실행</a><ol>${runs.map((r, i) => `<li><a href="#run-${i + 1}">${esc(r.name)}</a></li>`).join('')}</ol></li>`,
    ].join('');
    return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Nenene 작업 기록</title>
<style>${CSS}</style></head><body><main>
<h1>${esc(title)}</h1>
<p class="muted">Nenene 작업 기록 — 이 프로젝트에서 실제로 오간 것을 순서대로 폈습니다. 긴 것은 접어 두었을 뿐 자르지 않았습니다(LLM 요청·응답은 기록 단계의 4만 자 제한).</p>
<dl class="meta">${meta.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
<nav class="toc"><b>차례</b><ol>${toc}</ol></nav>

<h2 id="setup">주제·배경·설정</h2>
<p><b>주제</b> ${esc(p?.topic ?? '')}</p>
${p?.context ? `<h4>배경·맥락</h4>${pre(p.context, 'text')}` : ''}
${fold('내보낼 때의 앱 설정(키 제외)', json(rec.settings))}
${fold('법령·판례 목록 기준', json(rec.corpus))}
${rec.references.length ? fold(`참고문헌 파일 ${num(rec.references.length)}개`, `<ul>${rec.references.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`) : ''}

<h2 id="chat">구상 대화</h2>
${chatHtml(chat)}
${fold(`구상 단계 LLM 요청·응답 — ${num(rec.conceiveCalls.length)}회 (대화·조사 검색어·설계 뽑기)`, rec.conceiveCalls.length ? callsHtml(rec.conceiveCalls) : '<p class="muted">기록이 없습니다 — 이 기능이 생기기 전의 대화이거나 대화를 하지 않았습니다.</p>')}

<h2 id="dossier">조사 자료 <span class="muted">(지금 저장된 것 — 하루가 지나면 다시 조사해 덮입니다. 턴마다의 기록은 위 대화에 있습니다)</span></h2>
${dossierHtml(rec.dossier)}

<h2 id="plan">설계</h2>
${p?.plan ? json(p.plan) : '<p class="muted">설계가 없습니다.</p>'}

<h2 id="runs">실행</h2>
${runs.length ? runs.map(runHtml).join('') : '<p class="muted">실행이 없습니다.</p>'}
</main></body></html>`;
}

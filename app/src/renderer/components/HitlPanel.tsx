import { useState } from 'react';
import { Globe, HelpCircle, Paperclip } from 'lucide-react';
import type { Answer, Ask } from '../../shared/ipc.ts';
import { draftOf, updateDraft, useDrafts, withRef, type Draft } from '../lib/hitlDrafts.ts';

const URL_RE = /https?:\/\/[^\s<>"'「」『』]+/g;

/** 끝의 문장부호·짝 없는 ')'·영숫자 뒤에 붙은 한글 꼬리를 뗀다(src/law/sources.ts trimUrl 과 같은 규칙 — law.go.kr 한글주소는 '(…)' 로 끝난다). */
function trimUrl(u: string): string {
    // "…(2000헌마25)에서" 처럼 닫는 괄호 뒤에 붙은 한글도 문장이다.
    let t = u.replace(/(?<=[A-Za-z0-9=&_\-)])[가-힣]+$/, '').replace(/[.,;\]]+$/, '');
    while (t.endsWith(')') && (t.match(/\(/g) ?? []).length < (t.match(/\)/g) ?? []).length) t = t.slice(0, -1);
    return t;
}

/** 질문 문장에서 인용을 꺼낸다 — 질문은 늘 `"<인용>" 의 원문을 …` 꼴이다(인용 안에 큰따옴표가 있어도 끝까지). */
const citationOf = (a: Ask) => a.question.match(/^"([\s\S]+)"\s*의 원문을/)?.[1] ?? a.question.match(/"([^"]{4,})"/)?.[1] ?? '';

/** 사건번호 — 실제 사건부호만(헌마·헌바…, 도·다·누·두·노·나·구합·고단…). "제12권2호"·"2023년 3월" 같은 것은 아니다. */
const CASE_RE = /\b(\d{2,4})\s*(헌[가나다라마바사아]|구합|구단|가합|가단|가소|고합|고단|고정|카합|카단|재[가-힣]?|도|다|누|두|노|나|허|후|모|오|초|추|그|드|르|므|브|스|으|느)\s*(\d{1,7})\b/;

/**
 * 원문을 찾아볼 곳 — 질문에 든 후보 주소가 먼저, 그다음 인용으로 만든 검색.
 * 논문(저자, 「제목」, 학술지…)이면 학술 검색, 법령이면 법제처, 판례·결정이면 그 번호의 법제처 주소, DOI 면 doi.org.
 * 논문 제목 안에 사건번호나 「…법」이 들어 있어도 논문으로 본다(판례평석이 흔하다).
 */
function placesFor(a: Ask): { label: string; url: string }[] {
    const out: { label: string; url: string }[] = [];
    const seen = new Set<string>();
    const add = (label: string, url: string) => {
        if (!seen.has(url)) {
            seen.add(url);
            out.push({ label, url });
        }
    };
    for (const raw of `${a.detail}\n${a.question}`.match(URL_RE) ?? []) {
        const u = trimUrl(raw);
        add(/kci\.go\.kr/.test(u) ? 'KCI 후보' : /law\.go\.kr/.test(u) ? '법제처 후보' : '후보 위치', u);
    }
    const cite = citationOf(a).trim();
    const doi = `${a.detail} ${a.question}`.match(/\b10\.\d{4,9}\/[^\s"'<>]+/)?.[0]?.replace(/[.,;)]$/, '');
    if (doi) add('DOI', `https://doi.org/${doi}`);
    // 논문 꼴: 「제목」 앞에 저자(쉼표)가 있거나, 뒤에 학술지·권호·면이 있다.
    const scholarship = /[^\s「]\s*,\s*「/.test(cite) || /」\s*,\s*[^,]+(?:권|호|Vol|vol|No|학회|학보|논총|논집|연구|저널|Review|Journal)/.test(cite);
    const titled = cite.match(/「([^」]{2,})」/)?.[1];
    let statute: string | undefined;
    let caseNo: string | undefined;
    if (!scholarship) {
        // 「주민등록법」 제6조 · 개인정보 보호법 제2조 · 형사소송법 시행령 제3조
        statute = cite.match(/^「([^」]*(?:법|법률|령|규칙|조례))」/)?.[1] ?? cite.match(/^([^\s,「」]+(?:\s[^\s,「」]+){0,4}?(?:법|법률|시행령|시행규칙))\s+제\s*\d+\s*조/)?.[1];
        const m = cite.match(CASE_RE);
        if (m) caseNo = `${m[1]}${m[2]}${m[3]}`;
    }
    if (statute) add('법제처', `https://www.law.go.kr/법령/${encodeURIComponent(statute)}`);
    // 법제처 판례·헌재결정례 바로가기 — 파이프라인(src/law/decisions.ts)과 같은 주소 규칙.
    if (caseNo) add(/헌/.test(caseNo) ? '헌재 결정' : '판례', /헌/.test(caseNo) ? `https://www.law.go.kr/헌재결정례/(${caseNo})` : `https://www.law.go.kr/판례/(${caseNo})`);
    if (scholarship || (!statute && !caseNo)) {
        const q = titled ?? cite;
        if (q) {
            add('RISS', `https://www.riss.kr/search/Search.do?query=${encodeURIComponent(q)}`);
            add('DBpia', `https://www.dbpia.co.kr/search/topSearch?searchOption=all&query=${encodeURIComponent(q)}`);
        }
    }
    if (cite) add('구글 학술검색', `https://scholar.google.com/scholar?q=${encodeURIComponent(titled ?? cite)}`);
    return out;
}

/** 질문 설명 — 안의 주소를 누르면 원문 찾기 브라우저로 연다. */
function DetailText({ text, onOpen }: { text: string; onOpen: (url: string) => void }) {
    const parts: (string | { url: string })[] = [];
    let last = 0;
    for (const m of text.matchAll(URL_RE)) {
        const url = trimUrl(m[0]);
        const at = m.index ?? 0;
        if (at > last) parts.push(text.slice(last, at));
        parts.push({ url });
        last = at + url.length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return (
        <pre className="ask-detail">
            {parts.map((p, i) =>
                typeof p === 'string' ? (
                    p
                ) : (
                    <a
                        key={i}
                        href={p.url}
                        className="ask-link"
                        title="앱 안 브라우저로 열기 — 원문을 띄워 바로 넣을 수 있습니다"
                        onClick={(e) => {
                            e.preventDefault();
                            onOpen(p.url);
                        }}
                    >
                        {p.url}
                    </a>
                ),
            )}
        </pre>
    );
}

/**
 * 사람에게 묻기 — 모달이 아니라 본문 맨 위의 인라인 패널.
 *
 * 규칙은 CLI 때와 같다: 모든 질문에 답이 간다. 손대지 않은 질문은 「없음」으로 보낸다.
 * 「제공」을 고르고 경로를 비워 두거나 「직접 답함」을 고르고 글을 비워 두면 보낼 수 없다 — 빈 답은 답이 아니다
 * (빈 「직접 답함」은 파이프라인이 "형식을 알 수 없음"으로 그냥 두고, 다시 묻지도 않았다. 답 파일도 같은 것을 받지 않는다 — hitl.ts).
 * 초안은 패널 밖(lib/hitlDrafts.ts)에 있다 — 탭·프로젝트를 오가도 남는다.
 */
export function HitlPanel({ asks, projectId, onSubmit }: { asks: Ask[]; projectId: string; onSubmit: (a: Record<string, Answer>) => void }) {
    const draft = useDrafts();
    const [busy, setBusy] = useState(false);

    const get = (id: string): Draft => draftOf(draft, id);
    const set = (id: string, patch: Partial<Draft>) => updateDraft(id, (d) => ({ ...d, ...patch }));

    const openIn = (a: Ask, url: string) => void window.legal.openSourceBrowser({ askId: a.id, label: citationOf(a) || a.question, url, projectId });

    const blocked = asks.some((a) => {
        const d = get(a.id);
        return (d.action === 'provided' || d.action === 'answered') && !d.note.trim();
    });
    const untouched = asks.filter((a) => get(a.id).action === null).length;

    return (
        <section className="hitl" aria-live="polite">
            <header className="hitl-head">
                <HelpCircle size={18} />
                <div>
                    <h3>사람의 답이 필요합니다 · {asks.length}건</h3>
                    <p>원문을 구하지 못했거나 기록에 없는 사실이 필요한 항목입니다. 답하면 그 자리에서 계속됩니다.</p>
                </div>
            </header>
            <div className="hitl-list">
                {asks.map((a, i) => {
                    const d = get(a.id);
                    return (
                        <div className="ask" key={a.id}>
                            <div className="ask-q">
                                <span className="ask-n">{i + 1}</span>
                                <span>{a.question}</span>
                                <span className="chip">{a.kind === 'source' ? '원문' : '확인'}</span>
                            </div>
                            {a.detail && <DetailText text={a.detail} onOpen={(url) => openIn(a, url)} />}
                            {a.kind === 'source' && (
                                <div className="ask-find">
                                    <span>
                                        <Globe size={13} /> 원문 찾기
                                    </span>
                                    {placesFor(a).map((p) => (
                                        <button key={p.url} className="tiny" title={`${p.url}\n앱 안 브라우저로 엽니다. 거기서 내려받은 파일은 자동으로 이 질문에 붙습니다.`} onClick={() => openIn(a, p.url)}>
                                            {p.label}
                                        </button>
                                    ))}
                                </div>
                            )}
                            {a.tried && a.tried.length > 0 && (
                                <div className="ask-tried">
                                    <span>시도한 경로</span>
                                    {a.tried.map((t, j) => (
                                        <code key={j}>{t}</code>
                                    ))}
                                </div>
                            )}
                            <div className="choices">
                                <button className={`choice ${d.action === 'provided' ? 'on' : ''}`} onClick={() => set(a.id, { action: 'provided' })}>
                                    제공
                                </button>
                                <button className={`choice ${d.action === 'unavailable' || d.action === null ? 'on' : ''}`} onClick={() => set(a.id, { action: 'unavailable' })}>
                                    없음
                                </button>
                                <button className={`choice ${d.action === 'answered' ? 'on' : ''}`} onClick={() => set(a.id, { action: 'answered' })}>
                                    직접 답함
                                </button>
                            </div>
                            {d.action !== 'unavailable' && (d.added ?? []).some((y) => d.note.includes(y.ref)) && (
                                <p className="ask-added">
                                    브라우저에서 넣음:{' '}
                                    {(d.added ?? [])
                                        .filter((y) => d.note.includes(y.ref))
                                        .map((y) => (
                                            <span key={y.ref} className="chip" title={decodeURI(y.ref)}>
                                                ✓ {y.name}
                                            </span>
                                        ))}
                                </p>
                            )}
                            {d.action === 'provided' && (
                                <div className="ask-input">
                                    <input type="text" placeholder="/경로/논문.pdf · file:// · https://… (여러 개면 띄어서)" value={d.note} onChange={(e) => set(a.id, { note: e.target.value })} />
                                    <button
                                        onClick={async () => {
                                            // main 이 file:// 주소로 준다(공백·#·?·한글·윈도 경로가 인코딩된다).
                                            const ref = await window.legal.refsPick();
                                            // 덧붙인다 — 브라우저로 넣은 것을 지우지 않는다. 창이 떠 있는 동안 브라우저에서 붙은 것도 있으므로 지금 값에 붙인다.
                                            if (ref) updateDraft(a.id, (cur) => ({ ...cur, note: withRef(cur.note, ref) }));
                                        }}
                                    >
                                        <Paperclip size={14} /> 파일 선택
                                    </button>
                                </div>
                            )}
                            {d.action === 'answered' && (
                                <div className="ask-input">
                                    <textarea rows={3} placeholder="확인한 내용을 적어 주세요. URL 을 넣으면 가져와 읽고, 나머지는 판정에 그대로 반영됩니다." value={d.note} onChange={(e) => set(a.id, { note: e.target.value })} />
                                </div>
                            )}
                            {(d.action === 'unavailable' || d.action === null) && a.consequence && <p className="ask-consequence">{a.consequence}</p>}
                        </div>
                    );
                })}
            </div>
            <footer className="hitl-foot">
                <span className="hint">{blocked ? '「제공」은 경로·주소를, 「직접 답함」은 확인한 내용을 적어야 보낼 수 있습니다.' : untouched > 0 ? `손대지 않은 ${untouched}건은 「없음」으로 보냅니다.` : '모든 항목에 답했습니다.'}</span>
                <button
                    className="primary"
                    disabled={blocked || busy}
                    onClick={() => {
                        setBusy(true);
                        const out: Record<string, Answer> = {};
                        for (const a of asks) {
                            const d = get(a.id);
                            const note = d.note.trim();
                            out[a.id] = { action: d.action ?? 'unavailable', ...(note ? { note } : {}), by: 'ui' };
                        }
                        onSubmit(out);
                    }}
                >
                    {busy ? '보내는 중…' : '답하고 계속'}
                </button>
            </footer>
        </section>
    );
}

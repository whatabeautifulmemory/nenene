import { useEffect, useRef, useState } from 'react';
import { Check, FolderOpen, KeyRound, RefreshCw } from 'lucide-react';
import { keyScope, type ModelInfo, type ModelProbe, type PaperScale, type ProviderDef, type SearchProviderStatus, type Settings } from '../../shared/ipc.ts';

const ROLES: { id: keyof Settings['roles']; label: string; hint: string }[] = [
    { id: 'planner', label: '설계', hint: '논지·목차' },
    { id: 'writer', label: '집필', hint: '초고·수정' },
    { id: 'worker', label: '추출', hint: '주장·인용' },
    { id: 'con', label: '반대', hint: '반대 논증' },
    { id: 'judge', label: '판정', hint: '판정' },
];

const SCALES: { id: PaperScale; label: string; hint: string }[] = [
    { id: 'short', label: '짧게', hint: '5~6장 · 약 12k자' },
    { id: 'standard', label: '표준', hint: '7~9장 · 약 22k자' },
    { id: 'long', label: '길게', hint: '9~12장 · 약 35k자' },
];

const DEPTHS: { id: number; label: string; hint: string }[] = [
    { id: 1, label: '1단계', hint: '인용한 원문의 참고문헌까지 봅니다.' },
    { id: 2, label: '2단계', hint: '그 참고문헌의 참고문헌까지 봅니다(기본).' },
    { id: 3, label: '3단계', hint: '한 단계 더 들어갑니다. 오래 걸립니다.' },
];

const fmt = (n: number) => n.toLocaleString('ko-KR');

/** 키 하나를 OS 키체인에 넣는 작은 폼. 모델 키와 검색 키가 같은 모양으로 쓴다. */
function KeyInput(props: { keyId: string; placeholder: string; saved: boolean; disabled?: boolean; onSaved?: () => void }) {
    const [key, setKey] = useState('');
    const [note, setNote] = useState('');
    const save = async () => {
        if (!key.trim()) return;
        const r = await window.legal.setKey(props.keyId, key.trim());
        setNote(r.ok ? '키체인에 저장했습니다.' : `저장하지 못했습니다 — ${r.error ?? ''}`);
        if (r.ok) {
            setKey('');
            props.onSaved?.();
        }
    };
    return (
        <div className="keyline">
            <div className="row tight">
                <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={props.saved ? '저장됨 — 바꾸려면 새 키 입력' : props.placeholder} disabled={props.disabled} />
                <button onClick={() => void save()} disabled={!key.trim() || props.disabled} title="OS 키체인에 저장">
                    <KeyRound size={13} /> 저장
                </button>
            </div>
            {note && <span className="hint">{note}</span>}
        </div>
    );
}

/**
 * 검색·자료 공급자. 모델 공급자와 **다른 것**이다 — 모델은 글을 쓰고, 검색은 자료를 찾는다.
 * DeepSeek 만 둘 다 한다(검색 API 가 모델 키를 쓴다). 나머지 검색 공급자는 제 키가 따로 있다.
 */
function SearchSection(props: { settings: Settings; onPatch: (p: Partial<Settings>) => void }) {
    const [rows, setRows] = useState<SearchProviderStatus[]>([]);
    const [loading, setLoading] = useState(true);
    const load = async () => {
        setLoading(true);
        try {
            setRows(await window.legal.searchProviders());
        } finally {
            setLoading(false);
        }
    };
    useEffect(() => {
        void load();
    }, []);
    const web = rows.filter((r) => r.kind === 'web');
    const scholar = rows.filter((r) => r.kind === 'scholar');
    return (
        <section className="settings-section">
            <h3>
                검색·자료 공급자
                <button className="ghost tiny" onClick={() => void load()} title="상태 다시 읽기">
                    <RefreshCw size={12} />
                </button>
            </h3>
            <p className="hint">
                조사·헌재 결정 원문·구상 대화의 검색이 쓰는 곳입니다. <strong>모델 공급자와 별개</strong>이며, 키가 있는 공급자를 위에서부터 순서대로 씁니다.
            </p>
            {loading && rows.length === 0 ? (
                <p className="hint">상태를 읽는 중…</p>
            ) : (
                <>
                    <div className="provider-list">
                        {web.map((r, i) => (
                            <div key={r.id} className="provider-row stacked">
                                <div className="row tight">
                                    <span className="muted">{i + 1}.</span>
                                    <span className={`dot ${r.available ? 'ok' : ''}`} />
                                    <span style={{ flex: 1 }}>{r.label}</span>
                                    <span className={r.available ? 'ok-text' : 'muted'}>{r.available ? '사용 가능' : r.needsKey ? '키 없음' : '대기'}</span>
                                </div>
                                {r.note && <span className="hint indent">{r.note}</span>}
                                {r.keyId && <KeyInput keyId={r.keyId} placeholder={`${r.label} API 키`} saved={r.available} onSaved={() => void load()} />}
                            </div>
                        ))}
                    </div>
                    <div className="field">
                        <label>우선순위</label>
                        <input
                            type="text"
                            value={props.settings.searchOrder ?? ''}
                            onChange={(e) => props.onPatch({ searchOrder: e.target.value })}
                            placeholder={web.map((r) => r.id).join(',')}
                        />
                        <span className="hint">쉼표로 나열합니다. 비우면 기본 순서. 저장 후 상태를 다시 읽으면 순서가 반영됩니다.</span>
                    </div>
                    {scholar.length > 0 && (
                        <div className="provider-list">
                            {scholar.map((r) => (
                                <div key={r.id} className="provider-row stacked">
                                    <div className="row tight">
                                        <span className={`dot ${r.available ? 'ok' : 'warn'}`} />
                                        <span style={{ flex: 1 }}>{r.label}</span>
                                        <span className={r.available ? 'ok-text' : 'muted'}>{r.available ? '등록 키' : '키 필요'}</span>
                                    </div>
                                    {r.note && <span className="hint indent">{r.note}</span>}
                                    {r.keyId && <KeyInput keyId={r.keyId} placeholder="KCI OpenAPI 인증키" saved={r.available} onSaved={() => void load()} />}
                                </div>
                            ))}
                        </div>
                    )}
                </>
            )}
            <div className="field">
                <label>연락처 이메일 (Unpaywall — 학술 논문 열린 원문 찾기)</label>
                <input type="text" value={props.settings.contactEmail} onChange={(e) => props.onPatch({ contactEmail: e.target.value })} placeholder="you@example.com" />
            </div>
        </section>
    );
}

export function SettingsDialog(props: {
    providers: ProviderDef[];
    settings: Settings;
    hasKey: boolean;
    workspace: string;
    onClose: () => void;
    onSaved: (s: Settings) => void | Promise<void>;
    onWorkspaceChanged: (ws: string) => void | Promise<void>;
}) {
    const [s, setS] = useState<Settings>(props.settings);
    const [hasKey, setHasKey] = useState(props.hasKey);
    const [busy, setBusy] = useState(false);

    const provider = props.providers.find((p) => p.id === s.provider);
    const patch = (p: Partial<Settings>) => setS((v) => ({ ...v, ...p }));
    const endpoint = provider?.endpointEditable ? (s.endpoints?.[provider.id] ?? '') : '';
    const base = (endpoint.trim() || provider?.baseUrl || '').replace(/\/+$/, '');
    const scope = keyScope(provider, base);
    const modelName = s.model || provider?.models[0] || '';
    const outputCap = provider?.maxOutput?.[modelName];
    const [probe, setProbe] = useState<ModelProbe | null>(null);
    const [probing, setProbing] = useState(false);
    const [ctx, setCtx] = useState<number | null>(null);
    const seedOk = (provider?.transport ?? 'openai-compatible') === 'openai-compatible';
    const fetched: ModelInfo[] = probe?.models ?? [];
    const choices = [...new Set([...(provider?.models ?? []), ...fetched.map((m) => m.id)])];

    // 키 보관 이름이 바뀌면(공급자·주소 변경) 저장 여부를 다시 읽는다.
    useEffect(() => {
        let alive = true;
        void window.legal.hasKey(scope).then((v) => alive && setHasKey(v));
        return () => {
            alive = false;
        };
    }, [scope]);
    // 고른 모델의 문맥 길이 — 받아온 목록에 있으면 그것, 아니면 기존 구현 가 옮겨 온 표에서.
    useEffect(() => {
        const hit = fetched.find((m) => m.id === modelName)?.contextLength;
        if (hit) {
            setCtx(hit);
            return;
        }
        let alive = true;
        void window.legal.modelContext(modelName).then((v) => alive && setCtx(v));
        return () => {
            alive = false;
        };
    }, [modelName, probe]);

    // 응답이 늦게 오면 그사이 공급자·주소가 바뀌었을 수 있다 — 지금의 scope 에 대한 응답만 받는다.
    const probeFor = useRef('');
    useEffect(() => {
        probeFor.current = scope;
        setProbe(null);
    }, [scope]);
    const loadModels = async () => {
        if (!provider) return;
        const asked = scope;
        setProbing(true);
        try {
            const r = await window.legal.listModels(provider.id, provider.endpointEditable ? endpoint : undefined);
            if (probeFor.current === asked) setProbe(r);
        } finally {
            setProbing(false);
        }
    };

    const pickProvider = (id: string) => {
        const p = props.providers.find((x) => x.id === id);
        if (!p) return;
        // 공급자를 바꾸면 모델을 비운다 — "그 공급자의 기본을 쓴다"가 의도이기 때문.
        patch({ provider: p.id, model: '' });
        setProbe(null);
    };
    const probeNote = (pr: ModelProbe | null) =>
        !pr
            ? ''
            : pr.status === 'ok'
              ? `${fmt(pr.models.length)}개 모델 (도구 호출을 못 한다고 밝힌 모델은 뺐습니다)`
              : pr.status === 'unauthorized'
                ? '공급자에 닿았으나 키를 거절했습니다 — 키를 확인하세요.'
                : pr.status === 'unreachable'
                  ? '아무것도 응답하지 않았습니다 — 주소나 네트워크를 확인하세요. 키 문제가 아닙니다.'
                  : pr.status === 'none'
                    ? '이 공급자는 목록을 주지 않아 기본 목록을 씁니다.'
                    : '목록을 읽지 못했습니다.';

    return (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
            <div className="modal settings" style={{ width: 'min(720px, 100%)' }} role="dialog" aria-label="설정">
                <header>
                    <h2>설정</h2>
                    <p>모델은 글을 쓰고, 검색 공급자는 자료를 찾습니다. 둘은 따로 설정합니다. 모든 키는 OS 키체인에 저장되고 이 화면으로 내려오지 않습니다.</p>
                </header>
                <div className="content">
                    <section className="settings-section">
                        <h3>모델 공급자</h3>
                        <div className="row top">
                            <div className="field">
                                <label>공급자</label>
                                <select value={s.provider} onChange={(e) => pickProvider(e.target.value)}>
                                    {props.providers.map((p) => (
                                        <option key={p.id} value={p.id}>
                                            {p.label}
                                        </option>
                                    ))}
                                </select>
                                {provider?.note && <span className="hint">{provider.note}</span>}
                            </div>
                            <div className="field">
                                <label>모델</label>
                                <div className="row tight">
                                    <input
                                        type="text"
                                        list="model-choices"
                                        value={s.model}
                                        onChange={(e) => patch({ model: e.target.value })}
                                        placeholder={provider?.models[0] ? `공급자 기본 — ${provider.models[0]}` : '모델명 (목록 불러오기로 확인)'}
                                    />
                                    <datalist id="model-choices">
                                        {choices.map((m) => (
                                            <option key={m} value={m} />
                                        ))}
                                    </datalist>
                                    <button onClick={() => void loadModels()} disabled={probing || !provider} title="공급자에게 쓸 수 있는 모델을 묻는다">
                                        <RefreshCw size={13} /> {probing ? '읽는 중' : '목록'}
                                    </button>
                                </div>
                                {probe && <span className={`hint ${probe.status === 'ok' ? '' : 'warn-text'}`}>{probeNote(probe)}</span>}
                                {!modelName && <span className="hint warn-text">이 공급자는 기본 모델이 없습니다 — 모델을 고르거나 적어 주세요.</span>}
                            </div>
                        </div>

                        {provider?.endpointEditable && (
                            <div className="field">
                                <label>주소</label>
                                <input
                                    type="text"
                                    value={endpoint}
                                    onChange={(e) => patch({ endpoints: { ...(s.endpoints ?? {}), [provider.id]: e.target.value } })}
                                    placeholder={provider.baseUrl}
                                />
                                <span className="hint">
                                    요청 경로(/chat/completions)가 붙는 완전한 주소 — 버전 경로까지 그대로 적습니다. 비우면 <code>{provider.baseUrl}</code>. 키는 주소별로 따로 보관되어, 주소를 바꾸면 빈 키 칸이 보입니다.
                                </span>
                            </div>
                        )}

                        <div className="field">
                            <label>
                                API 키{provider?.auth === 'optional' ? ' (선택)' : ''} {hasKey && <span className="ok-text">· 저장됨 <Check size={12} /></span>}
                            </label>
                            {provider?.auth === 'none' ? (
                                <span className="hint">이 공급자는 키가 필요 없습니다.</span>
                            ) : (
                                <KeyInput key={scope} keyId={scope} placeholder={provider?.keyHint ?? 'sk-…'} saved={hasKey} onSaved={() => setHasKey(true)} />
                            )}
                            {provider?.authHeader && provider.authHeader !== 'bearer' && (
                                <span className="hint">
                                    키는 <code>{provider.authHeader}</code> 헤더로 보냅니다.
                                </span>
                            )}
                        </div>

                        <div className="row top">
                            <div className="field">
                                <label>temperature</label>
                                <input type="number" step="0.05" min="0" max="2" value={s.temperature} onChange={(e) => patch({ temperature: Math.min(2, Math.max(0, Number(e.target.value) || 0)) })} />
                            </div>
                            <div className="field">
                                <label>top_p</label>
                                <input
                                    type="number"
                                    step="0.05"
                                    min="0"
                                    max="1"
                                    value={s.topP ?? ''}
                                    placeholder="공급자 기본"
                                    onChange={(e) => patch({ topP: e.target.value === '' ? undefined : Math.min(1, Math.max(0, Number(e.target.value) || 0)) })}
                                />
                            </div>
                            <div className="field">
                                <label>seed</label>
                                <input
                                    type="number"
                                    step="1"
                                    value={s.seed ?? ''}
                                    placeholder={seedOk ? '보내지 않음' : '이 공급자는 받지 않음'}
                                    disabled={!seedOk}
                                    onChange={(e) => patch({ seed: e.target.value === '' ? undefined : Math.round(Number(e.target.value) || 0) })}
                                />
                            </div>
                        </div>
                        <div className="field">
                            <label>응답 최대 토큰 (max_tokens)</label>
                            <input
                                type="number"
                                step="1024"
                                min="1"
                                max={outputCap ?? 1_000_000}
                                value={s.maxTokens}
                                onChange={(e) => patch({ maxTokens: Math.min(outputCap ?? 1_000_000, Math.max(1, Math.floor(Number(e.target.value) || 1))) })}
                            />
                            <span className={`hint ${outputCap && s.maxTokens > outputCap ? 'warn-text' : ''}`}>
                                한 번의 호출이 <strong>생성</strong>하는 토큰의 상한입니다. 문맥 길이(입력+출력)와 다릅니다.
                                {outputCap ? ` 이 모델의 출력 상한 ${fmt(outputCap)}` : ''}
                                {ctx ? ` · 문맥 ${fmt(ctx)}` : ''}
                                {' · '}장 하나는 보통 4~8k 토큰이면 충분합니다. top_p 를 정하면 Anthropic 에는 temperature 와 함께 보내지 않습니다.
                            </span>
                        </div>

                        <div className="field">
                            <label>역할별 모델</label>
                            <span className="hint">비우면 위의 기본 모델을 씁니다. 판정을 다른 모델로 두면 같은 모델끼리의 상관이 줄어듭니다. 다른 공급자를 고르면 그 공급자의 키를 씁니다 — 위에서 그 공급자를 골라 키를 저장해 두세요.</span>
                            <div className="roles">
                                {ROLES.map((r) => {
                                    const cur = s.roles?.[r.id] ?? { provider: '', model: '' };
                                    const prov = props.providers.find((p) => p.id === cur.provider);
                                    return (
                                        <div key={r.id} className="role-row">
                                            <span className="role-label" title={r.hint}>
                                                {r.label}
                                            </span>
                                            <select value={cur.provider} onChange={(e) => patch({ roles: { ...s.roles, [r.id]: { provider: e.target.value, model: '' } } })}>
                                                <option value="">기본</option>
                                                {props.providers.map((p) => (
                                                    <option key={p.id} value={p.id}>
                                                        {p.label}
                                                    </option>
                                                ))}
                                            </select>
                                            <input
                                                type="text"
                                                list={`role-models-${r.id}`}
                                                placeholder={prov ? (prov.id === provider?.id ? `기본 — ${modelName || '모델 필요'}` : prov.models[0] ? `기본 — ${prov.models[0]}` : '모델 필요') : `기본 — ${modelName || '공급자 모델'}`}
                                                value={cur.model}
                                                onChange={(e) => patch({ roles: { ...s.roles, [r.id]: { provider: cur.provider || s.provider, model: e.target.value } } })}
                                            />
                                            <datalist id={`role-models-${r.id}`}>
                                                {(prov ?? provider)?.models.map((m) => (
                                                    <option key={m} value={m} />
                                                ))}
                                            </datalist>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </section>

                    <SearchSection settings={s} onPatch={patch} />

                    <section className="settings-section">
                        <h3>논문</h3>
                        {/* 선택지가 셋뿐이라 드롭다운 대신 버튼으로 둔다 — 드롭다운은 설명이 붙은 항목 글이 잘렸다. */}
                        <div className="row top">
                            <div className="field">
                                <label>기본 규모</label>
                                <div className="seg fill">
                                    {SCALES.map((x) => (
                                        <button key={x.id} className={(s.scale ?? 'standard') === x.id ? 'on' : ''} aria-pressed={(s.scale ?? 'standard') === x.id} onClick={() => patch({ scale: x.id })}>
                                            {x.label}
                                        </button>
                                    ))}
                                </div>
                                <span className="hint">{SCALES.find((x) => x.id === (s.scale ?? 'standard'))?.hint}</span>
                            </div>
                            <div className="field">
                                <label>참고문헌 따라가기</label>
                                <div className="seg fill">
                                    {DEPTHS.map((x) => (
                                        <button key={x.id} className={(s.snowballDepth ?? 2) === x.id ? 'on' : ''} aria-pressed={(s.snowballDepth ?? 2) === x.id} onClick={() => patch({ snowballDepth: x.id })}>
                                            {x.label}
                                        </button>
                                    ))}
                                </div>
                                <span className="hint">{DEPTHS.find((x) => x.id === (s.snowballDepth ?? 2))?.hint} 이미 본 문헌은 다시 찾지 않고, 새로 가져오는 문헌은 최대 12건입니다.</span>
                            </div>
                        </div>
                        <div className="field">
                            <label className="check">
                                <input type="checkbox" checked={s.assumeUnavailable} onChange={(e) => patch({ assumeUnavailable: e.target.checked })} />
                                원문이 없어도 묻지 않고 진행
                            </label>
                            <span className="hint indent">질문 단계를 건너뛰고, 확보하지 못한 원문은 모두 「없음」으로 기록합니다.</span>
                        </div>
                    </section>

                    <section className="settings-section">
                        <h3>앱</h3>
                        <div className="row top">
                            <div className="field" style={{ flex: 2 }}>
                                <label>워크스페이스</label>
                                <div className="row tight">
                                    <code className="path">{props.workspace || '~/Documents/Nenene'}</code>
                                    <button
                                        onClick={async () => {
                                            const ws = await window.legal.workspaceChoose();
                                            if (ws) await props.onWorkspaceChanged(ws);
                                        }}
                                    >
                                        <FolderOpen size={14} /> 변경
                                    </button>
                                </div>
                            </div>
                            <div className="field">
                                <label>테마</label>
                                <select value={s.theme ?? 'system'} onChange={(e) => patch({ theme: e.target.value as Settings['theme'] })}>
                                    <option value="system">시스템</option>
                                    <option value="light">라이트</option>
                                    <option value="dark">다크</option>
                                </select>
                            </div>
                        </div>
                    </section>
                </div>
                <footer>
                    <button className="ghost" onClick={props.onClose}>
                        취소
                    </button>
                    <button
                        className="primary"
                        disabled={busy}
                        onClick={async () => {
                            setBusy(true);
                            try {
                                const saved = await window.legal.saveSettings(s);
                                await props.onSaved(saved);
                            } finally {
                                setBusy(false);
                            }
                        }}
                    >
                        {busy ? '저장 중…' : '저장'}
                    </button>
                </footer>
            </div>
        </div>
    );
}

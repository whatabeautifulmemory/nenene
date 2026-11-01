import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ArrowLeft, FileClock, Settings as SettingsIcon } from 'lucide-react';
import type { Answer, ChatMessage, Ledger, MainEvent, ProjectFile, ProjectMeta, ProviderDef, RefFile, RunInfo, RunSummary, RunTag, Settings } from '../../shared/ipc.ts';
import { Titlebar } from '../components/Titlebar.tsx';
import { clearDrafts } from '../lib/hitlDrafts.ts';
import { initialRun, runReducer, runStatus } from '../lib/runState.ts';
import { Conceive } from '../stages/Conceive.tsx';
import { Manuscript } from '../stages/Manuscript.tsx';
import { Write } from '../stages/Write.tsx';

type StageKey = 'conceive' | 'write' | 'manuscript';

const STAGE_TABS: { id: StageKey; label: string }[] = [
    { id: 'conceive', label: '구상' },
    { id: 'write', label: '집필' },
    { id: 'manuscript', label: '원고' },
];

const emptyFile = (topic: string): ProjectFile => ({ version: 1, topic, context: '', manuscript: '', savedAt: '', chat: [], plan: null });

/** runs/ 이름은 시각순으로 정렬되는 문자열이다. 가장 최근 것이 앞에 오게. */
const sortRuns = (runs: RunInfo[]): RunInfo[] => [...runs].sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));

/**
 * 한 프로젝트의 작업 화면. 구상 · 집필 · 원고 세 단계를 오가되 상태는 전부 여기 있다.
 * 프로젝트가 바뀌면 App 이 key 로 이 컴포넌트를 새로 마운트한다.
 */
export function Workspace(props: { project: ProjectMeta; providers: ProviderDef[]; settings: Settings; onBack: () => void; onSettings: () => void; onProjectChanged: () => void }) {
    const { project, settings, providers } = props;

    const [stage, setStage] = useState<StageKey>('conceive');
    const [file, setFile] = useState<ProjectFile | null>(null);
    const fileRef = useRef<ProjectFile>(emptyFile(project.topic));
    const [dirty, setDirty] = useState(false);
    const [savedAt, setSavedAt] = useState<Date | null>(null);
    const [refs, setRefs] = useState<RefFile[]>([]);
    const [runs, setRuns] = useState<RunInfo[]>([]);
    const [ledger, setLedger] = useState<Ledger | null>(null);
    const [currentRunDir, setCurrentRunDir] = useState<string | undefined>(undefined);
    const [run, dispatch] = useReducer(runReducer, undefined, initialRun);
    /** 이 화면이 따라가는 실행과 마지막으로 받은 이벤트 순번 — 다른 프로젝트·다른 실행(멈춘 앞 실행)의 이벤트는 받지 않는다. */
    const runIdRef = useRef<string | null>(null);
    /** 새 실행을 여는 동안 붙잡아 둔 앞 실행의 이벤트(거절되면 되살린다) */
    const heldRef = useRef<{ prevId: string; events: { e: MainEvent; from: RunTag }[] } | null>(null);
    const seqRef = useRef(0);
    /** 실행 상태(runStatus)를 받기 전에 온 이 프로젝트의 이벤트 — 받은 뒤 순번을 보고 이어 붙인다. null 이면 바로 받는다. */
    const earlyRef = useRef<{ e: MainEvent; from: RunTag }[] | null>([]);
    const startingRef = useRef(false);
    const [stopping, setStopping] = useState(false);
    // 구상 대화의 답을 기다리는 중 — 구상 탭을 떠났다 와도(Conceive 가 다시 마운트돼도) 남아야 두 번째 메시지를 막는다.
    const [chatBusy, setChatBusy] = useState(false);
    const [chatError, setChatError] = useState<string | null>(null);

    const changedRef = useRef(props.onProjectChanged);
    changedRef.current = props.onProjectChanged;
    const saveTimer = useRef<number | null>(null);
    const dirtyRef = useRef(false);
    dirtyRef.current = dirty;

    // ---- 프로젝트 파일 ----
    const update = useCallback((patch: Partial<ProjectFile>) => {
        const next = { ...fileRef.current, ...patch };
        fileRef.current = next;
        setFile(next);
        setDirty(true);
    }, []);

    const save = useCallback(
        async (patch?: Partial<ProjectFile>) => {
            if (saveTimer.current) {
                window.clearTimeout(saveTimer.current);
                saveTimer.current = null;
            }
            const next = { ...fileRef.current, ...(patch ?? {}), savedAt: new Date().toISOString() };
            fileRef.current = next;
            setFile(next);
            await window.legal.projectSave(project.id, next);
            setDirty(false);
            setSavedAt(new Date());
            changedRef.current();
        },
        [project.id],
    );

    // 작업 기록 내보내기 — 디스크의 기록을 읽으므로 저장하지 않은 편집이 있으면 먼저 저장한다.
    const [exporting, setExporting] = useState(false);
    const [exported, setExported] = useState<{ path?: string; error?: string } | null>(null);
    const exportAudit = async () => {
        setExporting(true);
        try {
            if (dirty) await save();
            const r = await window.legal.auditExport(project.id);
            if (r) setExported('path' in r ? { path: r.path } : { error: r.error });
        } catch (e) {
            setExported({ error: e instanceof Error ? e.message : String(e) });
        } finally {
            setExporting(false);
        }
    };

    const saveSoon = useCallback(
        (patch: Partial<ProjectFile>) => {
            update(patch);
            if (saveTimer.current) window.clearTimeout(saveTimer.current);
            saveTimer.current = window.setTimeout(() => void save(), 800);
        },
        [update, save],
    );

    // 프로젝트를 나갈 때 저장하지 않은 것(디바운스 대기 중이든 원고 편집이든)은 흘려보낸다 —
    // 「← 프로젝트」 한 번에 편집이 사라지는 것보다 조용히 저장되는 편이 낫다.
    useEffect(() => {
        return () => {
            if (saveTimer.current) window.clearTimeout(saveTimer.current);
            if (saveTimer.current || dirtyRef.current) {
                void window.legal.projectSave(project.id, { ...fileRef.current, savedAt: new Date().toISOString() });
            }
        };
    }, [project.id]);

    // ---- 로드 ----
    useEffect(() => {
        let dead = false;
        earlyRef.current = [];
        void (async () => {
            const [proj, refList, runList, live] = await Promise.all([
                window.legal.projectLoad(project.id),
                window.legal.refsList(project.id),
                window.legal.listRuns(project.id),
                // 나가 있는 동안 돌던(또는 그사이 끝난) 실행. 전에는 다시 들어오면 빈 화면이라, 기다리던 질문이 다시 뜨지 않아 실행이 영영 멈춰 있었다.
                window.legal.runStatus(project.id),
            ]);
            if (dead) return;
            const f: ProjectFile = proj ? { ...emptyFile(project.topic), ...proj } : emptyFile(project.topic);
            fileRef.current = f;
            setFile(f);
            setRefs(refList);
            const sorted = sortRuns(runList);
            setRuns(sorted);
            setStage(f.manuscript.trim() ? 'manuscript' : 'conceive');

            if (live) {
                // 그 실행을 처음부터 다시 그리고, 상태를 받기 전에 온 이벤트는 순번을 보고 이어 붙인다.
                runIdRef.current = live.runId;
                seqRef.current = live.seq;
                dispatch({ type: 'resume', events: live.events, running: live.running, asks: live.asks });
                const early = earlyRef.current ?? [];
                earlyRef.current = null;
                for (const x of early) takeRef.current(x.e, x.from);
                const end = live.events[live.events.length - 1];
                if (end?.type === 'done') {
                    // 나가 있는 동안 끝났다 — 화면에 있었으면 했을 일(원고·원장 저장)을 지금 한다. 지난 원장으로 덮지 않게 여기서 끝낸다.
                    await onDoneRef.current(end.summary);
                    void window.legal.runAck(live.runId);
                    return;
                }
                if (end?.type === 'error') void window.legal.runAck(live.runId);
                setStage('write');
            } else earlyRef.current = null;

            const latest = sorted.find((r) => r.dir === f.runDir && r.hasLedger) ?? sorted.find((r) => r.hasLedger) ?? sorted.find((r) => r.hasPaper);
            if (!latest) return;
            setCurrentRunDir(latest.dir);
            const [l, p] = await Promise.all([latest.hasLedger ? window.legal.loadLedger(latest.dir) : null, latest.hasPaper ? window.legal.loadPaper(latest.dir) : null]);
            if (dead) return;
            if (l) {
                setLedger(l);
                // 실행을 다시 그렸으면 지난 원장으로 덮지 않는다.
                if (!live) dispatch({ type: 'seed', ledger: l });
            }
            if (p && !f.manuscript.trim()) {
                // 프로젝트 파일에 원고가 없는데 실행에는 있다 — 보여 주되 저장은 사용자가 한다.
                update({ manuscript: p, runDir: latest.dir });
                if (!live) setStage('manuscript');
            }
        })();
        return () => {
            dead = true;
        };
    }, [project.id, project.topic, update]);

    // ---- 실행 이벤트 ----
    const onDone = useCallback(
        async (s: RunSummary) => {
            setCurrentRunDir(s.runDir);
            const paper = s.paperMarkdown ?? (await window.legal.loadPaper(s.runDir)) ?? fileRef.current.manuscript;
            await save({ manuscript: paper, runDir: s.runDir });
            const l = await window.legal.loadLedger(s.runDir);
            if (l) setLedger(l);
            setRuns(sortRuns(await window.legal.listRuns(project.id)));
            setStage('manuscript');
        },
        [project.id, save],
    );
    const onDoneRef = useRef(onDone);
    onDoneRef.current = onDone;

    /**
     * 이 화면이 따라가는 실행의 이벤트 하나. 다른 프로젝트의 실행, 멈춘 앞 실행, 이미 받은 순번은 버린다.
     * from 이 없으면 시험용 주입(index.ts 의 스크린샷 모드)이라 그대로 받는다. 끝(done·error)을 받으면 main 에 알린다 — 다시 들어와도 되풀이하지 않게.
     */
    const take = (e: MainEvent, from?: RunTag) => {
        if (from) {
            // 새 실행을 여는 사이(main 의 답을 기다리는 동안) 온 앞 실행의 이벤트는 잠시 둔다 — main 이 새 실행을 거절하면 되살린다.
            if (heldRef.current && from.projectId === project.id && from.runId === heldRef.current.prevId) {
                heldRef.current.events.push({ e, from });
                return;
            }
            if (from.projectId !== project.id || from.runId !== runIdRef.current || from.seq <= seqRef.current) return;
            seqRef.current = from.seq;
        }
        dispatch({ type: 'event', e });
        if (e.type === 'done') void onDoneRef.current(e.summary).then(() => from && window.legal.runAck(from.runId));
        else if (e.type === 'error' && from) void window.legal.runAck(from.runId);
    };
    const takeRef = useRef(take);
    takeRef.current = take;

    useEffect(() => {
        return window.legal.onEvent((e, from) => {
            // 실행 상태를 받기 전이면 모아 둔다 — 아직 어느 실행을 따라갈지 모른다.
            if (from && earlyRef.current) {
                if (from.projectId === project.id) earlyRef.current.push({ e, from });
                return;
            }
            takeRef.current(e, from);
        });
    }, [project.id]);

    const start = useCallback(async () => {
        const f = fileRef.current;
        if (!f.topic.trim() || startingRef.current) return;
        startingRef.current = true;
        // 실행 id 는 화면이 정한다 — 첫 이벤트가 오기 전에 이 화면이 자기 실행을 알아야 한다.
        const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const prev = { id: runIdRef.current, seq: seqRef.current };
        heldRef.current = prev.id ? { prevId: prev.id, events: [] } : null;
        const refused = (message: string) => {
            runIdRef.current = prev.id;
            seqRef.current = prev.seq;
            const held = heldRef.current?.events ?? [];
            heldRef.current = null;
            for (const x of held) takeRef.current(x.e, x.from);
            dispatch({ type: 'failed', message });
            setStage('write');
        };
        try {
            if (saveTimer.current) await save();
            runIdRef.current = runId;
            seqRef.current = 0;
            const r = await window.legal.start({
                runId,
                projectId: project.id,
                topic: f.topic.trim(),
                context: f.context?.trim() || undefined,
                settings,
                plan: f.plan ?? undefined,
                scale: f.scale ?? settings.scale ?? 'standard',
                extraCorpus: f.extraCorpus && f.extraCorpus.length > 0 ? f.extraCorpus : undefined,
            });
            // 다른 실행이 돌고 있으면(멈추는 중인 것도) main 이 받지 않는다 — 지금 화면은 그대로 두고 까닭만 보인다.
            if ('error' in r) return refused(r.error);
            runIdRef.current = r.runId;
            clearDrafts();
            dispatch({ type: 'started' });
            setStage('write');
        } catch (e) {
            refused(e instanceof Error ? e.message : String(e));
        } finally {
            heldRef.current = null;
            startingRef.current = false;
        }
    }, [project.id, settings, save]);

    const cancel = useCallback(async () => {
        const id = runIdRef.current;
        if (!id) return;
        setStopping(true);
        try {
            // 멈출 때까지 기다린다 — 그 전에 「다시 집필」을 보이면 멈추는 중인 실행과 겹친다.
            await window.legal.cancel(id);
        } finally {
            setStopping(false);
        }
        clearDrafts();
        dispatch({ type: 'cancelled' });
    }, []);

    const answer = useCallback(async (answers: Record<string, Answer>) => {
        const id = runIdRef.current;
        dispatch({ type: 'answered' });
        clearDrafts(Object.keys(answers));
        if (id) await window.legal.answer(id, answers);
    }, []);

    // ---- 구상 대화 ----
    // 보내기와 기다림은 여기 둔다. Conceive 안에 있을 때는 탭을 바꾸면 기다림이 사라져 두 번째 메시지를 보낼 수 있었고,
    // 두 답이 각자 보낸 때의 대화 사본에 붙어 저장되며 서로를 지웠다(첫 답과 그 조사 기록이 사라졌다).
    const chatBusyRef = useRef(false);
    const sendChat = useCallback(
        async (text: string) => {
            if (chatBusyRef.current) return;
            chatBusyRef.current = true;
            const f = fileRef.current;
            const user: ChatMessage = { role: 'user', content: text, at: new Date().toISOString() };
            const msgs = [...(f.chat ?? []), user];
            update({ chat: msgs });
            setChatBusy(true);
            setChatError(null);
            try {
                const r = await window.legal.chatSend({ projectId: project.id, topic: f.topic, context: f.context?.trim() || undefined, messages: msgs, plan: f.plan ?? null });
                // 보낸 때의 사본이 아니라 지금의 대화에 붙인다.
                const now = fileRef.current.chat ?? msgs;
                if (r.error && !r.text) {
                    setChatError(r.error);
                    // 답은 실패했어도 조사는 돌았다 — 그 기록을 필자의 발언에 남긴다(다시 보내도 같은 자료는 다시 찾지 않는다).
                    await save({ chat: r.research ? now.map((m) => (m === user ? { ...user, research: r.research, ...(r.usage ? { usage: r.usage } : {}) } : m)) : now });
                    return;
                }
                const asst: ChatMessage = {
                    role: 'assistant',
                    content: r.text,
                    at: new Date().toISOString(),
                    ...(r.model ? { model: r.model } : {}),
                    ...(r.usage ? { usage: r.usage } : {}),
                    ...(r.research ? { research: r.research } : {}),
                };
                await save({ chat: [...now, asst] });
            } catch (e) {
                setChatError(e instanceof Error ? e.message : String(e));
            } finally {
                chatBusyRef.current = false;
                setChatBusy(false);
            }
        },
        [project.id, update, save],
    );

    const pickRun = useCallback(
        async (r: RunInfo) => {
            if (run.running) return;
            if (dirty && !window.confirm('저장하지 않은 수정이 있습니다. 이 실행의 원고로 바꿀까요?')) return;
            const [l, p] = await Promise.all([r.hasLedger ? window.legal.loadLedger(r.dir) : null, r.hasPaper ? window.legal.loadPaper(r.dir) : null]);
            setCurrentRunDir(r.dir);
            if (l) {
                setLedger(l);
                dispatch({ type: 'seed', ledger: l });
            }
            if (p !== null && p !== undefined) update({ manuscript: p, runDir: r.dir });
            else update({ runDir: r.dir });
        },
        [run.running, dirty, update],
    );

    const modelLabel = useMemo(() => {
        const writer = settings.roles?.writer;
        const pid = writer?.provider || settings.provider;
        const prov = providers.find((p) => p.id === pid);
        const model = writer?.model || settings.model || prov?.models[0] || '기본';
        return `${prov?.label ?? pid} · ${model}`;
    }, [settings, providers]);

    const status = runStatus(run);

    if (!file) {
        return (
            <div className="app">
                <Titlebar />
                <div className="empty">불러오는 중…</div>
            </div>
        );
    }

    return (
        <div className="app">
            <Titlebar
                left={
                    <button className="ghost" onClick={props.onBack}>
                        <ArrowLeft size={15} /> 프로젝트
                    </button>
                }
                right={
                    <>
                        <button className="ghost icon-only" onClick={() => void exportAudit()} disabled={exporting} title="작업 기록 내보내기 — 구상 대화·조사·실행·LLM 요청과 응답 (HTML·JSON)">
                            <FileClock size={16} />
                        </button>
                        <button className="ghost icon-only" onClick={props.onSettings} title="설정">
                            <SettingsIcon size={16} />
                        </button>
                    </>
                }
            />
            <div className="ws-head">
                <div className="ws-title" title={file.topic}>
                    {file.topic || project.id}
                </div>
                <div className="seg stages" role="tablist">
                    {STAGE_TABS.map((t) => (
                        <button key={t.id} role="tab" aria-selected={stage === t.id} className={stage === t.id ? 'on' : ''} onClick={() => setStage(t.id)}>
                            {t.label}
                            {t.id === 'conceive' && file.plan && <span className="seg-dot has-plan" title="설계 있음" />}
                            {t.id === 'write' && status !== 'idle' && <span className={`seg-dot ${status}`} title={status === 'running' ? '실행 중' : status === 'error' ? '오류' : '완료'} />}
                            {t.id === 'manuscript' && file.manuscript.trim() && <span className="seg-dot has-paper" title="원고 있음" />}
                        </button>
                    ))}
                </div>
                <div className="ws-status">
                    {run.running && (
                        <span className="run-status">
                            <span className="dot running" /> 집필 중
                        </span>
                    )}
                    {exported && (
                        <span className={exported.error ? 'warn-text' : 'muted'}>
                            {exported.error ? `기록 내보내기 실패: ${exported.error}` : '작업 기록을 저장했습니다'}
                            {exported.path && (
                                <button className="ghost tiny" onClick={() => void window.legal.openPath(exported.path!)}>
                                    열기
                                </button>
                            )}
                        </span>
                    )}
                    <span className="muted">{dirty ? '저장 안 됨' : savedAt ? `저장 ${savedAt.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}` : ''}</span>
                </div>
            </div>

            <div className="ws-body">
                {stage === 'conceive' && (
                    <Conceive
                        projectId={project.id}
                        file={file}
                        refs={refs}
                        defaultScale={settings.scale ?? 'standard'}
                        running={run.running}
                        chatBusy={chatBusy}
                        chatError={chatError}
                        onSend={(t) => void sendChat(t)}
                        onUpdate={update}
                        onSave={save}
                        onSaveSoon={saveSoon}
                        onStart={() => void start()}
                        onRefsChanged={setRefs}
                    />
                )}
                {stage === 'write' && (
                    <Write
                        projectId={project.id}
                        run={run}
                        stopping={stopping}
                        modelLabel={modelLabel}
                        canStart={Boolean(file.topic.trim())}
                        hasManuscript={Boolean(file.manuscript.trim())}
                        onStart={() => void start()}
                        onCancel={() => void cancel()}
                        onAnswer={(a) => void answer(a)}
                        onShowManuscript={() => setStage('manuscript')}
                        onDismissError={() => dispatch({ type: 'dismissError' })}
                    />
                )}
                {stage === 'manuscript' && (
                    <Manuscript
                        manuscript={file.manuscript}
                        topic={file.topic}
                        dirty={dirty}
                        savedAt={savedAt}
                        runDir={file.runDir ?? currentRunDir}
                        ledger={ledger}
                        runs={runs}
                        cites={run.cites}
                        onChange={(text) => update({ manuscript: text })}
                        onSave={() => save()}
                        onPickRun={pickRun}
                    />
                )}
            </div>
        </div>
    );
}

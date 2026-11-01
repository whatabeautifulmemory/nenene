// 파이프라인을 main 프로세스에서 돌린다.
//
// 파이프라인이 이미 Node 이므로 main 에 그대로 넣고, renderer 는 UI 만 한다. HITL 은 stdin 대신
// IPC 로 나간다 — 파이프라인의 hitl.ask 주입점에 함수 하나를 꽂으면 되고, 파이프라인 코드는
// 바뀌지 않는다.
//
// 기본은 초고→검증→수정(compose.ts). 원자 명제 파이프라인은 req.atomic 으로만 돈다.
import { appendFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { liveAsker, runPipeline } from '../../../src/pipeline.ts';
import { composePaper } from '../../../src/compose.ts';
import { assemblePaper, composeManuscript } from '../../../src/manuscript.ts';
import { writeOutputs } from '../../../src/report.ts';
import { complete, withRecorder, type CallRecord } from '../../../src/llm.ts';
import { withToolScope } from '../../../src/trace.ts';
import { modelFor, resolveModels } from '../../../src/config.ts';
import type { AnsweredAsk, Answer, Ask } from '../../../src/hitl.ts';
import type { Ledger } from '../../../src/pipeline.ts';
import { keyScope, type MainEvent, type RunRequest, type RunSnapshot, type RunSummary, type RunTag, type Settings } from '../shared/ipc.ts';
import { effectiveModel, getKey, getSettings } from './settings.ts';
import { defaultWorkspace, ensureDir, projectDir } from './project.ts';
import { providerById, resolveBaseUrl } from './providers.ts';
import { legalizeReady } from './legalize-boot.ts';
import { legalizeStatus } from '../../../src/law/legalize.ts';

export type Emit = (e: MainEvent) => void;

interface Pending {
    asks: Ask[];
    resolve: (answers: AnsweredAsk[]) => void;
    reject: (e: Error) => void;
}

/**
 * 실행 하나의 상태 — 실행마다 따로 들고, 실행 안의 함수들은 이것을 클로저로 잡는다.
 *
 * 전에는 pending·cancelled·aborter 가 모듈 전역이었다. 「중단」 뒤 옛 실행이 아직 모델 호출 중일 때 「집필」을 다시 누르면
 * 새 실행이 그 값을 갈아 끼웠고, 옛 실행은 새 실행의 살아 있는 신호로 장을 계속 쓰고(토큰), 질문 자리를 빼앗아 새 실행을
 * 영영 멈춰 세우고, 끝은 'error' 로 새 실행 화면에 알렸다. 이제 앞 실행이 끝나기 전에는 새 실행을 받지 않는다.
 */
interface Run {
    id: string;
    projectId: string;
    aborter: AbortController;
    cancelled: boolean;
    /** 멈춤을 누른 때 — 오래 멈추지 않는 실행이 새 실행을 영영 막지 않게 */
    cancelledAt?: number;
    pending: Pending | null;
    runDir?: string;
    /** 성공·실패·중단으로 끝났다. 화면이 받아 가면(ackRun) 잊는다 */
    ended: boolean;
    /** 다시 들어온 화면이 그릴 이벤트. 활동 줄(progress·tool)은 뒤쪽 FEED_KEEP 개만 */
    log: MainEvent[];
    feedCount: number;
    seq: number;
    finished: Promise<void>;
    finish: () => void;
}

/** 프로젝트별 마지막 실행 — 돌고 있는 것은 많아야 하나다. 끝난 것은 화면이 받아 갈 때까지 남긴다(그동안 다른 프로젝트에 가 있었을 수 있다). */
const runs = new Map<string, Run>();
const active = (): Run | undefined => [...runs.values()].find((r) => !r.ended);
const byId = (id: string): Run | undefined => [...runs.values()].find((r) => r.id === id);

/** 화면 리듀서의 활동 줄 상한(runState.ts FEED_CAP)과 같다 — 더 남겨도 화면에 보이지 않는다. */
const FEED_KEEP = 3000;
/** 멈춤을 누른 뒤 이만큼 지나도 끝나지 않은 실행은 새 실행을 막지 않는다 */
const STUCK_CANCEL_MS = 20_000;
const isFeed = (e: MainEvent) => e.type === 'progress' || e.type === 'tool';

function remember(run: Run, e: MainEvent): void {
    run.log.push(e);
    if (!isFeed(e)) return;
    // 넘칠 때마다 하나씩 빼면 느리다 — 반 더 쌓이면 한 번에 오래된 활동 줄을 덜어 낸다.
    if (++run.feedCount <= FEED_KEEP * 1.5) return;
    let drop = run.feedCount - FEED_KEEP;
    run.log = run.log.filter((x) => {
        if (drop > 0 && isFeed(x)) {
            drop--;
            return false;
        }
        return true;
    });
    run.feedCount = FEED_KEEP;
}

/** 새 실행을 연다. 돌고 있는(멈추는 중인 것도) 실행이 있으면 열지 않고 까닭을 돌려준다. */
function openRun(req: RunRequest): Run | string {
    const busy = active();
    if (busy) {
        // 멈춘 실행은 보통 곧 끝난다. 신호를 받지 않는 호출에 걸려 오래 안 끝나면 놓아 준다 — 그 실행의 이벤트·질문은 실행 id 로
        // 갈리므로 새 실행 화면에 섞이지 않는다(늦게 끝나도 endRun 은 그 실행만 닫는다).
        if (busy.cancelled && Date.now() - (busy.cancelledAt ?? 0) > STUCK_CANCEL_MS) busy.ended = true;
        else if (busy.cancelled) return '앞 실행이 아직 멈추는 중입니다. 잠시 뒤 다시 시작하세요.';
        else return busy.projectId === req.projectId ? '이 프로젝트의 집필이 이미 진행 중입니다.' : '다른 프로젝트의 집필이 진행 중입니다. 그 실행이 끝나거나 멈춘 뒤에 시작하세요.';
    }
    // 화면이 정한 id 를 쓴다 — 첫 이벤트가 오기 전에 화면이 자기 실행을 알아야 한다. 이상하거나 겹치면 새로 만든다.
    const id = typeof req.runId === 'string' && /^[\w-]{1,64}$/.test(req.runId) && !byId(req.runId) ? req.runId : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let finish = () => {};
    const finished = new Promise<void>((r) => (finish = r));
    const run: Run = { id, projectId: req.projectId, aborter: new AbortController(), cancelled: false, pending: null, ended: false, log: [], feedCount: 0, seq: 0, finished, finish };
    runs.set(req.projectId, run);
    return run;
}

function endRun(run: Run): void {
    run.ended = true;
    run.pending = null;
    run.finish();
}

/** renderer 의 질문 패널이 답을 보내면 여기서 풀린다. 그 실행의 질문일 때만 — 답했으면 true. */
export function resolveHitl(runId: string, answers: Record<string, Answer>): boolean {
    const run = byId(runId);
    if (!run?.pending) return false;
    const p = run.pending;
    run.pending = null;
    p.resolve(
        p.asks.map((a) => ({
            ...a,
            answer: answers[a.id] ?? { action: 'unavailable', by: 'ui-default', note: '답하지 않음' },
        })),
    );
    return true;
}

/**
 * 실행을 멈춘다. 끝날 때 풀리는 약속을 돌려준다(그 실행이 없으면 null).
 * 기다리던 질문은 「없음」으로 풀지 않고 실패시킨다 — 「없음」으로 풀면 파이프라인이 그 인용들을 "필자가 원문 없다고 함"으로
 * 기억해, 다음 실행부터 묻지 않는다. 멈춘 것은 답한 것이 아니다.
 */
export function cancelRun(runId: string): Promise<void> | null {
    const run = byId(runId);
    if (!run || run.ended) return null;
    run.cancelled = true;
    run.cancelledAt ??= Date.now();
    run.aborter.abort();
    if (run.pending) {
        const p = run.pending;
        run.pending = null;
        p.reject(new Error('중단됨 — 질문에 답하지 않고 멈췄습니다.'));
    }
    return run.finished;
}

/** 이 프로젝트의 실행 — 돌고 있거나, 끝났는데 화면이 아직 받아 가지 않은 것. */
export function runSnapshot(projectId: string): RunSnapshot | null {
    const run = runs.get(projectId);
    if (!run) return null;
    return { runId: run.id, projectId, running: !run.ended && !run.cancelled, asks: run.pending?.asks ?? null, events: run.log, seq: run.seq };
}

/** 화면이 끝난 실행을 받았다 — 다시 들어와도 같은 끝(원고 저장)을 되풀이하지 않게 잊는다. */
export function ackRun(runId: string): void {
    const run = byId(runId);
    if (run?.ended && runs.get(run.projectId) === run) runs.delete(run.projectId);
}

/**
 * 앱의 「집필 시작」. 실행을 열고 바로 돌려준다 — 진행은 send 로 간다(꼬리표: 실행 id·프로젝트·순번).
 * 끝(완료·오류·중단)도 이벤트로 간다.
 */
export function launchRun(req: RunRequest, send: (e: MainEvent, tag: RunTag) => void): { runId: string } | { error: string } {
    const run = openRun(req);
    if (typeof run === 'string') return { error: run };
    const out = (e: MainEvent) => {
        // 멈춘 실행이 멈추는 동안 낸 진행 줄·단계는 화면에 보내지 않는다(기록에는 남는다) — 끝을 알리는 것만 간다.
        if (run.cancelled && e.type !== 'error' && e.type !== 'done') return;
        remember(run, e);
        send(e, { runId: run.id, projectId: run.projectId, seq: ++run.seq });
    };
    // 이 응답({ runId })이 화면에 먼저 닿게 실행 본문은 다음 차례에 시작한다.
    setImmediate(() => {
        void (async () => {
            try {
                const summary = await execute(run, req, out);
                if (run.cancelled) out({ type: 'error', message: `중단됨 — 원장은 ${summary.runDir} 에 남았지만 원고는 조립하지 않았습니다.` });
                else out({ type: 'done', summary });
            } catch (e) {
                out({ type: 'error', message: run.cancelled ? `중단됨${run.runDir ? ` — 실행 기록은 ${run.runDir} 에 남았습니다.` : '.'}` : e instanceof Error ? e.message : String(e) });
            } finally {
                endRun(run);
            }
        })();
    });
    return { runId: run.id };
}

/** 역할 → 환경변수 접미. config.ts 의 ROLE_SUFFIX 와 이름이 맞아야 한다. */
const ROLE_ENV: { role: keyof NonNullable<Settings['roles']>; suffix: string }[] = [
    { role: 'planner', suffix: 'PLANNER' },
    { role: 'worker', suffix: 'WORKER' },
    { role: 'con', suffix: 'CON' },
    { role: 'judge', suffix: 'JUDGE' },
    { role: 'writer', suffix: 'CHAPTER' },
];

/** 검색·자료 공급자 키. 키체인 id → 환경변수. */
export const SEARCH_KEY_ENV: Record<string, string> = { tavily: 'TAVILY_API_KEY', brave: 'BRAVE_API_KEY', serper: 'SERPER_API_KEY', kci: 'KCI_API_KEY' };

/** envFor 가 만드는 변수들. 설정이 바뀌면 **지운 뒤** 다시 넣어야 한다 — Object.assign 은 지우지 못한다. */
const MANAGED_ENV = /^(LEGAL_AGENT_(MODEL|BASE_URL|API_KEY|PROVIDER)(_[A-Z]+)?|LEGAL_AGENT_(TEMPERATURE|MAX_TOKENS|TOP_P|SEED|CONTACT_EMAIL|SEARCH)|TAVILY_API_KEY|BRAVE_API_KEY|SERPER_API_KEY|KCI_API_KEY)$/;

/** 설정을 process.env 에 반영한다. 이전 설정이 남긴 변수는 지운다. */
export function applyEnv(s: Settings): void {
    for (const k of Object.keys(process.env)) if (MANAGED_ENV.test(k)) delete process.env[k];
    Object.assign(process.env, envFor(s));
}

export function envFor(s: Settings): Record<string, string> {
    const def = providerById(s.provider);
    const eff0 = effectiveModel(s);
    // 키는 공급자별(주소를 바꿀 수 있는 공급자는 주소별)로 보관한다. 키가 필요 없는 공급자는 비워 둔다.
    const key = getKey(keyScope(def, eff0.baseUrl)) ?? '';
    const searchEnv: Record<string, string> = {};
    for (const [id, env] of Object.entries(SEARCH_KEY_ENV)) {
        const k = getKey(`search:${id}`);
        if (k) searchEnv[env] = k;
    }
    const eff = effectiveModel(s);
    const roleEnv: Record<string, string> = {};
    for (const { role, suffix } of ROLE_ENV) {
        const r = s.roles?.[role];
        if (!r || (!r.provider && !r.model)) continue;
        const p = providerById(r.provider) ?? def;
        if (!p) continue;
        const model = r.model || (p.id === def?.id ? eff.model : p.models[0]);
        // 역할 공급자의 주소·키·전송 방식을 그대로 쓴다 — 기본 공급자의 키를 다른 공급자로 보내지 않는다.
        // 모델이 비었으면(기본 모델이 없는 공급자) 건너뛰지 않고 넘긴다 — config 가 "모델을 정해야 한다"고 알린다.
        const base = resolveBaseUrl(p, s.endpoints?.[p.id]);
        const k = getKey(keyScope(p, base)) ?? '';
        roleEnv[`LEGAL_AGENT_PROVIDER_${suffix}`] = p.id;
        if (model) roleEnv[`LEGAL_AGENT_MODEL_${suffix}`] = model;
        roleEnv[`LEGAL_AGENT_BASE_URL_${suffix}`] = base;
        roleEnv[`LEGAL_AGENT_API_KEY_${suffix}`] = k;
    }
    return {
        ...roleEnv,
        ...searchEnv,
        ...(s.searchOrder?.trim() ? { LEGAL_AGENT_SEARCH: s.searchOrder.trim() } : {}),
        LEGAL_AGENT_PROVIDER: def?.id ?? s.provider,
        LEGAL_AGENT_BASE_URL: eff.baseUrl,
        LEGAL_AGENT_API_KEY: key,
        LEGAL_AGENT_MODEL: eff.model,
        LEGAL_AGENT_TEMPERATURE: String(s.temperature),
        LEGAL_AGENT_MAX_TOKENS: String(s.maxTokens),
        ...(typeof s.topP === 'number' ? { LEGAL_AGENT_TOP_P: String(s.topP) } : {}),
        ...(typeof s.seed === 'number' ? { LEGAL_AGENT_SEED: String(s.seed) } : {}),
        ...(s.contactEmail ? { LEGAL_AGENT_CONTACT_EMAIL: s.contactEmail } : {}),
    };
}

/** 사람이 읽는 모델 라벨. 설정이 비어 있으면 공급자 기본값으로 — 빈 문자열을 찍지 않는다. */
export function modelLabel(s: Settings): string {
    const eff = effectiveModel(s);
    const def = providerById(s.provider);
    const roles = Object.values(s.roles ?? {}).filter((r) => r && (r.provider || r.model)).length;
    return `${eff.model} @ ${def?.label ?? s.provider} (${eff.baseUrl})${roles ? ` · 역할별 ${roles}개` : ''}`;
}

export function projectPaths(projectId: string | undefined): { pdir: string; refs: string; scratch: string } {
    const ws = getSettings().workspace || defaultWorkspace();
    const pdir = projectId ? projectDir(ws, projectId) : join(defaultWorkspace(), '_scratch');
    return { pdir, refs: join(pdir, 'references'), scratch: join(pdir, 'sources') };
}

/** 끝까지 기다리는 실행 — 자체점검(index.ts --e2e)용. 앱은 launchRun 을 쓴다. */
export async function startRun(req: RunRequest, emit: Emit): Promise<RunSummary> {
    const run = openRun(req);
    if (typeof run === 'string') throw new Error(run);
    try {
        return await execute(run, req, emit);
    } finally {
        endRun(run);
        if (runs.get(run.projectId) === run) runs.delete(run.projectId);
    }
}

function execute(run: Run, req: RunRequest, emit: Emit): Promise<RunSummary> {
    // 이 실행 안에서 일어난 모델 호출만 이 실행의 calls.jsonl 로 — 실행 중에 구상 대화를 해도 섞이지 않는다(withRecorder).
    // 기록 파일은 실행 폴더가 생긴 뒤에 정해지므로 자리만 먼저 잡는다.
    // 도구 이벤트도 같다(withToolScope) — 실행 중의 구상 대화 조사가 이 실행의 기록에 섞이지 않고, 실패·중단으로 끝나도 sink 가 남지 않는다.
    const sink: { write: ((r: CallRecord) => void) | null } = { write: null };
    return withToolScope(() => withRecorder((r) => sink.write?.(r), () => startRunInner(run, req, emit, sink)));
}

async function startRunInner(run: Run, req: RunRequest, emit: Emit, sink: { write: ((r: CallRecord) => void) | null }): Promise<RunSummary> {
    const s = req.settings;
    applyEnv(s);
    // 법령·판례 목록이 준비될 때까지 기다린다(켤 때 받기로 했으면 이미 받는 중이다). 아직 없으면 여기서 받을지 묻는다.
    // 기다리는 동안 「중단」을 누르면 바로 멈춘다.
    const ac = run.aborter;
    const signal = ac.signal;
    const legal = await Promise.race([
        legalizeReady((m) => emit({ type: 'progress', line: `[법령·판례] ${m}` } as MainEvent), ac.signal),
        new Promise<never>((_, rej) => ac.signal.addEventListener('abort', () => rej(new Error('중단됨 — 법령·판례 목록을 준비하는 중에 멈췄습니다.')), { once: true })),
    ]);
    // 준비가 안 됐으면 시작하지 않는다 — 조문·판례 조회가 첫 인용에서 실패해 모델 비용만 쓰고 멈춘다.
    // 왜 받지 않았는지에 맞춰 말한다 — 「다시 묻습니다」는 「나중에」일 때만 맞다. 허용 안 함이 적혀 있거나 시험 실행이면 묻지 않으므로
    // 그 말을 하던 때는 다시 시작해도 오지 않을 질문을 약속했다.
    if (legal.declined) {
        throw new Error(
            legal.declinedBy === 'no'
                ? 'GitHub 접근을 허용하지 않아 법령·판례 목록을 받지 않았습니다. 홈 화면에서 허용으로 바꾸거나 「받기」를 누르세요.'
                : legal.declinedBy === 'test'
                  ? '시험 실행이라 법령·판례 목록을 받지 않았습니다 — 시험 실행은 GitHub 에 나가지 않습니다. 목록을 받으려면 시험 설정 없이 앱을 켜고 「받기」를 누르세요.'
                  : '법령·판례 목록을 받지 않아 집필을 시작하지 않았습니다. 홈 화면의 「받기」를 누르거나, 다시 집필을 시작하면 다시 묻습니다.',
        );
    }
    if (!legal.ready) throw new Error('법령·판례 목록을 준비하지 못했습니다. 네트워크를 확인하고 다시 실행하세요(GitHub 요청 한도에 걸렸다면 한 시간 뒤).');

    let models;
    try {
        models = resolveModels(process.env);
    } catch (e) {
        throw new Error(e instanceof Error ? e.message : String(e));
    }
    // 역할별 모델을 설정했는데 그 공급자의 키나 모델이 없으면 시작하지 않는다 — 조용히 기본 모델로 돌리면
    // 사용자는 판정을 다른 모델로 나눴다고 믿는다. 기본 공급자의 키를 다른 공급자로 보내지도 않는다.
    if (models.warnings.length) throw new Error(`역할별 모델 설정을 확인해 주세요.\n${models.warnings.map((w) => `· ${w}`).join('\n')}`);
    const cfg = models.base;
    const pick = modelFor(models);

    // 초 단위로만 찍으면 같은 초에 시작한 두 실행이 한 폴더에 기록을 섞는다 — 밀리초와 무작위 꼬리를 붙인다(이름순 = 시각순은 그대로).
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)}-${Math.random().toString(36).slice(2, 6)}`;
    const { pdir, refs, scratch } = projectPaths(req.projectId);
    const runDir = join(pdir, 'runs', stamp);
    ensureDir(runDir);
    run.runDir = runDir;
    ensureDir(scratch);
    process.env.LEGAL_AGENT_SCRATCH = scratch;
    const corpus = [refs, scratch, ...(req.extraCorpus ?? [])].filter(Boolean).join(delimiter);
    if (corpus) process.env.LEGAL_AGENT_CORPUS = corpus;

    const transcriptPath = join(runDir, 'transcript.jsonl');
    const writeTr = (rec: unknown) => {
        try {
            appendFileSync(transcriptPath, JSON.stringify({ at: new Date().toISOString(), ...(rec as object) }) + '\n');
        } catch {
            /* 기록 실패가 실행을 죽이지 않는다 */
        }
    };
    const emit2 = (e: MainEvent) => {
        // 본문이 큰 이벤트(section)는 기록에서 본문을 줄인다 — transcript 는 감사용이지 원고 저장소가 아니다.
        if (e.type === 'section') writeTr({ ...e, section: { ...e.section, draft: (e.section.draft ?? '').slice(0, 400), revised: (e.section.revised ?? '').slice(0, 400) } });
        else writeTr(e);
        emit(e);
    };

    // 감사용 머리 기록 — 무엇을 어떤 설정으로 돌렸나. 키는 설정에 없다(키체인).
    writeTr({
        type: 'run-start',
        topic: req.topic,
        ...(req.context?.trim() ? { context: req.context.trim() } : {}),
        ...(req.plan ? { plan: req.plan } : {}),
        mode: req.atomic ? 'atomic' : 'paper',
        scale: req.scale ?? s.scale ?? 'standard',
        model: modelLabel(s),
        settings: {
            provider: s.provider,
            model: effectiveModel(s).model,
            baseUrl: effectiveModel(s).baseUrl,
            temperature: s.temperature,
            ...(s.topP !== undefined ? { topP: s.topP } : {}),
            ...(s.seed !== undefined ? { seed: s.seed } : {}),
            maxTokens: s.maxTokens,
            roles: s.roles ?? {},
            snowballDepth: s.snowballDepth ?? 2,
            assumeUnavailable: Boolean(s.assumeUnavailable),
        },
        corpus: legalizeStatus().commits,
    });

    const callsPath = join(runDir, 'calls.jsonl');
    sink.write = (r) => {
        try {
            appendFileSync(callsPath, JSON.stringify(r) + '\n');
        } catch {
            /* 기록 실패가 실행을 죽이지 않는다 */
        }
    };

    const usage = { prompt: 0, completion: 0, calls: 0 };
    // 이 실행의 신호를 단다 — 신호 없이 만들면 「중단」 뒤에도 가고 있던 구조화 호출이 끝까지 돌고 다음 호출도 나갔다.
    const asker = liveAsker(pick, signal);
    // 신호는 이 실행의 것 — 전에는 부를 때마다 전역 aborter 를 읽어, 새 실행이 시작되면 멈춘 실행의 호출이 새 실행의 신호를 달고 나갔다.
    const write = (r: { name: string; system: string; user: string; maxTokens?: number; temperature?: number }) =>
        complete(pick(r.name === 'revise' ? 'chapter' : r.name), r, usage, signal);

    const hitl = {
        interactive: false,
        ...(s.assumeUnavailable ? { assumeUnavailable: true } : {}),
        ...(s.assumeUnavailable
            ? {}
            : {
                  ask: (asks: Ask[]) =>
                      new Promise<AnsweredAsk[]>((resolve, reject) => {
                          // 멈춘 실행은 묻지 않는다 — 화면에 질문을 띄우지 않고 실행을 끝낸다.
                          if (run.cancelled) return reject(new Error('중단됨'));
                          // 필자의 답도 기록에 남긴다 — 질문만 있고 답이 없으면 감사가 안 된다.
                          run.pending = {
                              asks,
                              resolve: (answered) => {
                                  writeTr({ type: 'answers', answers: Object.fromEntries(answered.map((a) => [a.id, a.answer])) });
                                  resolve(answered);
                              },
                              reject,
                          };
                          emit2({ type: 'asks', asks });
                      }),
              }),
    };
    const label = modelLabel(s);

    let ledger: Ledger;
    try {
        if (req.atomic) {
            ledger = await runPipeline(
                {
                    topic: req.topic,
                    ...(req.context?.trim() ? { context: req.context.trim() } : {}),
                    maxIssues: req.issues ?? 2,
                    maxClaimsPerIssue: req.claims ?? 5,
                    concurrency: 3,
                    maxClarify: 6,
                    hitl,
                    onProgress: (line) => emit2({ type: 'progress', line }),
                    onTool: (event) => emit2({ type: 'tool', event }),
                },
                asker,
                label,
            );
        } else {
            ledger = await composePaper(
                {
                    topic: req.topic,
                    ...(req.context?.trim() ? { context: req.context.trim() } : {}),
                    ...(req.plan ? { plan: req.plan } : {}),
                    scale: req.scale ?? s.scale ?? 'standard',
                    concurrency: 3,
                    snowballDepth: s.snowballDepth ?? 2,
                    hitl,
                    onProgress: (line) => emit2({ type: 'progress', line }),
                    onTool: (event) => emit2({ type: 'tool', event }),
                    onEvent: (e) => emit2(e as MainEvent),
                    signal,
                },
                asker,
                write,
                label,
            );
        }
        ledger.usage = { prompt: (ledger.usage?.prompt ?? 0) + usage.prompt, completion: (ledger.usage?.completion ?? 0) + usage.completion, calls: (ledger.usage?.calls ?? 0) + usage.calls };

        const paths = writeOutputs(ledger, runDir);

        let paperPath: string | undefined;
        let paperMarkdown: string | undefined;
        if (!run.cancelled) {
            emit2({ type: 'progress', line: ledger.paper ? '논문 조립 (각주·참고문헌·검증 부록)…' : '논문 조립 중 (장별 집필)…' });
            try {
                const paper = ledger.paper ? assemblePaper(ledger) : await composeManuscript(ledger, (r) => complete(cfg, r, usage, signal));
                paperPath = join(runDir, 'paper.md');
                paperMarkdown = paper.markdown;
                writeFileSync(paperPath, paper.markdown);
                emit2({
                    type: 'progress',
                    line: `논문 ${paper.markdown.length.toLocaleString()}자 · 필자 확인 필요 인용 ${paper.diagnostics.flagged}건`,
                });
            } catch (e) {
                emit2({ type: 'progress', line: `논문 조립 실패: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}` });
            }
        }

        const verdicts: Record<string, number> = {};
        for (const { items } of ledger.issues) for (const it of items) verdicts[it.judgment.verdict] = (verdicts[it.judgment.verdict] ?? 0) + 1;
        writeTr({ type: run.cancelled ? 'cancelled' : 'done', summary: { runDir, coverage: ledger.coverage, verdicts, humanCount: ledger.human.length, usage: ledger.usage, ...(paperPath ? { paperPath } : {}) } });

        return {
            runDir,
            reportPath: paths.report,
            ledgerPath: paths.ledger,
            ...(paperPath ? { paperPath } : {}),
            ...(paperMarkdown ? { paperMarkdown } : {}),
            coverage: ledger.coverage,
            verdicts,
            humanCount: ledger.human.length,
        };
    } catch (e) {
        writeTr({ type: run.cancelled ? 'cancelled' : 'error', message: e instanceof Error ? e.message : String(e) });
        throw e;
    }
}


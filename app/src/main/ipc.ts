// IPC 핸들러. renderer 는 이 표면만 본다.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { effectiveModel, getKey, getSettings, hasKey, saveSettings, setKey, userDataDir } from './settings.ts';
import { addRefs, createProject, defaultWorkspace, ensureDir, listProjects, listRefs, projectDir, readProject, writeProject } from './project.ts';
import { markdownToDocx, markdownToHtml, transcriptHtml } from './export.ts';
import { legalizeStatus } from '../../../src/law/legalize.ts';
import { consentLegalize, legalizeProgress, networkAnswer, setNetworkAnswer, startLegalize } from './legalize-boot.ts';
import { auditHtml, collectAudit } from './audit.ts';
import { closeSourceBrowser, registerSourceBrowser } from './source-browser.ts';
import { providerStatus, searchWeb } from '../../../src/law/search.ts';
import { kciConfigured } from '../../../src/law/kci.ts';
import { fetchUrl, htmlToText } from '../../../src/law/web.ts';
import { RESEARCH_VERSION, citeTitle, planQueries, research, type Dossier, type Finding, type ResearchSearch } from '../../../src/law/research.ts';
import { PROVIDERS, fetchModels, lookupModelContext, providerById, resolveBaseUrl } from './providers.ts';
import { launchRun, resolveHitl, cancelRun, runSnapshot, ackRun, applyEnv, projectPaths, SEARCH_KEY_ENV } from './runner.ts';
import { keyScope, type Answer, type ChatReply, type ChatRequest, type MainEvent, type PlanProposeRequest, type ProjectFile, type RunRequest, type RunTag, type SearchProviderStatus, type Settings, type SideAsk, type SideAnswer } from '../shared/ipc.ts';
import { modelFor, resolveModels } from '../../../src/config.ts';
import { complete, withRecorder, type CallRecord } from '../../../src/llm.ts';
import { withToolScope } from '../../../src/trace.ts';
import { liveAsker } from '../../../src/pipeline.ts';
import { proposeThesis } from '../../../src/compose.ts';
import { CHAT_SYSTEM, researchBlock, thesisBlock } from '../../../src/prompts-paper.ts';

const projectPath = () => join(userDataDir(), 'project.json');

/**
 * 저장된 조사 기록. researchedAt = 조사를 돌린 때(턴 조사가 덧붙여도 바뀌지 않는다 — 하루 기준은 이것으로 잰다),
 * unreported = 이 조사를 아직 대화의 어느 메시지에도 기록하지 않았다(설계 뽑기가 먼저 조사를 돌린 경우 등).
 */
type StoredDossier = Dossier & { contextKey?: string; researchedAt?: string; unreported?: boolean };

/** 프로젝트마다 조사는 한 번에 하나 — 대화와 설계 뽑기가 동시에 불러도 같은 조사를 기다린다. */
const researching = new Map<string, Promise<StoredDossier>>();

/**
 * 프로젝트의 조사 기록. 구상 대화와 설계 추출이 같은 자료를 본다.
 * 하루 지나면 다시 조사한다 — 뉴스·판례는 움직인다. 조사에 든 모델 호출은 usage 에 더한다.
 */
async function projectDossier(projectId: string, topic: string, context: string, usage?: { prompt: number; completion: number; calls: number }): Promise<StoredDossier> {
    const { pdir, scratch } = projectPaths(projectId);
    ensureDir(pdir);
    const file = join(pdir, 'dossier.json');
    if (existsSync(file)) {
        try {
            const d = JSON.parse(readFileSync(file, 'utf8')) as StoredDossier;
            const at = d.researchedAt ? Date.parse(d.researchedAt) : statSync(file).mtimeMs;
            // 맥락이 바뀌면(URL·사건번호 추가) 다시 조사한다 — 주제만 같다고 하루를 기다리면 안 된다.
            if (Date.now() - at < 24 * 3600_000 && d.topic === topic && d.contextKey === contextKey(context) && d.findings?.length && d.v === RESEARCH_VERSION) return d;
        } catch {
            /* 다시 조사한다 */
        }
    }
    const running = researching.get(projectId);
    if (running) return running;
    const job = (async () => {
        applyEnv(getSettings());
        ensureDir(scratch);
        const models = resolveModels(process.env);
        const ask = liveAsker(modelFor(models));
        const u = usage ?? { prompt: 0, completion: 0, calls: 0 };
        const d: StoredDossier = await research(topic, context, { scratch, ask: (schema, o) => ask<any>(schema as never, o as never, u) });
        d.findings = d.findings.filter((f) => (f.quote ?? f.summary).trim().length >= 40);
        d.findings.forEach((f, i) => (f.id = `R${i + 1}`));
        // 짧아서 버린 자료를 「남김」 수에서도 뺀다 — 화면과 기록의 수가 맞아야 한다.
        for (const sch of d.searches ?? []) sch.kept = d.findings.filter((f) => f.source === sch.source && f.query === sch.q).length;
        d.researchedAt = new Date().toISOString();
        d.unreported = true;
        saveDossier(projectId, d, context);
        return d;
    })();
    researching.set(projectId, job);
    try {
        return await job;
    } finally {
        researching.delete(projectId);
    }
}

const contextKey = (context: string) => `${context.trim().length}:${[...context.trim()].slice(0, 400).join('').replace(/\s+/g, ' ')}`;

function saveDossier(projectId: string, d: StoredDossier, context: string): void {
    try {
        writeFileSync(join(projectPaths(projectId).pdir, 'dossier.json'), JSON.stringify({ ...d, contextKey: contextKey(context) }, null, 1));
    } catch {
        /* 저장 실패는 치명적이지 않다 */
    }
}

const sentencesOf = (text: string) =>
    text
        .replace(/\s+/g, ' ')
        .split(/(?<=[.!?。])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 30 && s.length <= 400);

/**
 * 구상 대화의 **턴별 조사**. 마지막 필자 발언에 든 URL 을 읽고, 발언에서 검색어를 만들어 웹을 찾는다.
 * 찾은 것은 프로젝트 dossier 에 합쳐져 이후 턴·설계 추출·집필이 같이 본다.
 *
 * 왜: 처음 구현은 프로젝트당 한 번 조사한 기록만 보고 답했다. 대화 중에 "이 판례 찾아봐",
 * "이 기사 읽어봐" 가 되지 않았다 — claude.ai 에서 하던 것의 절반이다.
 */
async function turnResearch(
    projectId: string,
    topic: string,
    context: string,
    lastUser: string,
    dossier: Dossier,
    ask: <T>(schema: unknown, o: { name: string; description: string; system: string; user: string }) => Promise<T>,
): Promise<{ added: Finding[]; searches: ResearchSearch[]; failed: { url: string; error?: string }[] }> {
    const added: Finding[] = [];
    const searches: ResearchSearch[] = [];
    const failed: { url: string; error?: string }[] = [];
    const have = new Set(dossier.findings.map((f) => f.url ?? f.citation));
    const push = (f: Finding) => {
        const key = f.url ?? f.citation;
        if (have.has(key)) return;
        have.add(key);
        added.push(f);
    };
    // 1) 필자가 붙인 URL 은 그대로 읽는다.
    for (const url of [...new Set(lastUser.match(/https?:\/\/[^\s)\]"'<>]+/g) ?? [])].slice(0, 3)) {
        const d = await fetchUrl(url);
        if (d.error || d.status >= 400 || !d.text || d.paywall || d.login) {
            failed.push({ url, error: d.error ?? (d.status >= 400 ? `HTTP ${d.status}` : d.paywall ? '유료 구독 벽' : d.login ? '로그인 필요' : '내용 없음') });
            continue;
        }
        const text = d.kind === 'html' ? htmlToText(d.text) : d.text;
        const sents = sentencesOf(text).slice(0, 6);
        if (!sents.length) {
            failed.push({ url, error: '읽을 문장 없음' });
            continue;
        }
        push({ id: '', kind: 'fact', authority: 3, citation: `공개 자료, <${url}>`, summary: sents[0]!.slice(0, 240), quote: sents.slice(0, 4).join(' '), url, fetchedAt: new Date().toISOString(), source: 'url' });
    }
    // 2) 발언에서 검색어를 만들어 웹을 찾는다. 짧은 맞장구("좋아", "그래서?")에는 검색하지 않는다.
    if (lastUser.replace(/\s+/g, '').length >= 14) {
        const planned = await planQueries(lastUser.slice(0, 600), `${topic}\n${context}`.slice(0, 1200), ask);
        for (const q of [...new Set(planned.map((p) => p.q))].slice(0, 3)) {
            const { results, used } = await searchWeb(q, { count: 4, content: true });
            const before = added.length;
            const provider = results[0]?.provider;
            for (const h of results) {
                const text = `${h.summary ?? ''} ${h.content ?? ''}`.trim();
                if (text.length < 80) continue;
                push({
                    id: '',
                    kind: 'news',
                    ...(h.authority !== undefined ? { authority: h.authority } : {}),
                    citation: `${citeTitle(h.title, h.siteName, h.url)} <${h.url}>`,
                    summary: (h.snippet || text).slice(0, 240),
                    quote: sentencesOf(text).slice(0, 3).join(' ').slice(0, 600) || text.slice(0, 600),
                    url: h.url,
                    fetchedAt: new Date().toISOString(),
                    source: 'web',
                    query: q,
                    ...(h.provider ? { provider: h.provider } : {}),
                });
            }
            const angle = planned.find((p) => p.q === q)?.angle;
            // 공급자가 모두 실패했으면 「결과 0」이 아니라 실패로 남긴다(research() 와 같은 기준).
            const failedAll = !results.length && (used === 'none' || used.split(',').every((x) => x.endsWith(':err')));
            searches.push({ source: 'web', q, ...(angle ? { angle } : {}), ...(provider ? { provider } : {}), ...(failedAll ? { error: `검색 실패(${used})` } : { results: results.length }), kept: added.length - before });
        }
    }
    if (added.length) {
        dossier.findings.push(...added);
        dossier.findings.forEach((f, i) => (f.id = `R${i + 1}`));
        saveDossier(projectId, dossier, context);
    }
    return { added, searches, failed };
}

/** 대화 한 턴의 조사 기록 — 메시지에 그대로 남긴다(dossier 는 하루마다 덮이고 번호가 바뀌므로 감사에는 이쪽이 원본이다). */
function researchNoteOf(items: Finding[], all: ResearchSearch[], failed: { url: string; error?: string }[], scope: 'initial' | 'turn'): NonNullable<ChatReply['research']> {
    // 같은 곳에 같은 검색어를 두 번 던졌으면(프로젝트 조사와 첫 턴 조사) 한 줄로 합치고 몇 번인지 남긴다.
    const searches: (ResearchSearch & { times?: number })[] = [];
    for (const x of all) {
        const same = searches.find((y) => y.source === x.source && y.q === x.q);
        if (!same) searches.push({ ...x });
        else {
            same.kept += x.kept;
            if (x.results !== undefined) same.results = (same.results ?? 0) + x.results;
            // 한 번이라도 성공했으면 실패 표시를 지운다. 둘 다 실패면 처음 까닭을 둔다.
            if (x.error === undefined || same.results !== undefined) delete same.error;
            same.times = (same.times ?? 1) + 1;
        }
    }
    return {
        count: items.length,
        sample: items.slice(0, 4).map((f) => f.citation.slice(0, 80)),
        scope,
        items: items.map((f) => ({
            id: f.id,
            kind: f.kind,
            citation: f.citation,
            summary: f.summary,
            ...(f.quote ? { quote: f.quote } : {}),
            ...(f.url ? { url: f.url } : {}),
            ...(f.source ? { source: f.source } : {}),
            ...(f.query ? { query: f.query } : {}),
            ...(f.provider ? { provider: f.provider } : {}),
            ...(f.authority !== undefined ? { authority: f.authority } : {}),
        })),
        searches,
        failed,
    };
}

const handlesOf = (d: Dossier) =>
    d.findings.map((f, i) => ({
        handle: f.id?.startsWith('R') ? f.id : `R${i + 1}`,
        kind: f.kind,
        citation: f.citation.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 110),
        summary: f.summary,
        ...(f.quote ? { quote: f.quote } : {}),
        ...(f.url ? { url: f.url } : {}),
    }));

export function registerIpc(win: () => BrowserWindow | null): void {
    const emit = (e: MainEvent, tag: RunTag) => win()?.webContents.send('legal:event', e, tag);

    ipcMain.handle('providers', () => PROVIDERS);
    // 공급자에게 실제로 쓸 수 있는 모델을 묻는다(기존 구현 fetchModels). 키는 main 에서만 쓰고 renderer 로 내려가지 않는다.
    ipcMain.handle('models:list', async (_e, provider: string, endpoint?: string) => {
        const def = providerById(provider);
        if (!def) return { models: [], status: 'error' };
        const base = resolveBaseUrl(def, endpoint ?? getSettings().endpoints?.[def.id]);
        return fetchModels(def, base, getKey(keyScope(def, base)) ?? undefined);
    });
    ipcMain.handle('models:context', (_e, model: string) => lookupModelContext(model) ?? null);
    ipcMain.handle('keys:has', (_e, provider: string) => hasKey(provider));
    ipcMain.handle('keys:set', (_e, provider: string, key: string) => setKey(provider, key));
    ipcMain.handle('settings:get', () => getSettings());
    ipcMain.handle('settings:save', (_e, s: Settings) => saveSettings(s));

    // 실행은 한 번에 하나 — 돌고 있거나 멈추는 중인 실행이 있으면 시작하지 않고 까닭을 돌려준다(runner openRun).
    ipcMain.handle('run:start', (_e, req: RunRequest) => launchRun(req, emit));
    // 프로젝트를 나갔다 온 화면이 실행을 다시 그린다 — 기다리는 질문도 다시 뜬다.
    ipcMain.handle('run:status', (_e, projectId: string) => runSnapshot(projectId));
    ipcMain.handle('run:ack', (_e, runId: string) => ackRun(runId));

    ipcMain.handle('run:answer', (_e, runId: string, answers: Record<string, Answer>) => {
        // 답했으면 원문 찾기 창은 할 일이 끝났다. 넣은 파일은 references/ 에 그대로 남는다.
        // 그 실행의 질문이 아니었으면(늦게 온 답) 창은 둔다 — 지금 질문의 창일 수 있다.
        if (resolveHitl(runId, answers)) closeSourceBrowser();
    });
    ipcMain.handle('run:cancel', async (_e, runId: string) => {
        const finished = cancelRun(runId);
        // 멈춘 실행의 질문에 늦게 받은 파일이 붙지 않게 원문 찾기 창도 닫는다.
        closeSourceBrowser();
        // 멈출 때까지 기다린다 — 모델 호출도 이제 신호로 끊기므로 보통 곧 끝난다. 그래야 「다시 집필」이 멈추는 중인 실행과 겹치지 않는다.
        // 오래 걸리면 먼저 돌아온다(그동안 새 실행은 「멈추는 중」으로 거절된다).
        if (finished) await Promise.race([finished, new Promise((r) => setTimeout(r, 15_000))]);
    });

    ipcMain.handle('ledger:load', (_e, runDir: string) => {
        try {
            return JSON.parse(readFileSync(join(runDir, 'ledger.json'), 'utf8'));
        } catch {
            return null;
        }
    });
    ipcMain.handle('paper:load', (_e, runDir: string) => {
        try {
            return readFileSync(join(runDir, 'paper.md'), 'utf8');
        } catch {
            return null;
        }
    });

    ipcMain.handle('project:save', (_e, p: ProjectFile) => {
        const withStamp = { ...p, savedAt: new Date().toISOString() };
        writeFileSync(projectPath(), JSON.stringify(withStamp, null, 2));
        return { path: projectPath() };
    });
    ipcMain.handle('project:load', () => {
        try {
            return JSON.parse(readFileSync(projectPath(), 'utf8')) as ProjectFile;
        } catch {
            return null;
        }
    });

    ipcMain.handle('export:as', async (_e, kind: 'md' | 'html' | 'docx', payload: { manuscript: string; topic: string; runDir?: string }) => {
        const stamp = new Date().toISOString().slice(0, 10);
        const safe = payload.topic.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || '논문';
        const res = await dialog.showSaveDialog({
            defaultPath: join(app.getPath('documents'), `${safe}_${stamp}.${kind === 'docx' ? 'docx' : kind}`),
            filters:
                kind === 'docx'
                    ? [{ name: 'Word 문서', extensions: ['docx'] }]
                    : kind === 'html'
                      ? [{ name: 'HTML', extensions: ['html'] }]
                      : [{ name: 'Markdown', extensions: ['md'] }],
        });
        if (res.canceled || !res.filePath) return { error: '취소됨' };
        writeFileSync(res.filePath, kind === 'docx' ? await markdownToDocx(payload.manuscript, payload.topic) : kind === 'html' ? markdownToHtml(payload.manuscript, payload.topic) : payload.manuscript);
        return { path: res.filePath };
    });

    ipcMain.handle('shell:open', (_e, p: string) => shell.openPath(p));
    ipcMain.handle('dialog:folder', async () => {
        const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'multiSelections'] });
        return r.canceled ? null : r.filePaths.join(delimiter);
    });
    ipcMain.handle('app:paths', () => ({ userData: userDataDir(), documents: app.getPath('documents') }));
    ipcMain.handle('search:providers', (): SearchProviderStatus[] => {
        applyEnv(getSettings());
        const web: SearchProviderStatus[] = providerStatus().map((p) => ({
            ...p,
            kind: 'web',
            ...(SEARCH_KEY_ENV[p.id] ? { keyId: `search:${p.id}` } : {}),
            ...(p.id === 'deepseek' ? { note: '모델 공급자의 DeepSeek 키를 같이 씁니다 (DeepSeek 이 모델 공급자일 때만)' } : p.id === 'ddg' ? { note: '키 없음 · 스크래핑이라 차단될 수 있습니다' } : {}),
        }));
        const kci: SearchProviderStatus = {
            id: 'kci',
            label: 'KCI 한국학술지인용색인 (서지·초록)',
            kind: 'scholar',
            needsKey: true,
            available: kciConfigured(),
            keyId: 'search:kci',
            note: kciConfigured() ? '등록 키 사용 중' : 'KCI_API_KEY 없음 — kci.go.kr 에서 OpenAPI 키를 신청해 설정하세요',
        };
        return [...web, kci];
    });
    ipcMain.handle('corpus:status', () => ({
        root: process.env.LEGAL_AGENT_ROOT ?? '',
        ...legalizeStatus(),
        ...legalizeProgress(),
    }));
    // 홈의 「받기」·「다시 받기」 — 누른 것이 곧 GitHub 접근 허용이다(허용으로 적는다). 기다리지 않는다(진행은 corpus:status 로 본다).
    ipcMain.handle('corpus:download', () => {
        consentLegalize();
        void startLegalize();
    });
    // 홈의 「GitHub 갱신」 — 값 없이 부르면 지금 답을, 'yes'|'no' 를 주면 바꿔 적고 그 답을 돌려준다(null: 아직 묻지 않음).
    ipcMain.handle('corpus:network', (_e, v?: unknown) => {
        if (v === 'yes' || v === 'no') setNetworkAnswer(v);
        return networkAnswer();
    });

    // ---- 프로젝트 폴더 ---------------------------------------------------------
    const workspace = () => getSettings().workspace || defaultWorkspace();
    // 원문 찾기 브라우저 — 받은 파일·넣은 페이지는 그 프로젝트의 references/ 로(다음 실행에서도 코퍼스로 쓰인다).
    registerSourceBrowser({ mainWindow: win, refsDir: (id) => join(projectDir(workspace(), id), 'references') });

    ipcMain.handle('workspace:get', () => workspace());
    ipcMain.handle('workspace:choose', async () => {
        const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: '프로젝트 폴더 선택' });
        if (r.canceled || !r.filePaths[0]) return null;
        const s = getSettings();
        saveSettings({ ...s, workspace: r.filePaths[0]! });
        ensureDir(r.filePaths[0]!);
        return r.filePaths[0]!;
    });
    ipcMain.handle('projects:list', () => listProjects(workspace()));
    ipcMain.handle('projects:create', (_e, topic: string, context: string) => createProject(workspace(), topic, context));
    ipcMain.handle('projects:save', (_e, id: string, p: ProjectFile) => {
        const dir = projectDir(workspace(), id);
        writeProject(dir, p);
        return { path: join(dir, 'project.json') };
    });
    ipcMain.handle('projects:load', (_e, id: string) => readProject(projectDir(workspace(), id)));
    ipcMain.handle('projects:delete', async (e, id: string) => {
        const dir = projectDir(workspace(), id);
        if (!existsSync(dir)) return { deleted: false };
        const w = BrowserWindow.fromWebContents(e.sender);
        const { response } = await dialog.showMessageBox(w ?? undefined!, {
            type: 'warning',
            buttons: ['취소', '휴지통으로 보내기'],
            defaultId: 0,
            cancelId: 0,
            message: `"${id}" 를 휴지통으로 보낼까요?`,
            detail: '프로젝트 폴더 전체(원고·참고문헌·실행 기록)가 휴지통으로 갑니다. 나중에 복원할 수 있습니다.',
        });
        if (response !== 1) return { deleted: false };
        await shell.trashItem(dir);
        return { deleted: true };
    });

    // ---- 참고문헌 -------------------------------------------------------------
    ipcMain.handle('refs:list', (_e, id: string) => listRefs(projectDir(workspace(), id)));
    ipcMain.handle('refs:add', async (_e, id: string) => {
        const r = await dialog.showOpenDialog({
            title: '참고문헌 추가',
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: '참고문헌', extensions: ['pdf', 'docx', 'md', 'txt', 'html', 'htm'] }],
        });
        if (r.canceled) return listRefs(projectDir(workspace(), id));
        return addRefs(projectDir(workspace(), id), r.filePaths);
    });
    ipcMain.handle('refs:open', (_e, id: string) => shell.openPath(join(projectDir(workspace(), id), 'references')));
    ipcMain.handle('refs:pick', async () => {
        const r = await dialog.showOpenDialog({
            title: '원문 파일 선택',
            properties: ['openFile'],
            filters: [{ name: '문서', extensions: ['pdf', 'docx', 'md', 'txt', 'html', 'htm'] }],
        });
        const p = r.canceled ? undefined : r.filePaths[0];
        // 경로가 아니라 file:// 주소로 준다. renderer 의 encodeURI 는 #·? 를 그대로 둬(조각·질의로 잘려 "파일이 없습니다"),
        // 공백 없는 경로는 날것으로 넣어 「직접 답함」에서는 읽히지 않았고, 윈도 경로는 역슬래시가 한글 앞에서 지워졌다.
        // 작은따옴표는 주소에서 빼 둔다 — 파이프라인이 note 에서 주소를 뽑을 때 따옴표에서 끊는다(sources.ts·compose.ts).
        // 한글 등 비ASCII 는 풀어 둔다 — 필자가 칸에서 파일 이름을 읽을 수 있게(%20·%23·%3F·%25 같은 ASCII 특수 문자만 남는다).
        // 파이프라인은 file:// 주소를 URL 로 읽으므로 풀린 한글도 그대로 읽힌다.
        return p
            ? pathToFileURL(p)
                  .href.replace(/'/g, '%27')
                  .replace(/(?:%[89A-F][0-9A-F])+/gi, (m) => {
                      try {
                          return decodeURIComponent(m);
                      } catch {
                          return m;
                      }
                  })
            : null;
    });

    // ---- 실행 기록 · 대화 내보내기 --------------------------------------------
    ipcMain.handle('runs:list', (_e, id: string) => {
        const dir = join(projectDir(workspace(), id), 'runs');
        if (!existsSync(dir)) return [];
        return readdirSync(dir)
            .filter((n) => !n.startsWith('.'))
            .map((n) => {
                const d = join(dir, n);
                return { dir: d, name: n, hasPaper: existsSync(join(d, 'paper.md')), hasLedger: existsSync(join(d, 'ledger.json')) };
            })
            .sort((a, b) => b.name.localeCompare(a.name));
    });
    // 프로젝트 작업 기록 — 구상 대화·조사·설계·실행 전부를 파일 하나로(감사용). 저장 형식은 저장 창에서 고른다(HTML·JSON).
    ipcMain.handle('audit:export', async (_e, id: string) => {
        const dir = projectDir(workspace(), id);
        if (!existsSync(dir)) return { error: '프로젝트 폴더가 없습니다.' };
        const stamp = new Date().toLocaleString('sv-SE').slice(0, 16).replace(/[: ]/g, '-');
        const w = win();
        const opts = {
            title: '작업 기록 내보내기',
            defaultPath: join(dir, `작업기록-${stamp}.html`),
            filters: [
                { name: 'HTML (읽기용)', extensions: ['html'] },
                { name: 'JSON (원자료)', extensions: ['json'] },
            ],
        };
        const target = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
        if (target.canceled || !target.filePath) return null;
        // 설정에는 키가 없다(키체인). 연락처 이메일은 기록을 남에게 줄 수 있으니 뺀다.
        const { contactEmail: _omit, ...settings } = getSettings();
        const rec = collectAudit({ id, dir, settings, corpus: { root: process.env.LEGAL_AGENT_ROOT ?? '', ...legalizeStatus() }, appVersion: app.getVersion() });
        try {
            writeFileSync(target.filePath, /\.json$/i.test(target.filePath) ? JSON.stringify(rec, null, 2) : auditHtml(rec));
        } catch (e) {
            return { error: e instanceof Error ? e.message : String(e) };
        }
        return { path: target.filePath };
    });
    ipcMain.handle('transcript:export', async (_e, _id: string, runDir: string, kind: 'json' | 'html') => {
        const src = join(runDir, 'transcript.jsonl');
        if (!existsSync(src)) return { error: '이 실행에는 대화 기록이 없습니다.' };
        const target = await dialog.showSaveDialog({
            defaultPath: join(runDir, `transcript.${kind}`),
            filters: [{ name: kind === 'html' ? 'HTML' : 'JSON', extensions: [kind] }],
        });
        if (target.canceled || !target.filePath) return { error: '취소됨' };
        const rows = readFileSync(src, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => {
                try {
                    return JSON.parse(l);
                } catch {
                    return { type: 'raw', text: l };
                }
            });
        if (kind === 'json') writeFileSync(target.filePath, JSON.stringify({ runDir, records: rows }, null, 2));
        else writeFileSync(target.filePath, transcriptHtml(runDir, rows));
        return { path: target.filePath };
    });

    // ---- 구상 대화 ------------------------------------------------------------
    //
    // 사용자와 모델이 논지를 같이 만든다. 모델은 프로젝트의 조사 기록을 보고 답하고, 자료에 없는
    // 판례·문헌은 ⚠ 로 표시한다. 대화는 project.json 에 남고, 「대화에서 설계 뽑기」가 그것을 읽는다.
    // 구상 단계의 모델 호출(대화·조사 검색어·설계 뽑기)은 그 프로젝트의 conceive-calls.jsonl 에 남긴다 — 실행의 calls.jsonl 과 섞지 않는다.
    const conceiveRecorder = (projectId: string) => (r: CallRecord) => {
        try {
            appendFileSync(join(projectPaths(projectId).pdir, 'conceive-calls.jsonl'), JSON.stringify(r) + '\n');
        } catch {
            /* 기록 실패가 대화를 막지 않는다 */
        }
    };
    ipcMain.handle('chat:send', (_e, req: ChatRequest): Promise<ChatReply> => withToolScope(() => withRecorder(conceiveRecorder(req.projectId), async (): Promise<ChatReply> => {
        applyEnv(getSettings());
        let models;
        try {
            models = resolveModels(process.env);
        } catch (e) {
            return { text: '', model: '', error: e instanceof Error ? e.message.slice(0, 300) : String(e) };
        }
        const cfg = modelFor(models)('side');
        const ask = liveAsker(modelFor(models));
        const usage = { prompt: 0, completion: 0, calls: 0 };
        let dossier: StoredDossier | null = null;
        let researchNote: ChatReply['research'] | undefined;
        let addedIds = new Set<string>();
        try {
            dossier = await projectDossier(req.projectId, req.topic, req.context ?? '', usage);
            // 아직 어느 메시지에도 기록하지 않은 프로젝트 조사(처음, 하루가 지나·맥락이 바뀌어 다시 한 것, 설계 뽑기가 먼저 돌린 것)면
            // 그 전체를, 아니면 이 발언으로 더 찾은 것만 알린다.
            const fresh = Boolean(dossier.unreported);
            const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
            const turn = lastUser ? await turnResearch(req.projectId, req.topic, req.context ?? '', lastUser, dossier, (schema, o) => ask<any>(schema as never, o as never, usage)) : { added: [], searches: [], failed: [] };
            addedIds = new Set(turn.added.map((f) => f.id));
            if (fresh) {
                researchNote = researchNoteOf(
                    dossier.findings,
                    [...(dossier.searches ?? []), ...turn.searches],
                    [...dossier.fetched.filter((f) => !f.ok).map((f) => ({ url: f.url, ...(f.error ? { error: f.error } : {}) })), ...turn.failed],
                    'initial',
                );
                dossier.unreported = false;
                saveDossier(req.projectId, dossier, req.context ?? '');
            } else if (turn.added.length || turn.searches.length || turn.failed.length) researchNote = researchNoteOf(turn.added, turn.searches, turn.failed, 'turn');
        } catch {
            dossier = dossier ?? null;
        }
        // 모델에게 보이는 자료 — 이 발언으로 찾은 것을 맨 앞에(목록이 길면 뒤가 잘리므로), 나머지는 원래 순서.
        const handles = dossier ? handlesOf(dossier) : [];
        const shown = [...handles.filter((h) => addedIds.has(h.handle)), ...handles.filter((h) => !addedIds.has(h.handle))];
        const transcript = req.messages
            .slice(-24)
            .map((m) => `### ${m.role === 'user' ? '필자' : '파트너'}\n${m.content}`)
            .join('\n\n');
        const user = [
            `## 논문 주제\n${req.topic}`,
            ...(req.context?.trim() ? ['', `## 필자가 준 배경\n${req.context.trim()}`] : []),
            ...(req.plan && (req.plan.thesis || req.plan.title) ? ['', thesisBlock(req.plan)] : []),
            '',
            dossier ? researchBlock(shown, Math.max(28, addedIds.size + 20), 220) : '## 조사 자료\n(아직 없음)',
            '',
            '## 대화',
            transcript,
            '',
            '파트너로서 마지막 필자의 말에 답한다.',
        ].join('\n');
        try {
            const text = await complete(cfg, { name: 'side', system: CHAT_SYSTEM, user, maxTokens: 3000 }, usage);
            return { text, model: cfg.model, usage, ...(researchNote ? { research: researchNote } : {}) };
        } catch (e) {
            // 답이 실패해도 조사는 이미 돌았다(자료는 dossier 에 들어갔다). 기록을 돌려줘 필자의 발언에 남긴다.
            return { text: '', model: cfg.model, usage, error: e instanceof Error ? e.message.slice(0, 300) : String(e), ...(researchNote ? { research: researchNote } : {}) };
        }
    })));

    ipcMain.handle('plan:propose', (_e, req: PlanProposeRequest) => withToolScope(() => withRecorder(conceiveRecorder(req.projectId), async () => {
        applyEnv(getSettings());
        let models;
        try {
            models = resolveModels(process.env);
        } catch (e) {
            return { error: e instanceof Error ? e.message.slice(0, 300) : String(e) };
        }
        const ask = liveAsker(modelFor(models));
        let findings: Dossier['findings'] = [];
        try {
            findings = (await projectDossier(req.projectId, req.topic, req.context ?? '')).findings;
        } catch {
            findings = [];
        }
        try {
            const plan = await proposeThesis(
                { topic: req.topic, ...(req.context ? { context: req.context } : {}), messages: req.messages, current: req.current ?? null, findings },
                ask,
                { prompt: 0, completion: 0, calls: 0 },
            );
            return { plan };
        } catch (e) {
            return { error: e instanceof Error ? e.message.slice(0, 300) : String(e) };
        }
    })));

    /** @deprecated 옆질문 — 구상 대화로 흡수됨. 호환용으로 남긴다. */
    ipcMain.handle('side:ask', async (_e, req: SideAsk): Promise<SideAnswer> => {
        applyEnv(getSettings());
        const models = resolveModels(process.env);
        const cfg = modelFor(models)('side');
        const user = [`## 논문 주제\n${req.topic}`, ...(req.context ? ['', `## 필자가 준 배경\n${req.context}`] : []), ...(req.summary ? ['', `## 현재 검토 원장 요약\n${req.summary}`] : []), '', `## 옆질문\n${req.question}`].join('\n');
        try {
            const text = await complete(cfg, { name: 'side', system: CHAT_SYSTEM, user, maxTokens: 2048 });
            return { text, model: cfg.model };
        } catch (e) {
            return { text: '', model: cfg.model, error: e instanceof Error ? e.message.slice(0, 300) : String(e) };
        }
    });
}

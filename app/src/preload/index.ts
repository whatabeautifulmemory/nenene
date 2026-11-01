// contextBridge. renderer 가 볼 수 있는 것은 이 표면뿐이다 — node 도 ipc 도 직접 못 쓴다.
import { contextBridge, ipcRenderer } from 'electron';
import type { Answer, LegalApi, MainEvent, RunRequest, RunTag, Settings, SourceAdded } from '../shared/ipc.ts';

// 홈 화면의 「GitHub 갱신」 단추가 쓰는 다리 하나 — 형식을 이 다리와 같은 자리에서 LegalApi 에 더한다.
declare module '../shared/ipc.ts' {
    interface LegalApi {
        /** GitHub 접근 허용(홈 화면) — 값 없이 부르면 지금 답, 'yes'|'no' 를 주면 바꾼 답. null 은 아직 묻지 않음. */
        corpusNetwork(answer?: 'yes' | 'no'): Promise<'yes' | 'no' | null>;
    }
}

const api: LegalApi = {
    providers: () => ipcRenderer.invoke('providers'),
    listModels: (p: string, endpoint?: string) => ipcRenderer.invoke('models:list', p, endpoint),
    modelContext: (m: string) => ipcRenderer.invoke('models:context', m),
    hasKey: (p: string) => ipcRenderer.invoke('keys:has', p),
    setKey: (p: string, k: string) => ipcRenderer.invoke('keys:set', p, k),
    getSettings: () => ipcRenderer.invoke('settings:get'),
    saveSettings: (s: Settings) => ipcRenderer.invoke('settings:save', s),
    start: (req: RunRequest) => ipcRenderer.invoke('run:start', req),
    cancel: (runId: string) => ipcRenderer.invoke('run:cancel', runId),
    answer: (runId: string, a: Record<string, Answer>) => ipcRenderer.invoke('run:answer', runId, a),
    onEvent: (cb: (e: MainEvent, from?: RunTag) => void) => {
        const h = (_: unknown, e: MainEvent, from?: RunTag) => cb(e, from);
        ipcRenderer.on('legal:event', h);
        return () => {
            ipcRenderer.removeListener('legal:event', h);
        };
    },
    runStatus: (projectId: string) => ipcRenderer.invoke('run:status', projectId),
    runAck: (runId: string) => ipcRenderer.invoke('run:ack', runId),
    loadLedger: (runDir: string) => ipcRenderer.invoke('ledger:load', runDir),
    loadPaper: (runDir: string) => ipcRenderer.invoke('paper:load', runDir),
    exportAs: (kind, payload) => ipcRenderer.invoke('export:as', kind, payload),
    openPath: (p: string) => ipcRenderer.invoke('shell:open', p),
    pickFolder: () => ipcRenderer.invoke('dialog:folder'),
    chatSend: (req) => ipcRenderer.invoke('chat:send', req),
    planPropose: (req) => ipcRenderer.invoke('plan:propose', req),
    sideAsk: (req) => ipcRenderer.invoke('side:ask', req),
    workspaceGet: () => ipcRenderer.invoke('workspace:get'),
    workspaceChoose: () => ipcRenderer.invoke('workspace:choose'),
    projectsList: () => ipcRenderer.invoke('projects:list'),
    projectCreate: (topic, context) => ipcRenderer.invoke('projects:create', topic, context),
    projectSave: (id, p) => ipcRenderer.invoke('projects:save', id, p),
    projectLoad: (id) => ipcRenderer.invoke('projects:load', id),
    projectDelete: (id) => ipcRenderer.invoke('projects:delete', id),
    refsList: (id) => ipcRenderer.invoke('refs:list', id),
    refsAdd: (id) => ipcRenderer.invoke('refs:add', id),
    refsOpenFolder: (id) => ipcRenderer.invoke('refs:open', id),
    refsPick: () => ipcRenderer.invoke('refs:pick'),
    transcriptExport: (id, runDir, kind) => ipcRenderer.invoke('transcript:export', id, runDir, kind),
    auditExport: (id) => ipcRenderer.invoke('audit:export', id),
    listRuns: (id) => ipcRenderer.invoke('runs:list', id),
    corpusStatus: () => ipcRenderer.invoke('corpus:status'),
    corpusDownload: () => ipcRenderer.invoke('corpus:download'),
    corpusNetwork: (answer?: 'yes' | 'no') => ipcRenderer.invoke('corpus:network', answer),
    openSourceBrowser: (req) => ipcRenderer.invoke('srcbrowser:open', req),
    onSourceAdded: (cb) => {
        const h = (_: unknown, a: SourceAdded) => cb(a);
        ipcRenderer.on('legal:source-added', h);
        return () => {
            ipcRenderer.removeListener('legal:source-added', h);
        };
    },
    searchProviders: () => ipcRenderer.invoke('search:providers'),
};

contextBridge.exposeInMainWorld('legal', api);

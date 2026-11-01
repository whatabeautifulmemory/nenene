// 원문 찾기 브라우저 — 「사람의 답이 필요합니다」에서 후보 링크를 누르면 여기서 연다.
//
// 흐름: 후보 위치(KCI·법제처·DOI·학술검색…)를 앱 안 창에서 연다 → 필자가 로그인하거나 「원문 보기」를 눌러 원문을 띄운다 →
// 내려받는 파일은 **자동으로** 프로젝트의 references/ 에 저장되고 그 질문의 답(「제공」)에 붙는다. PDF 가 아니라 웹 페이지면
// 「이 페이지 넣기」로 보이는 글(모든 프레임)을 .md 로 저장해 붙인다. 브라우저에서 내려받아 경로를 찾아 붙여 넣던 일을 없앤다.
//
// 탭: 페이지가 여는 새 창(target=_blank·window.open·POST 폼·빈 창에 글 쓰기·⌘/가운데 누르기)은 **같은 창의 탭**으로 연다.
// Chromium 이 만든 웹 내용을 그대로 탭에 넣으므로(createWindow) POST 본문·window.opener·window.close() 가 브라우저처럼 동작한다.
// 예전에는 http(s) 팝업을 지금 페이지 자리에 덮어 열고(검색 결과가 사라졌다) 빈 창은 도구막대 없는 별도 창으로 띄웠다.
// 탭은 질문에 묶인다 — 다른 질문으로 열면 앞 질문의 탭과 받는 중인 파일을 닫는다. 창을 닫아도 질문은 살아 있다(받던 파일은 붙는다).
// 질문이 끝나는 것은 답했을 때·실행을 멈췄을 때·다른 질문으로 넘어갔을 때뿐이다(retire).
//
// 보안: 페이지는 신뢰할 수 없다. 페이지 쪽에는 preload 도 node 도 없다(sandbox). http(s) 만 연다. 앱의 IPC 는 도구막대(우리 파일)만 쓴다.
// 권한은 앱 화면(파일·개발 서버) 말고는 모두 거절한다(서비스 워커·PDF 뷰어 포함). 내려받기는 **그 탭에서** 사람이 누른 뒤에만 받는다.
// 세션은 앱 기본 세션이다(로그인이 앱을 다시 켜도 남는다) — 따로 만든 persist: 세션은 두 번째부터 모든 요청이 ERR_FAILED 로
// 실패했다(Electron 33, 앱 창이 기본 세션을 먼저 연 뒤). 앱 화면은 file:// 이라 웹 페이지와 저장소가 섞이지 않는다.
import { app, BrowserWindow, Menu, WebContentsView, clipboard, ipcMain, nativeTheme, net, session, type ClientRequest, type DownloadItem, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface SourceBrowserOpen {
    /** 이 브라우저에서 넣은 파일을 붙일 질문 */
    askId: string;
    /** 도구막대에 보일 질문 이름(인용) */
    label: string;
    url: string;
    projectId: string;
}

export interface SourceAdded {
    askId: string;
    /** 질문의 답에 넣을 값 — 공백·따옴표가 있어도 안전한 file:// 주소 */
    ref: string;
    path: string;
    name: string;
    kind: 'download' | 'page';
}

/** 질문 하나. retired 는 답했거나 다른 질문으로 넘어갔다는 뜻 — 그 뒤에 끝난 내려받기는 붙이지 않는다. */
type Target = SourceBrowserOpen & { dir: string; retired?: boolean; requests: Set<ClientRequest> };

interface Tab {
    /** webContents.id — 도구막대가 탭을 가리키는 이름 */
    id: number;
    view: WebContentsView;
    /** 이 탭(과 이 탭이 연 탭)에서 받은 것을 붙일 질문 */
    owner: Target;
    openerId?: number;
    /** 이 탭을 연 페이지의 주소(열 때 정해 둔다) — 빈 창 탭의 「이 페이지 넣기」 출처. 연 탭이 닫히거나 옮겨 가도 그대로다. */
    source?: string;
    /** 질문 패널에서 연 주소 — 같은 후보를 다시 누르면 새 탭 대신 이 탭으로 */
    startUrl?: string;
    /** 이 탭의 문서를 띄운 POST — 「이 페이지 넣기」가 PDF 를 다시 받을 때 같은 요청을 보낸다(GET 으로 받으면 오류 페이지가 온다) */
    post?: { url: string; body: Buffer; contentType?: string; referrer?: string };
    /** 이 탭에서 사람이 마지막으로 누르거나 친 때 — 페이지가 연 탭은 연 탭의 것을 물려받는다 */
    lastInputAt: number;
}

type Level = 'info' | 'ok' | 'warn';

/** 도구막대 높이 — 탭이 둘 이상이면 탭 줄이 생긴다 */
const BAR_ONE = 84;
const BAR_TABS = 118;
/** 팝업이 팝업을 여는 페이지가 창을 채우지 못하게 */
const MAX_TABS = 12;
/** 사람이 누르거나 친 뒤 이 시간 안의 내려받기만 받는다 — 페이지가 스스로 파일을 넣지 못하게(LPS_BROWSER_GESTURE_MS 는 시험용) */
const GESTURE_MS = Number(process.env.LPS_BROWSER_GESTURE_MS) || 30_000;
/** 누른 뒤 이 시간 안에 페이지가 연 새 창만 앞으로 띄운다. 그 밖(광고·타이머)은 뒤쪽 탭으로 */
const POPUP_GESTURE_MS = 5_000;
/** 「이 페이지 넣기」가 부른 내려받기가 이 시간 안에 시작하지 않으면 실패를 알린다(LPS_BROWSER_ADD_TIMEOUT_MS 는 시험용) */
const ADD_TIMEOUT_MS = Number(process.env.LPS_BROWSER_ADD_TIMEOUT_MS) || 20_000;
/** 받는 파일의 상한 — 논문·판결 PDF 는 이보다 훨씬 작다 */
const MAX_FILE = 150 * 1024 * 1024;
/** 파이프라인이 읽는 형식만 질문에 붙인다(src/law/sources.ts loadOneProvided). 나머지는 받지 않는다. */
const READABLE = new Set(['.pdf', '.docx', '.html', '.htm', '.txt', '.md']);
/** 파일 이름이 엉뚱할 때(FileDown.do·view.jsp) 서버가 밝힌 형식으로 이름을 고친다 */
const MIME_EXT: [RegExp, string][] = [
    [/pdf/i, '.pdf'],
    [/wordprocessingml/i, '.docx'],
    [/html/i, '.html'],
    [/markdown/i, '.md'],
    [/text\/plain/i, '.txt'],
];
/** 형식을 밝히지 않는 내려받기(octet-stream) — 받은 뒤 내용을 보고 PDF·DOCX 면 넣는다 */
const OPAQUE_MIME = /^(|application\/(octet-stream|x-download|force-download|download|unknown|binary)|binary\/octet-stream)$/i;
const NEVER_EXT = /^\.(zip|exe|dmg|pkg|msi|apk|jar|7z|rar|gz|tgz|iso|bat|cmd|sh|js|vbs|ps1|hwp|hwpx)$/;
/** 짧은 HTML·글 파일이 이런 말이면 원문이 아니라 오류·안내 페이지다 */
const NOTICE_PAGE = /오류\s*페이지|페이지를\s*찾을\s*수\s*없|잘못된\s*(?:접근|요청)|세션이\s*(?:만료|종료)|기간이\s*만료|로그인(?:이|을)?\s*(?:필요|해\s*주)|권한이\s*없|이용\s*권한|Page\s*Not\s*Found|404\s*Not\s*Found|Access\s*Denied|Forbidden/i;
const PAGE_PREFS = {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    plugins: true, // PDF 를 창 안에서 띄운다(Chromium PDF 뷰어)
} as const;
const MAC = process.platform === 'darwin';
/** 안내 글의 단축키 표기 */
const MOD = MAC ? '⌘' : 'Ctrl+';

let win: BrowserWindow | null = null;
let bar: WebContentsView | null = null;
let tabs: Tab[] = [];
let activeId: number | null = null;
/** 지금 질문. 창을 닫아도 남는다 — 답하거나 멈추거나 다른 질문으로 넘어갈 때 retire 한다. */
let target: Target | null = null;
let added: SourceAdded[] = [];
let message = '';
let level: Level = 'info';
/** 「이 페이지 넣기」가 부른 내려받기(주소별) — 사람이 누른 것으로 치고, 제때 시작하지 않으면 실패를 알린다 */
const pendingAdds = new Map<string, { owner: Target; timer: NodeJS.Timeout }>();
/** 끝난 질문의 「이 페이지 넣기」 주소 — 그 탭이 닫힌 뒤 도착한 내려받기(웹 내용이 없다)도 우리 것으로 알아보고 취소한다 */
const retiredAdds = new Map<string, NodeJS.Timeout>();
/** 이름을 정했지만 아직 디스크에 없는 저장 경로 — 같은 이름의 파일 두 개가 같은 경로를 받지 않게 */
const reserved = new Set<string>();
let mainWin: () => BrowserWindow | null = () => null;
let refsDirOf: (projectId: string) => string = () => '';
/** 이 브라우저에서 생긴 웹 내용 전부(탭·팝업). 닫힌 뒤의 것도 남는다. */
const family = new WeakSet<WebContents>();
/** 받는 중인 파일과 그 질문 — 질문이 끝나면 취소한다 */
const downloads = new Map<DownloadItem, Target>();

const isWeb = (u: string) => /^https?:\/\//i.test(u);
const noHash = (u: string) => u.replace(/#.*$/, '');
const sameUrl = (a: string, b: string): boolean => noHash(a) === noHash(b);
const urlOf = (wc: WebContents): string => (wc.isDestroyed() ? '' : wc.getURL());
const inFamily = (wc: WebContents | null | undefined): boolean => Boolean(wc && !wc.isDestroyed() && (family.has(wc) || (wc.hostWebContents && family.has(wc.hostWebContents))));
/** Chromium 의 PDF 뷰어(확장 프로그램 페이지). 탭 안에 뜨지만 hostWebContents 가 비어 있다. */
const isPdfViewer = (wc: WebContents | null | undefined): boolean => Boolean(wc && !wc.isDestroyed() && /^chrome-extension:\/\//.test(wc.getURL()));
const activeTab = (): Tab | undefined => tabs.find((t) => t.id === activeId);
const tabOf = (wc: WebContents | null | undefined): Tab | undefined =>
    wc && !wc.isDestroyed() ? tabs.find((t) => t.view.webContents === wc || (wc.hostWebContents && t.view.webContents === wc.hostWebContents)) : undefined;
const newTarget = (req: SourceBrowserOpen): Target => ({ ...req, dir: refsDirOf(req.projectId), requests: new Set() });

/**
 * 저장할 파일 이름 — 경로 구분자·예약 문자·공백·따옴표를 _ 로(따옴표는 답을 여러 개로 나눌 때 끊긴다), 확장자는 지키고 이름은
 * UTF-8 150바이트까지(파일 이름 255바이트 한도), 이미 있거나 다른 내려받기가 잡아 둔 이름이면 -2, -3… 정한 경로는 잡아 둔다
 * (release 로 푼다) — 같은 순간에 시작한 같은 이름의 내려받기가 한 파일을 덮어쓰던 것을 막는다.
 */
function uniquePath(dir: string, name: string): string {
    const clean = (name || 'download').replace(/[\\/:*?"<>|'`#%\s]+/g, '_').replace(/^\.+/, '') || 'download';
    const ext = extname(clean).slice(0, 10);
    let stem = clean.slice(0, clean.length - extname(clean).length) || 'download';
    while (Buffer.byteLength(stem) > 150) stem = stem.slice(0, -1);
    let p = join(dir, `${stem}${ext}`);
    for (let i = 2; existsSync(p) || reserved.has(p); i++) p = join(dir, `${stem}-${i}${ext}`);
    reserved.add(p);
    return p;
}
const release = (p: string) => reserved.delete(p);

const stemOf = (name: string) => name.slice(0, name.length - extname(name).length) || 'download';

/** 파일 앞(또는 끝) n 바이트 — 큰 파일을 통째로 읽지 않는다 */
function readPart(path: string, n: number, fromEnd = false): Buffer {
    const fd = openSync(path, 'r');
    try {
        const size = fstatSync(fd).size;
        const len = Math.min(n, size);
        const b = Buffer.alloc(len);
        const got = readSync(fd, b, 0, len, fromEnd ? size - len : 0);
        return b.subarray(0, got);
    } finally {
        closeSync(fd);
    }
}

/** 받은 파일의 실제 형식 — 확장자를 믿지 않는다. DOCX 는 ZIP 끝의 목록(central directory)에 word/document.xml 이 있는지로. */
function sniff(path: string): 'pdf' | 'docx' | 'zip' | 'other' {
    const head = readPart(path, 1024).toString('latin1');
    if (head.includes('%PDF-')) return 'pdf'; // 앞에 공백·BOM 이 붙어 오는 서버가 있다
    if (head.startsWith('PK')) return readPart(path, 256 * 1024, true).toString('latin1').includes('word/document.xml') ? 'docx' : 'zip';
    return 'other';
}

function sendState(): void {
    if (!bar || bar.webContents.isDestroyed()) return;
    const wc = activeTab()?.view.webContents;
    const live = wc && !wc.isDestroyed() ? wc : undefined;
    const title = live?.getTitle() ?? '';
    if (win && !win.isDestroyed()) win.setTitle(title ? `원문 찾기 — ${title}` : '원문 찾기');
    bar.webContents.send('srcbar:state', {
        url: live?.getURL() ?? '',
        title,
        loading: live?.isLoading() ?? false,
        canBack: live?.navigationHistory.canGoBack() ?? false,
        canForward: live?.navigationHistory.canGoForward() ?? false,
        tabs: tabs.map((t) => {
            const c = t.view.webContents;
            const dead = c.isDestroyed();
            return { id: t.id, title: dead ? '' : c.getTitle(), url: dead ? '' : c.getURL(), loading: !dead && c.isLoading(), active: t.id === activeId };
        }),
        label: target?.label ?? '',
        dir: target?.dir ?? '',
        added: added.filter((a) => a.askId === target?.askId).map((a) => ({ name: a.name, kind: a.kind, path: a.path })),
        message,
        level,
        dark: nativeTheme.shouldUseDarkColors,
    });
}

/** 도구막대 알림. owner 를 주면 그 질문이 끝났을 때(다른 질문의 도구막대가 떠 있을 때) 알리지 않는다. */
function say(m: string, lv: Level = 'info', owner?: Target): void {
    if (owner && (owner.retired || owner !== target)) return;
    message = m;
    level = lv;
    sendState();
}

/** 넣은 파일을 기록하고 앱 창(질문 패널)에 알린다. t 는 그 파일이 나온 탭의 질문이다. */
function attach(path: string, kind: SourceAdded['kind'], t: Target): void {
    if (t.retired) {
        rmSync(path, { force: true });
        return;
    }
    const a: SourceAdded = { askId: t.askId, ref: pathToFileURL(path).href, path, name: basename(path), kind };
    added.push(a);
    const m = mainWin();
    if (m && !m.isDestroyed()) m.webContents.send('legal:source-added', a);
    say(`${a.name} 을(를) 넣었습니다 — 「${t.label.slice(0, 40)}」의 답(「제공」)에 붙었습니다.`, 'ok', t);
}

function layout(): void {
    if (!win || win.isDestroyed() || !bar) return;
    const { width, height } = win.getContentBounds();
    const barH = tabs.length > 1 ? BAR_TABS : BAR_ONE;
    bar.setBounds({ x: 0, y: 0, width, height: barH });
    for (const t of tabs) {
        t.view.setBounds({ x: 0, y: barH, width, height: Math.max(0, height - barH) });
        t.view.setVisible(t.id === activeId);
    }
}

/** 탭을 앞으로. 키보드 초점은 창이 이미 앞에 있을 때만 옮긴다 — 다른 창(앱 화면)에서 쓰던 글자가 페이지로 가지 않게. */
function activate(id: number): void {
    const t = tabs.find((x) => x.id === id);
    if (!t) return;
    activeId = id;
    layout();
    if (win && !win.isDestroyed() && win.isFocused() && !t.view.webContents.isDestroyed()) t.view.webContents.focus();
    sendState();
}

/**
 * 탭을 뗀다. 남은 탭이 없으면 창을 닫는다(keepWindow 면 두고 — 질문을 바꿀 때 새 탭을 곧 연다).
 * 지금 탭이었으면 그 탭을 연 탭으로, 없으면 옆 탭으로 간다.
 */
function removeTab(id: number, keepWindow = false): void {
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [t] = tabs.splice(i, 1);
    if (win && !win.isDestroyed()) win.contentView.removeChildView(t!.view);
    if (!t!.view.webContents.isDestroyed()) t!.view.webContents.close();
    if (!tabs.length) {
        activeId = null;
        if (!keepWindow && win && !win.isDestroyed()) win.close();
        return;
    }
    if (activeId === id) {
        const opener = t!.openerId !== undefined ? tabs.find((x) => x.id === t!.openerId) : undefined;
        activate((opener ?? tabs[Math.min(i, tabs.length - 1)]!).id);
    } else {
        layout();
        sendState();
    }
}

/** 탭 하나를 만든다. webContents 가 오면(페이지가 연 창) 그것을 넣는다 — POST·opener 가 살아 있다. */
function addTab(owner: Target, opts: { webContents?: WebContents; opener?: Tab; background?: boolean; post?: Tab['post'] } = {}): Tab {
    const view = new WebContentsView({ webPreferences: { ...PAGE_PREFS }, ...(opts.webContents ? { webContents: opts.webContents } : {}) });
    const o = opts.opener;
    const openerUrl = o ? urlOf(o.view.webContents) : '';
    const tab: Tab = {
        id: view.webContents.id,
        view,
        owner,
        lastInputAt: o?.lastInputAt ?? 0,
        ...(o ? { openerId: o.id } : {}),
        ...(o ? { source: isWeb(openerUrl) ? openerUrl : o.source } : {}),
        ...(opts.post ? { post: opts.post } : {}),
    };
    if (!tab.source) delete tab.source;
    // 페이지가 연 탭은 연 탭 뒤, 같은 탭이 앞서 연 탭들 뒤에 — 브라우저처럼(결과 1·2·3 을 열면 1·2·3 순서)
    let at = o ? tabs.findIndex((t) => t.id === o.id) : -1;
    if (at >= 0) while (tabs[at + 1]?.openerId === o!.id) at++;
    if (at >= 0) tabs.splice(at + 1, 0, tab);
    else tabs.push(tab);
    win!.contentView.addChildView(view);
    view.setVisible(false);
    guardTab(tab);
    if (!opts.background || activeId === null) activate(tab.id);
    else {
        layout();
        sendState();
    }
    return tab;
}

/** 링크를 새 탭에서 연다(오른쪽 메뉴·질문 패널·주소창). 탭이 가득이면 열지 않는다 — 지금 페이지를 덮어쓰지 않는다. */
function openInTab(owner: Target, url: string, opts: { referrer?: string; opener?: Tab } = {}): Tab | undefined {
    if (!isWeb(url)) return undefined;
    if (tabs.length >= MAX_TABS) {
        say(`탭이 ${MAX_TABS}개라 새 탭을 열지 않았습니다 — 쓰지 않는 탭을 닫은 뒤 다시 눌러 주세요.`, 'warn');
        return undefined;
    }
    const t = addTab(owner, opts.opener ? { opener: opts.opener } : {});
    t.view.webContents.loadURL(url, opts.referrer ? { httpReferrer: opts.referrer } : {}).catch(() => {
        /* did-fail-load 가 도구막대에 알린다 */
    });
    return t;
}

function nextTab(step: number): void {
    if (tabs.length < 2) return;
    const i = Math.max(0, tabs.findIndex((t) => t.id === activeId));
    activate(tabs[(i + step + tabs.length) % tabs.length]!.id);
}

function zoom(wc: WebContents | undefined, step: number | null): void {
    if (!wc) return;
    wc.setZoomLevel(step === null ? 0 : Math.max(-3, Math.min(5, wc.getZoomLevel() + step)));
}

/**
 * 단축키 — 앱 메뉴가 없는 창이라 직접 받는다. ⌘(맥)·Ctrl(그 밖) 기준. 뒤로·앞으로는 맥이 ⌘[ ⌘], 그 밖이 Alt+←→ 다
 * (맥의 ⌥←→ 는 글자 칸에서 낱말 이동이라 가로채지 않는다). 누르고 있어 반복되는 키로 탭이 줄줄이 닫히지 않게 ⌘W 는 반복을 무시한다.
 */
function shortcut(e: Electron.Event, input: Electron.Input): void {
    if (input.type !== 'keyDown') return;
    const mod = MAC ? input.meta : input.control;
    const key = input.key.toLowerCase();
    const t = activeTab();
    const wc = t && !t.view.webContents.isDestroyed() ? t.view.webContents : undefined;
    let done = true;
    if (mod && !input.shift && key === 'w') {
        if (t && !input.isAutoRepeat) removeTab(t.id);
    } else if (input.control && key === 'tab') nextTab(input.shift ? -1 : 1);
    else if (mod && input.shift && (input.code === 'BracketRight' || input.code === 'BracketLeft')) nextTab(input.code === 'BracketRight' ? 1 : -1);
    else if (mod && !input.shift && /^[1-9]$/.test(input.key)) {
        const n = Number(input.key);
        const pick = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
        if (pick) activate(pick.id);
    } else if (mod && key === 'l') {
        if (bar && !bar.webContents.isDestroyed()) {
            bar.webContents.focus();
            bar.webContents.send('srcbar:focus-url');
        }
    } else if (mod && key === 'r') wc?.reload();
    else if (mod && (key === '=' || key === '+')) zoom(wc, 0.5);
    else if (mod && key === '-') zoom(wc, -0.5);
    else if (mod && key === '0') zoom(wc, null);
    else if ((MAC && input.meta && !input.shift && input.code === 'BracketLeft') || (!MAC && input.alt && key === 'arrowleft')) wc?.navigationHistory.goBack();
    else if ((MAC && input.meta && !input.shift && input.code === 'BracketRight') || (!MAC && input.alt && key === 'arrowright')) wc?.navigationHistory.goForward();
    else done = false;
    if (done) e.preventDefault();
}

/** 오른쪽 누르기 메뉴 — Electron 은 기본 메뉴가 없어 링크를 새 탭으로 열 길이 없었다. */
function contextMenu(tab: Tab, p: Electron.ContextMenuParams): void {
    const wc = tab.view.webContents;
    const items: MenuItemConstructorOptions[] = [];
    if (p.linkURL && isWeb(p.linkURL)) {
        items.push(
            { label: '새 탭에서 열기', click: () => openInTab(tab.owner, p.linkURL, { referrer: urlOf(wc), opener: tab }) },
            { label: '링크 주소 복사', click: () => clipboard.writeText(p.linkURL) },
            { type: 'separator' },
        );
    }
    if (p.isEditable) {
        items.push({ label: '잘라내기', role: 'cut', enabled: p.editFlags.canCut }, { label: '복사', role: 'copy', enabled: p.editFlags.canCopy }, { label: '붙여넣기', role: 'paste', enabled: p.editFlags.canPaste }, { type: 'separator' });
    } else if (p.selectionText.trim()) {
        items.push({ label: '복사', role: 'copy' }, { type: 'separator' });
    }
    items.push(
        { label: '뒤로', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: '앞으로', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: '새로고침', click: () => wc.reload() },
    );
    if (win && !win.isDestroyed()) Menu.buildFromTemplate(items).popup({ window: win });
}

/** 탭 쪽 안전장치와 이벤트 — http(s) 만, 새 창은 탭으로, 권한은 거절(prepareSession), 내려받기는 references/ 로. */
function guardTab(tab: Tab): void {
    const wc = tab.view.webContents;
    family.add(wc);
    wc.setWindowOpenHandler((d) => {
        const blank = d.url === '' || d.url === 'about:blank';
        if (!isWeb(d.url) && !blank) return { action: 'deny' };
        if (tabs.length >= MAX_TABS) {
            say(`탭이 ${MAX_TABS}개라 페이지가 연 새 창을 막았습니다 — 쓰지 않는 탭을 닫아 주세요.`, 'warn', tab.owner);
            return { action: 'deny' };
        }
        // 사람이 방금 이 탭에서 누른 것이 연 창만 앞으로 띄운다. 타이머·광고·뒤쪽 탭이 연 창은 뒤쪽 탭으로(초점을 빼앗지 않게).
        const byUser = tab.id === activeId && Date.now() - tab.lastInputAt < POPUP_GESTURE_MS;
        const raw = d.postBody?.data.filter((x): x is Electron.UploadRawData => x.type === 'rawData');
        const post =
            d.postBody && raw && raw.length === d.postBody.data.length && isWeb(d.url)
                ? {
                      url: d.url,
                      body: Buffer.concat(raw.map((x) => x.bytes)),
                      contentType: `${d.postBody.contentType}${d.postBody.boundary ? `; boundary=${d.postBody.boundary}` : ''}`,
                      ...(d.referrer?.url ? { referrer: d.referrer.url } : {}),
                  }
                : undefined;
        return {
            action: 'allow',
            // 탭은 연 탭이 닫혀도 남는다(브라우저처럼). 창을 닫으면 모두 닫는다(closed).
            outlivesOpener: true,
            // o.webContents 는 Chromium 이 이미 만든 새 창의 웹 내용이다(타입 정의에는 없다). target=_blank·window.open 이면 오고
            // 주소를 이미 싣고 있다. ⌘·가운데 누르기(background-tab)는 비어 오므로 — 그때는 주소를 직접 연다(Electron 33 에서 확인).
            createWindow: (o) => {
                const made = (o as Electron.BrowserWindowConstructorOptions & { webContents?: WebContents }).webContents;
                const t = addTab(tab.owner, { ...(made ? { webContents: made } : {}), opener: tab, background: d.disposition === 'background-tab' || !byUser, ...(post ? { post } : {}) });
                if (!byUser && d.disposition !== 'background-tab') say('페이지가 새 탭을 뒤쪽에 열었습니다.', 'info', tab.owner);
                if (!made && isWeb(d.url)) {
                    t.view.webContents
                        .loadURL(d.url, {
                            ...(d.referrer?.url ? { httpReferrer: d.referrer } : {}),
                            ...(d.postBody ? { postData: d.postBody.data, extraHeaders: `Content-Type: ${d.postBody.contentType}${d.postBody.boundary ? `; boundary=${d.postBody.boundary}` : ''}` } : {}),
                        })
                        .catch(() => {});
                }
                return t.view.webContents;
            },
        };
    });
    wc.on('will-navigate', (e, url) => {
        if (!isWeb(url)) e.preventDefault();
    });
    for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated'] as const) wc.on(ev as 'did-stop-loading', () => sendState());
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
        if (isMain && code !== -3 && tab.id === activeId) say(`열지 못했습니다: ${desc} (${url})`, 'warn', tab.owner);
    });
    wc.on('render-process-gone', () => {
        if (tab.id === activeId) say(`페이지가 멈췄습니다 — 새로고침(${MOD}R)하거나 탭을 닫아 주세요.`, 'warn', tab.owner);
    });
    // 페이지가 window.close() 를 부르면(로그인 팝업이 끝나면) 웹 내용이 없어진다 — 탭도 뗀다.
    wc.on('destroyed', () => removeTab(tab.id));
    wc.on('input-event', (_e, ie) => {
        if (/^(mouseDown|keyDown|rawKeyDown|touchStart|gestureTap)$/.test(ie.type)) tab.lastInputAt = Date.now();
    });
    wc.on('before-input-event', shortcut);
    wc.on('context-menu', (_e, p) => contextMenu(tab, p));
}

/** 앱 화면(창의 웹 내용)인가 — 개발 중에는 http://localhost 를 띄우므로 주소가 아니라 종류로 가린다. */
const isAppContents = (wc: WebContents): boolean => !inFamily(wc) && !isPdfViewer(wc) && wc.getType() === 'window';
const appOrigin = (u: string | undefined): boolean => {
    if (!u) return false;
    if (u.startsWith('file:')) return true;
    const m = mainWin();
    try {
        return Boolean(m && !m.isDestroyed() && new URL(u).origin === new URL(m.webContents.getURL()).origin);
    } catch {
        return false;
    }
};

function finishDownload(item: DownloadItem, path: string, owner: Target, opts: { expected: boolean; opaque: boolean }): void {
    let interrupted = false;
    let tooBig = false;
    item.on('updated', (_e, state) => {
        // 끊긴 내려받기는 Chromium 이 「다시 이어 받기」를 기다리며 done 을 내지 않는다 — 취소해 끝을 낸다.
        if (state === 'interrupted') {
            interrupted = true;
            item.cancel();
        } else if (item.getReceivedBytes() > MAX_FILE) {
            tooBig = true;
            item.cancel();
        }
    });
    item.once('done', (_ev, state) => {
        downloads.delete(item);
        release(path);
        const saved = item.getSavePath() || path;
        const drop = () => rmSync(saved, { force: true });
        if (owner.retired) return drop();
        if (state !== 'completed') {
            drop();
            say(
                tooBig ? `${basename(path)}: 너무 커서(150MB 넘음) 받지 않았습니다.` : interrupted ? `받는 도중 끊겼습니다: ${basename(path)} — 다시 눌러 주세요.` : `받지 못했습니다(${state === 'cancelled' ? '취소됨' : '중단됨'}): ${basename(path)}`,
                'warn',
                owner,
            );
            return;
        }
        const reject = (why: string) => {
            drop();
            say(`${basename(saved)}: ${why}`, 'warn', owner);
        };
        let final = saved;
        try {
            const kind = sniff(saved);
            const ext = extname(saved).toLowerCase();
            if (opts.opaque) {
                // 형식을 밝히지 않은 파일 — 내용이 PDF·DOCX 일 때만 이름을 고쳐 넣는다.
                const real = kind === 'pdf' ? '.pdf' : kind === 'docx' ? '.docx' : '';
                if (!real) return reject('PDF·DOCX 가 아닌 파일이라 넣지 않았습니다.');
                const dest = uniquePath(owner.dir, `${stemOf(basename(saved))}${real}`);
                try {
                    renameSync(saved, dest);
                } finally {
                    release(dest);
                }
                final = dest;
            } else if (ext === '.pdf' && kind !== 'pdf') {
                return reject('PDF 가 아니라 다른 것이 왔습니다(링크 만료·로그인 필요). 원문 보기를 다시 눌러 주세요.');
            } else if (ext === '.docx' && kind !== 'docx') {
                return reject('DOCX 가 아니라 다른 것이 왔습니다.');
            } else if (opts.expected && kind !== 'pdf') {
                return reject('PDF 를 다시 받았더니 다른 것이 왔습니다(링크 만료·로그인 필요). 사이트의 「다운로드」 버튼을 눌러 주세요.');
            } else if (ext === '.html' || ext === '.htm' || ext === '.txt' || ext === '.md') {
                const text = readPart(saved, 400_000).toString('utf8').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                if (text.length < 400 || (text.length < 3000 && NOTICE_PAGE.test(text))) return reject('원문이 아니라 오류·안내 페이지로 보여 넣지 않았습니다.');
            }
        } catch (err) {
            // 확인하지 못한 파일은 넣지 않는다(이름 바꾸기가 백신 등에 막히면 .part 가 남는다 — 그것도 지운다).
            return reject(`확인하지 못해 넣지 않았습니다(${err instanceof Error ? err.message : String(err)}).`);
        }
        attach(final, 'download', owner);
    });
}

let sessionReady = false;
function prepareSession(): void {
    if (sessionReady) return;
    sessionReady = true;
    const ses = session.defaultSession;
    // 권한은 앱 화면에만. 웹 내용이 없는 요청(서비스 워커)은 요청한 주소로 가린다 — 예전에는 둘 다 허용됐다.
    ses.setPermissionRequestHandler((wc, _perm, cb, details) => cb(wc ? isAppContents(wc) : appOrigin(details.requestingUrl)));
    ses.setPermissionCheckHandler((wc, _perm, origin, details) => (wc ? isAppContents(wc) : appOrigin(details.requestingUrl ?? origin)));
    // 탭의 문서를 띄운 POST 를 기억한다 — 같은 탭에서 보낸 폼(검색·「원문보기」)도 다시 받을 수 있게.
    ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'], types: ['mainFrame'] }, (d, cb) => {
        const t = d.webContentsId !== undefined ? tabs.find((x) => x.id === d.webContentsId) : undefined;
        if (t) {
            const raw = d.uploadData?.filter((x) => x.bytes);
            const keepType = t.post?.url === d.url ? t.post.contentType : undefined;
            t.post =
                d.method === 'POST' && raw?.length && raw.length === d.uploadData!.length
                    ? { url: d.url, body: Buffer.concat(raw.map((x) => x.bytes)), ...(keepType ? { contentType: keepType } : {}), ...(d.referrer ? { referrer: d.referrer } : {}) }
                    : undefined;
        }
        cb({});
    });
    ses.on('will-download', (_e, item, wc) => {
        const tab = tabOf(wc);
        const viewer = !tab && isPdfViewer(wc) && Boolean(win && !win.isDestroyed());
        // 「이 페이지 넣기」가 부른 것인가 — 그 탭이 그 사이 닫혔어도(웹 내용이 없어도) 그 질문의 것이다.
        const key = item.getURLChain().map(noHash).find((u) => pendingAdds.has(u));
        const add = key ? pendingAdds.get(key) : undefined;
        if (add) {
            clearTimeout(add.timer);
            pendingAdds.delete(key!);
        }
        // 닫힌 탭(웹 내용이 없어진 것)에서 온 내려받기도 이 브라우저의 것이다 — 그냥 두면 Electron 이 「저장」 창을 띄운다.
        const late = key ? undefined : item.getURLChain().map(noHash).find((u) => retiredAdds.has(u));
        if (late) {
            item.cancel();
            return;
        }
        const ours = Boolean(tab || viewer || add || (wc && (wc.isDestroyed() || family.has(wc))));
        if (!ours) return; // 앱 화면의 내려받기는 건드리지 않는다
        const owner = add?.owner ?? tab?.owner ?? (viewer ? activeTab()?.owner : undefined);
        if (!owner || owner.retired) {
            item.cancel();
            return;
        }
        let name = item.getFilename();
        if (!name) {
            try {
                name = basename(new URL(item.getURL()).pathname);
            } catch {
                /* blob:·data: 주소 */
            }
        }
        name ||= 'download';
        // 사람이 **그 탭에서** 누르지 않은 내려받기는 받지 않는다(PDF 뷰어의 저장 단추는 Chromium 것이라 믿는다).
        // 다른 탭이나 도구막대를 누른 것으로 뒤쪽 탭의 내려받기가 풀리지 않게 탭마다 잰다.
        if (!add && !viewer && Date.now() - (tab?.lastInputAt ?? 0) > GESTURE_MS) {
            item.cancel();
            say(`페이지가 스스로 내려받으려던 파일을 막았습니다(${name}). 원하는 파일이면 링크를 직접 눌러 주세요.`, 'warn', owner);
            return;
        }
        if (item.getTotalBytes() > MAX_FILE) {
            item.cancel();
            say(`${name}: 너무 커서(150MB 넘음) 받지 않았습니다.`, 'warn', owner);
            return;
        }
        let ext = extname(name).toLowerCase();
        const mime = item.getMimeType();
        let opaque = false;
        if (!READABLE.has(ext)) {
            const byMime = MIME_EXT.find(([re]) => re.test(mime))?.[1];
            if (ext === '.hwp' || ext === '.hwpx' || /hwp/i.test(mime)) {
                item.cancel();
                say(`${name}: HWP 는 읽지 못합니다 — PDF 로 받아 주세요.`, 'warn', owner);
                return;
            }
            if (byMime) {
                name = `${stemOf(name)}${byMime}`;
                ext = byMime;
            } else if (OPAQUE_MIME.test(mime) && !NEVER_EXT.test(ext)) {
                opaque = true;
                name = `${stemOf(name)}.part`;
            } else {
                item.cancel();
                say(`${name}: 넣을 수 없는 형식입니다(PDF·DOCX·HTML·TXT 만).`, 'warn', owner);
                return;
            }
        }
        mkdirSync(owner.dir, { recursive: true });
        const path = uniquePath(owner.dir, name);
        item.setSavePath(path);
        downloads.set(item, owner);
        say(`받는 중: ${basename(path)}`, 'info', owner);
        finishDownload(item, path, owner, { expected: Boolean(add), opaque });
    });
    // 시스템 밝기 모드가 바뀌면 도구막대·창 바탕도 바꾼다(페이지가 조용할 때도).
    nativeTheme.on('updated', () => {
        if (win && !win.isDestroyed()) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1c1c1f' : '#faf9f6');
        sendState();
    });
}

/** 질문이 끝났다 — 받는 중인 것·다시 받는 중인 것은 취소하고, 늦게 끝난 것은 붙이지 않는다. */
function retire(t: Target | null): void {
    if (!t || t.retired) return;
    t.retired = true;
    for (const [item, owner] of downloads) {
        const st = item.getState();
        if (owner === t && st !== 'completed' && st !== 'cancelled') item.cancel();
    }
    for (const r of t.requests) r.abort();
    t.requests.clear();
    for (const [k, a] of pendingAdds) {
        if (a.owner !== t) continue;
        clearTimeout(a.timer);
        pendingAdds.delete(k);
        clearTimeout(retiredAdds.get(k));
        retiredAdds.set(
            k,
            setTimeout(() => retiredAdds.delete(k), 120_000),
        );
    }
}

function createWindow(): void {
    prepareSession();
    const parent = mainWin();
    win = new BrowserWindow({
        width: 1180,
        height: 860,
        minWidth: 720,
        minHeight: 480,
        title: '원문 찾기',
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1f' : '#faf9f6',
        ...(parent ? { parent } : {}),
        show: false,
    });
    win.removeMenu?.();
    // 창 제목은 지금 탭의 제목을 따른다(sendState). 창의 웹 내용은 비어 있어 제목을 덮어쓰지 않게 한다.
    win.on('page-title-updated', (e) => e.preventDefault());
    bar = new WebContentsView({
        webPreferences: {
            preload: join(app.getAppPath(), 'out', 'preload', 'browser-bar.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    win.contentView.addChildView(bar);
    // 도구막대는 우리 파일 말고는 열지 않는다(끌어다 놓기 등).
    bar.webContents.on('will-navigate', (e) => e.preventDefault());
    bar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    bar.webContents.on('did-finish-load', () => sendState());
    bar.webContents.on('before-input-event', shortcut);
    // 도구막대에서 누르거나 친 것(주소 입력 등)은 지금 탭의 것으로 친다 — 주소창에 친 주소가 곧바로 파일인 경우.
    bar.webContents.on('input-event', (_e, ie) => {
        const t = activeTab();
        if (t && /^(mouseDown|keyDown|rawKeyDown)$/.test(ie.type)) t.lastInputAt = Date.now();
    });
    void bar.webContents.loadFile(join(app.getAppPath(), 'out', 'browser', 'bar.html'));
    win.on('resize', layout);
    const barView = bar;
    win.on('closed', () => {
        // 창이 닫혀도 뷰의 웹 내용은 남는다 — 직접 닫는다(숨은 페이지가 돌며 소리·요청을 내지 않게).
        // 질문(target)은 그대로 둔다: 받던 파일은 그 질문에 붙고, 답하거나 멈추면 그때 retire 한다.
        const all = tabs;
        tabs = [];
        activeId = null;
        for (const t of all) if (!t.view.webContents.isDestroyed()) t.view.webContents.close();
        if (!barView.webContents.isDestroyed()) barView.webContents.close();
        win = null;
        bar = null;
    });
    layout();
    win.show();
}

/**
 * 열기. 같은 질문이면 새 탭으로(같은 후보를 다시 누르면 그 탭으로), 다른 질문이면 앞 질문의 탭을 닫고 새로 연다 —
 * 앞 질문의 팝업에서 받은 파일이 새 질문에 붙지 않게.
 */
export function openSourceBrowser(req: SourceBrowserOpen): void {
    if (!isWeb(req.url)) return;
    const same = Boolean(target && !target.retired && target.askId === req.askId && target.projectId === req.projectId);
    if (!same) {
        retire(target);
        message = '';
        level = 'info';
        target = newTarget(req);
    } else target!.label = req.label;
    const t = target!;
    if (!win || win.isDestroyed()) createWindow();
    else {
        if (!same) for (const x of [...tabs]) removeTab(x.id, true);
        win.focus();
    }
    const existing = tabs.find((x) => x.startUrl === req.url || sameUrl(urlOf(x.view.webContents), req.url));
    if (existing) activate(existing.id);
    else {
        const tab = openInTab(t, req.url);
        if (tab && !tab.startUrl) tab.startUrl = req.url;
        if (tab && process.env.LPS_SHOT_BROWSER && tabs.length === 1) shotHook(tab, process.env.LPS_SHOT_BROWSER);
    }
    sendState();
}

/** 질문에 답했거나 실행을 멈췄으면 질문을 끝내고 창을 닫는다 — 다음 질문 묶음에는 다시 연다. 창이 이미 닫혀 있어도 질문은 끝낸다. */
export function closeSourceBrowser(): void {
    retire(target);
    // 앞서 끝내지 못한 질문의 파일이 남아 있으면 그것도(창을 닫은 뒤 질문이 바뀐 경우)
    for (const owner of new Set(downloads.values())) retire(owner);
    target = null;
    if (win && !win.isDestroyed()) win.close();
    added = [];
}

/** 원문이 아니라 논문 소개(초록·서지) 페이지로 보이는가 — 그런 페이지를 「필자가 준 원문」으로 넣지 않는다. */
function abstractOnly(text: string): boolean {
    // 줄 하나가 통째로 「초록」「Abstract」인 것만 — 뉴스·판결 본문에 「요약」이 한 번 나오는 것까지 잡지 않게.
    const hasAbstract = /(^|\n)\s*(국문\s*초록|초\s*록|Abstract|ABSTRACT|요\s*약)\s*(\n|$)/.test(text);
    // 구조 신호는 **제목 자리**(줄 머리, 「Ⅰ.」「1.」「제1장」 같은 번호 뒤)에 있을 때만 센다 — sources.ts 의 looksLikeFullText(text, true) 와 같다.
    // 아무 데서나 세면 KCI 논문 소개 페이지가 「참고문헌 (41) 열기/닫기」 위젯과 초록 속 「…결론에 도달하였다」로 둘을 채워 원문으로 저장됐다(읽을 때야 거부됐다).
    const esc = (m: string) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const atHead = (m: string) =>
        new RegExp(`(?:^|\\n)[ \\t\\r]*(?:[#*【〈<\\[(][ \\t]*)?(?:(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+|[IVX]+|\\d{1,2}|제\\s*\\d+\\s*[장절])\\s*[.)]?[ \\t]*)?${esc(m)}`).test(text);
    const markers = ['참고문헌', 'References', 'REFERENCES', '서론', 'Introduction', '결론', 'Conclusion', 'Ⅰ.', 'Ⅱ.'].filter(atHead).length;
    return hasAbstract && (text.length < 6000 || markers < 2);
}

/** 내려받기를 부르고 기다린다 — 서버가 파일을 주지 않으면(4xx·만료) 「받는 중」에 멈춰 있지 않게 알린다. 탭마다 따로 기다린다. */
function expectDownload(tab: Tab, url: string): void {
    const key = noHash(url);
    const prev = pendingAdds.get(key);
    if (prev) clearTimeout(prev.timer);
    const owner = tab.owner;
    pendingAdds.set(key, {
        owner,
        timer: setTimeout(() => {
            pendingAdds.delete(key);
            say('받지 못했습니다 — 서버가 파일을 다시 주지 않았습니다(주소 만료·로그인 필요). 사이트의 「다운로드」 버튼을 눌러 주세요.', 'warn', owner);
        }, ADD_TIMEOUT_MS),
    });
    tab.view.webContents.downloadURL(url);
}

/**
 * POST 로 띄운 PDF 를 같은 POST 로 다시 받는다(로그인한 세션 그대로). GET 으로 받으면 오류 페이지가 온다.
 * 처음 요청의 Referer 를 그대로 보낸다(연 탭의 지금 주소를 다른 출처로 보내면 Chromium 이 요청을 막는다).
 * 리다이렉트는 http(s) 로만 따라간다 — file:// 로 보내 로컬 파일을 원문으로 넣게 하는 페이지를 막는다.
 */
function refetchPost(tab: Tab, url: string): void {
    const post = tab.post!;
    const owner = tab.owner;
    const fail = (why: string) => say(why, 'warn', owner);
    say('PDF 를 받는 중…', 'info', owner);
    const ses = session.defaultSession;
    const ref = post.referrer && isWeb(post.referrer) ? post.referrer : tab.source && isWeb(tab.source) ? tab.source : '';
    const req = net.request({ method: 'POST', url, session: ses, useSessionCookies: true, redirect: 'manual', ...(ref ? { referrerPolicy: 'unsafe-url' } : {}) });
    owner.requests.add(req);
    const first = post.body.subarray(0, 200).toString('latin1');
    const boundary = /^--([^\r\n]+)\r?\n/.exec(first)?.[1];
    req.setHeader('Content-Type', post.contentType ?? (boundary ? `multipart/form-data; boundary=${boundary}` : 'application/x-www-form-urlencoded'));
    if (ref) req.setHeader('Referer', ref);
    let hops = 0;
    let finished = false;
    const end = () => {
        finished = true;
        clearTimeout(timer);
        owner.requests.delete(req);
    };
    req.on('redirect', (_status, _method, to) => {
        if (isWeb(to) && ++hops <= 5) return req.followRedirect();
        end();
        req.abort();
        fail(isWeb(to) ? '받지 못했습니다 — 리다이렉트가 너무 많습니다.' : '받지 못했습니다 — 서버가 웹 주소가 아닌 곳으로 보내려 했습니다.');
    });
    const timer = setTimeout(() => {
        if (finished) return;
        end();
        req.abort();
        fail('받지 못했습니다 — 서버가 90초 동안 답하지 않았습니다.');
    }, 90_000);
    req.on('response', (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
            if (finished) return;
            size += c.length;
            if (size > MAX_FILE) {
                end();
                req.abort();
                fail('파일이 너무 커서(150MB 넘음) 넣지 않았습니다.');
                return;
            }
            chunks.push(c);
        });
        res.on('end', () => {
            if (finished) return;
            end();
            if (owner.retired) return;
            const body = Buffer.concat(chunks);
            if (!body.subarray(0, 1024).toString('latin1').includes('%PDF-')) {
                return fail('이 PDF 는 다시 받을 수 없습니다(일회용 주소이거나 세션이 끝남). 사이트의 「다운로드」 버튼을 누르면 그 파일이 바로 붙습니다.');
            }
            const cd = String(res.headers['content-disposition'] ?? '');
            const fromCd = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1] ?? /filename="?([^";]+)"?/i.exec(cd)?.[1];
            let name = 'download.pdf';
            try {
                name = fromCd ? decodeURIComponent(fromCd) : basename(new URL(url).pathname) || name;
            } catch {
                /* 이름은 기본값 */
            }
            mkdirSync(owner.dir, { recursive: true });
            const path = uniquePath(owner.dir, `${stemOf(name)}.pdf`);
            try {
                writeFileSync(path, body);
            } finally {
                release(path);
            }
            attach(path, 'download', owner);
        });
        res.on('error', () => {
            if (finished) return;
            end();
            fail('받는 도중 끊겼습니다.');
        });
    });
    req.on('error', (err) => {
        if (finished) return;
        end();
        fail(`받지 못했습니다: ${err.message}`);
    });
    req.end(post.body);
}

/** 지금 탭을 넣는다. PDF(프레임 안 포함)면 그 파일을 받고(로그인한 세션 그대로), 아니면 보이는 글(모든 프레임)을 .md 로. */
async function addCurrentPage(): Promise<void> {
    const tab = activeTab();
    if (!tab || tab.view.webContents.isDestroyed()) return;
    const t = tab.owner;
    const wc = tab.view.webContents;
    let url = wc.getURL();
    // 빈 창에 글을 써 넣은 팝업(「원문보기」)은 about:blank 다 — 그 창을 연 페이지의 주소(열 때 정해 둔 것)를 출처로 쓴다.
    if (url === 'about:blank' || url === '') url = tab.source ?? '';
    if (!isWeb(url)) {
        say('넣을 수 있는 페이지가 아닙니다 — 원문(PDF·본문)을 띄운 뒤 다시 누르세요.', 'warn', t);
        return;
    }
    // PDF 를 찾는다: 페이지 자체이거나, 뷰어 페이지 안의 프레임.
    for (const f of wc.mainFrame.framesInSubtree) {
        let ct = '';
        try {
            ct = String(await f.executeJavaScript('document.contentType', true));
        } catch {
            /* PDF 뷰어 등 */
        }
        if (/pdf/i.test(ct) || (f === wc.mainFrame && /\.pdf(?:$|[?#])/i.test(f.url))) {
            if (!isWeb(f.url)) continue;
            if (f === wc.mainFrame && tab.post && sameUrl(tab.post.url, f.url)) {
                refetchPost(tab, f.url);
                return;
            }
            say('PDF 를 받는 중…', 'info', t);
            expectDownload(tab, f.url);
            return;
        }
    }
    // 소개 페이지가 원문 PDF 링크를 달고 있으면(citation_pdf_url 등 — 학술지 페이지 대부분) 그것을 받는다. 로그인한 세션 그대로.
    try {
        const link = String(
            await wc.executeJavaScript(
                `(() => { for (const n of ['citation_pdf_url','bepress_citation_pdf_url','eprints.document_url']) { const m = document.querySelector('meta[name="' + n + '"]'); if (m && m.content) return new URL(m.content, location.href).href; } const l = document.querySelector('link[type="application/pdf"][href]'); return l ? l.href : ''; })()`,
                true,
            ),
        );
        if (isWeb(link)) {
            say('이 페이지가 가리키는 원문 PDF 를 받는 중…', 'info', t);
            expectDownload(tab, link);
            return;
        }
    } catch {
        /* 메타를 읽지 못하면 글을 넣는다 */
    }
    const parts: string[] = [];
    for (const f of wc.mainFrame.framesInSubtree) {
        try {
            const text = String(await f.executeJavaScript('document.body ? document.body.innerText : ""', true)).trim();
            if (text.length >= 40 && !parts.includes(text)) parts.push(text);
        } catch {
            /* 막힌 프레임 */
        }
    }
    const text = parts.join('\n\n---\n\n');
    if (text.length < 300) {
        say('이 페이지에는 넣을 만한 글이 거의 없습니다. 원문(PDF·본문)을 띄운 뒤 다시 누르세요.', 'warn', t);
        return;
    }
    if (abstractOnly(text)) {
        say('초록·서지 페이지로 보입니다 — 이것은 원문이 아닙니다. 「원문 보기」로 PDF·본문을 띄운 뒤 다시 누르세요.', 'warn', t);
        return;
    }
    if (t.retired) return;
    const title = (wc.getTitle() || url).replace(/\s+/g, ' ').trim();
    mkdirSync(t.dir, { recursive: true });
    const path = uniquePath(t.dir, `${title.slice(0, 80)}.md`);
    // captured_by 를 맨 앞에 — 읽는 쪽(sources.ts)이 머리 앞부분에서 이 표지를 찾는다. 긴 제목·주소가 표지를 밀어내지 않게 자른다.
    const header = ['---', 'captured_by: nenene-browser', `title: ${title.slice(0, 300)}`, `source: ${url.slice(0, 1000)}`, `captured_at: ${new Date().toISOString()}`, `for: ${t.label.replace(/\s+/g, ' ').slice(0, 200)}`, '---', ''].join('\n');
    try {
        writeFileSync(path, header + text);
    } finally {
        release(path);
    }
    attach(path, 'page', t);
}

/**
 * 시험용(스크린샷 모드): 지금 탭이 다 뜨면 LPS_SHOT_BROWSER_ADD=1 일 때 「이 페이지 넣기」를 누르고, 도구막대·지금 탭을
 * <prefix>-bar.png · <prefix>-page.png 로 찍는다. 앱 창 하나만 찍는 스크린샷 모드로는 이 창이 안 보이기 때문이다.
 */
function shotHook(tab: Tab, prefix: string): void {
    let done = false;
    tab.view.webContents.on('did-stop-loading', () => {
        if (done) return;
        done = true;
        setTimeout(async () => {
            if (process.env.LPS_SHOT_BROWSER_ADD === '1') await addCurrentPage();
            await new Promise((r) => setTimeout(r, 2500));
            const t = activeTab();
            if (!bar || bar.webContents.isDestroyed() || !t || t.view.webContents.isDestroyed()) return;
            writeFileSync(`${prefix}-bar.png`, (await bar.webContents.capturePage()).toPNG());
            writeFileSync(`${prefix}-page.png`, (await t.view.webContents.capturePage()).toPNG());
        }, 2500);
    });
}

export function registerSourceBrowser(opts: { mainWindow: () => BrowserWindow | null; refsDir: (projectId: string) => string }): void {
    mainWin = opts.mainWindow;
    refsDirOf = opts.refsDir;
    ipcMain.handle('srcbrowser:open', (_e, req: SourceBrowserOpen) => openSourceBrowser(req));
    ipcMain.handle('srcbrowser:close', () => closeSourceBrowser());
    // 도구막대에서만 오는 것 — 보낸 쪽이 도구막대인지 확인한다(페이지에는 preload 가 없지만 한 번 더).
    const fromBar = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => Boolean(bar && e.sender === bar.webContents);
    const live = () => {
        const t = activeTab();
        return t && !t.view.webContents.isDestroyed() ? t.view.webContents : undefined;
    };
    ipcMain.on('srcbar:nav', (e, raw: string) => {
        if (!fromBar(e)) return;
        let u = String(raw ?? '').trim();
        if (!u) return;
        if (!/^[a-z]+:\/\//i.test(u)) u = /\s/.test(u) || !/\./.test(u) ? `https://scholar.google.com/scholar?q=${encodeURIComponent(u)}` : `https://${u}`;
        if (!isWeb(u)) return;
        const wc = live();
        if (wc) void wc.loadURL(u).catch(() => {});
        else if (target && !target.retired) openInTab(target, u);
    });
    ipcMain.on('srcbar:back', (e) => fromBar(e) && live()?.navigationHistory.goBack());
    ipcMain.on('srcbar:forward', (e) => fromBar(e) && live()?.navigationHistory.goForward());
    ipcMain.on('srcbar:reload', (e) => fromBar(e) && live()?.reload());
    ipcMain.on('srcbar:tab-select', (e, id: number) => fromBar(e) && activate(Number(id)));
    ipcMain.on('srcbar:tab-close', (e, id: number) => fromBar(e) && removeTab(Number(id)));
    ipcMain.on('srcbar:add-page', (e) => {
        if (fromBar(e)) addCurrentPage().catch((err: unknown) => say(`넣지 못했습니다: ${err instanceof Error ? err.message : String(err)}`, 'warn'));
    });
    ipcMain.on('srcbar:close', (e) => fromBar(e) && win?.close());
    ipcMain.on('srcbar:ready', (e) => fromBar(e) && sendState());
}

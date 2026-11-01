// Electron 진입점.
import { app, BrowserWindow, dialog, shell } from 'electron';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { registerIpc } from './ipc.ts';
import { consentLegalize, offerLegalize } from './legalize-boot.ts';
import { userDataDir } from './settings.ts';

// app.getAppPath() 는 package.json 이 있는 디렉터리다. __dirname/import.meta 로 계산하지 않는
// 이유: 번들·패키징·dev 에서 세 가지 다른 값이 나오고, 그 중 둘은 틀린다.
const appPath = () => app.getAppPath();

// 부팅 흔적. GUI 앱은 터미널이 없으면 stdout 이 사라지므로, 어디까지 갔는지를 파일로 남긴다.
function boot(msg: string): void {
    try {
        writeFileSync(join(tmpdir(), 'lps-boot.log'), `${new Date().toISOString()} ${msg}\n`, { flag: 'a' });
    } catch {
        /* 무시 */
    }
}
boot('module loaded');
// Finder·Dock 으로 띄운 맥 앱은 launchd 의 PATH(/usr/bin:/bin:/usr/sbin:/sbin)만 받는다 — Homebrew 로 깐 pdftotext·git 을
// 못 찾는다(실제로 pdftotext 가 깔려 있는데 "pdftotext 가 필요합니다"로 KCI PDF 를 전부 못 읽었다). 흔한 자리를 앞에 붙인다.
if (process.platform === 'darwin') {
    const have = (process.env.PATH ?? '').split(':');
    const extra = ['/opt/homebrew/bin', '/usr/local/bin'].filter((d) => !have.includes(d) && existsSync(d));
    if (extra.length) process.env.PATH = [...extra, ...have].filter(Boolean).join(':');
}
const here = () => join(appPath(), 'out', 'main');
const isDev = process.argv.includes('--dev');
const isSelftest = process.argv.includes('--selftest');
const isE2e = process.argv.includes('--e2e');
const shotIdx = process.argv.indexOf('--screenshot');
const shotPath = shotIdx > 0 ? process.argv[shotIdx + 1] : null;
// 시험용 — 패키지 앱이 뜨는지만 본다(LPS_HIDDEN_WINDOW=1). 창을 한 번도 보이지 않고 Dock 아이콘도 숨긴다. 부팅 기록에 창이 보였는지 남긴다.
// 시험 실행이기도 하다(legalize-boot 의 testRun) — 묻지 않고, GitHub 에 나가지 않고, 허용 여부를 적지 않는다. 띄울 상자·창은 띄우지 않고 끝낸다(hiddenExit).
const hiddenWindow = process.env.LPS_HIDDEN_WINDOW === '1';
/**
 * 숨은 창에서 창·상자를 띄워야 할 때 — 띄우지 않고 부팅 기록에 남긴 뒤 끝낸다. 보이지 않는 앱의 상자·창은 아무도 닫을 수 없어
 * 점검이 그 자리에서 멈춘 채 남는다(오류 상자를 그대로 띄우던 때가 그랬다).
 */
function hiddenExit(why: string): void {
    boot(`hidden window — ${why} — not shown, exiting`);
    app.exit(1);
}

let win: BrowserWindow | null = null;
const getWin = () => win;

// 파이프라인이 오래 걸리므로 단일 인스턴스로 두고, 두 번째 실행은 기존 창을 띄운다.
// 자체점검·스크린샷 모드는 단일 인스턴스 락을 쓰지 않는다. 개발 중에는 이전 창이 아직
// 종료 중인 경우가 흔하고, 그때 테스트가 "다른 인스턴스가 락을 잡고 있다"로 조용히 끝난다.
const testMode = isSelftest || Boolean(shotPath);
boot(`singleInstance=${testMode ? 'skipped' : app.requestSingleInstanceLock()}`);
if (!testMode && !app.requestSingleInstanceLock()) {
    boot('another instance holds the lock — quitting');
    app.quit();
} else {
    app.on('second-instance', () => {
        if (win && !hiddenWindow) {
            if (win.isMinimized()) win.restore();
            win.focus();
        }
    });
}

function createWindow(): BrowserWindow {
    const w = new BrowserWindow({
        width: 1440,
        height: 920,
        minWidth: 1000,
        minHeight: 640,
        title: 'Nenene',
        backgroundColor: '#faf9f6',
        titleBarStyle: 'hiddenInset',
        ...(hiddenWindow ? { show: false } : {}),
        webPreferences: {
            preload: join(appPath(), 'out', 'preload', 'index.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            // preload 가 ESM 이 아닌 CJS 번들이므로 sandbox 는 끈다. renderer 에는 여전히
            // node 가 없고 contextBridge 로 노출한 표면만 쓸 수 있다.
            sandbox: false,
        },
    });

    // renderer 의 window.open(url) 은 새 Electron 창이 아니라 **시스템 브라우저**로 보낸다.
    // 출처 URL 을 앱 안에서 열면 키체인·IPC 표면이 외부 페이지와 같은 창에 놓인다.
    w.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
        return { action: 'deny' };
    });
    boot(`selftest=${isSelftest} dev=${isDev} appPath=${appPath()}`);
    const target = isDev ? 'http://localhost:5173' : join(appPath(), 'out', 'renderer', 'index.html');
    boot(`loading ${target}`);
    w.webContents.on('did-finish-load', () => boot('did-finish-load'));
    if (hiddenWindow) w.webContents.once('did-finish-load', () => boot(`window visible=${w.isVisible()}`));
    w.webContents.on('did-fail-load', (_e, c, d, u) => boot(`did-fail-load ${c} ${d} ${u}`));
    w.webContents.on('console-message', (_e, _l, m) => boot(`renderer console: ${m}`));
    if (isDev) w.loadURL(target);
    else
        w.loadFile(target).catch((e) => {
            boot(`loadFile rejected: ${e?.message ?? e}`);
        });

    w.on('closed', () => {
        win = null;
    });
    return w;
}

app.whenReady().then(() => {
    boot('app ready');

    // 스크린샷 모드: 실제 실행 산출물(원고·원장)을 프로젝트로 심어 두고 창을 띄운 뒤 찍는다.
    // 빈 화면이 아니라 **데이터가 들어간 UI** 를 확인하는 것이 목적이다.
    if (shotPath) {
        try {
            const seedPaper = process.env.LPS_SEED_PAPER ?? '';
            const seedRun = process.env.LPS_SEED_RUN ?? '';
            const seedTopic = process.env.LPS_SEED_TOPIC ?? '한국 휴대전화번호 기반 본인확인체계에서 파생되는 연계정보(CI)의 헌법적 문제점';
            writeFileSync(
                join(userDataDir(), 'project.json'),
                JSON.stringify({ version: 1, topic: seedTopic, manuscript: seedPaper, runDir: seedRun, savedAt: new Date().toISOString() }),
            );
            boot(`seeded project (paper ${seedPaper.length}자, run ${seedRun})`);
        } catch (e) {
            boot(`seed failed: ${String(e)}`);
        }
    }
    // 파이프라인의 코퍼스 루트.
    //
    // 개발 실행에서는 앱이 프로젝트 디렉터리 안에 있으므로 한 단계 위가 루트다. 패키징하면
    // appPath 가 app.asar 라서 그 위가 아무 데도 아니다 — 그래서 리소스에 넣어 둔 corpus/ 를
    // 가리킨다. 이걸 틀리면 법령·판례 인덱스를 못 찾아 **모든 인용이 "코퍼스 밖"으로** 나온다.
    //
    // 패키지 앱은 리소스의 corpus/ 를 **사용자 데이터 폴더로 한 번 복사해** 그쪽을 루트로 쓴다. 번들 안은 쓰기용이
    // 아니다 — 조문을 처음 읽을 때 git 이 가져오는 내용, 원문 캐시, 필자가 준 원문이 모두 루트 아래에 쌓인다.
    let root = app.isPackaged ? join(process.resourcesPath, 'corpus') : resolve(appPath(), '..');
    if (app.isPackaged && !process.env.LEGAL_AGENT_ROOT) {
        const mine = join(userDataDir(), 'corpus');
        try {
            // 처음이면 통째로 복사. 앱을 새 버전으로 바꿔 번들의 코퍼스가 달라졌으면(기준 커밋이 다르면) 목록·클론·기록을 새로 덮고,
            // 원문 캐시는 있는 것을 두고 없는 것만 더한다. 어느 번들에서 왔는지는 corpus/.bundled 에 적어 둔다.
            const bundledMeta = (() => {
                try {
                    return readFileSync(join(root, 'data', 'cache', 'legalize-meta.json'), 'utf8');
                } catch {
                    return '';
                }
            })();
            const marker = join(mine, '.bundled');
            const copiedFrom = existsSync(marker) ? readFileSync(marker, 'utf8') : '';
            if (!existsSync(root)) {
                // 코퍼스를 넣지 않은 빌드 — 복사할 것이 없다. 사용자 데이터 폴더를 그대로 루트로 쓰고,
                // 법령·판례 목록은 시작 시 점검(ensureLegalize)이 받는다. (전에는 복사가 실패해 번들 안의 없는 경로를 루트로 썼다.)
                mkdirSync(join(mine, 'data', 'cache'), { recursive: true });
            } else if (!existsSync(join(mine, 'data', 'cache', 'law-index.txt'))) {
                cpSync(root, mine, { recursive: true, force: false, errorOnExist: false });
                writeFileSync(marker, bundledMeta);
            } else if (bundledMeta && bundledMeta !== copiedFrom) {
                for (const f of ['law-index.txt', 'precedent-index.txt', 'legalize-meta.json']) cpSync(join(root, 'data', 'cache', f), join(mine, 'data', 'cache', f), { force: true });
                rmSync(join(mine, '.legalize'), { recursive: true, force: true });
                cpSync(join(root, '.legalize'), join(mine, '.legalize'), { recursive: true });
                cpSync(join(root, 'data', 'cache', 'docs'), join(mine, 'data', 'cache', 'docs'), { recursive: true, force: false, errorOnExist: false });
                writeFileSync(marker, bundledMeta);
            }
            root = mine;
        } catch (e) {
            boot(`corpus copy failed — using bundled read-only corpus: ${String(e)}`);
        }
    }
    process.env.LEGAL_AGENT_ROOT = process.env.LEGAL_AGENT_ROOT ?? root;
    boot(`root=${process.env.LEGAL_AGENT_ROOT} packaged=${app.isPackaged}`);
    registerIpc(getWin);
    if (hiddenWindow) app.dock?.hide();
    // 숨은 창에서는 다른 창(원문 찾기 브라우저 등)도 띄우지 않는다 — 사람이 눌러야 열리지만 보이지 않는 앱에는 누를 사람이 없고, 그래도 열리면
    // (스크린샷의 LPS_SHOT_JS 처럼 대신 누른 것) 아무도 닫을 수 없다. 큰 창은 이 다음 줄에서 만들어지므로 win 이 있을 때만 본다.
    if (hiddenWindow) {
        app.on('browser-window-created', (_e, w) => {
            if (win && w !== win) hiddenExit('another window was created');
        });
    }
    win = createWindow();
    // 법령·판례 목록 점검 — 창이 뜬 뒤, 목록이 없으면 받을지, 있으면(번들 포함) GitHub 갱신을 허용할지 한 번 묻는다(답은 사용자 데이터 폴더에 — legalize-boot.ts).
    // 백그라운드라 창은 멈추지 않고, 실행은 runner 가 이걸 기다린다. 시험 실행(자체점검·스크린샷·e2e, LPS_LEGALIZE_ANSWER, LPS_HIDDEN_WINDOW=1 등)은 묻지 않고 GitHub 에 나가지 않는다 —
    // 이 컴퓨터에 있는 목록·원문만 쓰고(없으면 받지 않는다) 허용 여부를 적지 않는다(test) — 시험 결과가 네트워크에 따라 달라지지 않게.
    if ((testMode || isE2e) && process.env.LPS_LEGALIZE_ANSWER !== 'no') consentLegalize({ test: true });
    win.webContents.once('did-finish-load', () => void offerLegalize((m) => boot(`legalize: ${m}`)));

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) win = createWindow();
    });

    if (shotPath) {
        // 시험용: 원문 요청(asks)을 심는다 — 파이프라인을 돌리지 않고 질문 패널·원문 찾기 브라우저를 확인하려고.
        const asksFile = process.env.LPS_SHOT_ASKS;
        if (asksFile) {
            win.webContents.once('did-finish-load', () => {
                setTimeout(() => win?.webContents.send('legal:event', { type: 'asks', asks: JSON.parse(readFileSync(asksFile, 'utf8')) }), Number(process.env.LPS_SHOT_ASKS_DELAY ?? 6000));
            });
        }
        win.webContents.once('did-finish-load', async () => {
            await new Promise((r) => setTimeout(r, 2500));
            // 탭을 먼저 바꾸고 JS 를 실행한다 — 반대 순서면 그 탭에만 있는 버튼을 못 찾는다.
            const tab = process.env.LPS_SHOT_TAB;
            if (tab) {
                await win!.webContents.executeJavaScript(
                    `document.querySelectorAll('.tab')[${Number(tab)}]?.click(); true`,
                );
                await new Promise((r) => setTimeout(r, 700));
            }
            const shotJs = process.env.LPS_SHOT_JS;
            if (shotJs) {
                await win!.webContents.executeJavaScript(shotJs).catch((e) => boot(`shot js failed: ${e}`));
                await new Promise((r) => setTimeout(r, 900));
            }
            const img = await win!.webContents.capturePage();
            writeFileSync(shotPath, img.toPNG());
            boot(`screenshot ${shotPath} ${img.getSize().width}x${img.getSize().height}`);
            setTimeout(() => app.exit(0), 200);
        });
    }

    if (isSelftest) {
        // GUI 앱의 stdout 은 터미널이 없으면 사라진다. 자체 점검 결과는 파일로도 남긴다.
        const out = join(tmpdir(), 'lps-selftest.log');
        win.webContents.on('did-fail-load', (_e, code, desc, url) => {
            writeFileSync(out, `DID-FAIL-LOAD ${code} ${desc} ${url}\n`);
            app.exit(1);
        });
        win.webContents.once('did-finish-load', async () => {
            boot('selftest handler entered');
            const lines: string[] = [`userData: ${userDataDir()}`];
            const step = async <T,>(label: string, fn: () => Promise<T>): Promise<T | string> => {
                boot(`step: ${label}`);
                try {
                    const v = await Promise.race([
                        fn(),
                        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout 8s')), 8000)),
                    ]);
                    boot(`step ok: ${label}`);
                    return v as T;
                } catch (e) {
                    const m = e instanceof Error ? e.message : String(e);
                    boot(`step FAIL: ${label} — ${m}`);
                    return `ERROR ${m}`;
                }
            };
            // React 의 첫 effect 가 끝나기를 기다린다 — did-finish-load 직후에는 아직
            // "불러오는 중…" 이 렌더되어 있다.
            await new Promise((r) => setTimeout(r, 1500));
            const rendered = await step('renderer rendered', () =>
                win!.webContents.executeJavaScript(`JSON.stringify({ app: !!document.querySelector('.app'), chars: document.body.innerText.length })`),
            );
            lines.push(`renderer: ${String(rendered)}`);
            const has = await step('typeof window.legal', () => win!.webContents.executeJavaScript('typeof window.legal'));
            lines.push(`preload bridge: ${has}`);
            const providers = await step('providers()', () => win!.webContents.executeJavaScript('window.legal.providers()'));
            lines.push(`providers: ${Array.isArray(providers) ? providers.length : String(providers)}`);
            const settings = await step('getSettings()', () => win!.webContents.executeJavaScript('window.legal.getSettings()'));
            const st = settings as { provider?: string; model?: string; baseUrl?: string; maxTokens?: number };
            lines.push(`settings(저장값): provider=${st.provider} model=${JSON.stringify(st.model)} baseUrl=${JSON.stringify(st.baseUrl)} maxTokens=${st.maxTokens}`);
            const { effectiveModel } = await import('./settings.ts');
            const eff = effectiveModel(st as never);
            lines.push(`settings(실효): ${eff.model} @ ${eff.baseUrl}`);
            const { legalizeStatus } = await import('../../../src/law/legalize.ts');
            const cst = legalizeStatus();
            lines.push(`corpus: root=${process.env.LEGAL_AGENT_ROOT} 법령=${cst.lawIndex} 판례=${cst.precedentIndex} 저장소=${cst.clones}/2 방식=${cst.mode}`);
            if (cst.lawIndex === 0 || cst.precedentIndex === 0) lines.push('SELFTEST ERROR: 코퍼스 인덱스를 읽지 못함');

            if (isE2e) {
                // 실제 파이프라인을 Electron main 안에서 한 번 돌린다. 번들·경로·LEGAL_AGENT_ROOT
                // 가 맞는지 확인하는 것이 목적이므로 가장 작은 실행으로 한다(논문 조립은 제외).
                const { startRun } = await import('./runner.ts');
                const s = await import('./settings.ts');
                // 개발용 자체점검에서는 프로젝트 루트의 .env 를 읽어 모델 설정을 채운다.
                const { loadEnv } = await import('../../../src/env.ts');
                loadEnv(join(appPath(), '..', '.env'));
                const devKey = process.env.DEEPSEEK_API_KEY;
                if (devKey) {
                    s.setKey('deepseek', devKey);
                    s.saveSettings({ ...s.getSettings(), provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' });
                }
                const e2eSettings = { ...s.getSettings(), issues: 1, claims: 2, assumeUnavailable: true, withPaper: false };
                const { createProject, defaultWorkspace } = await import('./project.ts');
                const proj = createProject(e2eSettings.workspace || defaultWorkspace(), '형사소송법 제215조의 압수 대상 범위');
                try {
                    const summary = await startRun(
                        {
                            projectId: proj.id,
                            topic: '형사소송법 제215조의 압수 대상 범위',
                            settings: e2eSettings,
                            issues: 1,
                            claims: 2,
                            // 자체점검은 번들·경로 확인이 목적이다. 가장 작은 실행(원자 파이프라인)으로 한다.
                            atomic: true,
                        },
                        (e) => {
                        if (e.type === 'progress') lines.push(`  · ${e.line}`);
                    });
                    lines.push(`E2E run ok: 명제 ${summary.coverage.claims} · 인용 ${summary.coverage.citations} · ${summary.runDir}`);
                } catch (e) {
                    lines.push(`E2E RUN ERROR: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
                }
            }
            const text = '=== SELFTEST ===\n' + lines.join('\n') + '\n';
            boot(text);
            writeFileSync(join(tmpdir(), 'lps-selftest.log'), text);
            setTimeout(() => app.exit(lines.some((l) => l.includes('ERROR')) ? 1 : 0), 300);
        });
    }

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin' || isSelftest) app.quit();
    });
});

process.on('uncaughtException', (e) => {
    process.stderr.write(`uncaught: ${e?.stack ?? e}\n`);
    // 숨은 창에서는 오류 상자를 띄우지 않는다 — 부팅 기록에 남기고 끝낸다(hiddenExit).
    if (hiddenWindow) return hiddenExit(`uncaught exception: ${e?.stack ?? e}`);
    if (isSelftest) app.exit(1);
    else dialog.showErrorBox('예기치 않은 오류', String(e?.message ?? e));
});

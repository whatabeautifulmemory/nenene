// 법령·판례 목록(legalize.kr)의 시작 시 점검과 GitHub 접근 허용. 없으면 **받을지 묻고** 받는다 — git 이 있으면 clone, 없으면 HTTP(윈도우 포함).
//
// 받는 동안 창은 멈추지 않는다(ensureLegalize 는 비동기). 실행(runner)과 상태 조회는 같은 약속을 기다린다 —
// 두 번 받지 않는다. 진행 메시지는 기다리는 모두에게 간다(시작할 때 띄운 점검에 나중에 합류한 실행에도).
//
// GitHub 에 나가는 일 — 받은 지 7일이 지난 목록의 갱신, 시행 전 법령의 직전(현행) 판본 받기, 조문·판례 원문을 처음 읽을 때 가져오기,
// 목록 받기 — 은 **필자가 허용한 뒤에만** 한다. 답은 사용자 데이터 폴더의 legalize-consent.json({ network: 'yes'|'no', at, via })에 적어 두고,
// 적혀 있는 동안은 다시 묻지 않는다(파일이 없거나 깨졌으면 아직 묻지 않은 것이다). 받아 둔 목록(앱 번들에 든 것 포함)이 있다는 것은 허용이 아니다 —
// 그렇게 보던 때는 패키지 앱이 한 번도 묻지 않고 7일마다 갱신하고 직전 판본과 원문을 GitHub 에서 가져왔다.
//
// 묻는 때:
//  · 목록이 있고 답이 없다 → 창이 뜬 뒤 한 번 「허용 / 허용 안 함」(집필을 먼저 시작하면 그때). 고른 단추는 어느 것이든 적는다.
//    단추를 고르지 않고 닫은 것(Esc·창 닫기)은 답이 아니다 — 적지 않고, 이 실행은 이 컴퓨터에 있는 것만 쓰며, 집필을 시작할 때·다음에 켤 때 다시 묻는다.
//  · 목록이 없고 답이 없다 → 「받기 / 나중에」(켤 때, 그리고 목록 없이 집필을 시작하려 할 때). 「받기」는 허용으로 적는다.
//    「나중에」는 적지 않는다 — 목록이 없는 동안은 켤 때마다, 집필을 시작할 때마다 다시 묻는다. 아무것도 받지 않는다.
//  · 답이 적혀 있다 → 묻지 않는다. 허용이면 목록이 없을 때 그냥 받고, 허용 안 함이면 받지 않는다.
// 허용 안 함(그리고 답하기 전)에는 이 컴퓨터에 있는 것만 쓴다(legalize 의 로컬만) — 없는 원문은 검증 불가로 남는다.
// 답은 홈 화면에서 바꾼다(setNetworkAnswer). 홈의 「받기」·「다시 받기」도 허용이다. CLI 는 묻지 않고 받는다(실행이 곧 동의).
//
// 시험 실행(자체점검·스크린샷·e2e, LPS_LEGALIZE_ANSWER(어떤 값이든), LPS_LEGALIZE_REFRESH=0, NODE_ENV=test, LPS_HIDDEN_WINDOW=1)은 GitHub 에 전혀 나가지 않는다 —
// 묻지 않고, 허용 파일을 읽지도 쓰지도 않으며, 적힌 답·홈에서 고른 답과 상관없이 「허용 안 함」처럼 이 컴퓨터에 있는 것만 쓴다(갱신·직전 판본 받기·
// 원문 가져오기·목록 받기 모두 없음). 목록이 없으면 받지 않는다(「나중에」와 같다). 전에는 시험 실행도 원문을 GitHub 에서 가져오고 목록이 없으면 받았다 —
// 그래서 필자가 「허용 안 함」을 골라 둔 컴퓨터에서도 LPS_LEGALIZE_REFRESH=0 등으로 켠 앱이 GitHub 에 나갔다.
import { app, BrowserWindow, dialog } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensureLegalize, legalizeConsent, legalizeStatus, refreshLegalize, setLegalizeConsent, setLegalizeLocalOnly, staleRepos, type LegalizeStatus } from '../../../src/law/legalize.ts';

let ready: Promise<LegalizeStatus> | null = null;
let lastMessage = '';
let lastError = '';
/** 이 실행에서 받기로 했다(「받기」, 홈의 받기, 허용이 적혀 있음) — 홈의 「준비하는 중」 표시에 쓴다. */
let consented = false;
let asking: Promise<boolean> | null = null;
let askingNetwork: Promise<NetworkAnswer | null> | null = null;
/** 자체점검·스크린샷·e2e(consentLegalize({ test: true })) */
let testFlag = false;
let refreshing: Promise<void> | null = null;
const listeners = new Set<(m: string) => void>();
const broadcast = (m: string) => {
    lastMessage = m;
    for (const l of listeners) l(m);
};

export type NetworkAnswer = 'yes' | 'no';

/**
 * 시험 실행인가 — 답을 미리 정한 시험(LPS_LEGALIZE_ANSWER)과 갱신을 끈 실행(LPS_LEGALIZE_REFRESH=0)·NODE_ENV=test 도 시험이다.
 * 숨은 창(LPS_HIDDEN_WINDOW=1 — 켜짐 점검)도 시험이다: 창이 보이지 않아 아무도 답할 수 없다. 시험이 아니던 때는 허용 여부를 묻는 창이
 * 보이지 않는 창에 붙어 떠 있었다(답이 없어 집필 시작이 그 창을 기다렸다).
 */
const testRun = (): boolean =>
    testFlag || Boolean(process.env.LPS_LEGALIZE_ANSWER) || process.env.LPS_LEGALIZE_REFRESH === '0' || process.env.NODE_ENV === 'test' || process.env.LPS_HIDDEN_WINDOW === '1';

const consentFile = () => join(app.getPath('userData'), 'legalize-consent.json');
/** 적힌 답(undefined: 아직 읽지 않음). 시험 실행은 쓰지 않는다(networkAnswer 가 늘 'no'). */
let answer: NetworkAnswer | null | undefined;

/**
 * GitHub 접근 허용 — 'yes' 허용 · 'no' 허용 안 함 · null 아직 묻지 않음(파일이 없거나 깨짐).
 * 시험 실행은 파일을 읽지 않고 늘 'no' 다 — 홈 화면에도 그 실행이 실제로 따르는 답(허용 안 함)이 보인다.
 */
export function networkAnswer(): NetworkAnswer | null {
    if (testRun()) return 'no';
    if (answer === undefined) {
        answer = null;
        try {
            const j = JSON.parse(readFileSync(consentFile(), 'utf8')) as { network?: unknown };
            if (j.network === 'yes' || j.network === 'no') answer = j.network;
        } catch {
            /* 없거나 깨진 파일 — 아직 묻지 않은 것으로 본다 */
        }
    }
    return answer;
}

/**
 * 답을 적는다 — 원자적으로(쓰다 끊겨도 반쪽 파일이 「허용」으로 읽히지 않게). 쓰지 못하면 이 실행 동안만 따른다.
 * 시험 실행은 적지도 따르지도 않는다 — 홈의 단추·「받기」를 눌러도 그 실행은 GitHub 에 나가지 않고, 필자의 파일도 그대로다.
 */
function remember(v: NetworkAnswer, via: string): void {
    if (testRun()) return;
    answer = v;
    try {
        const f = consentFile();
        mkdirSync(dirname(f), { recursive: true });
        const tmp = `${f}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ network: v, at: new Date().toISOString(), via }, null, 2));
        renameSync(tmp, f);
    } catch (e) {
        broadcast(`GitHub 접근 허용 여부를 저장하지 못했습니다 — 이번 실행 동안만 따릅니다: ${e instanceof Error ? e.message : String(e)}`);
    }
    passGate();
}

/**
 * 홈의 「받기」·「다시 받기」 — 받기에 동의한 것으로 두고 허용으로 적는다.
 * test: 자체점검·스크린샷·e2e 라는 표시일 뿐이다(index.ts) — 받지 않고, 이 실행을 시험 실행(GitHub 에 나가지 않음)으로 둔다.
 */
export function consentLegalize(opts: { test?: boolean } = {}): void {
    if (opts.test) {
        testFlag = true;
        passGate();
        return;
    }
    consented = true;
    remember('yes', 'home-download');
}

/** 홈 화면의 「GitHub 갱신」 단추 — 답을 바꿔 적는다. */
export function setNetworkAnswer(v: NetworkAnswer): void {
    remember(v, 'home');
}

/**
 * 문을 맞춘다 — 허용이면 갱신·직전 판본 받기·원문 가져오기·목록 받기를 열고, 허용 안 함이거나 아직 답이 없으면 이 컴퓨터에 있는 것만 쓴다.
 * 시험 실행은 networkAnswer() 가 'no' 라 늘 이 컴퓨터에 있는 것만 쓴다(적힌 「허용」도 따르지 않는다).
 */
function passGate(): void {
    const yes = networkAnswer() === 'yes';
    setLegalizeConsent(yes);
    setLegalizeLocalOnly(!yes);
}
// 모듈을 부르는 순간 닫는다 — 창이 뜨고 묻기 전에 읽은 조문이 GitHub 에서 오지 않게(라이브러리의 기본은 원문을 가져온다).
passGate();

/**
 * 받은 지 7일이 지났으면 갱신한다(묻지 않는다). 동시에 두 번 하지 않는다 — 켤 때 시작한 갱신에 실행이 합류한다.
 * 실패는 진행 메시지(켤 때는 부팅 기록, 실행 중에는 진행 줄)로만 알리고 이전 판을 그대로 쓴다. 던지지 않는다.
 */
function refreshIfDue(): Promise<void> {
    if (!legalizeConsent() || !staleRepos().length) return refreshing ?? Promise.resolve();
    refreshing ??= refreshLegalize({ onProgress: broadcast })
        .then(() => {})
        .catch((e: unknown) => broadcast(`갱신 실패: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => {
            refreshing = null;
        });
    return refreshing;
}

export function startLegalize(log?: (m: string) => void): Promise<LegalizeStatus> {
    if (log) listeners.add(log);
    if (ready) return ready;
    lastError = '';
    ready = ensureLegalize({ onProgress: broadcast })
        .catch((e: unknown) => {
            lastError = e instanceof Error ? e.message : String(e);
            for (const l of listeners) l(`실패: ${lastError}`);
            ready = null; // 다음 실행 때 다시 시도한다
            return legalizeStatus();
        });
    return ready;
}

/**
 * 창에 붙은 시트로 띄운다(창이 없으면 앱 전체 창).
 * 숨은 창(LPS_HIDDEN_WINDOW=1)에서는 띄우지 않는다 — 시험 실행이라 여기까지 오지 않지만, 오면 아무도 답할 수 없는 창이 뜨는 것이므로
 * 부팅 기록에 남기고 끝낸다(index.ts 의 오류 상자와 같다). 답은 「단추를 고르지 않음」(cancelId)이라 적히지 않는다.
 */
function showQuestion(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
    if (process.env.LPS_HIDDEN_WINDOW === '1') {
        try {
            writeFileSync(join(tmpdir(), 'lps-boot.log'), `${new Date().toISOString()} hidden window — dialog not shown, exiting: ${options.message}\n`, { flag: 'a' });
        } catch {
            /* 무시 */
        }
        app.exit(1);
        return Promise.resolve({ response: options.cancelId ?? -1, checkboxChecked: false });
    }
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

/**
 * 목록은 있고 아직 답이 없을 때 — GitHub 접근을 허용할지 한 번 묻는다. 고른 단추는 어느 것이든 적는다. 동시에 두 번 묻지 않는다
 * (켤 때 물은 창이 떠 있는 동안 집필을 시작한 경우).
 * Esc·창 닫기는 답이 아니다 — cancelId 를 어느 단추도 아닌 2 로 둔다(1 이면 Esc 가 「허용 안 함」으로 영영 적혔다). 맥에서는 Esc 가 듣지 않아
 * 단추를 골라야 하고, 윈도우·리눅스에서 닫으면 2 가 와서 적지 않는다(null — 이 실행은 이 컴퓨터에 있는 것만 쓰고 다음에 다시 묻는다).
 */
function askNetwork(): Promise<NetworkAnswer | null> {
    const a = networkAnswer();
    if (a) return Promise.resolve(a);
    askingNetwork ??= showQuestion({
        type: 'question',
        buttons: ['허용', '허용 안 함'],
        defaultId: 0,
        cancelId: 2,
        message: '법령·판례 목록을 GitHub 에서 갱신해도 될까요?',
        detail: [
            '허용하면 받은 지 7일이 지난 목록을 legalize.kr 의 공개 저장소(GitHub)에서 새로 받고, 인용을 대조할 때 이 컴퓨터에 없는 조문·판례 원문과 시행 중인 판본을 그때그때 가져옵니다.',
            '허용하지 않으면 GitHub 에서는 아무것도 받지 않고, 법령·판례 목록과의 대조는 이 컴퓨터에 있는 것으로만 합니다. 원문이 없는 인용은 「검증 불가」로 남깁니다(판례 원문을 법제처·웹 검색에서 찾는 것은 이 선택과 상관없이 합니다).',
            '한 번 고르면 다시 묻지 않습니다. 홈 화면에서 바꿀 수 있습니다.',
        ].join('\n\n'),
    })
        .then((r) => {
            if (r.response !== 0 && r.response !== 1) return null; // 단추를 고르지 않고 닫음 — 적지 않는다
            const v: NetworkAnswer = r.response === 0 ? 'yes' : 'no';
            remember(v, 'question');
            return v;
        })
        .finally(() => {
            askingNetwork = null;
        });
    return askingNetwork;
}

/** 물어야 하는가 — 목록이 있고 답이 없다(시험 실행은 networkAnswer() 가 'no' 라 묻지 않는다). */
const needsNetworkAnswer = () => networkAnswer() === null;

/**
 * 목록이 없을 때 — 받을지 묻는다. 창에 붙은 시트로 띄우고, 동시에 두 번 묻지 않는다(켤 때 물은 창이 떠 있는 동안 실행을 누른 경우).
 * 답이 적혀 있으면 묻지 않는다(허용이면 받고, 허용 안 함이면 받지 않는다). 시험 실행은 묻지 않고 받지 않는다(networkAnswer() 가 'no').
 */
function ask(when: 'launch' | 'run'): Promise<boolean> {
    const a = networkAnswer();
    if (a) {
        if (a === 'yes') consented = true;
        return Promise.resolve(a === 'yes');
    }
    if (asking) return asking;
    const options = {
        type: 'question' as const,
        buttons: ['받기', '나중에'],
        defaultId: 0,
        cancelId: 1,
        message: when === 'run' ? '집필하려면 법령·판례 목록이 필요합니다. 지금 받을까요?' : '법령·판례 목록을 받을까요?',
        detail: [
            '인용한 조문·판례가 실제로 있는지 대조하는 데 씁니다. legalize.kr 의 공개 저장소 두 곳(GitHub)에서 목록만 받습니다 — 법령 약 5,800건 · 판례 약 125,000건, 12MB 안팎, 보통 몇 초.',
            '원문은 인용할 때 그 문서만 가져옵니다. 「받기」를 고르면 이것과 함께 7일마다의 목록 갱신, 시행 중인 판본 받기도 허용합니다(홈 화면에서 바꿀 수 있습니다).',
            when === 'run' ? '받지 않으면 집필을 시작하지 않습니다.' : '받지 않아도 구상·설계는 할 수 있습니다. 집필을 시작할 때 다시 묻습니다.',
        ].join('\n\n'),
    };
    asking = showQuestion(options)
        .then((r) => {
            if (r.response === 0) {
                consented = true;
                remember('yes', 'download');
            }
            return r.response === 0;
        })
        .finally(() => {
            asking = null;
        });
    return asking;
}

/** 앱이 켜졌을 때 — 목록이 있으면 (답이 없으면 한 번 묻고) 점검만(내려받지 않는다. 허용이면 7일이 지났을 때 갱신), 없으면 묻고 받는다. 기다리지 않아도 된다. */
export async function offerLegalize(log?: (m: string) => void): Promise<void> {
    passGate();
    if (legalizeStatus().ready) {
        // 답을 받은 뒤에 점검한다 — 허용하기 전에는 갱신하지 않는다
        if (needsNetworkAnswer()) await askNetwork();
    } else if (!(await ask('launch'))) return;
    passGate();
    void startLegalize(log).then((st) => (st.ready ? refreshIfDue() : undefined));
}

/**
 * 실행 직전에 부른다 — 준비 중이면 끝날 때까지 기다리고(진행 메시지를 받는다), 실패했으면 다시 시도한다.
 * 목록이 없고 아직 받기로 하지 않았으면 묻는다. 「나중에」(또는 허용 안 함이 적혀 있음)면 declined 로 돌려준다.
 * 목록은 있는데 아직 답이 없으면(켤 때 물은 창이 떠 있거나 묻기 전) 답을 받고 시작한다 — 어느 답이든 실행은 한다.
 */
export async function legalizeReady(
    log?: (m: string) => void,
    signal?: AbortSignal,
): Promise<LegalizeStatus & { declined?: boolean; declinedBy?: 'later' | 'no' | 'test' }> {
    passGate();
    if (!ready && !legalizeStatus().ready) {
        if (!(await ask('run'))) {
            // 허용 안 함이 적혀 있거나 시험 실행이면 묻지 않았다 — 왜 받지 않았는지 진행 줄에 남기고, 집필을 멈추는 말(runner)도 그에 맞춘다
            // (declinedBy — 「다시 집필을 시작하면 다시 묻습니다」는 「나중에」일 때만 맞다).
            const by = testRun() ? 'test' : networkAnswer() === 'no' ? 'no' : 'later';
            if (by === 'test') log?.('시험 실행이라 목록을 받지 않았습니다 — 시험 실행은 GitHub 에 나가지 않습니다.');
            else if (by === 'no') log?.('GitHub 접근을 허용하지 않아 목록을 받지 않았습니다 — 홈 화면의 「받기」를 누르면 받습니다.');
            passGate(); // 「나중에」 — 갱신도 직전 판본 받기도 원문 가져오기도 하지 않는다
            return { ...legalizeStatus(), declined: true, declinedBy: by };
        }
    } else if (needsNetworkAnswer()) await askNetwork();
    passGate();
    // 기다리다 중단된 실행의 진행 줄이 다음 실행에 섞이지 않게 — 중단되면 바로 듣기를 멈춘다.
    if (log) signal?.addEventListener('abort', () => listeners.delete(log), { once: true });
    try {
        const st = await startLegalize(log);
        if (!st.ready) return st;
        // 실행을 시작하기 전에 갱신한다(7일) — 실행 기록 머리(runner.ts)의 코퍼스 커밋이 갱신된 커밋이 되게, 끝날 때까지 기다린다(제한 시간이 있다).
        await refreshIfDue();
        return legalizeStatus();
    } finally {
        if (log) listeners.delete(log);
    }
}

/** 상태 조회용 — 기다리지 않는다. network: GitHub 접근 허용(홈 화면에 보인다 — 시험 실행은 'no'). */
export function legalizeProgress(): { preparing: boolean; message: string; error: string; consented: boolean; network: NetworkAnswer | null } {
    return { preparing: Boolean(ready) && !legalizeStatus().ready, message: lastMessage, error: lastError, consented, network: networkAnswer() };
}

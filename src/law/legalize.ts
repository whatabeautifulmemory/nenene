// legalize.kr as a tool: 대한민국 법령·판례를 "모델 기억"이 아니라 로컬 원문에서 읽는다.
//
// 왜 이게 PoC의 중심인가: 이 파이프라인의 인용 검증은 LLM 판정이 아니라 **원문 대조**여야 한다.
// 같은 모델에게 "이 판례 실재하니?"라고 물으면 그건 검증이 아니라 재확인이고, 두 번째 모델도
// 첫 번째와 같은 방식으로 틀린다. 그래서 인용은 여기서 결정적으로 판정한다 — 파일이 있으면
// 실재하고, 없으면 없다.
//
// 데이터: legalize.kr 두 저장소를 blobless partial clone 으로 받아 두고(트리만, 약 25MB),
// 파일 내용은 필요할 때 git 이 지연 fetch 한다. API 레이트리밋을 쓰지 않고, 오프라인에서도
// 이미 받은 문서는 즉시 읽힌다.
//
//   legalize-kr   kr/{법령명}/{법령구분}.md      예: kr/형사소송법/법률.md
//   precedent-kr  {분류}/{법원}/{법원}_{선고일}_{사건번호}.md
//                 예: 형사/대법원/대법원_2022-06-30_2022도1452.md
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 코퍼스 루트. **지연 계산**이다.
 *
 * 상수로 두면 모듈이 로드되는 순간 값이 굳는다 — Electron 앱은 자기 루트를 app.whenReady() 에서
 * 정하는데, 그때는 이미 파이프라인 모듈이 평가된 뒤다. 그래서 번들 안에서 루트가 앱 디렉터리로
 * 잡혔고, 인덱스가 "없다"고 나왔다. 처음 쓸 때 계산하면 순서 문제가 사라진다.
 */
const root = () => process.env.LEGAL_AGENT_ROOT ?? resolve(import.meta.dirname, '../..');
export const CLONES = () => join(root(), '.legalize');
export const CACHE = () => join(root(), 'data/cache');
const DOC_CACHE = () => join(CACHE(), 'docs');
const META = () => join(CACHE(), 'legalize-meta.json');

export class LegalizeUnavailable extends Error {}

type Repo = 'legalize-kr' | 'precedent-kr';
const REPOS: Repo[] = ['legalize-kr', 'precedent-kr'];
const INDEX_FILE: Record<Repo, string> = { 'legalize-kr': 'law-index.txt', 'precedent-kr': 'precedent-index.txt' };
const GH = 'https://github.com/legalize-kr';

/** 받아 둔 저장소의 상태 — 어느 커밋을, 어떤 방식으로(git 클론 / HTTP) 받았는가. */
interface RepoMeta {
    commit: string;
    source: 'git' | 'http';
    at: string;
    files: number;
    /** 고정 커밋의 raw 주소가 404(강제 push 로 사라짐)라 HEAD 로 읽었다 — 7일을 기다리지 않고 다음 실행 전에 갱신한다. */
    stale?: boolean;
    /** 마지막 갱신 실패 시각 — 오프라인에서 실행할 때마다 제한 시간만큼 기다리지 않게, 잠시 다시 시도하지 않는다. */
    refreshFailedAt?: string;
}
type Meta = Partial<Record<Repo, RepoMeta>>;
const readMeta = (): Meta => {
    try {
        return JSON.parse(readFileSync(META(), 'utf8')) as Meta;
    } catch {
        return {};
    }
};
const writeMeta = (m: Meta) => {
    mkdirSync(CACHE(), { recursive: true });
    writeFileSync(META(), JSON.stringify(m, null, 2));
};

/**
 * 코퍼스 받기에 동의했는가 — 7일마다의 자동 갱신과, 시행 전 법령의 직전(현행) 판본 받기는 이 문을 지난 뒤에만 GitHub 에 나간다.
 * 기본은 닫혀 있다: 라이브러리로 부르는 쪽(시험·스크립트)은 열지 않으면 나가지 않는다. CLI 는 묻지 않고 받으므로 --mock 이 아니면 열고,
 * 앱은 legalize-boot 가 필자의 허용(허용 여부를 묻는 창의 「허용」, 「받기」)을 확인한 뒤 연다 — 받아 둔 목록(번들 포함)이 있다는 것은 허용이 아니다.
 */
let netConsent = false;
export function setLegalizeConsent(v: boolean): void {
    netConsent = v;
}
export const legalizeConsent = (): boolean => netConsent;

/**
 * 이 컴퓨터에 있는 것만 쓴다 — GitHub 에 전혀 나가지 않는다. 앱에서 필자가 GitHub 접근을 「허용 안 함」으로 골랐거나 아직 답하지 않았을 때,
 * 앱의 시험 실행과 CLI 의 --mock, 또는 LPS_LEGALIZE_NETWORK=0 · LPS_LEGALIZE_REFRESH=0 · NODE_ENV=test(CLI·라이브러리). 동의(netConsent)는 갱신·직전 판본 받기만 막는다 — 그것만으로는 목록 받기와 원문을 처음 읽을 때의
 * 가져오기(git 지연 fetch · 고정 커밋 raw · 404 → HEAD)가 그대로 나갔다. 여기서는 그것도 하지 않고, 받아 둔 원문(원문 캐시·클론에 든 blob)만 읽는다.
 * 없는 원문은 LegalizeOffline 이다 — 검증은 「없는 법령·조문」이 아니라 검증 불가(차단 아님)로 둔다(verify.ts).
 * 기본은 꺼져 있다 — 라이브러리로 부르는 쪽(시험·스크립트)은 지금처럼 원문을 가져온다.
 */
let localOnly = false;
export function setLegalizeLocalOnly(v: boolean): void {
    // 「허용」으로 바뀌면 이 실행에서 못 읽은 판본 머리를 버린다 — 이제 읽을 수 있다(그대로 두면 판본 고르기가 계속 그 판본을 「없음」으로 본다).
    if (localOnly && !v) for (const [p, x] of versionCache) if (x.offline) versionCache.delete(p);
    localOnly = v;
}
// 시험 경로(LPS_LEGALIZE_REFRESH=0 · NODE_ENV=test)도 CLI·라이브러리에서 로컬만이다 — 필자의 규칙에서 이 둘은 네트워크 없는 시험 경로다.
// 갱신·직전 판본 받기만 막던 때는 그 값으로 돌린 CLI·라이브러리가 목록이 없으면 받고 원문을 GitHub 에서 가져왔다(앱의 시험 실행만 로컬이었다).
export const legalizeLocalOnly = (): boolean => localOnly || process.env.LPS_LEGALIZE_NETWORK === '0' || process.env.LPS_LEGALIZE_REFRESH === '0' || process.env.NODE_ENV === 'test';
/** 원문을 이 컴퓨터에서 찾지 못했고 GitHub 에 나가지 않는다 — 검증 불가의 이유로 그대로 적는다. */
export const OFFLINE_NOTE = '원문이 이 컴퓨터에 없음 — GitHub 접근을 허용하지 않음';
export class LegalizeOffline extends LegalizeUnavailable {}
// 목록이 없다고 알릴 때 왜 받지 않는지 — env 로 막았으면 그 이름을 댄다(CLI 를 그 값으로 돌린 사람이 「허용하지 않음」을 고른 적은 없다).
const offlineWhy = () =>
    process.env.LPS_LEGALIZE_NETWORK === '0' ? 'LPS_LEGALIZE_NETWORK=0'
    : process.env.LPS_LEGALIZE_REFRESH === '0' ? 'LPS_LEGALIZE_REFRESH=0'
    : process.env.NODE_ENV === 'test' ? 'NODE_ENV=test'
    : 'GitHub 접근을 허용하지 않음';
const offlineList = (repo: Repo | '법령·판례') => new LegalizeOffline(`${repo} 목록이 이 컴퓨터에 없음 — ${offlineWhy()}`);

/** 이 컴퓨터의 오늘(현지 날짜) — 시행일자와 견준다. UTC 로 자르면 한국의 새벽 0~9시에 하루 어긋난다. */
export function todayLocal(d = new Date()): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let gitChecked: boolean | null = null;
/** git 이 있는가. 윈도우·맥에 기본으로 깔려 있지 않을 수 있다 — 없으면 HTTP 로 받는다. */
export function gitAvailable(): boolean {
    if (process.env.LEGAL_AGENT_NO_GIT === '1') return false;
    if (gitChecked !== null) return gitChecked;
    try {
        // macOS 의 /usr/bin/git 은 개발자 도구(CLT)가 없으면 "설치하시겠습니까" 창을 띄우는 껍데기다. 먼저 확인한다.
        if (process.platform === 'darwin' && (process.env.PATH ?? '').split(':').every((d) => d === '/usr/bin' || !existsSync(join(d, 'git')))) {
            execFileSync('xcode-select', ['-p'], { stdio: 'ignore', timeout: 5_000 });
        }
        execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 10_000, windowsHide: true });
        gitChecked = true;
    } catch {
        gitChecked = false;
    }
    return gitChecked;
}

/**
 * 클론의 커밋을 git 없이 읽는다(.git/shallow · HEAD · packed-refs). 앱 번들에 든 클론을 git 없는 컴퓨터에서 쓸 때,
 * 그리고 끊긴 클론(HEAD 가 비어 있음)을 가려낼 때 쓴다. 못 읽으면 undefined — 쓸 수 없는 클론이다.
 */
function cloneCommit(repo: Repo): string | undefined {
    const g = join(CLONES(), repo, '.git');
    const sha = (x: string | undefined) => (x && /^[0-9a-f]{40}$/.test(x.trim()) ? x.trim() : undefined);
    try {
        // 갱신(fetch --depth 1)한 클론의 shallow 에는 옛 커밋과 새 커밋이 함께 적힌다(순서는 해시순) — 한 줄일 때만 그 커밋이다.
        const lines = readFileSync(join(g, 'shallow'), 'utf8').split('\n').filter(Boolean);
        const sh = lines.length === 1 ? sha(lines[0]) : undefined;
        if (sh) return sh;
    } catch {
        /* 얕은 클론이 아니거나 끊김 */
    }
    try {
        const head = readFileSync(join(g, 'HEAD'), 'utf8').trim();
        if (sha(head)) return head;
        const ref = head.replace(/^ref:\s*/, '');
        if (existsSync(join(g, ref))) return sha(readFileSync(join(g, ref), 'utf8'));
        const packed = readFileSync(join(g, 'packed-refs'), 'utf8');
        const m = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
        return sha(m?.split(' ')[0]);
    } catch {
        return undefined;
    }
}

const hasClone = (repo: Repo) => existsSync(join(CLONES(), repo, '.git'));
/** 쓸 수 있는 클론 — .git 이 있고 커밋을 읽을 수 있다(끊긴 클론은 HEAD 가 비어 있다). */
const cloneValid = (repo: Repo) => hasClone(repo) && Boolean(cloneCommit(repo));
const hasIndex = (repo: Repo) => existsSync(join(CACHE(), INDEX_FILE[repo]));
/** 문서를 읽을 기준 커밋 — 기록(meta)이 우선, 없으면 클론에서 git 없이 읽는다. HTTP 로 읽을 때 쓴다. */
const pinnedCommit = (repo: Repo): string | undefined => readMeta()[repo]?.commit ?? cloneCommit(repo);
/**
 * 이 저장소의 문서를 읽을 수 있는가 — 인덱스가 있고, (git 이 있고 클론이 멀쩡하거나) 기준 커밋을 안다.
 * git 이 없는 컴퓨터에서 번들의 클론은 git 으로는 못 읽지만 그 커밋을 HTTP 로 읽으면 된다.
 */
const repoReady = (repo: Repo) => hasIndex(repo) && ((cloneValid(repo) && gitAvailable()) || Boolean(pinnedCommit(repo)));
/** git 으로 읽을 것인가 — 인덱스가 그 클론에서 나왔을 때만(HTTP 로 다시 받았으면 클론은 버린 것이다). */
const readsByGit = (repo: Repo) => cloneValid(repo) && gitAvailable() && readMeta()[repo]?.source !== 'http';

/** 인덱스를 원자적으로 쓴다 — 받다가 끊겨도 반쪽 인덱스가 "준비됨"으로 보이지 않게. */
function writeIndex(repo: Repo, paths: string[]): void {
    mkdirSync(CACHE(), { recursive: true });
    const file = join(CACHE(), INDEX_FILE[repo]);
    writeFileSync(`${file}.tmp`, paths.join('\n') + '\n');
    renameSync(`${file}.tmp`, file);
}

const run = (args: string[], cwd?: string, timeout = 15 * 60 * 1000): Promise<string> =>
    new Promise((ok, fail) =>
        execFile('git', args, { cwd, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8', timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (e, out, err) =>
            e ? fail(new Error(`git ${args.slice(0, 2).join(' ')}: ${e.killed ? `제한 시간(${Math.round(timeout / 1000)}초) 초과` : String(err || e.message).slice(0, 300)}`)) : ok(out),
        ),
    );

/** git: blobless partial clone(트리만) → 경로 인덱스. 파일 내용은 처음 읽을 때 git 이 가져온다. */
async function setupByGit(repo: Repo, onProgress: (m: string) => void, signal?: AbortSignal): Promise<RepoMeta> {
    const dir = join(CLONES(), repo);
    // 끊긴 클론(.git 은 있으나 HEAD 가 비어 있음)은 지우고 다시 받는다 — 두면 영원히 "있음"으로 보인다.
    if (hasClone(repo) && !cloneValid(repo)) {
        onProgress(`${repo} 클론이 끊긴 채 남아 있어 지우고 다시 받습니다`);
        rmSync(dir, { recursive: true, force: true });
    }
    if (!hasClone(repo)) {
        onProgress(`${repo} 받는 중 (git, 트리만)`);
        mkdirSync(CLONES(), { recursive: true });
        await new Promise<void>((ok, fail) => {
            // spawn — 클론은 수십 초 걸릴 수 있고, 그동안 앱이 멈추면 안 된다. 전송이 멎으면(60초간 1KB/s 미만) git 이 끝내고,
            // 그래도 10분이 넘으면 끊는다. 비밀번호를 묻는 창을 띄우지 않게 한다.
            const child = spawn(
                'git',
                ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=60', 'clone', '--filter=blob:none', '--no-checkout', '--depth', '1', '--quiet', `${GH}/${repo}.git`, dir],
                { stdio: 'ignore', windowsHide: true, timeout: 10 * 60 * 1000, ...(signal ? { signal } : {}), env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
            );
            child.on('error', fail);
            child.on('close', (code) => (code === 0 ? ok() : fail(new Error(`git clone ${repo} 실패 (code ${code})`))));
        });
    }
    onProgress(`${repo} 목록 만드는 중`);
    const list = (await run(['-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', 'HEAD'], dir)).split('\n').filter(Boolean);
    const commit = (await run(['rev-parse', 'HEAD'], dir)).trim();
    writeIndex(repo, list);
    return { commit, source: 'git', at: new Date().toISOString(), files: list.length };
}

async function gh(path: string, signal?: AbortSignal): Promise<any> {
    const r = await fetch(`https://api.github.com${path}`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'nenene-legalize' },
        // 판례 트리 한 번이 8MB 를 넘는다 — 느린 회선에서도 끝나게 넉넉히
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
    });
    if (!r.ok) throw new Error(`GitHub API ${r.status}${r.status === 403 ? ' (요청 한도 초과일 수 있습니다 — 한 시간 뒤 다시)' : ''}: ${path}`);
    return r.json();
}

/**
 * HTTP: git 없이 GitHub API 로 경로 인덱스를 만든다. 판례 저장소는 12.5만 건이라 한 번의 재귀 목록이
 * 잘리므로(10만 건 한도) 폴더별로 나눠 받는다. 문서 내용은 그 커밋의 raw 주소에서 읽는다.
 */
async function setupByHttp(repo: Repo, onProgress: (m: string) => void, signal?: AbortSignal, shas?: Map<string, string>): Promise<RepoMeta> {
    onProgress(`${repo} 목록 받는 중 (HTTP)`);
    const head = await gh(`/repos/legalize-kr/${repo}/commits/HEAD`, signal);
    const commit = String(head.sha);
    // 갱신할 때는 파일마다 blob 해시도 받아 둔다(shas) — 원문 캐시에서 바뀐 문서만 지우려고.
    const walk = async (treeSha: string, prefix: string): Promise<string[]> => {
        const t = await gh(`/repos/legalize-kr/${repo}/git/trees/${treeSha}?recursive=1`, signal);
        if (!t.truncated) {
            const blobs = (t.tree as any[]).filter((e) => e.type === 'blob');
            for (const e of blobs) shas?.set(`${prefix}${e.path}`, String(e.sha));
            return blobs.map((e) => `${prefix}${e.path}`);
        }
        const top = await gh(`/repos/legalize-kr/${repo}/git/trees/${treeSha}`, signal);
        const out: string[] = [];
        for (const e of top.tree as any[]) {
            if (e.type === 'blob') {
                out.push(`${prefix}${e.path}`);
                shas?.set(`${prefix}${e.path}`, String(e.sha));
            } else if (e.type === 'tree') out.push(...(await walk(e.sha, `${prefix}${e.path}/`)));
        }
        return out;
    };
    const list = await walk(String(head.commit.tree.sha), '');
    writeIndex(repo, list);
    return { commit, source: 'http', at: new Date().toISOString(), files: list.length };
}

export interface LegalizeStatus {
    lawIndex: number;
    precedentIndex: number;
    clones: number;
    mode: 'git' | 'http' | 'none';
    commits: Partial<Record<Repo, string>>;
    ready: boolean;
}

/**
 * 원문 코퍼스가 없으면 **준비한다** (있나 없나 보고 → 없으면 받는다). 비동기라 앱을 멈추지 않는다.
 *
 * 예전에는 bash 스크립트(scripts/setup-legalize.sh)를 불렀다 — 윈도우에는 bash 가 없고, git 도 기본이 아니다.
 * 이제 같은 일을 여기서 한다: git 이 있으면 blobless clone(트리만, 약 25MB 이하), 없으면 GitHub API 로 목록만 받고
 * 문서는 필요할 때 raw 주소에서 읽는다. 멱등하다 — 이미 있으면 아무것도 하지 않는다.
 */
export async function ensureLegalize(opts: { onProgress?: (m: string) => void; signal?: AbortSignal } = {}): Promise<LegalizeStatus> {
    const say = opts.onProgress ?? (() => {});
    const meta = readMeta();
    for (const repo of REPOS) {
        // 클론은 있는데 기록이 없으면(예전 설치·앱 번들) 클론의 커밋을 기록해 둔다 — git 이 없어도 HTTP 로 읽게.
        if (hasIndex(repo) && cloneValid(repo) && !meta[repo]?.commit) {
            meta[repo] = { commit: cloneCommit(repo)!, source: 'git', at: new Date().toISOString(), files: 0 };
            writeMeta(meta);
        }
        if (repoReady(repo)) continue;
        if (legalizeLocalOnly()) throw offlineList(repo);
        try {
            meta[repo] = gitAvailable() ? await setupByGit(repo, say, opts.signal) : await setupByHttp(repo, say, opts.signal);
        } catch (e) {
            // git 이 있는데 실패했으면(방화벽 등) HTTP 로 한 번 더
            if (gitAvailable()) {
                say(`${repo}: git 으로 받지 못해 HTTP 로 다시 — ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
                meta[repo] = await setupByHttp(repo, say, opts.signal);
            } else throw e;
        }
        writeMeta(meta);
        resetIndexCaches();
        say(`${repo} 준비됨 — ${meta[repo]!.files.toLocaleString()}건`);
    }
    return legalizeStatus();
}

/** 목록을 새로 받았으면 메모리에 든 것(목록·법원·판본 머리·사건번호 색인)을 버린다 — 옛 목록과 새 원문이 섞이지 않게. */
function resetIndexCaches(): void {
    lawIndex = null;
    precIndex = null;
    courtSet = null;
    caseIndex = null;
    versionCache.clear();
    headReads.clear();
}

// ---- 자동 갱신(7일) ------------------------------------------------------------------
//
// 한 번 받은 목록을 다시 받지 않으면 코퍼스가 그 날에 멈춘다 — 실제로 받은 지 사흘 만에 법령 1건·판례 67건이 뒤처졌다.
// 그래서 동의를 받은 뒤에는 7일이 지나면 실행 전에 묻지 않고 갱신한다. 실패해도 실행은 막지 않는다 — 이전 판을 그대로 쓰고 알린다.

const REFRESH_MS = 7 * 86_400_000;
/** 갱신이 실패하면 이만큼은 다시 시도하지 않는다 — 오프라인에서 실행할 때마다 제한 시간만큼 기다리지 않게. */
const RETRY_MS = 6 * 3_600_000;

/** 갱신할 저장소 — 받은 지(at) 7일이 넘었거나, 고정 커밋을 더는 읽을 수 없다고 표시된 것(stale). 막 실패한 것은 잠시 뺀다. */
export function staleRepos(now = Date.now()): Repo[] {
    const meta = readMeta();
    return REPOS.filter((r) => {
        const m = meta[r];
        if (!m?.commit || !hasIndex(r)) return false;
        const failed = Date.parse(m.refreshFailedAt ?? '');
        if (Number.isFinite(failed) && now - failed < RETRY_MS) return false;
        const at = Date.parse(m.at);
        return Boolean(m.stale) || !Number.isFinite(at) || now - at > REFRESH_MS;
    });
}

/** git 의 blob 해시 — 원문 캐시의 문서가 새 커밋에서도 같은 내용인지 본다(트리의 해시와 같으면 그대로 둔다). */
const blobSha = (text: string) => {
    const buf = Buffer.from(text, 'utf8');
    return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
};

/**
 * 원문 캐시에서 새 커밋과 내용이 다른 문서를 지운다 — 캐시가 옛 커밋의 원문을 새 목록과 섞어 내주지 않게.
 * 내용이 같은 문서는 둔다(대부분이다). 새 커밋에 없는 경로도 지운다.
 */
function dropChangedDocs(repo: Repo, shas: Map<string, string>): number {
    let dir: string[];
    try {
        dir = readdirSync(DOC_CACHE());
    } catch {
        return 0;
    }
    const bySafe = new Map<string, string>();
    for (const [p, s] of shas) bySafe.set(`${repo}__${p.replace(/[/\\]/g, '__')}`, s);
    let dropped = 0;
    for (const f of dir) {
        if (!f.startsWith(`${repo}__`) || f.endsWith('.tmp')) continue;
        const want = bySafe.get(f);
        try {
            if (want && blobSha(readFileSync(join(DOC_CACHE(), f), 'utf8')) === want) continue;
            rmSync(join(DOC_CACHE(), f), { force: true });
            dropped++;
        } catch {
            /* 못 지운 캐시는 다음 갱신에 다시 본다 */
        }
    }
    return dropped;
}

/**
 * 원격 HEAD 가 고정 커밋과 같다 — 받은 시각만 새로 하고 「갱신 필요」(stale)·실패 시각을 지운다. 옛 기록을 그대로 두던 때는 stale 이 남아
 * 실행마다 「갱신 중 … → 이미 최신」 과 API 요청이 되풀이됐다. 고정 커밋의 raw 가 또 404 면 readBlob 이 다시 단다.
 */
function checkedSame(old: RepoMeta): RepoMeta {
    const { stale: _stale, refreshFailedAt: _failed, ...rest } = old;
    return { ...rest, at: new Date().toISOString() };
}

/** git: 원격 HEAD 를 depth 1·blobless 로 받아 HEAD 를 옮기고 목록을 다시 만든다(체크아웃 없음 — 트리만). */
async function refreshByGit(repo: Repo, old: RepoMeta, timeout: number): Promise<{ meta: RepoMeta; shas: Map<string, string> | null }> {
    const dir = join(CLONES(), repo);
    await run(['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=30', 'fetch', '--depth', '1', '--filter=blob:none', '--quiet', 'origin', 'HEAD'], dir, timeout);
    const commit = (await run(['rev-parse', 'FETCH_HEAD'], dir)).trim();
    if (commit === old.commit) return { meta: checkedSame(old), shas: null };
    const shas = new Map<string, string>();
    for (const line of (await run(['-c', 'core.quotePath=false', 'ls-tree', '-r', commit], dir)).split('\n')) {
        const m = /^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(line);
        if (m) shas.set(m[2]!, m[1]!);
    }
    if (!shas.size) throw new Error(`${repo} 새 커밋 ${commit.slice(0, 7)} 의 목록이 비어 있음`);
    // HEAD 는 기록(meta)을 쓴 뒤에 옮긴다(refreshLegalize) — 원문은 기록된 커밋에서 읽으므로(readBlob) 도중에 실패해도 옛 판 그대로다.
    return { meta: { commit, source: 'git', at: new Date().toISOString(), files: shas.size }, shas };
}

/** HTTP: 처음 받을 때처럼 API 로 목록을 다시 받는다(setupByHttp 가 목록을 새로 쓴다). */
async function refreshByHttp(repo: Repo, old: RepoMeta, timeout: number, say: (m: string) => void, signal?: AbortSignal): Promise<{ meta: RepoMeta; shas: Map<string, string> | null }> {
    const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
    const head = await gh(`/repos/legalize-kr/${repo}/commits/HEAD`, sig);
    if (String(head.sha) === old.commit) return { meta: checkedSame(old), shas: null };
    const shas = new Map<string, string>();
    return { meta: await setupByHttp(repo, say, sig, shas), shas };
}

/**
 * 받은 지 7일이 지난 목록을 갱신한다 — 실행을 시작하기 전에 부른다. **던지지 않는다**: 실패하면 이전 클론·고정 커밋을 그대로 쓰고 onProgress 로 알린다.
 * 동의(setLegalizeConsent)가 없거나, LPS_LEGALIZE_REFRESH=0 이거나, 시험(NODE_ENV=test)이면 하지 않는다. --mock 실행은 CLI 가 부르지 않는다.
 * 새 커밋과 시각은 legalize-meta.json 에 적는다 — 실행 기록(transcript 머리)의 코퍼스 커밋은 거기서 읽으므로 갱신된 커밋이 적힌다.
 */
export async function refreshLegalize(opts: { onProgress?: (m: string) => void; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ refreshed: Repo[]; failed: Repo[]; skipped?: string }> {
    const say = opts.onProgress ?? (() => {});
    if (process.env.LPS_LEGALIZE_REFRESH === '0') return { refreshed: [], failed: [], skipped: 'LPS_LEGALIZE_REFRESH=0' };
    if (process.env.NODE_ENV === 'test') return { refreshed: [], failed: [], skipped: 'test' };
    if (legalizeLocalOnly()) return { refreshed: [], failed: [], skipped: process.env.LPS_LEGALIZE_NETWORK === '0' ? 'LPS_LEGALIZE_NETWORK=0' : 'local' };
    if (!netConsent) return { refreshed: [], failed: [], skipped: 'consent' };
    const timeout = opts.timeoutMs ?? (Number(process.env.LPS_LEGALIZE_REFRESH_TIMEOUT) || 120_000);
    const refreshed: Repo[] = [];
    const failed: Repo[] = [];
    for (const repo of staleRepos()) {
        const meta = readMeta();
        const old = meta[repo]!;
        say(`${repo} 갱신 중 (받은 지 ${Math.max(0, Math.floor((Date.now() - (Date.parse(old.at) || 0)) / 86_400_000))}일${old.stale ? ' · 고정 커밋을 읽을 수 없음' : ''})`);
        try {
            const r = readsByGit(repo) ? await refreshByGit(repo, old, timeout) : await refreshByHttp(repo, old, timeout, say, opts.signal);
            if (r.shas) {
                if (r.meta.source === 'git') writeIndex(repo, [...r.shas.keys()]);
                const dropped = dropChangedDocs(repo, r.shas);
                say(`${repo} 갱신됨 ${old.commit.slice(0, 7)} → ${r.meta.commit.slice(0, 7)} — ${r.meta.files.toLocaleString()}건${dropped ? ` · 바뀐 원문 캐시 ${dropped}건 비움` : ''}`);
            } else say(`${repo} 이미 최신 (${old.commit.slice(0, 7)})`);
            const next = readMeta();
            next[repo] = r.meta;
            writeMeta(next);
            resetIndexCaches();
            // 클론의 HEAD 도 새 커밋으로 — git 없이 커밋을 읽는 쪽(cloneCommit)과 사람이 보는 클론이 기록과 같게. 체크아웃은 하지 않는다.
            if (r.shas && r.meta.source === 'git') await run(['update-ref', 'HEAD', r.meta.commit], join(CLONES(), repo)).catch(() => {});
            refreshed.push(repo);
        } catch (e) {
            const next = readMeta();
            if (next[repo]) next[repo] = { ...next[repo]!, refreshFailedAt: new Date().toISOString() };
            writeMeta(next);
            failed.push(repo);
            say(`${repo} 갱신 실패 — 이전 판(${old.commit.slice(0, 7)})을 그대로 씁니다: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
        }
    }
    return { refreshed, failed };
}

/**
 * 동기 경로(조문·판례를 처음 읽는 순간)의 안전망. 시작할 때 ensureLegalize 를 기다리는 것이 원칙이고,
 * 여기는 그걸 거치지 않은 호출(라이브러리로 직접 쓸 때)을 위해 git 이 있으면 그 자리에서 받는다.
 * git 이 없으면 동기로 HTTP 를 돌릴 수 없으니 준비가 필요하다고 알린다.
 */
function bootstrapLegalize(only: Repo[] = REPOS): void {
    // 필요한 저장소만 본다 — 판례 목록을 못 받아도(요청 한도 등) 조문은 읽혀야 한다.
    if (only.every(repoReady)) return;
    if (legalizeLocalOnly()) throw offlineList(only.length === 1 ? only[0]! : '법령·판례');
    if (!gitAvailable()) {
        throw new LegalizeUnavailable('법령·판례 목록이 아직 없습니다 — 앱을 다시 열거나 `npm run setup:legalize` 로 준비하세요(git 없이 HTTP 로 받습니다).');
    }
    process.stderr.write('[legalize] 로컬 법령·판례 목록이 없어 받습니다 (git, 트리만)…\n');
    const meta = readMeta();
    for (const repo of only) {
        if (repoReady(repo)) continue;
        const dir = join(CLONES(), repo);
        try {
            if (hasClone(repo) && !cloneValid(repo)) rmSync(dir, { recursive: true, force: true });
            if (!hasClone(repo)) {
                mkdirSync(CLONES(), { recursive: true });
                execFileSync('git', ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=60', 'clone', '--filter=blob:none', '--no-checkout', '--depth', '1', '--quiet', `${GH}/${repo}.git`, dir], {
                    stdio: 'ignore',
                    timeout: 10 * 60 * 1000,
                    windowsHide: true,
                    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
                });
            }
            const list = execFileSync('git', ['-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', 'HEAD'], { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true }).split('\n').filter(Boolean);
            const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', windowsHide: true }).trim();
            writeIndex(repo, list);
            meta[repo] = { commit, source: 'git', at: new Date().toISOString(), files: list.length };
        } catch (e) {
            throw new LegalizeUnavailable(`법령·판례 목록을 받지 못했습니다 (네트워크 확인): ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
        }
    }
    writeMeta(meta);
}

function ensureIndex(kind: 'law' | 'precedent'): string[] {
    bootstrapLegalize([kind === 'law' ? 'legalize-kr' : 'precedent-kr']);
    const file = join(CACHE(), kind === 'law' ? 'law-index.txt' : 'precedent-index.txt');
    if (!existsSync(file)) {
        throw new LegalizeUnavailable(`인덱스가 없습니다: ${file}\n\`npm run setup:legalize\` 를 실행하세요.`);
    }
    return readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

let lawIndex: string[] | null = null;
let precIndex: string[] | null = null;

export const laws = (): string[] => (lawIndex ??= ensureIndex('law'));
export const precedents = (): string[] => (precIndex ??= ensureIndex('precedent'));

/**
 * 동기 HTTP GET — 조문 읽기는 동기 API 라서, git 이 없을 때는 자식 프로세스(같은 node/Electron 바이너리)에
 * fetch 를 맡기고 기다린다. Electron 바이너리는 ELECTRON_RUN_AS_NODE=1 이면 node 로 동작한다.
 */
function fetchSync(url: string): string {
    const code =
        "let u='';process.stdin.on('data',d=>u+=d).on('end',async()=>{try{const r=await fetch(u.trim(),{signal:AbortSignal.timeout(30000),headers:{'user-agent':'nenene-legalize'}});if(!r.ok){process.stderr.write('HTTP '+r.status);process.exit(2)}process.stdout.write(Buffer.from(await r.arrayBuffer()))}catch(e){process.stderr.write(String(e));process.exit(3)}})";
    const r = spawnSync(process.execPath, ['-e', code], {
        input: url,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        maxBuffer: 64 * 1024 * 1024,
        timeout: 45_000,
        windowsHide: true,
    });
    if (r.status !== 0) {
        const err = String(r.stderr ?? r.error ?? '');
        throw Object.assign(new LegalizeUnavailable(`원문을 받지 못했습니다 (${url.slice(0, 120)}): ${err.slice(0, 200)}`), { status: Number(/^HTTP (\d{3})/.exec(err)?.[1]) || 0 });
    }
    return r.stdout.toString('utf8');
}

/** 「형사소송법」, 형사소송법, 형사 소송법 → 형사소송법 */
export function normalizeLawName(raw: string): string {
    return raw
        .replace(/[「」『』〈〉《》]/g, '')
        .replace(/\s+/g, '')
        .replace(/ㆍ/g, '·')
        .trim();
}

/**
 * 법령명 → 저장소 경로. 정확일치 → 정규화 일치 → 별칭.
 *
 * 접미 일치(`…형사소송법`)는 일부러 하지 않는다. 「북한인권법」과 「북한인권법 시행령」이
 * 같은 접미를 갖는 식으로, 접미 매칭은 조용히 다른 법을 인용하게 만든다 — 인용 검증기가
 * 저지르면 안 되는 정확히 그 실수다.
 */
export function resolveLawPath(rawName: string): string | null {
    const name = normalizeLawName(rawName);
    if (!name) return null;

    // "…법률 시행령 제19조의2" 는 시행령 파일을 가리킨다. 법률.md 를 열면 그 조문이 없어
    // article_missing 이 되고, 검증기는 멀쩡한 인용을 "조문 없음"으로 차단한다.
    // 행정입법이 많은 분야(개인정보·정보통신)에서는 이게 결정적이다.
    const all = laws();
    const inDir = (n: string) => all.filter((p) => normalizeLawName(p.split('/')[1] ?? '') === n);
    // 법률이 있으면 법률, 없으면 첫 파일의 종류 — 그 종류의 판본들 중에서는 frontmatter 로 고른다(pickVersion).
    // 판본이 둘 이상인 폴더(머리를 읽는 폴더)에서 첫 종류가 폐지 기록뿐이면, 본문이 있는 다른 주 종류(시행령·시행규칙 같은 하위 규범은 빼고)를 쓴다 —
    // 「국무총리비서실직제」 는 1962년 각령(폐지 스텁)이 첫 파일이라 2024년 대통령령을 두고 폐지 기록으로 대조했다.
    const ofKind = (paths: string[], k: string) => paths.filter((p) => lawKindOf(p) === k);
    const byDefault = (paths: string[]) => {
        const kinds = [...new Set(paths.map(lawKindOf))];
        if (kinds.includes('법률')) return pickVersion(ofKind(paths, '법률'));
        const first = pickVersion(ofKind(paths, kinds[0]!));
        if (!kinds.some((k) => ofKind(paths, k).length > 1) || !lawVersionOf(first).stub) return first;
        for (const k of kinds.slice(1)) {
            if (KIND_SUFFIX.some((s) => s.kind === k)) continue;
            const v = pickVersion(ofKind(paths, k));
            if (!lawVersionOf(v).stub) return v;
        }
        return first;
    };

    // 종류 접미는 **떼어낸 이름이 실제로 존재할 때만** 종류 표시다.
    //
    // 이 조건이 없으면 「대한민국헌법」이 '헌법'→'헌'으로 잘려 사라진다. '법'으로 끝나는 모든
    // 법령(헌법·민법·형법·상법)이 같은 방식으로 사라졌고, 그 결과 **헌법 조문 인용이 전부
    // "법령을 찾을 수 없음"으로 판정**되었다 — 헌법 논문에서 치명적이다.
    // 별칭은 정규화된 이름으로 찾는다. 값에 공백이 있으면(「개인정보 보호법」) 디렉터리명과
    // 비교할 때 조용히 어긋난다 — 실제로 그 별칭이 한 번도 맞지 않았다.
    const viaAlias = (n: string): string[] => {
        const alias = LAW_ALIASES[n];
        return alias ? inDir(normalizeLawName(alias)) : [];
    };

    const kind = KIND_SUFFIX.find((k) => k.re.test(name));
    if (kind) {
        const base = name.replace(kind.re, '');
        // 「금융실명법 시행령」처럼 **약칭 + 종류**인 경우가 흔하다. 약칭을 풀어서 그 종류 파일을 찾는다.
        const basePaths = inDir(base).length ? inDir(base) : viaAlias(base);
        if (basePaths.length) {
            // 진짜 종류 접미다. 그 종류가 없으면 null — 다른 종류로 대신하지 않는다. 「시행령(대통령령).md」 도 시행령이다.
            const same = basePaths.filter((p) => lawKindOf(p) === kind.kind);
            return same.length ? pickVersion(same) : null;
        }
    }

    let paths = inDir(name);
    if (!paths.length) paths = viaAlias(name);
    if (!paths.length) return null;
    return byDefault(paths);
}

/** 법령명 끝에 붙는 종류 표시 → 파일의 종류(lawKindOf — 「시행령.md」·「시행령(대통령령).md」 둘 다 시행령) */
const KIND_SUFFIX: { re: RegExp; kind: string }[] = [
    { re: /시행규칙$/, kind: '시행규칙' },
    { re: /시행령$/, kind: '시행령' },
    { re: /시행세칙$/, kind: '시행세칙' },
    { re: /(법률|법)$/, kind: '법률' },
];

/** 좁게 유지한다. 여기에 없는 것은 별칭이 아니라 오타이거나 다른 법이다. */
const LAW_ALIASES: Record<string, string> = {
    헌법: '대한민국헌법',
    형소법: '형사소송법',
    민소법: '민사소송법',
    개인정보보호법: '개인정보 보호법',
    정보통신망법: '정보통신망 이용촉진 및 정보보호 등에 관한 법률',
    정통망법: '정보통신망 이용촉진 및 정보보호 등에 관한 법률',
    망법: '정보통신망 이용촉진 및 정보보호 등에 관한 법률',
    금융실명법: '금융실명거래 및 비밀보장에 관한 법률',
    금융실명거래법: '금융실명거래 및 비밀보장에 관한 법률',
    신용정보법: '신용정보의 이용 및 보호에 관한 법률',
    재외동포법: '재외동포의 출입국과 법적 지위에 관한 법률',
    가족관계등록법: '가족관계의 등록 등에 관한 법률',
    통비법: '통신비밀보호법',
    공선법: '공직선거법',
    특금법: '특정 금융거래정보의 보고 및 이용 등에 관한 법률',
    특정금융정보법: '특정 금융거래정보의 보고 및 이용 등에 관한 법률',
    성폭력처벌법: '성폭력범죄의 처벌 등에 관한 특례법',
    아청법: '아동·청소년의 성보호에 관한 법률',
    청소년성보호법: '아동·청소년의 성보호에 관한 법률',
    전자금융법: '전자금융거래법',
    위치정보법: '위치정보의 보호 및 이용 등에 관한 법률',
    저작권법: '저작권법',
    경직법: '경찰관 직무집행법',
    가상자산이용자보호법: '가상자산 이용자 보호 등에 관한 법률',
    인공지능기본법: '인공지능 발전과 신뢰 기반 조성 등에 관한 기본법',
    테러방지법: '국민보호와 공공안전을 위한 테러방지법',
};

/** 같은 이름으로 시작하는 법령들 — "형사소송법"을 못 찾았을 때 후보를 보여주기 위한 것. */
export function suggestLaws(fragment: string, limit = 8): string[] {
    const name = normalizeLawName(fragment);
    // 종류로 거른다(이름 「/법률.md」 가 아니라) — 법률이 「법률(법률).md」 로만 있는 폴더도 후보다. 판본이 둘인 폴더는 한 번만.
    return [
        ...new Set(
            laws()
                .filter((p) => lawKindOf(p) === '법률' && normalizeLawName(p.split('/')[1] ?? '').includes(name))
                .map((p) => p.split('/')[1]!),
        ),
    ].slice(0, limit);
}

/**
 * 문서 하나를 읽는다 — 캐시 → git(클론이 있으면) → HTTP(고정 커밋의 raw 주소). 두 번째부터는 캐시에서.
 * 로컬만(legalizeLocalOnly)이면 캐시와 클론에 이미 든 blob 까지만 — 없으면 LegalizeOffline(GitHub 에 나가지 않는다).
 */
function readBlob(repo: Repo, path: string): string {
    const safe = path.replace(/[/\\]/g, '__');
    const cached = join(DOC_CACHE(), `${repo}__${safe}`);
    if (existsSync(cached)) return readFileSync(cached, 'utf8');
    bootstrapLegalize([repo]); // 목록이 없으면 이 자리에서 준비한다 (있으면 no-op)
    const fromHead = headReads.get(`${repo}:${path}`);
    if (fromHead !== undefined) return fromHead;
    let text: string;
    const local = legalizeLocalOnly();
    if (readsByGit(repo)) {
        // 기록된 커밋에서 읽는다(HEAD 가 아니라) — 목록(인덱스)이 그 커밋에서 나왔다. 갱신이 HEAD 를 옮기다 끊겨도 목록과 원문이 같은 판이다.
        // 로컬만이면 클론에 이미 든 blob 만 읽는다 — 지연 fetch 를 끈다(GIT_NO_LAZY_FETCH 는 git 2.44 부터라, 그보다 옛 git 에서도 나가지 못하게 전송도 막는다).
        try {
            text = execFileSync('git', [...(local ? ['-c', 'protocol.allow=never'] : []), 'cat-file', 'blob', `${pinnedCommit(repo) ?? 'HEAD'}:${path}`], {
                cwd: join(CLONES(), repo),
                encoding: 'utf8',
                maxBuffer: 64 * 1024 * 1024,
                windowsHide: true,
                // 못 읽은 blob 의 「fatal: …」 을 터미널에 흘리지 않는다 — 이 경우는 오류가 아니라 검증 불가다
                ...(local ? { env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }, stdio: 'pipe' as const } : {}),
            });
        } catch (e) {
            if (local) throw new LegalizeOffline(OFFLINE_NOTE);
            throw e;
        }
    } else {
        if (local) throw new LegalizeOffline(OFFLINE_NOTE);
        const commit = pinnedCommit(repo);
        if (!commit) throw new LegalizeUnavailable(`${repo} 의 기준 커밋을 모릅니다 — \`npm run setup:legalize\` 로 다시 준비하세요.`);
        const raw = (ref: string) => `https://raw.githubusercontent.com/legalize-kr/${repo}/${ref}/${path.split('/').map(encodeURIComponent).join('/')}`;
        try {
            text = fetchSync(raw(commit));
        } catch (e) {
            // 강제 push 로 고정 커밋이 사라지면 그 raw 주소는 404 다(legalize-kr 는 6개월에 28번 강제 push 했다). HEAD 에서 한 번만 다시 읽고,
            // 되면 기록에 「갱신 필요」를 단다 — 다음 실행 전에 7일을 기다리지 않고 목록을 새로 받는다. HEAD 의 원문은 고정 커밋의 것이 아니므로
            // 디스크 캐시에 두지 않는다(이 실행 동안 메모리에만) — 캐시가 두 판을 섞어 내주지 않게.
            if ((e as { status?: number }).status !== 404) throw e;
            const head = fetchSync(raw('HEAD'));
            const meta = readMeta();
            if (meta[repo] && !meta[repo]!.stale) {
                meta[repo] = { ...meta[repo]!, stale: true };
                writeMeta(meta);
            }
            process.stderr.write(`[legalize] ${repo}@${commit.slice(0, 7)} 의 ${path} 가 404 — HEAD 에서 읽었습니다. 다음 실행 전에 목록을 갱신합니다.\n`);
            headReads.set(`${repo}:${path}`, head);
            return head;
        }
    }
    mkdirSync(DOC_CACHE(), { recursive: true });
    // 원자적으로 — 쓰다 끊긴 반쪽 파일이 다음부터 "캐시된 원문"으로 읽히지 않게
    const tmp = `${cached}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, cached);
    return text;
}

/** HEAD 에서 읽은 원문(고정 커밋이 404) — 디스크 캐시에 두지 않고 이 실행 동안만 쓴다. */
const headReads = new Map<string, string>();

/**
 * YAML frontmatter 를 최소한으로 파싱한다. md 파일 머리가 `---` 로 시작하는 형태뿐이다.
 *
 * **맨 앞 칸에서 시작하는 키만** 필드다. 법령 3,000개가 별표 목록(첨부파일:)을 갖는데, 그 항목은 「- 별표번호: …」 아래 들여 쓴
 * 「  제목: …」 을 갖는다 — 들여쓰기를 무시하던 때는 그 별표 제목이 법령의 제목을 덮어썼다(119구조·구급법 시행규칙의 제목이
 * 「감염병 발생 통보서」). 목록의 값(「- 노동부」)은 바로 앞 키에 이어 붙이고, 목록 안의 키·값(중첩된 표)은 버린다.
 */
function splitFrontmatter(text: string): { meta: Record<string, string>; body: string } {
    if (!text.startsWith('---')) return { meta: {}, body: text };
    const end = text.indexOf('\n---', 3);
    if (end < 0) return { meta: {}, body: text };
    const head = text.slice(3, end);
    const meta: Record<string, string> = {};
    const unquote = (s: string) => s.trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
    let lastKey = '';
    for (const line of head.split('\n')) {
        if (!line.trim()) continue;
        const item = /^\s*-\s+(.*)$/.exec(line);
        if (item) {
            // 목록의 낱값만 앞 키에 붙인다. 「- 별표번호: '0000'」 처럼 표인 항목은 필드가 아니다.
            if (lastKey && !/^[^'"\s][^:]*:(?:\s|$)/.test(item[1]!)) meta[lastKey] = [meta[lastKey], unquote(item[1]!)].filter(Boolean).join(', ');
            continue;
        }
        if (/^\s/.test(line)) continue; // 들여 쓴 줄 — 목록 항목(표) 안의 키다
        const m = /^([^:]+):\s*(.*)$/.exec(line);
        if (!m) continue;
        lastKey = m[1]!.trim();
        meta[lastKey] = unquote(m[2]!);
    }
    return { meta, body: text.slice(end + 4).replace(/^\n+/, '') };
}

/** 파일의 종류 — 이름에서 괄호 꼬리를 뗀 것(「법률(법률).md」 → 법률, 「시행규칙(해양수산부령).md」 → 시행규칙). 같은 폴더의 같은 종류는 한 법령의 판본들이다. */
export function lawKindOf(path: string): string {
    return (path.split('/').pop() ?? '').replace(/\.md$/, '').replace(/\([^()]*\)$/, '');
}

/**
 * 폐지 기록뿐인 파일인가 — 본문에 제N조(N≥1)가 하나도 없고, 부칙 앞의 본문이 폐지를 말한다(「…은 이를 폐지한다」).
 * 상태는 보지 않는다: legalize-kr 의 상태 필드는 폐지 스텁까지 전부 「시행」이다(HEAD 35c580c 의 5,772개 모두 — 스텁이 몇 개인지는 판마다 달라 여기에 박지 않는다). 부칙만 보면 안 된다 —
 * 「연호에관한법률」처럼 조 없이 짧은 법도 부칙에서 옛 법을 폐지한다. 「제0조」 머리는 스텁이 쓰는 꼴이라 조문으로 세지 않는다.
 */
export function isRepealStub(body: string): boolean {
    if (/^#{3,6}\s*제\s*0*[1-9]\d*\s*조/m.test(body)) return false;
    const main = body.split(/^#{1,6}\s*부칙/m)[0] ?? body;
    return /폐지한다|폐지된\s*법령|본문\s*없음/.test(main);
}

interface LawVersion {
    공포일자: string;
    시행일자: string;
    stub: boolean;
    /** 읽지 못했다(네트워크 등) — 판본 고르기에서 맨 뒤로 */
    unread?: boolean;
    /** 원문이 이 컴퓨터에 없어 읽지 못했다(로컬만) — 판본을 고를 수 없다(pickVersion) */
    offline?: boolean;
}
/** 경로 → 판본 머리. 같은 종류의 파일이 둘 이상인 폴더만 읽는다(HEAD 35c580c 에서 88개). 한 번 읽으면 이 실행 동안 다시 읽지 않는다. */
const versionCache = new Map<string, LawVersion>();
function lawVersionOf(path: string): LawVersion {
    const hit = versionCache.get(path);
    if (hit) return hit;
    let v: LawVersion;
    try {
        const { meta, body } = splitFrontmatter(readBlob('legalize-kr', path));
        v = { 공포일자: meta['공포일자'] ?? '', 시행일자: meta['시행일자'] ?? '', stub: isRepealStub(body) };
    } catch (e) {
        v = { 공포일자: '', 시행일자: '', stub: false, unread: true, ...(e instanceof LegalizeOffline ? { offline: true } : {}) };
    }
    versionCache.set(path, v);
    return v;
}

/**
 * 같은 종류의 판본들 중 하나를 고른다 — **파일 이름이 아니라 frontmatter 로**. 폐지 스텁을 빼고(전부 스텁이면 스텁), 공포일자가 가장 늦은 것,
 * 같으면 시행일자가 늦은 것, 그래도 같으면 괄호 붙은 이름. 이름(「/법률.md」)으로 고르던 때는 X.md 와 X(구분).md 가 함께 있는 86쌍 중
 * 83쌍에서 평문 파일이 구법이나 폐지 스텁이라(legalize-kr 이슈 #26), 헌법재판소법 제68조가 1997년 원문(「법원의 재판을 제외하고는」)으로
 * verified 되고 근로기준법 제46조가 article_missing 이 되었다.
 */
function pickVersion(paths: string[]): string {
    if (paths.length <= 1) return paths[0]!;
    const all = paths.map((p) => ({ p, v: lawVersionOf(p), paren: /\)\.md$/.test(p) }));
    // 원문이 이 컴퓨터에 없는 판본이 있으면(로컬만) 고르지 않고 그 판본을 돌려준다 — 읽히는 판본으로 고르면 그것이 최신인지 모르는 채
    // 옛 판본·폐지 스텁과 대조해 조문 없음(article_missing)이 될 수 있다. 그 판본을 읽는 자리에서 검증 불가가 된다(getLawDoc → offline).
    const missing = all.find((x) => x.v.offline);
    if (missing) return missing.p;
    const live = all.filter((x) => !x.v.stub);
    const pool = live.length ? live : all;
    pool.sort((a, b) => Number(Boolean(a.v.unread)) - Number(Boolean(b.v.unread)) || b.v.공포일자.localeCompare(a.v.공포일자) || b.v.시행일자.localeCompare(a.v.시행일자) || Number(b.paren) - Number(a.paren));
    return pool[0]!.p;
}

export interface LawDoc {
    name: string;
    path: string;
    meta: Record<string, string>;
    body: string;
}

export function getLawDoc(rawName: string): LawDoc | { error: string; suggestions?: string[]; offline?: boolean } {
    const path = resolveLawPath(rawName);
    if (!path) {
        const s = suggestLaws(rawName);
        return {
            error: `법령을 찾을 수 없음: "${rawName}"`,
            ...(s.length ? { suggestions: s } : {}),
        };
    }
    let text: string;
    try {
        text = readBlob('legalize-kr', path);
    } catch (e) {
        // 법령은 목록에 있는데 원문이 이 컴퓨터에 없다(로컬만) — 「없는 법령」 이 아니다. offline 으로 가른다(verify 는 검증 불가로 둔다).
        // 던지지 않는다: 원문 사다리(resolveDocument)·조문 조회(coverage)는 error 를 「원문 없음」으로 받는다.
        if (e instanceof LegalizeOffline) return { error: e.message, offline: true };
        throw e;
    }
    const { meta, body } = splitFrontmatter(text);
    return { name: path.split('/')[1]!, path, meta, body };
}

/** 폐지 기록뿐인 판본의 설명 — 「없는 조문」이 아니라 「그 법이 폐지됐다는 기록만 있다」. */
export function repealNote(doc: LawDoc): string {
    const d = doc.meta['시행일자'] || doc.meta['공포일자'];
    return `코퍼스에 폐지 기록만 있음(폐지${d ? ` ${d}` : ''})`;
}

// ---- 시행 전 판본과 직전(현행) 판본 --------------------------------------------------
//
// legalize-kr 의 HEAD 는 law.go.kr 의 「현행」이 아니다 — 공포되면 시행 전이라도 들어온다(HEAD 35c580c 에 시행일이 미래인 판본이 395개:
// 개인정보 보호법 시행 2027-03-09, 저작권법 2027-04-21 …). 그 판본으로 대조하면 아직 효력이 없는 조문을 현행으로 확인한다. 그래서
//  (1) 고른 판본의 시행일자가 오늘 뒤면 그렇다고 적고(시행 전 판본과 대조 — 상태는 그 원문으로 평소대로 정한다),
//  (2) 동의를 받았으면 GitHub 이력에서 시행 중인 직전 판본을 받아 그것과 대조한다(prefetchInForce → 캐시 → inForceVersion).
// 부칙의 조문별 시행일(일부 조문만 나중에 시행하는 분할 시행)은 보지 않는다 — 범위 밖이다. 파일의 시행일자 하나로만 가른다.

/** 시행일자가 오늘(현지 날짜) 뒤인 판본인가. 9999-01-01(시행일 미정)도 시행 전이다. */
export function notYetInForce(meta: Record<string, string>, today = todayLocal()): boolean {
    const d = meta['시행일자'] ?? '';
    return /^\d{4}-\d{2}-\d{2}$/.test(d) && d > today;
}

/** 직전 판본을 찾은 결과 — 경로와 **그때의 HEAD 고정 커밋**마다 하나. 갱신으로 커밋이 바뀌면 다시 찾는다. */
export interface InForceVersion {
    /** ok: 시행 중인 직전 판본을 받음 · none: 이력 앞쪽의 판본도 전부 시행 전 */
    status: 'ok' | 'none';
    path: string;
    pin: string;
    sha?: string;
    공포일자?: string;
    시행일자?: string;
    text?: string;
    at: string;
}
const INFORCE = () => join(CACHE(), 'inforce');
const inForceFile = (path: string, pin: string) => join(INFORCE(), `${pin.slice(0, 12)}__${path.replace(/[/\\]/g, '__')}.json`);
/** 이 실행에서 이미 본 것 — 실패(요청 한도·네트워크·404)는 디스크에 두지 않고 여기에만 둔다(다음 실행에서 다시 시도). */
const inForceMem = new Map<string, InForceVersion | { status: 'failed'; error: string }>();

/** 캐시에서 직전 판본을 읽는다(동기, 요청 없음) — verifyAuthority 가 쓴다. 받기는 prefetchInForce 가 미리 한다. */
export function inForceVersion(path: string): InForceVersion | null {
    const pin = pinnedCommit('legalize-kr');
    if (!pin) return null;
    const f = inForceFile(path, pin);
    const mem = inForceMem.get(f);
    if (mem) return mem.status === 'failed' ? null : mem;
    try {
        const v = JSON.parse(readFileSync(f, 'utf8')) as InForceVersion;
        if (v.pin !== pin || v.path !== path) return null;
        inForceMem.set(f, v);
        return v;
    } catch {
        return null;
    }
}

/**
 * 고른 판본이 시행 전이면 GitHub 이력에서 시행 중인 직전 판본을 받아 캐시해 둔다 — 비동기라 검증(동기) 전에 파이프라인이 기다리는 자리에서 부른다.
 * 동의(setLegalizeConsent)가 있을 때만 나간다. 요청은 법령마다 1~3번(이력 1번 + 원문 최대 2번)이고, 결과는 (경로, HEAD 고정 커밋)마다 디스크에 남아
 * 다음부터는 0번이다. 실패해도 던지지 않는다 — 시행 전 판본 표시(L4)로 돌아가고 state·error 로 알린다.
 */
export async function prefetchInForce(path: string, opts: { signal?: AbortSignal } = {}): Promise<{ state: 'skipped' | 'cached' | 'fetched' | 'none' | 'failed'; requests: number; error?: string }> {
    if (!netConsent || legalizeLocalOnly()) return { state: 'skipped', requests: 0 };
    // 시험(NODE_ENV=test)에서는 나가지 않는다 — refreshLegalize 와 같은 잣대. CLI 는 --mock 이 아니면 동의를 열므로, 동의만 보던 때는 NODE_ENV=test 로 돌린
    // CLI 시험이 시행 전 법령마다 api.github.com·raw 로 나갔다. 이미 디스크에 있는 캐시는 검증(inForceVersion)이 그대로 읽는다 — 요청이 아니다.
    // LPS_LEGALIZE_REFRESH=0 도 같다 — 갱신만 막던 때는 그 값을 준 CLI 실행이 직전 판본을 받으러 GitHub API 에 나갔다.
    if (process.env.NODE_ENV === 'test' || process.env.LPS_LEGALIZE_REFRESH === '0') return { state: 'skipped', requests: 0 };
    const pin = pinnedCommit('legalize-kr');
    if (!pin) return { state: 'skipped', requests: 0 };
    const f = inForceFile(path, pin);
    const mem = inForceMem.get(f);
    if (mem) return mem.status === 'failed' ? { state: 'failed', requests: 0, error: mem.error } : { state: 'cached', requests: 0 };
    if (inForceVersion(path)) return { state: 'cached', requests: 0 };
    let requests = 0;
    try {
        const head = splitFrontmatter(readBlob('legalize-kr', path)).meta;
        const today = todayLocal();
        if (!notYetInForce(head, today)) return { state: 'skipped', requests: 0 };
        const sig = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
        requests++;
        const list = (await gh(`/repos/legalize-kr/legalize-kr/commits?path=${encodeURIComponent(path)}&until=${encodeURIComponent(new Date().toISOString())}&per_page=5`, sig)) as {
            sha: string;
            commit?: { author?: { date?: string }; committer?: { date?: string } };
        }[];
        // 빈 목록은 「직전 판본 없음」이 아니다 — 이 경로의 HEAD 판본 커밋조차 없으면 응답이 이상한 것이다(캐시하지 않고 다음에 다시).
        if (!Array.isArray(list) || !list.length) throw new Error('GitHub API 가 이 경로의 커밋 이력을 주지 않음');
        // 고른 판본(HEAD)을 만든 커밋은 받지 않고, 그 뒤의 커밋을 차례로 받아 **시행일자로** 고른다(보통 두 번째 항목).
        // 공포일 **이전** 날짜의 커밋만 보던 때는, 같은 날 공포된 다른 개정(의료법 2026-10-20 일부개정·타법개정 — HEAD 35c580c 의 시행 전 법령 395개 중 21개)의
        // 시행 중 판본을 건너뛰고 더 옛 판본을 「현행 판본」으로 대조했다. 커밋 날짜는 대개 공포일자로 합성되어 있으므로 날짜로는
        // 「고른 판본보다 새 커밋」(원격이 고정 커밋보다 앞섰거나, 날짜가 합성되지 않은 정리 커밋)만 앞에서 건너뛰고, 그다음 하나(공포일 당일·날짜 모름)를
        // 고른 판본의 커밋으로 본다. 그 하나가 공포일보다 옛 날짜면 고른 판본의 커밋이 이력에 없는 것이라 빼지 않는다.
        const day = (c: (typeof list)[number]) => (c.commit?.author?.date ?? c.commit?.committer?.date ?? '').slice(0, 10);
        const promulgated = head['공포일자'] ?? '';
        const dated = /^\d{4}-\d{2}-\d{2}$/.test(promulgated);
        let from = 0;
        if (dated) while (from < list.length && day(list[from]!) > promulgated) from++;
        if (from < list.length && (!dated || !day(list[from]!) || day(list[from]!) >= promulgated)) from++;
        const older = list.slice(from);
        let found: InForceVersion | null = null;
        for (const c of older.slice(0, 2)) {
            requests++;
            const r = await fetch(`https://raw.githubusercontent.com/legalize-kr/legalize-kr/${c.sha}/${path.split('/').map(encodeURIComponent).join('/')}`, {
                headers: { 'user-agent': 'nenene-legalize' },
                signal: sig,
            });
            if (!r.ok) throw new Error(`raw ${r.status}: ${c.sha.slice(0, 7)} ${path}`);
            const text = await r.text();
            const meta = splitFrontmatter(text).meta;
            if (notYetInForce(meta, today)) continue;
            found = { status: 'ok', path, pin, sha: c.sha, 공포일자: meta['공포일자'] ?? '', 시행일자: meta['시행일자'] ?? '', text, at: new Date().toISOString() };
            break;
        }
        const v: InForceVersion = found ?? { status: 'none', path, pin, at: new Date().toISOString() };
        mkdirSync(INFORCE(), { recursive: true });
        writeFileSync(`${f}.${process.pid}.tmp`, JSON.stringify(v));
        renameSync(`${f}.${process.pid}.tmp`, f);
        inForceMem.set(f, v);
        return { state: found ? 'fetched' : 'none', requests };
    } catch (e) {
        const error = e instanceof Error ? e.message.slice(0, 200) : String(e);
        inForceMem.set(f, { status: 'failed', error });
        return { state: 'failed', requests, error };
    }
}

/**
 * 대조할 판본 — 고른 판본이 시행 중이면 그대로. 시행 전이면 캐시에 직전(현행) 판본이 있으면 그것(note: 현행 판본과 대조…), 없으면 고른 판본 그대로
 * (note: 시행 전 판본과 대조 — 현행 조문과 다를 수 있음). pending 은 시행 전 판본(직전 판본으로 바꿨을 때만).
 */
export function versionedLawDoc(doc: LawDoc): { doc: LawDoc; note?: string; sha?: string; pending?: LawDoc } {
    if (!notYetInForce(doc.meta)) return { doc };
    const promulgated = doc.meta['공포일자'] ?? '';
    const effective = doc.meta['시행일자'] ?? '';
    const cur = inForceVersion(doc.path);
    if (cur?.status === 'ok' && cur.text) {
        const { meta, body } = splitFrontmatter(cur.text);
        return { doc: { ...doc, meta, body }, note: `현행 판본(시행 ${cur.시행일자})과 대조. 공포된 개정(시행 ${effective})이 있음`, sha: cur.sha!, pending: doc };
    }
    return { doc, note: `시행 전 판본(공포 ${promulgated}, 시행 ${effective})과 대조 — 현행 조문과 다를 수 있음` };
}

export interface Article {
    no: string; // "제215조"
    heading: string; // "제215조 (압수, 수색, 검증)"
    text: string;
}

/** "제215조", "215", "제215조의2" → 정규화된 조번호 */
export function normalizeArticleNo(raw: string): string {
    const m = /제?\s*(\d+)\s*조(?:\s*의\s*(\d+))?/.exec(raw);
    if (!m) return raw.trim();
    return `제${Number(m[1])}조${m[2] ? `의${Number(m[2])}` : ''}`;
}

/**
 * 조문 하나를 잘라낸다. 헤딩(`##### 제215조 (…)`)부터 같은 레벨의 다음 헤딩 전까지.
 * 조문이 없으면 null — 이게 인용 검증의 "그 조문은 없다" 판정이 된다.
 */
export function getArticle(doc: LawDoc, rawNo: string): Article | null {
    const no = normalizeArticleNo(rawNo);
    const lines = doc.body.split('\n');
    const isHeading = (l: string) => /^#{3,6}\s/.test(l);
    let start = -1;
    let level = 0;
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i]!;
        if (!isHeading(l)) continue;
        const title = l.replace(/^#+\s*/, '').trim();
        if (title === no || title.startsWith(`${no}(`) || title.startsWith(`${no} (`)) {
            start = i;
            level = (l.match(/^#+/) ?? [''])[0].length;
            break;
        }
    }
    if (start < 0) return null;
    let end = lines.length;
    for (let j = start + 1; j < lines.length; j++) {
        const l = lines[j]!;
        if (!isHeading(l)) continue;
        const lv = (l.match(/^#+/) ?? [''])[0].length;
        if (lv <= level) {
            end = j;
            break;
        }
    }
    return {
        no,
        heading: lines[start]!.replace(/^#+\s*/, '').trim(),
        text: lines.slice(start, end).join('\n').trim(),
    };
}

/** 인용에 나오는 모든 조문 번호 ("제215조, 제216조제3항" → ["제215조","제216조"]) */
export function articleNosIn(citation: string): string[] {
    const out = new Set<string>();
    for (const m of citation.matchAll(/제?\s*\d+\s*조(?:\s*의\s*\d+)?/g)) {
        out.add(normalizeArticleNo(m[0]));
    }
    return [...out];
}

/**
 * 이 코퍼스가 어떤 법원을 담고 있는가.
 *
 * precedent-kr 은 **대법원과 하급심만** 담고 있고 헌법재판소 결정은 한 건도 없다(헌 부호 사건번호 0건 — 몇 건 중인지는 인덱스가 정한다).
 * 이 사실을 모르면 헌재 결정을 인용한 명제가 전부 not_found 로 떨어지고, 검증기는 "없는 판례"라고
 * 단정한다 — 코퍼스의 구멍을 인용의 거짓으로 보고하는 것이다. 헌법 주제에서는 이게 결정적이다.
 */
let courtSet: Set<string> | null = null;

export function corpusCourts(): Set<string> {
    if (courtSet) return courtSet;
    courtSet = new Set(precedents().map((p) => p.split('/')[1]).filter(Boolean) as string[]);
    return courtSet;
}

const COURT_SYNONYM: Record<string, string> = {
    헌재: '헌법재판소',
    대판: '대법원',
    고법: '하급심',
};

export function normalizeCourt(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    const c = raw.replace(/\s+/g, '');
    if (COURT_SYNONYM[c]) return COURT_SYNONYM[c];
    if (c.includes('헌법재판소')) return '헌법재판소';
    if (c.includes('대법원')) return '대법원';
    if (c.includes('법원')) return '하급심';
    return c;
}

/** 이 법원의 문서가 코퍼스에 있는가. 없으면 "검증 불가"이지 "없는 판례"가 아니다. */
export function courtCovered(raw: string | undefined): boolean {
    const c = normalizeCourt(raw);
    if (!c) return true;
    const have = corpusCourts();
    if (have.has(c)) return true;
    if (c === '하급심') return have.has('하급심');
    return false;
}

export interface PrecDoc {
    caseNo: string;
    court: string;
    date: string;
    title: string;
    meta: Record<string, string>;
    body: string;
    path: string;
}

export interface PrecHit {
    path: string;
    court: string;
    date: string;
    caseNo: string;
    /**
     * 사건번호를 파일 이름의 **숫자만 있는 칸**(「75므17_18」 의 18)으로 맞췄다 — 이어 쓴 사건번호일 수도, 판례일련번호(「91도2241_601693」)일 수도 있다.
     * 원문 머리(사건번호 필드)로 확인한 뒤에만 그 판결이다(verify.ts pickPrecedent).
     */
    partial?: boolean;
}

/** 선고일을 모른다 — precedent-kr 의 29,180건(거의 전부 일반행정)은 파일 이름에 0000-00-00 을 달고 선고일자 필드가 없다. */
export const UNKNOWN_DATE = '0000-00-00';

const FULL_CASE_NO = /(?<!\d)(\d{2,4})\s*([가-힣]{1,5})\s*(\d+)(?:-(\d+))?/g;

/**
 * 사건번호 칸(파일 이름의 `{사건번호}` 부분, 또는 원문 머리의 사건번호 필드)이 담은 사건번호들.
 *
 * 병합·본소/반소·일련번호가 붙은 파일이 5,910개다 — 「2000므1257_본소_1264_반소」「92다39334_39341_병합_604425」「86스29_30_31」
 * 「85다카779_85다카780」. 접미 일치(`_{사건번호}.md`)로 찾던 때는 이 중 대법원 2,111건을 찾지 못했다(README 의 예 2000므1257 도).
 * 온전한 사건번호는 그대로, 숫자만 있는 칸은 바로 앞 사건번호의 연도·부호를 이어 쓴 것으로 읽는다(partial — 판례일련번호일 수도 있다).
 * 「192-197」 은 범위, 「240-1」 은 다른 번호(가지 번호)다. 한 번호의 일부(「2000므1257」 속 「2000므125」)는 사건번호가 아니다.
 */
export function caseNosOfPart(part: string): { no: string; partial: boolean }[] {
    const out: { no: string; partial: boolean }[] = [];
    const push = (no: string, partial: boolean) => {
        if (!out.some((o) => o.no === no)) out.push({ no, partial });
    };
    const span = (prefix: string, a: string, b: string | undefined, partial: boolean) => {
        const x = Number(a);
        const y = b === undefined ? NaN : Number(b);
        if (b !== undefined && y > x && y - x <= 500) for (let n = x; n <= y; n++) push(`${prefix}${n}`, partial || n !== x);
        else push(`${prefix}${a}${b !== undefined ? `-${b}` : ''}`, partial);
    };
    let prefix = '';
    // 칸을 쪼개기 전에 번호 안의 공백을 붙이고(「2020두 33572」「91가합 84677」 — 공백으로 먼저 쪼개던 때는 「2020두」 와 「33572」 로 갈려 그 번호를 못 찾아
    // 맞는 인용이 not_found 로 막혔다), 「169 내지 177」 은 범위(169-177)로 읽는다.
    const joined = part.replace(/(\d{2,4}[가-힣]{1,5})\s+(?=\d)/g, '$1').replace(/(\d)\s*내지\s*(?=\d)/g, '$1-');
    for (const tok of joined.split(/[_,，\s]+/).filter(Boolean)) {
        let full = false;
        for (const m of tok.matchAll(FULL_CASE_NO)) {
            full = true;
            prefix = `${m[1]}${m[2]}`;
            span(prefix, m[3]!, m[4], false);
        }
        if (full || !prefix) continue;
        const d = /^(\d+)(?:[-∼~](\d+))?(?:\(.*\))?$/.exec(tok);
        if (d) span(prefix, d[1]!, d[2], true);
    }
    return out;
}

/** 사건번호 → 판례 경로들. 목록을 한 번 훑어 만든다(12.5만 건, 한 번). 목록을 새로 받으면 버린다(resetIndexCaches). */
let caseIndex: Map<string, { path: string; partial: boolean }[]> | null = null;
function caseIndexOf(): Map<string, { path: string; partial: boolean }[]> {
    if (caseIndex) return caseIndex;
    const idx = new Map<string, { path: string; partial: boolean }[]>();
    for (const p of precedents()) {
        const file = p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/, '');
        const m = /^(.+?)_(\d{4}-\d{2}-\d{2})_(.+)$/.exec(file);
        if (!m) continue;
        for (const { no, partial } of caseNosOfPart(m[3]!)) {
            const list = idx.get(no);
            if (list) list.push({ path: p, partial });
            else idx.set(no, [{ path: p, partial }]);
        }
    }
    caseIndex = idx;
    return idx;
}

/**
 * 사건번호로 판례 경로를 찾는다.
 *
 * 파일명이 `{법원}_{선고일}_{사건번호칸}.md` 이므로, 인용한 사건번호가 그 칸의 사건번호들 중 **하나와 통째로** 같은 파일을 찾고(caseNosOfPart) —
 * 다른 번호의 일부로는 맞추지 않는다 — 날짜·법원이 주어지면 그것으로 좁힌다. 날짜가 틀렸을 때의 처리:
 * 사건번호가 실재하면 **실재 판례**이고, 날짜만 틀린 것이다. 그래서 dateMismatch 를 따로
 * 돌려준다. 인용 검증에서 이 둘은 다른 사건이다(없는 판례 ≠ 날짜를 잘못 쓴 판례).
 * 선고일이 0000-00-00(모름)인 파일은 날짜로 거르지 않는다 — 맞는지 틀린지 알 수 없다.
 */
export function findPrecedent(input: {
    caseNo: string;
    date?: string;
    court?: string;
}): PrecHit[] {
    const caseNo = input.caseNo.replace(/\s+/g, '');
    if (!caseNo) return [];
    let hits = caseIndexOf().get(caseNo) ?? [];
    if (input.court) {
        const narrowed = hits.filter((h) => h.path.includes(`/${input.court}/`));
        if (narrowed.length) hits = narrowed;
    }
    if (input.date) {
        const iso = input.date.replace(/[.\s]/g, '-').replace(/-+$/, '');
        const narrowed = hits.filter((h) => h.path.includes(`_${iso}_`) || h.path.includes(`_${UNKNOWN_DATE}_`));
        // 날짜로 더 좁히지 못하면 좁히지 않은 채 돌려준다 — 실재하지만 날짜가 다르다는 사실이
        // 판정에 필요하기 때문이다.
        if (narrowed.length) hits = narrowed;
    }
    return hits.map(({ path: p, partial }) => {
        const parts = p.split('/');
        const file = parts[parts.length - 1]!.replace(/\.md$/, '');
        const m = /^(.+?)_(\d{4}-\d{2}-\d{2})_(.+)$/.exec(file);
        return {
            path: p,
            court: m?.[1] ?? parts[parts.length - 2] ?? '',
            date: m?.[2] ?? '',
            caseNo: m?.[3] ?? caseNo,
            ...(partial ? { partial: true } : {}),
        };
    });
}

export function getPrecedent(path: string): PrecDoc {
    const { meta, body } = splitFrontmatter(readBlob('precedent-kr', path));
    const parts = path.split('/');
    const file = parts[parts.length - 1]!.replace(/\.md$/, '');
    const m = /^(.+?)_(\d{4}-\d{2}-\d{2})_(.+)$/.exec(file);
    return {
        caseNo: meta['사건번호'] ?? m?.[3] ?? '',
        court: meta['법원명'] ?? m?.[1] ?? '',
        date: meta['선고일자'] ?? m?.[2] ?? '',
        title: body.split('\n').find((l) => l.startsWith('# '))?.slice(2).trim() ?? '',
        meta,
        body,
        path,
    };
}

/** 판례 본문에서 특정 키워드 주변을 뽑아 근거로 쓴다 (전문은 너무 길다). */
export function excerpt(doc: PrecDoc, keyword: string, radius = 400): string {
    const idx = doc.body.indexOf(keyword);
    if (idx < 0) return doc.body.slice(0, radius * 2);
    return doc.body.slice(Math.max(0, idx - radius), idx + radius).trim();
}

export function legalizeStatus(): LegalizeStatus {
    const meta = readMeta();
    // 인덱스 파일의 줄 수 — 상태 조회가 준비(다운로드)를 일으키지 않게 파일만 읽는다.
    const count = (repo: Repo) => {
        if (!hasIndex(repo)) return 0;
        try {
            if (repo === 'legalize-kr' && lawIndex) return lawIndex.length;
            if (repo === 'precedent-kr' && precIndex) return precIndex.length;
            return readFileSync(join(CACHE(), INDEX_FILE[repo]), 'utf8').split('\n').filter(Boolean).length;
        } catch {
            return 0;
        }
    };
    const clones = REPOS.filter(hasClone).length;
    const ready = REPOS.every(repoReady);
    return {
        lawIndex: count('legalize-kr'),
        precedentIndex: count('precedent-kr'),
        clones,
        mode: !ready ? 'none' : REPOS.every(readsByGit) ? 'git' : 'http',
        commits: Object.fromEntries(REPOS.filter((r) => meta[r]?.commit).map((r) => [r, meta[r]!.commit])),
        ready,
    };
}

/** 실행 시점의 준비 상태 점검(동기) — git 이 있으면 없을 때 이 자리에서 받는다. */
export function ensureLegalizeReady(): LegalizeStatus {
    try {
        bootstrapLegalize();
    } catch {
        /* 상태로 알린다 */
    }
    return legalizeStatus();
}

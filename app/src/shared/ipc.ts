// main ↔ renderer 계약.
//
// **파이프라인의 타입을 그대로 가져오지 않는다.** renderer 는 main 의 모듈 그래프를 알 필요가
// 없고, IPC 경계를 넘는 것은 값의 모양뿐이다. 여기서는 UI 가 실제로 읽는 필드만 구조적으로
// 선언한다. main 쪽은 진짜 타입을 쓰고, 이 선언과 어긋나면 그 자리에서 컴파일이 깨진다.

/** 모델 공급자(src/providers.ts — 기존 구현 의 PROVIDERS 를 옮긴 것). UI 가 읽는 필드만 구조적으로 선언한다. */
export interface ProviderDef {
    id: string;
    label: string;
    baseUrl: string;
    /** 시드 모델(첫 항목이 기본). 실제 목록은 listModels 로 받아온다 */
    models: string[];
    keyHint: string;
    transport?: 'openai-compatible' | 'deepseek' | 'anthropic';
    /** 'optional' — 로컬 런타임은 키가 없어도 되지만 인증 프록시 뒤라면 필요하다 */
    auth: 'required' | 'optional' | 'none';
    authHeader?: string;
    modelsSource?: 'openai' | 'ollama-tags' | 'openrouter' | 'gateway' | 'static';
    note?: string;
    /** 주소를 바꿀 수 있는 항목. 키는 주소(origin)별로 따로 보관한다 */
    endpointEditable?: boolean;
    /** 모델별 응답(출력) 토큰 상한 — API 가 받는 max_tokens 의 최대값. 모르면 생략. */
    maxOutput?: Record<string, number>;
}

export interface ModelInfo {
    id: string;
    tools?: boolean;
    contextLength?: number;
    seed?: boolean;
}

export interface ModelProbe {
    models: ModelInfo[];
    status: 'ok' | 'unauthorized' | 'unreachable' | 'error' | 'none';
}

/**
 * 키를 보관하는 이름. 주소가 고정인 공급자는 id, 주소를 바꿀 수 있는 공급자는 id@origin —
 * 주소를 다른 컴퓨터로 바꾸면 빈 키 칸이 보이고, 앞의 호스트용 키가 새 호스트로 따라가지 않는다(기존 구현 keyScope).
 */
export function keyScope(def: Pick<ProviderDef, 'id' | 'endpointEditable' | 'baseUrl'> | undefined, base?: string): string {
    if (!def) return '';
    if (!def.endpointEditable) return def.id;
    const b = (base || def.baseUrl || '').trim();
    try {
        return `${def.id}@${new URL(b).origin}`;
    } catch {
        return `${def.id}@${b}`;
    }
}

/** 역할별 모델. 비어 있으면 기본 프로파일을 쓴다. */
export interface RoleModel {
    provider: string;
    model: string;
}

/** 논문 규모. 장 수와 분량을 정한다. */
export type PaperScale = 'short' | 'standard' | 'long';

export interface Settings {
    provider: string;
    baseUrl: string;
    model: string;
    temperature: number;
    maxTokens: number;
    /** @deprecated 원자 파이프라인 규모. 새 파이프라인은 scale 을 쓴다 */
    issues: number;
    /** @deprecated */
    claims: number;
    withPaper: boolean;
    assumeUnavailable: boolean;
    contactEmail: string;
    /** 프로젝트 폴더 루트. 비어 있으면 ~/Documents/Nenene */
    workspace: string;
    /** system = OS 설정을 따른다 */
    theme: 'system' | 'light' | 'dark';
    /** 찬성/반대/판정을 다른 모델로 돌리면 절차적 독립이 통계적 독립에 가까워진다. */
    roles: { planner?: RoleModel; worker?: RoleModel; con?: RoleModel; judge?: RoleModel; writer?: RoleModel };
    /** 기본 논문 규모 */
    scale?: PaperScale;
    /** 참고문헌 연쇄 탐색 깊이 1~3 (기본 2) */
    snowballDepth?: number;
    /** 검색 공급자 우선순위 — 쉼표 목록 (예: "tavily,deepseek,ddg"). 비우면 기본 순서 */
    searchOrder?: string;
    /** top_p (0~1). 비우면 보내지 않는다 — 공급자 기본값 */
    topP?: number;
    /** 시드. OpenAI 호환 전송에만 보낸다. 비우면 보내지 않는다 */
    seed?: number;
    /** 주소를 바꿀 수 있는 공급자(Ollama·OpenAI 호환·OpenCodex)의 주소, 공급자 id 별 */
    endpoints?: Record<string, string>;
    /** 설정 파일 형식. 없으면 예전 파일이라 한 번 옮긴다 */
    settingsVersion?: number;
}

/** 검색·자료 공급자 상태. keyId 가 있으면 setKey(keyId, …) 로 키를 넣는다. */
export interface SearchProviderStatus {
    id: string;
    label: string;
    /** 'web' = 웹 검색, 'scholar' = 학술 서지 */
    kind: 'web' | 'scholar';
    needsKey: boolean;
    available: boolean;
    keyId?: string;
    note?: string;
}

export interface ProjectMeta {
    id: string;
    dir: string;
    title: string;
    topic: string;
    runs: number;
    refs: number;
    updatedAt: string;
    /** 설계가 있는가 — 목록 카드에 단계 표시용 */
    hasPlan?: boolean;
    hasPaper?: boolean;
}

export interface RefFile {
    name: string;
    size: number;
    ext: string;
    path: string;
}

// ---- 논문 설계 ----------------------------------------------------------------------

export interface PaperThesis {
    title: string;
    thesis: string;
    concepts: { term: string; definition: string }[];
    questions: string[];
    position: string;
    scope: string;
    method: string;
}

export type SectionRole = 'intro' | 'background' | 'analysis' | 'doctrine' | 'evaluation' | 'comparative' | 'proposal' | 'conclusion';

export interface PaperSection {
    id: string;
    /** 로마 숫자 "I", "II" … 조립기가 붙인다 */
    number: string;
    title: string;
    role: SectionRole;
    brief: string;
    claims: string[];
    sources: string[];
    subsections: string[];
    targetChars: number;
    /** 초고 (⟦인용⟧ 마커 포함) */
    draft?: string;
    /** 검증 결과를 반영해 다시 쓴 본문 (⟦인용⟧ 마커 포함) */
    revised?: string;
    /** 이 장에서 추출해 검토한 주장의 id (ledger.issues[].items[].claim.id) */
    claimIds?: string[];
    /** 이 장이 쓴 인용의 정규화 키 */
    citeKeys?: string[];
}

export interface CiteStatus {
    /** 정규화 키 (중복 제거용) */
    key: string;
    /** 본문에 쓰인 원문 그대로 */
    raw: string;
    kind: 'statute' | 'precedent' | 'constitutional' | 'scholarship' | 'research' | 'url' | 'other';
    /** 각주 번호 */
    n: number;
    /** 인용 검증 상태 (verified / not_found / article_missing / date_mismatch / unverifiable / corpus_gap) */
    check: string;
    /** 원문 확보 상태 (full_text / provided / abstract_only / … ) */
    source: string;
    how?: string;
    url?: string;
    note?: string;
    /** 어느 장에서 쓰였는가 */
    sections: string[];
    /** 원문에서 확인되지 않아 조립 전에 본문에서 뺀 인용 — 상태표에는 남고 각주는 없다 */
    withheld?: true;
}

export interface PaperPlan {
    thesis: PaperThesis;
    sections: PaperSection[];
    abstract?: string;
    keywords?: string[];
    cites?: CiteStatus[];
    /** 본문에서 뺀 인용(그 표지가 생기기 전 원장은 여기에만 있다) */
    withheld?: CiteStatus[];
    scale?: PaperScale;
}

export interface RunRequest {
    /** 화면이 정한 실행 id — 첫 이벤트가 오기 전에 화면이 자기 실행을 알아야 한다. main 이 받지 못하면 새로 만들어 돌려준다 */
    runId?: string;
    projectId: string;
    topic: string;
    /** 필자가 주는 배경·맥락. */
    context?: string;
    settings: Settings;
    /** 구상 단계에서 확정한 설계. 있으면 논지 설계 단계를 건너뛴다 */
    plan?: PaperThesis;
    scale?: PaperScale;
    /** 참고문헌 추가 디렉터리 (프로젝트별) */
    extraCorpus?: string[];
    /** @deprecated 원자 파이프라인 */
    issues?: number;
    /** @deprecated */
    claims?: number;
    /** 원자 파이프라인으로 돌린다 (실험 비교용) */
    atomic?: boolean;
}

// ---- 구상 대화 ----------------------------------------------------------------------

/** 원문 찾기 브라우저에서 질문에 붙인 것 — ref 는 질문의 답에 넣을 file:// 주소(공백이 있어도 안전). */
export interface SourceAdded {
    askId: string;
    ref: string;
    path: string;
    name: string;
    kind: 'download' | 'page';
}

/** 조사로 남은 자료 하나(구상 대화의 턴 기록). */
export interface ResearchItem {
    /** dossier 번호(R1…) — 그때의 번호다. 다시 조사하면 바뀐다. */
    id: string;
    kind: string;
    citation: string;
    summary: string;
    quote?: string;
    url?: string;
    /** url(필자가 준 링크) · web · wiki · kci · crossref */
    source?: string;
    /** 이 자료를 낳은 검색어 */
    query?: string;
    /** 웹 검색이면 답한 공급자 */
    provider?: string;
    authority?: number;
}

/** 조사로 던진 검색 하나 — 0건도 남긴다. */
export interface ResearchSearchNote {
    source: string;
    q: string;
    angle?: string;
    provider?: string;
    /** 검색이 돌려준 수(KCI 는 용어별 결과의 합, 백과는 없음) */
    results?: number;
    kept: number;
    /** 같은 곳에 같은 검색어를 여러 번 던졌으면 그 횟수 */
    times?: number;
    /** 검색 자체가 실패했다(공급자 오류·키 없음) — 「찾았는데 없었다」와 다르다 */
    error?: string;
}

/** 대화 한 턴에서 돈 조사. 예전 기록에는 count·sample 만 있다. */
export interface ResearchNote {
    count: number;
    sample: string[];
    /** initial = 프로젝트 조사(처음, 또는 하루가 지나·맥락이 바뀌어 다시 한 것), turn = 이 발언으로 더 찾은 것 */
    scope?: 'initial' | 'turn';
    items?: ResearchItem[];
    searches?: ResearchSearchNote[];
    /** 읽지 못한 링크 */
    failed?: { url: string; error?: string }[];
}

export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    at?: string;
    /** 이 턴에서 조사가 돌았으면 그 기록 */
    research?: ResearchNote;
    /** 답한 모델과 이 턴의 토큰(조사 검색어 만들기 포함) — 감사용 */
    model?: string;
    usage?: { prompt: number; completion: number; calls: number };
}

export interface ChatRequest {
    projectId: string;
    topic: string;
    context?: string;
    messages: ChatMessage[];
    /** 현재 설계 카드 — 있으면 모델이 그 위에서 말한다 */
    plan?: PaperThesis | null;
}

export interface ChatReply {
    text: string;
    model: string;
    error?: string;
    research?: ResearchNote;
    usage?: { prompt: number; completion: number; calls: number };
}

export interface PlanProposeRequest {
    projectId: string;
    topic: string;
    context?: string;
    messages: ChatMessage[];
    /** 사용자가 이미 적어 둔 것 — 비워 두지 않고 존중한다 */
    current?: PaperThesis | null;
}

/** @deprecated 옆질문은 구상 대화로 흡수되었다 */
export interface SideAsk {
    question: string;
    topic: string;
    context?: string;
    summary: string;
}
export interface SideAnswer {
    text: string;
    model: string;
    error?: string;
}

// ---- HITL ---------------------------------------------------------------------------

export type AnswerAction = 'provided' | 'unavailable' | 'answered';

export interface Answer {
    action: AnswerAction;
    note?: string;
    by?: string;
}

export interface Ask {
    id: string;
    kind: 'source' | 'clarify';
    question: string;
    detail: string;
    consequence: string;
    tried?: string[];
}

export interface AnsweredAsk extends Ask {
    answer: Answer;
}

// ---- 원장 ---------------------------------------------------------------------------

export interface Authority {
    type: string;
    citation: string;
    holding: string;
}

export interface Claim {
    id: string;
    proposition: string;
    role: string;
    premise: string;
    step: string;
    authority: Authority[];
    /** 초고에서 이 주장을 담은 문장 (새 파이프라인) */
    span?: string;
}

export interface Objection {
    claimId: string;
    objection: string;
    alternative: string;
    attack: string;
    premise: string;
    defeat: string;
    authority: Authority[];
}

export interface Judgment {
    confidence?: number;
    claimId: string;
    verdict: 'supported' | 'weak' | 'refuted' | 'unresolved';
    reasoning: string;
    surviving: string[];
    discriminators: string[];
}

export interface CitationCheck {
    citation: string;
    type: string;
    state: string;
    resolved?: string;
    quote?: string;
    note?: string;
}

export interface Passage {
    text: string;
    score: number;
    matched: string[];
}

export interface SourceDoc {
    state: string;
    how: string;
    url?: string;
    title?: string;
    fullText?: string;
    chars?: number;
    abstractText?: string;
    error?: string;
    attempts?: string[];
}

export interface SourceResolution {
    authority: Authority;
    doc: SourceDoc;
    passages: Passage[];
    usable: boolean;
    why?: string;
    humanProvided?: boolean;
}

export interface Evidence {
    grade: string;
    usableCount: number;
    total: number;
    reason: string;
}

export interface Downgrade {
    from: string;
    to: string;
    why: string;
    /** 판정자가 실제로 낸 등급 — 절차 답으로 바뀐 뒤 강등됐을 때만 from 과 다르다 */
    judged?: string;
}

export interface LedgerItem {
    claim: Claim;
    original?: Claim;
    changes?: string[];
    citations: CitationCheck[];
    sources: SourceResolution[];
    evidence: Evidence;
    objection: Objection;
    judgment: Judgment;
    downgrade?: Downgrade;
    human: { question: string; answer: Answer }[];
}

export interface Coverage {
    claims: number;
    citations: number;
    verified: number;
    blocking: number;
    unverifiable: number;
    fullText: number;
    notFullText: number;
    downgraded: number;
    revised?: number;
    withdrawn?: number;
}

export interface Ledger {
    /** 조사 기록 — 웹 검색·단서 URL·백과·서지에서 확인한 것 */
    dossier?: { topic: string; queries: string[]; findings: { id?: string; kind: string; citation: string; summary: string; quote?: string; url?: string }[] };
    topic: string;
    context?: string;
    model: string;
    startedAt: string;
    finishedAt?: string;
    /** 'paper' = 초고→검증→수정. 'atomic' = 원자 명제 파이프라인 */
    mode?: 'paper' | 'atomic';
    /** 새 파이프라인의 논문 설계·본문. issues[] 는 장(section)에 대응한다 */
    paper?: PaperPlan;
    issues: {
        issue: { id: string; question: string; why_contested: string; positions: string[] };
        items: LedgerItem[];
        withdrawn: { claim: Claim; originalProposition: string; changes: string[]; why: string }[];
    }[];
    coverage: Coverage;
    usage?: { prompt: number; completion: number; calls: number };
    human?: AnsweredAsk[];
}

export interface RunSummary {
    runDir: string;
    reportPath: string;
    ledgerPath: string;
    paperPath?: string;
    paperMarkdown?: string;
    coverage: Coverage;
    verdicts: Record<string, number>;
    humanCount: number;
}

export interface ToolEvent {
    at: string;
    kind: 'acquire' | 'verify' | 'coverage' | 'resolve' | 'extract';
    name: string;
    subject: string;
    ok: boolean;
    ms: number;
    detail?: string;
    input?: string;
    output?: string;
}

export type StageId = 'research' | 'thesis' | 'outline' | 'draft' | 'cite' | 'hitl' | 'snowball' | 'review' | 'gapfill' | 'revise' | 'reverify' | 'citecheck' | 'assemble';

/** hint 는 스테퍼 칸 아래 짧은 설명(두 줄 안), desc 는 올렸을 때 보이는 풀어 쓴 설명. */
export const STAGES: { id: StageId; label: string; hint: string; desc: string }[] = [
    { id: 'research', label: '조사', hint: '웹·백과·서지·판례', desc: '주제로 웹·백과사전·학술 서지(KCI 등)·판례 원문을 찾아 자료집을 만든다.' },
    { id: 'thesis', label: '논지', hint: '제목·논지·연구질문', desc: '조사 결과로 제목·중심 논지·연구질문을 세운다. 구상에서 만든 설계가 있으면 건너뛴다.' },
    { id: 'outline', label: '목차', hint: '장 구성과 각 장의 일', desc: '장 구성과 각 장이 맡을 일을 정한다.' },
    { id: 'draft', label: '초고', hint: '장 순서대로 집필', desc: '목차의 장 순서대로 초고를 쓴다.' },
    { id: 'cite', label: '인용', hint: '원문 확보·대조', desc: '초고의 인용마다 원문을 확보하고 인용 문구와 대조한다.' },
    { id: 'hitl', label: '질문', hint: '못 구한 원문 묻기', desc: '자동으로 구하지 못한 원문을 필자에게 묻는다 — 파일·주소로 주거나 「없음」으로 표시한다.' },
    { id: 'snowball', label: '연쇄', hint: '참고문헌 따라가기', desc: '확보한 원문의 참고문헌·참조판례를 따라가 문헌을 더 모은다.' },
    { id: 'review', label: '검토', hint: '주장 추출·반대·판정', desc: '장마다 주장을 뽑아 반대 논거를 세우고, 근거를 보고 판정한다.' },
    { id: 'gapfill', label: '보강', hint: '부족한 자료 보강', desc: '판정이 요구한 자료를 찾아 다시 판정한다(최대 3회).' },
    { id: 'revise', label: '수정', hint: '판정 반영해 수정', desc: '검증 결과를 반영해 장을 다시 쓴다.' },
    { id: 'reverify', label: '재검증', hint: '바뀐 주장 재판정', desc: '수정본에서 바뀐 주장을 다시 반대·판정한다.' },
    { id: 'citecheck', label: '인용 대조', hint: '각주 문장 대조', desc: '각주가 달린 문장이 원문 발췌와 맞는지(숫자·날짜 포함) 대조하고, 틀린 곳을 고친다.' },
    { id: 'assemble', label: '조립', hint: '초록·각주·참고문헌', desc: '초록·각주·참고문헌을 붙여 논문으로 조립한다.' },
];

export type MainEvent =
    | { type: 'progress'; line: string }
    | { type: 'asks'; asks: Ask[] }
    | { type: 'tool'; event: ToolEvent }
    | { type: 'stage'; stage: StageId; status: 'start' | 'done' | 'skip' | 'error'; detail?: string }
    | { type: 'plan'; plan: PaperPlan }
    | { type: 'section'; section: PaperSection; phase: 'draft' | 'revised' }
    | { type: 'cites'; cites: CiteStatus[] }
    | { type: 'review'; sectionId: string; item: LedgerItem }
    /** 장의 판정 목록 전체를 갈아끼운다 — 재검증이 수정본에서 사라진 주장의 판정을 뺄 때 */
    | { type: 'reviews'; sectionId: string; items: LedgerItem[] }
    | { type: 'done'; summary: RunSummary }
    | { type: 'error'; message: string };

/**
 * 실행 이벤트의 꼬리표. 화면은 자기 프로젝트·자기 실행의 것만 받는다 — 전에는 꼬리표가 없어, 멈춘 실행의 늦은 이벤트가
 * 새 실행 화면에, 프로젝트 A 의 실행이 프로젝트 B 화면에 들어갔다(B 의 원고 자리에 A 의 논문이 저장됐다). seq 는 실행마다 1부터.
 */
export interface RunTag {
    runId: string;
    projectId: string;
    seq: number;
}

/** 프로젝트의 실행 — 돌고 있거나, 끝났는데 화면이 아직 받아 가지 않은 것. 프로젝트를 나갔다 오면 이것으로 다시 그린다. */
export interface RunSnapshot {
    runId: string;
    projectId: string;
    /** 돌고 있다 (멈추는 중이면 false) */
    running: boolean;
    /** 필자의 답을 기다리는 질문 */
    asks: Ask[] | null;
    /** 이 실행이 지금까지 낸 이벤트(끝났으면 마지막이 done·error). 활동 줄(진행·도구)은 뒤쪽 일부만 */
    events: MainEvent[];
    /** events 의 마지막 순번 — 이보다 큰 것만 새로 받는다 */
    seq: number;
}

export interface ProjectFile {
    version: 1;
    topic: string;
    context?: string;
    manuscript: string;
    /** 참고문헌 추가 디렉터리. `references/` 는 항상 포함되므로 여기 넣지 않는다. */
    extraCorpus?: string[];
    /** @deprecated */
    issues?: number;
    /** @deprecated */
    claims?: number;
    runDir?: string;
    savedAt: string;
    /** 구상 대화 */
    chat?: ChatMessage[];
    /** 확정한 논문 설계 */
    plan?: PaperThesis | null;
    scale?: PaperScale;
}

export interface RunInfo {
    dir: string;
    name: string;
    hasPaper: boolean;
    hasLedger: boolean;
}

/** preload 가 window.legal 로 노출하는 표면 */
export interface LegalApi {
    providers(): Promise<ProviderDef[]>;
    /** 공급자에게 실제로 쓸 수 있는 모델을 묻는다. endpoint 를 주면 그 주소로 */
    listModels(provider: string, endpoint?: string): Promise<ModelProbe>;
    /** 모델의 문맥 길이(입력+출력) — 모르면 null */
    modelContext(model: string): Promise<number | null>;
    hasKey(provider: string): Promise<boolean>;
    setKey(provider: string, key: string): Promise<{ ok: boolean; error?: string }>;
    getSettings(): Promise<Settings>;
    saveSettings(s: Settings): Promise<Settings>;
    /** 다른 실행이 돌고 있으면(멈추는 중인 것도) 시작하지 않고 error 로 까닭을 준다 */
    start(req: RunRequest): Promise<{ runId: string } | { error: string }>;
    /** 그 실행을 멈춘다. 멈출 때까지 기다린다(오래 걸리면 먼저 돌아온다) */
    cancel(runId: string): Promise<void>;
    answer(runId: string, answers: Record<string, Answer>): Promise<void>;
    /** from 이 없는 이벤트는 시험용 주입이다(index.ts 의 스크린샷 모드) — 실제 실행의 것은 늘 꼬리표가 붙는다 */
    onEvent(cb: (e: MainEvent, from?: RunTag) => void): () => void;
    /** 이 프로젝트의 실행. 없으면 null */
    runStatus(projectId: string): Promise<RunSnapshot | null>;
    /** 끝난 실행을 화면이 받았다(원고 저장까지) — 다시 들어와도 되풀이하지 않는다 */
    runAck(runId: string): Promise<void>;
    loadLedger(runDir: string): Promise<Ledger | null>;
    loadPaper(runDir: string): Promise<string | null>;
    exportAs(kind: 'md' | 'html' | 'docx', payload: { manuscript: string; topic: string; runDir?: string }): Promise<{ path: string } | { error: string }>;
    openPath(p: string): Promise<void>;
    pickFolder(): Promise<string | null>;
    /** 구상 대화 */
    chatSend(req: ChatRequest): Promise<ChatReply>;
    /** 대화에서 논문 설계를 뽑는다 */
    planPropose(req: PlanProposeRequest): Promise<{ plan: PaperThesis } | { error: string }>;
    /** @deprecated */
    sideAsk(req: SideAsk): Promise<SideAnswer>;
    workspaceGet(): Promise<string>;
    workspaceChoose(): Promise<string | null>;
    projectsList(): Promise<ProjectMeta[]>;
    projectCreate(topic: string, context: string): Promise<ProjectMeta>;
    projectSave(id: string, p: ProjectFile): Promise<{ path: string }>;
    projectLoad(id: string): Promise<ProjectFile | null>;
    projectDelete(id: string): Promise<{ deleted: boolean }>;
    refsList(id: string): Promise<RefFile[]>;
    refsAdd(id: string): Promise<RefFile[]>;
    refsOpenFolder(id: string): Promise<void>;
    /**
     * 원문 파일 하나를 골라 **file:// 주소**로 돌려준다(main 의 pathToFileURL — 공백·#·?·한글·윈도 경로가 모두 인코딩된다).
     * 답의 note 에 그대로 붙이면 파이프라인(sources.ts splitProvidedTargets)이 「제공」이든 「직접 답함」이든 같은 파일로 읽는다.
     */
    refsPick(): Promise<string | null>;
    transcriptExport(id: string, runDir: string, kind: 'json' | 'html'): Promise<{ path: string } | { error: string }>;
    /** 프로젝트 작업 기록(감사용) — 저장 창에서 HTML·JSON 을 고른다. 취소하면 null. */
    auditExport(id: string): Promise<{ path: string } | { error: string } | null>;
    listRuns(id: string): Promise<RunInfo[]>;
    corpusStatus(): Promise<{ root: string; lawIndex: number; precedentIndex: number; clones: number; mode: 'git' | 'http' | 'none'; ready: boolean; preparing: boolean; message: string; error: string; consented: boolean }>;
    /** 법령·판례 목록 받기 — 홈의 「받기」. 기다리지 않는다. */
    corpusDownload(): Promise<void>;
    /** 원문 찾기 브라우저 — 질문 패널의 후보 링크. 그 창에서 받은 파일·넣은 페이지는 onSourceAdded 로 온다. */
    openSourceBrowser(req: { askId: string; label: string; url: string; projectId: string }): Promise<void>;
    onSourceAdded(cb: (a: SourceAdded) => void): () => void;
    searchProviders(): Promise<SearchProviderStatus[]>;
}

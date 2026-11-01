// human-on-the-loop. **선택이 아니라 강제**인 부분.
//
// 이 파이프라인이 조용히 넘어가면 안 되는 두 지점이 있다:
//   1) 원문을 확보하지 못했을 때 — 초록이나 서지만 읽고 "읽었다"고 말하는 것
//   2) 판정에 필요한 사실·규범이 기록에 없을 때 — 모르는 것을 그럴듯하게 메우는 것
// 둘 다 모델이 스스로 해결할 수 없다. 그래서 멈추고 사람에게 묻는다.
//
// 강제의 방식:
//   · 대화형이면 선택지 번호를 받을 때까지 다시 묻는다. 그냥 Enter 로 넘어갈 수 없다.
//   · 비대화형이면 답이 없을 때 **실행을 실패시킨다.** 조용히 "없음"으로 처리하지 않는다 —
//     그게 바로 이 장치가 막으려는 것이다.
//   · `--assume-unavailable` 은 명시적 선택이다. 모든 질문에 "없음"으로 답하고 그 사실을
//     원장에 남긴다. 자동화가 필요하면 이 플래그를 쓰고, 그 사실이 보고서에 찍힌다.
//
// 기존 구현 의 교훈: 프롬프트는 강제하지 못한다. 여기서 강제하는 것은 코드다.
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFileSync } from 'node:fs';

export type AskKind = 'source' | 'clarify';

export interface Ask {
    id: string;
    kind: AskKind;
    /** 한 줄 질문 */
    question: string;
    /** 왜 묻는가 · 지금까지 무엇을 시도했는가 */
    detail: string;
    /** 답이 없으면 무엇이 되는가 */
    consequence: string;
    /** 시도했지만 실패한 경로들 */
    tried?: string[];
}

export type AnswerAction = 'provided' | 'unavailable' | 'answered';

export interface Answer {
    action: AnswerAction;
    /** 자유 서술 — provided 면 경로/URL, answered 면 내용 */
    note?: string;
    /** 이 답을 누가/어떻게 냈는가: human | assume-unavailable | answers-file */
    by?: string;
}

export interface AnsweredAsk extends Ask {
    answer: Answer;
}

export class HitlRequired extends Error {
    constructor(readonly asks: Ask[]) {
        super(
            [
                `사람의 답이 필요한 항목이 ${asks.length}개 있습니다. 비대화형 실행이라 중단합니다.`,
                ...asks.flatMap((a, i) => [`  ${i + 1}. [${a.kind}] ${a.question}`, `     id: ${a.id}`]),
                '',
                '해결 방법:',
                '  · 대화형으로 다시 실행하거나',
                '  · --answers <파일.json> 로 답을 주거나  { "<id>": { "action": "provided|unavailable|answered", "note": "..." } }',
                '  · --assume-unavailable 로 전부 "없음"으로 답하고 진행 (원장에 기록됨)',
            ].join('\n'),
        );
    }
}

export interface HitlOptions {
    /** false 면 절대 stdin 을 읽지 않는다 */
    interactive: boolean;
    /** 미리 준 답 파일 */
    answersFile?: string;
    /** 모든 질문에 "없음"으로 답한다 — 명시적 선택이며 기록된다 */
    assumeUnavailable?: boolean;
    /**
     * 답을 **다른 곳에서** 받아오는 함수. 주어지면 stdin 을 읽지 않는다.
     *
     * Electron 앱이 이걸 쓴다: main 이 질문을 IPC 로 renderer 에 보내고 모달이 답을 받는다.
     * 파이프라인 입장에서는 stdin 이든 모달이든 같은 것이고, 그래서 이 파일만 고치면 된다 —
     * 터미널용 답 수집기를 UI 가 재사용하는 게 아니라, **답을 받는 자리를 비워 두는 것**이다.
     */
    ask?: (asks: Ask[]) => Promise<AnsweredAsk[]>;
}

const CHOICES = [
    { key: '1', action: 'provided' as const, label: '제공하겠다 (파일 경로 또는 URL)' },
    { key: '2', action: 'unavailable' as const, label: '없다 / 구할 수 없다 (그 상태로 진행)' },
    { key: '3', action: 'answered' as const, label: '내용을 직접 답하겠다' },
];

function loadAnswers(file: string): Record<string, Answer> {
    try {
        return JSON.parse(readFileSync(file, 'utf8')) as Record<string, Answer>;
    } catch (e) {
        throw new Error(`답 파일을 읽을 수 없습니다: ${file} — ${e instanceof Error ? e.message : String(e)}`);
    }
}

function render(a: Ask, i: number, total: number): string {
    const lines = [
        '',
        `─── [${i + 1}/${total}] ${a.kind === 'source' ? '원문 확보' : '확인 질문'} ───`,
        a.question,
        '',
        `  ${a.detail.replace(/\n/g, '\n  ')}`,
    ];
    if (a.tried?.length) lines.push('', `  시도한 경로: ${a.tried.join(', ')}`);
    lines.push('', `  답이 없으면: ${a.consequence}`);
    return lines.join('\n');
}

/**
 * 모든 질문에 답을 받는다. 답을 받지 못하면 던진다 — 빈 답으로 진행하지 않는다.
 */
export async function runHitl(asks: Ask[], opts: HitlOptions): Promise<AnsweredAsk[]> {
    if (!asks.length) return [];

    // 주입된 수집기가 있으면 그것이 우선이다. 답을 받는 자리만 바꾸고 나머지 규칙
    // (모든 질문에 답해야 한다)은 그대로다 — 수집기도 같은 규칙을 지켜야 한다.
    if (opts.ask) {
        const answered = await opts.ask(asks);
        const missing = asks.filter((a) => !answered.some((x) => x.id === a.id));
        if (missing.length) throw new HitlRequired(missing);
        return answered;
    }

    if (opts.assumeUnavailable) {
        return asks.map((a) => ({ ...a, answer: { action: 'unavailable', by: 'assume-unavailable', note: '자동 처리: 원문 없음' } }));
    }

    if (opts.answersFile) {
        const given = loadAnswers(opts.answersFile);
        // 템플릿의 action:"" 그대로 둔 항목은 답이 아니다 — 그걸 "없음"으로 읽으면 묻지도 않고 ⚠ 가 찍힌다.
        const VALID = new Set(['provided', 'unavailable', 'answered']);
        const missing = asks.filter((a) => !given[a.id] || !VALID.has(given[a.id]!.action) || ((given[a.id]!.action === 'provided' || given[a.id]!.action === 'answered') && !given[a.id]!.note?.trim()));
        if (missing.length) {
            throw new HitlRequired(missing);
        }
        return asks.map((a) => ({ ...a, answer: { ...given[a.id]!, by: 'answers-file' } }));
    }

    if (!opts.interactive || !stdin.isTTY) {
        throw new HitlRequired(asks);
    }

    const rl = createInterface({ input: stdin, output: stdout });
    const out: AnsweredAsk[] = [];
    try {
        for (let i = 0; i < asks.length; i++) {
            const a = asks[i]!;
            stdout.write(`${render(a, i, asks.length)}\n`);
            for (const c of CHOICES) stdout.write(`  ${c.key}) ${c.label}\n`);

            let action: AnswerAction | null = null;
            while (!action) {
                const raw = (await rl.question('\n  선택: ')).trim();
                const hit = CHOICES.find((c) => c.key === raw);
                if (hit) action = hit.action;
                else stdout.write('  1, 2, 3 중 하나를 입력하세요.\n');
            }

            let note: string | undefined;
            if (action === 'provided') {
                note = (await rl.question('  파일 경로·file://·URL (여러 개면 띄어서): ')).trim();
                if (!note) {
                    stdout.write('  경로가 비어 있습니다. 다시 입력하세요.\n');
                    note = (await rl.question('  파일 경로 또는 URL: ')).trim();
                }
            } else if (action === 'answered') {
                note = (await rl.question('  내용 (URL 을 넣으면 가져와 읽습니다): ')).trim();
            }
            out.push({ ...a, answer: { action, note, by: 'human' } });
        }
    } finally {
        rl.close();
    }
    return out;
}

/** 원문 확보 실패를 질문으로 바꾼다. 상태마다 물어볼 말이 다르다 — 그게 요점이다. */
export function sourceAsk(args: {
    id: string;
    citation: string;
    state: string;
    attempts: string[];
    abstractText?: string;
    url?: string;
    /** 왜 전문이 아닌지 (예: "PDF 1면(초록면)") — 사람이 무엇을 줘야 하는지 알게 한다. */
    note?: string;
}): Ask {
    const { citation, state, attempts } = args;
    const detailByState: Record<string, string> = {
        paywalled: '원문이 존재하지만 접근이 차단되어 있습니다(페이월). 제가 읽은 것은 접근 차단 페이지입니다 — 내용이 아닙니다.',
        login_required: '로그인해야 열람할 수 있는 페이지입니다. 읽은 것은 로그인 안내 화면입니다.',
        abstract_only: '초록만 확보했습니다. **초록으로는 판단하지 않습니다** — 초록은 논문이 무엇을 주장하는지 요약할 뿐, 그 주장이 어떻게 논증되는지, 어떤 반론을 다루는지, 어떤 한계를 인정하는지를 말해주지 않습니다.',
        metadata_only: '서지 정보(제목·저자·DOI)만 확인했습니다. 본문은 확보하지 못했습니다.',
        not_found: '어떤 오픈 액세스 경로에서도 찾지 못했습니다. 이 인용이 실재하지 않을 가능성도 있습니다. 다만 제가 가진 코퍼스는 대법원 판례의 전부가 아니므로, "코퍼스에 없음"이 "존재하지 않음"은 아닙니다.',
        corpus_gap: '이 결정은 제 코퍼스가 담고 있지 않은 법원의 것입니다(헌법재판소 결정은 0건 수록). 실재 여부를 제가 판정할 수 없습니다 — 원문을 주시면 읽고 판단하겠습니다.',
        error: '원문을 가져오는 중 오류가 발생했습니다.',
    };
    // KCI 원문 내려받기를 실제로 시도한 경우만 그렇게 말한다(KCI 에서 논문을 못 찾은 경우와 다르다).
    const triedKci = attempts.some((a) => a.toLowerCase().includes('kci')) && /원문 내려받기/.test(args.note ?? '');
    const detail = [
        detailByState[state] ?? '원문을 확보하지 못했습니다.',
        triedKci ? '\nKCI 논문 페이지의 "원문 내려받기"로 전문을 자동으로 받으려 했지만 받지 못했습니다 — 이유는 아래 "확보한 것의 한계"에 있습니다. 학술지가 원문 공개를 막은 경우가 대부분이고, 그때는 학회 사이트·기관구독·필자 제공이 필요합니다.' : '',
        args.note ? `\n확보한 것의 한계: ${args.note}` : '',
        args.abstractText ? `\n확보한 초록 발췌: ${args.abstractText.slice(0, 300)}…` : '',
        args.url ? `\n후보 위치: ${args.url}` : '',
    ]
        .filter(Boolean)
        .join('\n');

    return {
        id: args.id,
        kind: 'source',
        question: `"${citation}" 의 원문을 제공해 주실 수 있습니까?`,
        detail,
        tried: attempts,
        consequence:
            '원문이 없으면 이 인용에 기대는 명제는 "원문 미확인"으로 표시되고, 판정이 supported 로 나와도 코드가 unresolved 로 강등합니다. 없는 것을 읽은 척하지 않습니다.',
    };
}

/** 판정이 미결일 때, 사람만 답할 수 있는 것을 되묻는다. */
export function clarifyAsk(args: { id: string; proposition: string; discriminators: string[]; why: string }): Ask {
    return {
        id: args.id,
        kind: 'clarify',
        question: `이 명제를 판정하려면 확인이 필요합니다: ${args.discriminators.slice(0, 2).join(' / ') || '기록에 없는 사실'}`,
        detail: [
            `명제: ${args.proposition}`,
            '',
            `판정자가 미결로 남긴 이유: ${args.why}`,
            '',
            '이것은 모델이 더 생각해서 풀 문제가 아니라, 기록에 없는 사실을 확인해야 풀리는 문제입니다.',
        ].join('\n'),
        consequence: '답이 없으면 미결로 남습니다. 그것도 정직한 결과이므로, 모르면 "없다"고 답하셔도 됩니다.',
    };
}

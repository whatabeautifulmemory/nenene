// 자료 구조. LLM이 채우는 것과 코드가 판정하는 것을 타입으로 갈라 둔다.
//
//   LLM 이 채운다   Claim · Objection · Judgment(의견)  → 주장과 반대, 그리고 그 판단
//   코드가 판정한다 CitationCheck                       → 인용의 실재 여부
//
// 인용 검증을 Judgment 에서 분리한 이유: 판정은 LLM이 해도 되지만, "이 판례가 실재하는가"는
// LLM이 하면 안 된다. 같은 모델은 같은 방식으로 같은 것을 지어낸다.
import { z } from 'zod';

export const AUTHORITY_TYPES = [
    'statute', // 법령 조문
    'precedent', // 판례 (헌법재판소 결정 포함 — 법원명으로 구별한다)
    'scholarship', // 학설
    'comparative', // 비교법
    'legislative_history', // 입법연혁·심의자료
    'practice', // 실무례·공개자료
] as const;

export const Authority = z.object({
    type: z.enum(AUTHORITY_TYPES),
    /** 인용 문구 그대로. 예: "형사소송법 제215조", "대법원 2022. 6. 30. 선고 2022도1452 판결" */
    citation: z.string(),
    /** 이 권위가 이 명제에 관해 무엇을 말하는가 (한 문장) */
    holding: z.string(),
});
export type Authority = z.infer<typeof Authority>;

export const CLAIM_ROLES = [
    'rule', // 규범 명제 — 무엇이 규정되어 있는가
    'interpretation', // 해석 명제 — 그 규범이 무엇을 뜻하는가
    'application', // 포섭 명제 — 사안이 그 규범에 들어가는가
    'evaluation', // 평가 명제 — 그 해석이 정당한가 (비례·체계·목적)
    'policy', // 정책 명제 — 그래서 무엇을 해야 하는가
] as const;

export const Claim = z.object({
    id: z.string().describe('이 쟁점 안에서의 짧은 식별자. 예: "C1"'),
    proposition: z.string().describe('완결된 한 문장의 명제. "~할 수 있다/없다" 형태'),
    role: z.enum(CLAIM_ROLES),
    /** 이 명제가 성립하려면 참이어야 하는 것. 반대측이 공격할 지점이다. */
    premise: z.string(),
    /** 권위에서 명제로 건너가는 한 걸음. 생략하면 그 자체가 도약이다. */
    step: z.string(),
    authority: z.array(Authority).min(1),
});
export type Claim = z.infer<typeof Claim>;

export const ATTACK_KINDS = [
    'authority_false', // 그 권위는 실재하지 않거나 다른 것이다
    'authority_misread', // 권위는 있으나 그렇게 말하지 않는다
    'authority_out_of_scope', // 권위는 맞으나 이 쟁점에 미치지 않는다 (obiter·개정 전·다른 절차구조)
    'premise_false', // 전제가 성립하지 않는다
    'inference_gap', // 근거에서 결론이 따라나오지 않는다
    'counter_authority', // 반대 결론을 지지하는 권위가 있다
    'consequence', // 결론을 받아들이면 감당할 수 없는 귀결이 생긴다
] as const;

export const Objection = z.object({
    claimId: z.string(),
    /** 가장 강한 형태의 반대 논증. 반박하기 쉬운 형태로 약화시키지 말 것. */
    objection: z.string(),
    /** 같은 권위로 가능한 다른 해석, 또는 반대 결론. */
    alternative: z.string(),
    attack: z.enum(ATTACK_KINDS),
    /** 이 반대가 성립하려면 참이어야 하는 것. */
    premise: z.string(),
    /** 무엇이 이 반대를 죽이는가 — 구체적으로. "타당하지 않다"는 답이 아니다. */
    defeat: z.string(),
    authority: z.array(Authority),
    /**
     * 이 반대의 무게. material = 명제를 흔든다, minor = 표현·범위의 다듬기, none = 실질적 반대 없음.
     * 반대를 반드시 하나 내야 했던 탓에 억지 반대가 판정을 끌어내렸다 — 없으면 없다고 쓴다.
     * 보조 표지라 null·틀린 값은 비운 것으로 읽는다(.catch) — 이 칸 하나 때문에 반대 전체가 스키마에서 떨어지면 주장이 원장에서 빠진다.
     */
    strength: z.enum(['material', 'minor', 'none']).optional().catch(undefined).describe('material=명제를 흔든다 · minor=표현·범위 다듬기 · none=실질적 반대 없음'),
});
export type Objection = z.infer<typeof Objection>;

export const VERDICTS = [
    // 근거가 명제를 지지하고, 반대 해석이 문언·체계·판례로 배제된다
    'supported',
    // 명제와 양립하지만, 다른 해석도 같은 근거와 똑같이 양립한다 — 반대가 살아남았다
    'weak',
    // 근거가 명제와 모순되거나, 권위가 그렇게 말하지 않는다
    'refuted',
    // 판단에 필요한 규범·사실이 기록에 없다
    'unresolved',
] as const;

export const Judgment = z.object({
    /** 이 판단이 뒤집힐 가능성. 1 에 가까울수록 확신. 재검증 루프의 트리거다. */
    confidence: z.number().min(0).max(1).describe('0~1. 원문이 명제를 직접 지지하면 0.8 이상, 간접적이면 0.5 이하'),
    claimId: z.string(),
    verdict: z.enum(VERDICTS),
    /** 반대에 대한 가장 강한 반론. 반대를 이겼다면 무엇이 이겼는지. */
    reasoning: z.string(),
    /** 끝까지 살아남은 반대. 없으면 빈 배열 — 단, 정말 없을 때만. */
    surviving: z.array(z.string()),
    /** 이 판정을 뒤집을 수 있는 것: 어떤 조문·판례·사실이 나오면 결론이 바뀌는가. */
    discriminators: z.array(z.string()),
    /**
     * 판정자가 본 반대의 성격. literalism = 권위가 저자의 결론을 문언으로 말하라고 요구하는 반대,
     * stale_missing_source = "원문 없음"을 말하지만 지금은 원문이 있는 반대, none = 실질적 반대 없음.
     * 코드는 substantive 가 아닌 반대에 기댄 refuted 를 weak 로 내린다.
     */
    objection_quality: z.enum(['substantive', 'literalism', 'stale_missing_source', 'none']).optional().catch(undefined).describe('반대의 성격 — substantive/literalism/stale_missing_source/none'),
    /**
     * 판정 절차의 세 답(논문 주장용). 코드는 판정이 이 세 답과 맞는지만 본다 — 전제 확인·추론 타당·대안이 똑같이 그럴듯하지
     * 않음인데 박약이면 지지로, 전제 미확인·추론 단절·대안 동등인데 지지면 박약으로, 전제·추론이 섰는데 반박이면 박약으로 맞춘다
     * (판정자 자신의 기준으로). 이 셋과 objection_quality 는 보조 표지라 null·틀린 값은 비운 것으로 읽는다(.catch) — json_object
     * 경로의 모델이 선택 칸에 null 을 내면 판정 전체가 떨어져 주장이 원장에서 빠진다.
     */
    premises_supported: z.boolean().optional().catch(undefined).describe('원문 발췌가 명제의 전제(사실·법리)를 확인해 주는가'),
    inference_valid: z.boolean().optional().catch(undefined).describe('전제가 참이면 결론이 따르는가'),
    alternative_equally_plausible: z.boolean().optional().catch(undefined).describe('반대측 대안 해석이 발췌에 비추어 명제와 똑같이 그럴듯한가'),
});
export type Judgment = z.infer<typeof Judgment>;

/**
 * 원문을 본 뒤의 명제 보정 (원자 파이프라인용).
 */
export const RevisedClaim = z.object({
    claimId: z.string(),
    proposition: z.string().describe('원문에 비추어 고친 명제. 원문이 지지하지 않는 부분은 뺀다.'),
    premise: z.string().describe('고친 전제'),
    step: z.string().describe('고친 도약'),
    keep_authorities: z.array(z.string()).describe('원문이 실제로 지지하는 인용만 남긴다. 인용 문자열 그대로.'),
    changes: z.array(z.string()).describe('무엇을 왜 고쳤는가. 바꾼 것이 없으면 빈 배열.'),
    withdraw: z.boolean().describe('원문이 명제를 전혀 지지하지 않아 철회하는 경우 true'),
});
export type RevisedClaim = z.infer<typeof RevisedClaim>;

// ---- 코드가 판정하는 것 ---------------------------------------------------------------

export const CITATION_STATES = [
    'verified', // 원문에서 확인됨
    'not_found', // 코퍼스에 없음 — 실재하지 않거나, 코퍼스가 불완전하거나
    'corpus_gap', // 이 코퍼스가 다루지 않는 법원/문서 종류 — 실재 여부 판정 불가
    'article_missing', // 법령은 있으나 그 조문이 없다
    'date_mismatch', // 사건번호는 실재하나 선고일이 다르다
    'misread', // 원문은 있으나 인용된 취지와 다르다 (수동 표시)
    'unverifiable', // 학설·비교법 등 원문 코퍼스가 없는 종류
] as const;

export const CitationCheck = z.object({
    citation: z.string(),
    type: z.enum(AUTHORITY_TYPES),
    state: z.enum(CITATION_STATES),
    /** 확인된 원문 위치 (저장소 경로 또는 조문) */
    resolved: z.string().optional(),
    /** 원문에서 뽑은 실제 문구 — 인용이 원문과 맞는지 사람이 볼 수 있게 */
    quote: z.string().optional(),
    note: z.string().optional(),
});
export type CitationCheck = z.infer<typeof CitationCheck>;

/** 인용 검증이 실패한 claim 은 판정과 무관하게 논문에 들어갈 수 없다. */
export const blockingStates = new Set<CitationCheck['state']>(['not_found', 'article_missing', 'date_mismatch']);

/**
 * Planner 의 산출물 — **논증 의도** (원자 파이프라인용).
 */
export const Intent = z.object({
    id: z.string(),
    question: z.string().describe('이 쟁점에서 확립해야 할 것 한 문장'),
    kind: z.enum(CLAIM_ROLES),
    laws: z.array(z.string()).describe('확인해야 할 법령명 (예: "정보통신망법", "대한민국헌법")'),
    provisions: z
        .array(z.string())
        .describe('확인할 조문을 조문 단위로. 예: "형사소송법 제216조", "대한민국헌법 제37조". 법령명만 쓰지 말 것.'),
    needs: z.string().describe('필요한 권위의 종류와 이유'),
});
export const IntentList = z.object({ intents: z.array(Intent) });

export const JudgeBatch = z.object({ judgments: z.array(Judgment) });
export const ObjectionBatch = z.object({ objections: z.array(Objection) });

/** 인용 대조 — 각주 문장 ↔ 원문 발췌. */
export const CiteCheckBatch = z.object({
    checks: z.array(
        z.object({
            id: z.string().describe('입력의 [id] 그대로'),
            verdict: z.enum(['supported', 'partial', 'unsupported']).describe('발췌가 문장을 뒷받침하는 정도'),
            reason: z.string().describe('한두 문장 — 무엇이 맞고 무엇이 빠졌는지'),
        }),
    ),
});
export const ClaimBatch = z.object({ claims: z.array(Claim) });
export const IssueList = z.object({
    issues: z.array(
        z.object({
            id: z.string(),
            question: z.string().describe('찬·반으로 갈리는 한 문장의 법적 질문'),
            why_contested: z.string().describe('왜 이 쟁점이 실제로 다투어지는가'),
            positions: z.array(z.string()).describe('현재 존재하는 견해들 (2~4개)'),
        }),
    ),
});

/** 조사 검색어. 각도별로 하나씩 — 같은 각도만 세 개 만들면 조사가 아니라 반복이다. */
export const QueryList = z.object({
    queries: z.array(
        z.object({
            q: z.string().describe('검색엔진에 그대로 넣을 짧은 구 (6~25자)'),
            angle: z.enum(['fact', 'law', 'ruling', 'scholarship', 'critique']),
        }),
    ),
});

/** 판례 리랭크 결과. relevance 2 만 실제 인용 대상이다. */
export const CasePickList = z.object({
    picks: z.array(
        z.object({
            caseNo: z.string(),
            relevance: z.number().int().min(0).max(2),
            why: z.string(),
        }),
    ),
});

// ---- 초고 → 검증 → 수정 파이프라인 ---------------------------------------------------
//
// 논문은 **먼저 쓴다.** 논지·목차·초고를 모델이 만들고, 그 초고의 인용과 주장을 코드와
// 적대적 검토가 확인한 뒤, 확인 결과를 들고 다시 쓴다. 원자 명제를 검증한 뒤 조립하는
// 옛 방식은 검증 가능한 것(조문 요약)만 남겨 논문을 보고서로 퇴화시켰다.

/** 논지 설계. 구상 단계에서 사용자와 함께 만들거나, 모델이 주제·맥락·조사에서 뽑는다. */
export const PaperThesisSchema = z.object({
    title: z.string().describe('논문 제목. 부제가 있으면 " ― " 뒤에'),
    thesis: z.string().describe('중심 논지 2~4문장. 이 논문이 무엇을 주장하고 어떻게 논증하는가'),
    concepts: z
        .array(z.object({ term: z.string(), definition: z.string() }))
        .describe('이 논문이 세우는 핵심 개념·분석틀 (2~5개). 논문 전체에서 같은 말로 쓴다'),
    questions: z.array(z.string()).describe('연구질문. 필자가 개수를 지정했으면 그 수대로'),
    position: z.string().describe('필자의 입장 한 문장 — 결론에서 무엇을 제안하는가'),
    scope: z.string().describe('다루는 범위와 다루지 않는 범위'),
    method: z.string().describe('규범분석·판례분석·비교법 등 방법'),
});
export type PaperThesis = z.infer<typeof PaperThesisSchema>;

export const SECTION_ROLES = [
    'intro', // 서론 — 문제의 제기, 범위와 방법
    'background', // 제도·연혁·사실관계
    'analysis', // 구조 분석 (분석틀 적용)
    'doctrine', // 규범·판례 검토
    'evaluation', // 헌법적/법리적 평가 (심사)
    'comparative', // 비교법
    'proposal', // 개선방안
    'conclusion', // 결론
] as const;

export const OutlineSchema = z.object({
    sections: z.array(
        z.object({
            id: z.string().describe('"S1", "S2" …'),
            title: z.string().describe('장 제목 (번호 없이)'),
            role: z.enum(SECTION_ROLES),
            brief: z.string().describe('이 장이 하는 일 2~4문장: 무엇을 세우고 어디로 넘기는가'),
            claims: z.array(z.string()).describe('이 장에서 세울 주장 2~5개 (한 문장씩)'),
            sources: z.array(z.string()).describe('쓸 자료: 조문·판례·문헌·조사 핸들([R3]). 아는 것만'),
            subsections: z.array(z.string()).describe('소절 제목 (0~5개). 없으면 빈 배열'),
            targetChars: z.number().int().min(600).max(6000),
        }),
    ),
});
export type Outline = z.infer<typeof OutlineSchema>;

/** 초고에서 뽑은, 하중을 지는 주장. 원자 명제 스키마(Claim)에 본문 위치를 더한 것. */
export const ClaimExtract = Claim.extend({
    span: z.string().describe('초고에서 이 주장을 담은 문장(들) 그대로. 수정 단계가 이 자리를 고친다'),
});
export const ClaimExtractBatch = z.object({ claims: z.array(ClaimExtract) });
export type ClaimExtractT = z.infer<typeof ClaimExtract>;

export const AbstractSchema = z.object({
    abstract: z.string().describe('국문초록 600~1000자. 문제·방법·논증·결론 순'),
    keywords: z.array(z.string()).min(5).max(10).describe('주제어'),
});

/** KCI(한국학술지) 검색용 핵심어. 주제 문장을 그대로 쓰면 0건이므로 모델이 용어를 만든다. */
export const KciTermList = z.object({
    terms: z.array(z.string()).min(2).max(6).describe('한국 법학 문헌이 실제로 쓰는 단어. 한 단어 또는 붙여 쓴 복합명사'),
});

/** 구상 대화에서 논지를 뽑을 때 쓰는 입력 형식 */
export const ChatMessageSchema = z.object({ role: z.enum(['user', 'assistant']), content: z.string() });
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

// ---- 되돌림 고리: 연쇄 탐색 · 보강 ------------------------------------------------------
//
// 집필은 선형이 아니다. 원문을 읽으면 그 안의 참고문헌·참조판례가 필요해지고, 판정이 "이게 있어야
// 판단된다"고 말한다. 둘 다 모델이 **고르고**, 코드가 **찾는다**.

/** 확보한 원문의 참고문헌·참조판례 후보 중 이 논문에 필요한 것을 고른다. */
export const RefPickList = z.object({
    picks: z.array(
        z.object({
            citation: z.string().describe('후보 목록의 문자열 그대로'),
            kind: z.enum(['scholarship', 'precedent', 'statute']),
            why: z.string().describe('이 논문의 어느 주장에 왜 필요한가 (한 문장)'),
        }),
    ),
});

/** 판정이 요구한 자료를 찾기 위한 질의. 주장마다 최대 2개. */
export const GapNeedList = z.object({
    needs: z.array(
        z.object({
            claimId: z.string(),
            kind: z.enum(['precedent', 'statute', 'scholarship', 'fact']),
            query: z.string().describe('검색어 (6~30자). 코퍼스·KCI·웹에 그대로 넣는다'),
            citation: z.string().optional().describe('특정 조문·사건번호·문헌을 안다면 정식 인용으로. 검증에서 확인된다. 모르면 비운다'),
            why: z.string().describe('판정의 어떤 결락을 메우는가'),
        }),
    ),
});

// 키 없이 파이프라인만 확인하기 위한 고정 응답.
//
// 이건 품질 시험이 아니다 — 배관 시험이다. 실제 모델 출력의 품질은 키를 넣고 돌려야 알 수 있다.
// 다만 fixture 를 그럴듯하게 만들어 둔 이유가 있다. 이 파이프라인의 핵심 동작 셋이 눈에 보여야
// 배관이 맞는지 알 수 있다:
//   · C4b — 원문을 구할 수 없는 학설 인용 → 사람에게 묻는 경로
//   · C4  — 존재하지 않는 판례 인용     → 차단 + 원장 표시
//   · 전부 — 초록/서지만으로는 supported 가 나올 수 없다
//
// **fixture 를 순서로 고르지 않는다.** claim 은 병렬로 처리되므로 호출 순서가 실행마다 다르다.
// 처음 버전은 인덱스를 돌려 쓰다가 판정과 반대가 서로 다른 명제에 붙었다 — 원인은 fixture 였지만
// 결과는 배관 버그와 똑같이 보였다. 그래서 지금은 프롬프트에 들어 있는 명제로 찾는다.
import type { Asker } from './pipeline.ts';

export const ISSUES = {
    issues: [
        {
            id: 'I1',
            question:
                '수사기관이 압수·수색영장에 기재되지 않은 원격지 서버의 전자정보를, 영장에 기재된 정보처리장치를 통해 압수할 수 있는가?',
            why_contested:
                '형사소송법 제215조는 영장에 의한 압수·수색을 규정하지만 원격지 정보에 관한 명시적 규정을 두지 않았고, 2022년 대법원 판결이 이 문제를 다루었다. 영장의 장소적·대상적 범위를 문언대로 엄격히 볼 것인지, 압수수색의 실효성 확보를 위해 필요한 처분으로 볼 것인지가 갈린다.',
            positions: [
                '적극설 — 현행 규정만으로 해석상 허용된다',
                '소극설 — 별도 입법 없이는 허용될 수 없다',
                '제한적 적극설 — 전자정보나 서버를 특정할 수 없는 경우에 한정하여 허용된다',
            ],
        },
    ],
};

export const CLAIMS = {
    claims: [
        {
            id: 'C1',
            proposition: '형사소송법 제215조는 사법경찰관이 법관이 발부한 영장에 의하여 압수·수색·검증을 할 수 있다고 규정한다.',
            role: 'rule',
            premise: '제215조가 현행 유효한 규정이며, 원격지 전자정보에 대한 적용을 배제하는 단서를 두지 않았다.',
            step: '규정의 문언이 원격지 정보를 명시적으로 제외하지 않으므로 포섭 가능성이 열린다.',
            authority: [{ type: 'statute', citation: '형사소송법 제215조', holding: '영장에 의한 압수·수색·검증의 근거를 둔다.' }],
        },
        {
            id: 'C2',
            proposition: '원격지 서버의 전자정보를 수색장소에 있는 정보처리장치로 현출하는 행위는 압수·수색에 필요한 처분에 해당한다.',
            role: 'interpretation',
            premise: '‘필요한 처분’의 개념이 영장에 기재된 장소 밖의 매체에 대한 접근까지 포함한다.',
            step: '제215조의 압수·수색이 정보처리장치를 매개로 이루어지는 이상, 현출 행위는 집행의 일부다.',
            authority: [
                {
                    type: 'precedent',
                    citation: '대법원 2022. 6. 30. 선고 2022도1452 판결',
                    holding: '원격지 전자정보의 현출을 압수수색에 필요한 처분으로 보았다.',
                },
            ],
        },
        {
            id: 'C3',
            proposition: '영장에 압수할 물건이 정보처리장치에 저장된 전자정보로 기재되어 있으면, 그 장치를 통해 원격지 서버의 전자정보를 압수할 수 있다.',
            role: 'application',
            premise: '영장의 대상 특정이 원격지 서버 정보를 포함하는 것으로 해석될 수 있다.',
            step: '대상 특정이 충분하므로 장소적 범위의 확대 문제가 생기지 않는다.',
            authority: [
                {
                    type: 'precedent',
                    citation: '대법원 2022. 6. 30. 선고 2022도1452 판결',
                    holding: '영장 기재 장소에서의 집행으로 보아 허용하였다.',
                },
            ],
        },
        {
            id: 'C4b',
            proposition: '원격 압수수색의 허용 범위를 정보저장매체의 소재가 아닌 영장 집행지 기준으로 정한 학설이 이미 확립되어 있다.',
            role: 'evaluation',
            premise: '국내 형사법 학계에서 이 견해가 유력설로 자리 잡았다.',
            step: '유력설의 존재 자체가 해석의 정당성을 뒷받침한다.',
            authority: [
                {
                    type: 'scholarship',
                    citation:
                        '장응혁, 「원격 압수수색의 법적 성격: 대법원 2022. 6. 30. 선고 2022도1452 판결을 소재로」, 디지털포렌식연구 제16권 제3호, 2022, 157-176면',
                    holding: '원격 압수수색의 법적 성격에 관하여 집행지 기준설이 유력하다고 서술하였다.',
                },
            ],
        },
        {
            id: 'C4',
            proposition: '대법원은 이후 판결에서도 원격지 전자정보 압수에 관한 위 법리를 유지하고 있다.',
            role: 'evaluation',
            premise: '후속 판결이 존재하고 같은 법리를 반복하였다.',
            step: '선례의 유지 자체가 법리의 안정성을 보여준다.',
            authority: [{ type: 'precedent', citation: '대법원 2023. 3. 15. 선고 2023도9999 판결', holding: '위 법리를 그대로 유지하였다.' }],
        },
    ],
};

export const OBJECTIONS: Record<string, unknown> = {
    C1: {
        claimId: 'C1',
        objection:
            '조문의 문언이 원격지 정보를 배제하지 않는다는 사실은 그 정보를 포함한다는 결론을 지지하지 않는다. 영장주의의 헌법적 함의는 영장에 기재된 장소와 대상의 범위를 수사기관의 편의로 확장하는 해석을 허용하지 않는다.',
        alternative: '제215조는 영장에 기재된 장소에서의 집행을 전제한 규정이고, 원격지 접근은 별도의 입법이 필요한 영역이다.',
        attack: 'inference_gap',
        premise: '문언에 없다는 것이 곧 허용을 뜻하지는 않는다.',
        defeat: '제215조 또는 제106조가 원격지 정보를 명시적으로 언급하거나, 대법원이 문언상 허용된다고 명시적으로 판시한 경우.',
        authority: [{ type: 'statute', citation: '형사소송법 제307조', holding: '위법수집증거 배제의 근거.' }],
    },
    C2: {
        claimId: 'C2',
        objection:
            '인용된 판결의 판시사항은 "압수·수색영장에 적힌 ‘압수할 물건’에 별도로 원격지 서버 저장 전자정보가 특정되어 있어야 하는지 여부(적극)"라고 스스로 밝히고 있다. 즉 이 판결은 명제가 말하는 방향이 아니라 반대 방향의 판시다.',
        alternative: '이 판결은 원격지 압수를 허용한 것이 아니라, 허용되려면 영장에 원격지 정보가 별도로 특정되어야 한다고 한 것이다.',
        attack: 'authority_misread',
        premise: '판시사항의 문언이 명제와 반대 취지다.',
        defeat: '판결 전문에서 원격지 정보의 별도 특정을 요구하지 않는다는 부분이 확인되거나, 다른 판결이 그 요구를 철회한 경우.',
        authority: [
            {
                type: 'precedent',
                citation: '대법원 2022. 6. 30. 선고 2022도1452 판결',
                holding: '원격지 서버 저장 전자정보의 별도 특정을 요구하였다.',
            },
        ],
    },
    C3: {
        claimId: 'C3',
        objection:
            '영장에 “정보처리장치에 저장된 전자정보”라고만 기재되어 있으면, 그 문언은 그 장치 안의 저장 영역을 가리킨다. 원격지 서버는 다른 장소에 있는 다른 매체이고, 이를 포함한다고 읽으려면 문언을 확장해야 한다.',
        alternative: '영장 기재만으로는 원격지 서버가 특정되지 않으므로, 별도의 영장 또는 보전처분이 필요하다.',
        attack: 'authority_out_of_scope',
        premise: '영장의 대상 특정은 장소적 범위와 독립하여 확장될 수 없다.',
        defeat: '영장 자체에 원격지 서버의 소재나 접속 정보가 기재되어 있는 경우.',
        authority: [{ type: 'statute', citation: '형사소송법 제114조', holding: '영장의 기재사항.' }],
    },
    C4b: {
        claimId: 'C4b',
        objection:
            '인용된 학설의 원문을 확보하지 못했다. 초록이나 서지로는 그 논문이 실제로 이 명제를 주장하는지, 어떤 조건을 붙였는지, 반대 견해를 어떻게 다루었는지 알 수 없다. 확인되지 않은 유력설을 근거로 해석의 정당성을 논할 수는 없다.',
        alternative: '그 학설이 존재하더라도 유력설인지, 그리고 그 내용이 명제와 같은지 원문에서 확인되어야 한다.',
        attack: 'authority_false',
        premise: '인용된 학설의 실재와 내용이 원문에서 확인되지 않았다.',
        defeat: '해당 논문의 원문(관련 대목)이 제시되는 경우.',
        authority: [],
    },
    C4: {
        claimId: 'C4',
        objection:
            '인용된 사건번호로는 어떤 판결인지 특정할 수 없고, 원문 발췌도 제공되지 않았다. 확인되지 않은 선례를 근거로 법리의 안정성을 논할 수는 없다. 또한 선례의 반복은 법리의 정당성이 아니라 사실상의 관행을 보여줄 뿐이다.',
        alternative: '후속 판결이 실재하더라도 그것이 이 명제를 지지하는지는 별도로 확인되어야 한다.',
        attack: 'authority_false',
        premise: '인용된 판결의 실재와 취지가 확인되지 않았다.',
        defeat: '해당 사건번호의 판결 원문이 제시되는 경우.',
        authority: [],
    },
};

export const JUDGMENTS: Record<string, unknown> = {
    C1: {
        claimId: 'C1',
        confidence: 0.85,
        verdict: 'supported',
        reasoning:
            '제215조가 영장에 의한 압수·수색의 근거를 둔다는 것은 원문으로 확인되고, 반대가 제시한 “문언에 없다”는 논거는 이 명제 자체를 겨냥하지 않는다. 명제는 규정의 존재를 말할 뿐 원격지 정보의 포함 여부를 말하지 않으므로, 반대는 한 단계 뒤의 명제(C2)를 향한 것이다.',
        surviving: [],
        discriminators: ['제215조가 개정되어 원격지 정보를 명시하게 되는 경우'],
    },
    C2: {
        claimId: 'C2',
        confidence: 0.8,
        verdict: 'refuted',
        reasoning:
            '인용된 판결의 판시사항은 원격지 서버 저장 전자정보가 영장에 별도로 특정되어 있어야 한다고 밝히고 있다. 이는 명제가 주장하는 “필요한 처분에 해당한다”와 정합적이지 않다. 필요한 처분이라는 표현은 집행 수단을 가리키는 것이지 영장의 대상 특정을 면제하는 근거가 아니다.',
        surviving: ['영장에 원격지 정보가 별도로 특정되지 않았음에도 허용한 사례가 있는가'],
        discriminators: [
            '대법원이 별도 특정 요구를 철회하거나 완화한 판결을 선고하는 경우',
            '형사소송법 제215조의2(보전요청)의 입법 취지가 해석에 반영되는 경우',
        ],
    },
    C3: {
        claimId: 'C3',
        confidence: 0.45,
        verdict: 'weak',
        reasoning:
            '명제는 영장 기재만으로 원격지 서버 정보가 특정된다고 보는데, 그 해석을 명시적으로 지지하는 권위가 제시되지 않았다. 반대로 영장의 대상 특정이 장소적 범위와 독립할 수 없다는 반대가 살아남는다.',
        surviving: ['영장의 대상 특정과 장소적 범위는 독립적으로 확장될 수 없다'],
        discriminators: [
            '영장에 원격지 서버의 접속 정보나 소재가 기재된 사례',
            '제106조 제3항의 “정보저장매체” 개념에 원격지 매체가 포함되는지에 관한 판례',
        ],
    },
    C4b: {
        // 일부러 **나쁜 판정**을 넣는다. 원문을 읽지 못한 상태에서 supported 를 내는 것이
        // 이 게이트가 막으려는 실패이고, 코드가 실제로 내리는지 봐야 한다.
        claimId: 'C4b',
        confidence: 0.7,
        verdict: 'supported',
        reasoning:
            '인용된 학설은 이 견해가 국내에서 유력함을 확인해 준다. 따라서 영장 집행지 기준설이 확립되어 있다고 볼 수 있다.',
        surviving: ['인용된 학설의 실재와 내용이 확인되지 않았다'],
        discriminators: ['해당 논문 원문의 관련 대목 확보', '국내 형사법 학계의 통설 지위를 보여주는 다른 문헌'],
    },
    C4: {
        // 역시 일부러 나쁜 판정. 없는 판례를 근거로 supported 를 낸다.
        claimId: 'C4',
        confidence: 0.7,
        verdict: 'supported',
        reasoning:
            '후속 판결이 같은 법리를 유지하였다면, 그 법리는 안정적이라고 평가할 수 있다.',
        surviving: ['후속 판결의 실재 자체가 확인되지 않았다'],
        discriminators: ['해당 사건번호의 판결 원문 확보', '같은 법리를 반복한 후속 판결의 확인'],
    },
};

/** 보정 fixture — mock 에서는 아무것도 고치지 않는다. 실제 보정은 실모델 실행에서 본다. */
const revisionFor = (claimId: string): unknown => {
    const c = CLAIMS.claims.find((x) => x.id === claimId)!;
    return {
        claimId,
        proposition: c.proposition,
        premise: c.premise,
        step: c.step,
        keep_authorities: c.authority.map((a) => a.citation),
        changes: [],
        withdraw: false,
    };
};

/** 프롬프트에 들어 있는 명제로 fixture 를 찾는다 — 호출 순서에 기대지 않는다. */
function claimKeyIn(text: string): string | undefined {
    for (const c of CLAIMS.claims) {
        if (text.includes(c.proposition.slice(0, 40))) return c.id;
    }
    return undefined;
}


// ---- 초고→검증→수정 파이프라인 fixture ------------------------------------------------

export const THESIS = {
    title: '원격지 서버 전자정보의 압수와 영장의 대상 특정 ― 2022도1452 판결의 구조와 한계',
    thesis:
        '영장에 기재된 정보처리장치를 통한 원격지 서버 전자정보의 취득은 집행의 수단이 아니라 압수 대상의 확장이다. 따라서 그 허용 여부는 "필요한 처분"의 해석이 아니라 영장의 대상 특정 요건에서 결정되어야 하며, 대법원 2022도1452 판결은 이 구조를 채택한 것으로 읽어야 한다.',
    concepts: [
        { term: '대상 확장', definition: '영장이 특정한 저장매체 밖의 정보를 집행 과정에서 취득하는 것' },
        { term: '수단 해석', definition: '원격 접속을 압수·수색에 필요한 처분(집행 방법)으로 보는 해석' },
    ],
    questions: ['원격지 정보의 취득은 집행 수단인가, 대상 확장인가', '2022도1452 판결은 어느 쪽 구조를 취했는가', '입법 없이 해석으로 규율할 수 있는가'],
    position: '영장에 원격지 정보를 별도로 특정하도록 하는 해석을 유지하되, 특정 불능 사안을 위한 입법을 제안한다.',
    scope: '헌법상 영장주의와 형사소송법 해석에 한정하며, 국외 서버의 주권 문제는 다루지 않는다.',
    method: '규범분석·판례분석',
};

export const OUTLINE = {
    sections: [
        { id: 'S1', title: '서론', role: 'intro', brief: '문제를 제기하고 범위·방법을 밝힌다.', claims: ['원격지 정보 취득은 실무에서 일상화되었으나 규범은 침묵한다'], sources: ['형사소송법 제215조'], subsections: [], targetChars: 800 },
        { id: 'S2', title: '규범 구조와 판례', role: 'doctrine', brief: '제215조·제106조의 구조와 2022도1452 판결의 논리를 분석한다.', claims: ['원격 접속은 필요한 처분이 아니라 대상 확장이다', '2022도1452 판결은 별도 특정을 요구한다'], sources: ['형사소송법 제215조', '대법원 2022. 6. 30. 선고 2022도1452 판결'], subsections: ['조문의 구조', '판결의 논리'], targetChars: 1500 },
        { id: 'S3', title: '결론', role: 'conclusion', brief: '논지를 요약하고 입법을 제안한다.', claims: ['특정 불능 사안을 위한 입법이 필요하다'], sources: [], subsections: [], targetChars: 600 },
    ],
};

/** 장별 초고 fixture. 마커 넷: 실재 조문·실재 판례·원문 없는 학설·없는 판례. */
export const DRAFTS: Record<string, string> = {
    S1: `수사기관이 압수·수색영장에 기재된 정보처리장치를 통하여 원격지 서버에 저장된 전자정보를 취득하는 일은 이미 일상적 실무가 되었다. 그러나 형사소송법은 영장에 의한 압수·수색의 근거를 둘 뿐⟦형사소송법 제215조⟧, 원격지 정보에 관하여는 침묵한다.

본 논문은 이 침묵을 "필요한 처분"의 해석으로 메우는 수단 해석이 영장주의의 구조와 양립하지 않음을 논증한다.`,
    S2: `### 1. 조문의 구조

형사소송법은 사법경찰관이 법관이 발부한 영장에 의하여 압수·수색·검증을 할 수 있다고 규정한다⟦형사소송법 제215조⟧. 이 조문은 집행의 근거일 뿐 대상의 범위를 정하지 않는다.

### 2. 판결의 논리

대법원은 원격지 서버의 전자정보를 수색장소의 정보처리장치로 현출하는 행위를 압수·수색에 필요한 처분으로 보았다⟦대법원 2022. 6. 30. 선고 2022도1452 판결⟧. 학설은 집행지 기준설이 유력하다고 한다⟦장응혁, 「원격 압수수색의 법적 성격: 대법원 2022. 6. 30. 선고 2022도1452 판결을 소재로」, 디지털포렌식연구 제16권 제3호, 2022, 157-176면⟧. 대법원은 이후 판결에서도 위 법리를 유지하고 있다⟦대법원 2023. 3. 15. 선고 2023도9999 판결⟧.`,
    S3: `이상의 검토는 원격지 정보의 취득이 집행 수단이 아니라 대상 확장임을 보였다. 특정이 불가능한 사안을 위하여는 입법이 필요하다.`,
};

export const EXTRACTS: Record<string, unknown[]> = {
    S2: [
        { ...CLAIMS.claims[1], id: 'C2', span: '대법원은 원격지 서버의 전자정보를 수색장소의 정보처리장치로 현출하는 행위를 압수·수색에 필요한 처분으로 보았다' },
        { ...CLAIMS.claims[3], id: 'C4b', span: '학설은 집행지 기준설이 유력하다고 한다' },
        { ...CLAIMS.claims[4], id: 'C4', span: '대법원은 이후 판결에서도 위 법리를 유지하고 있다' },
    ],
};

export const ABSTRACT = {
    abstract: '본 논문은 원격지 서버 전자정보의 취득을 집행 수단이 아니라 대상 확장으로 파악하고, 2022도1452 판결이 영장의 별도 특정을 요구한 구조를 채택하였음을 논증한다. 결론으로 특정 불능 사안을 위한 입법을 제안한다.',
    keywords: ['원격 압수수색', '영장주의', '대상 특정', '필요한 처분', '2022도1452'],
};

function sectionKeyIn(text: string): string | undefined {
    // 장 머리("## 지금 쓸 장: II. …")가 먼저다. 초고 본문으로 찾으면 "앞 장의 요지"에 섞인
    // 앞 장 초고에 걸려 매번 I 장이 나온다(실제로 그랬다 — 세 장이 전부 서론이었다).
    const m = /## (?:지금 쓸 장|이 장|장):\s*[IVX]+\.\s*(.+)/.exec(text);
    const title = m?.[1]?.trim();
    const sec = OUTLINE.sections.find((s) => s.title === title);
    if (sec) return sec.id;
    for (const [id, d] of Object.entries(DRAFTS)) if (text.includes(d.slice(0, 60))) return id;
    return undefined;
}

/** 모델 없이 장을 "쓴다". 초고는 fixture, 수정은 미확보 인용에 ⚠ 를 붙여 돌려준다. */
export function mockWriter(): (req: { name: string; system: string; user: string }) => Promise<string> {
    return async (req) => {
        // 인용 고침 — 걸린 첫 문장에서 그 인용 마커를 뺀다(지시대로 "뒷받침이 없으면 마커를 뺀다").
        if (req.name === 'cite_fix') {
            const text = /## 현재 원고\n([\s\S]*?)\n\n## 고칠 문장/.exec(req.user)?.[1] ?? '';
            const cite = /인용: (⟦[^⟧]+⟧)/.exec(req.user)?.[1];
            const sentence = /- 문장: "([^"]+)"/.exec(req.user)?.[1];
            if (!text || !cite || !sentence) return text;
            const target = text.split(/(?<=[.?!])\s+/).find((x) => x.replace(/\s+/g, ' ').includes(sentence.slice(0, 40)));
            return target ? text.replace(target, target.replace(cite, '')) : text.replace(cite, '');
        }
        const id = sectionKeyIn(req.user);
        if (!id) throw new Error('mock draft fixture 없음 (프롬프트에서 장을 찾지 못함)');
        const draft = DRAFTS[id]!;
        if (req.name === 'revise') {
            return draft
                .replace(/⟦대법원 2023\. 3\. 15\. 선고 2023도9999 판결⟧/g, '')
                .replace('대법원은 이후 판결에서도 위 법리를 유지하고 있다.', '후속 판결의 존재는 이 기록에서 확인되지 않았다.')
                .replace(/(157-176면⟧)\./, '$1 ⚠.');
        }
        return draft;
    };
}

export function mockAsker(): Asker {
    return async <T>(
        _schema: unknown,
        req: { name: string; user: string },
        usage: { prompt: number; completion: number; calls: number },
    ): Promise<T> => {
        usage.calls += 1;
        usage.prompt += 1200;
        usage.completion += 600;
        switch (req.name) {
            case 'issues':
                return ISSUES as T;
            case 'claims':
                return CLAIMS as T;
            case 'revision': {
                const key = claimKeyIn(req.user);
                if (!key) throw new Error('mock revision fixture 없음');
                return revisionFor(key) as T;
            }
            case 'objections': {
                const key = claimKeyIn(req.user);
                const f = key ? OBJECTIONS[key] : undefined;
                if (!f) throw new Error('mock objection fixture 없음 (프롬프트에서 명제를 찾지 못함)');
                return { objections: [f] } as T;
            }
            case 'judgments': {
                const key = claimKeyIn(req.user);
                const f = key ? JUDGMENTS[key] : undefined;
                if (!f) throw new Error('mock judgment fixture 없음 (프롬프트에서 명제를 찾지 못함)');
                return { judgments: [f] } as T;
            }
            case 'thesis':
                return THESIS as T;
            case 'outline':
                return OUTLINE as T;
            case 'claims_extract': {
                const id = sectionKeyIn(req.user);
                const base = (id ? EXTRACTS[id] : undefined) ?? [];
                // LPS_MOCK_REVERIFY=1 — 수정본에서 뽑을 때는 권위를 비워 "예전과 다른 주장"으로 만든다(재판정 경로 시험).
                if (process.env.LPS_MOCK_REVERIFY === '1' && req.user.includes('후속 판결의 존재는 이 기록에서 확인되지 않았다')) {
                    return { claims: base.map((c) => ({ ...(c as object), authority: [] })) } as T;
                }
                return { claims: base } as T;
            }
            case 'abstract':
                return ABSTRACT as T;
            case 'search_queries':
                return { queries: [] } as T;
            case 'ref_pick': {
                // LPS_MOCK_PICK=1 이면 후보 목록의 판례부터 지정 개수만큼 고른다 — 다단계 연쇄 탐색을 결정적으로 시험하려고.
                if (process.env.LPS_MOCK_PICK !== '1') return { picks: [] } as T;
                const max = Number(/최대\s*(\d+)개/.exec(req.user)?.[1] ?? 2);
                const rows = [...req.user.matchAll(/^\d+\.\s*\[(precedent|scholarship|statute)\]\s*(.+?)(?:\s{2}←.*)?$/gm)].map((m) => ({ kind: m[1]!, citation: m[2]!.trim() }));
                rows.sort((a, b) => (a.kind === 'precedent' ? 0 : 1) - (b.kind === 'precedent' ? 0 : 1));
                return { picks: rows.slice(0, max).map((r) => ({ ...r, why: '시험용 선택' })) } as T;
            }
            case 'cite_check': {
                // 인용 대조 — 전부 뒷받침으로 답한다(배관 시험용).
                const ids = [...req.user.matchAll(/### \[([^\]]+)\]/g)].map((m) => m[1]!);
                // LPS_MOCK_CITECHECK=bad — 첫 대조 문장을 "뒷받침 안 됨"으로(고침 경로 시험). 고친 뒤 다시 대조(-R)는 뒷받침.
                const bad = process.env.LPS_MOCK_CITECHECK === 'bad';
                return { checks: ids.map((id, i) => ({ id, verdict: bad && i === 0 && /-K\d+$/.test(id) ? 'unsupported' : 'supported', reason: '시험용' })) } as T;
            }
            case 'gap_needs':
                return { needs: [] } as T;
            case 'case_rerank':
                return { picks: [] } as T;
            default:
                throw new Error(`mock fixture 없음: ${req.name}`);
        }
    };
}

// 판례 리랭커.
//
// 규칙 점수로 20개를 뽑고, 그중 **이 쟁점의 판례인지**를 모델이 판정한다. 규칙만으로는
// 정밀도가 안 나온다 — "보호조치"로 검색하면 행정법 판례가 섞이고, "랜섬웨어"로 검색하면
// "지불"이 걸려 민사 판례가 올라온다. 반대로 규칙을 조이면 정답(판시사항에만 있는 개념)을
// 놓친다. 넓게 뽑고 좁게 고르는 것이 맞다.
import type { CaseHit } from './cases.ts';
import { CasePickList } from '../schemas.ts';

export interface Pick {
    caseNo: string;
    /** 2 = 이 쟁점을 직접 다룬다, 1 = 관련은 있으나 주된 쟁점이 아니다, 0 = 무관 */
    relevance: 0 | 1 | 2;
    why: string;
}

const SYSTEM = `너는 한국 법학 논문의 판례 조사 담당이다.
주어진 쟁점에 대해, 후보 판례 중 **그 쟁점을 실제로 다루는 것**만 고른다.

판정 기준:
- 2: 쟁점의 법리가 이 판례의 판시사항·판결요지에 직접 등장하고, 인용하면 논증이 성립한다.
- 1: 같은 법률·같은 유형이지만 주된 쟁점이 다르다. 보조 인용으로만 쓸 수 있다.
- 0: 사건명이나 요지가 겹칠 뿐 쟁점이 다르다. **고르지 않는다.**

가장 흔한 실패는 '단어가 겹친다'를 '쟁점이 같다'로 착각하는 것이다. 확신이 없으면 0이다.
후보에 없으면 아무것도 고르지 않는다 — 없는 사건번호를 만들지 않는다.`;

/**
 * @param ask  파이프라인의 구조화 호출 함수 (재시도·failover 를 이미 갖고 있다)
 */
export async function rerankCases(
    question: string,
    candidates: CaseHit[],
    ask: <T>(schema: unknown, opts: { name: string; description: string; system: string; user: string }) => Promise<T>,
): Promise<CaseHit[]> {
    if (!candidates.length) return [];

    const user = [
        `## 쟁점\n${question}`,
        '',
        '## 후보 판례',
        ...candidates.map(
            (c, i) =>
                `${i + 1}. ${c.caseNo} | ${c.court} ${c.date} | ${c.name}\n   판시사항: ${c.summary.slice(0, 300)}`,
        ),
        '',
        '이 중 쟁점을 실제로 다루는 것을 고른다. relevance 2 를 우선하고, 1 은 보조로 최대 2건.',
    ].join('\n');

    try {
        const out = await ask<{ picks: Pick[] }>(CasePickList, {
            name: 'case_rerank',
            description: '후보 판례 중 쟁점을 실제로 다루는 것을 고른다',
            system: SYSTEM,
            user,
        });
        const byNo = new Map(candidates.map((c) => [c.caseNo.replace(/\s+/g, ''), c]));
        const picked: CaseHit[] = [];
        for (const p of out.picks ?? []) {
            if (p.relevance < 1) continue;
            const hit = byNo.get(String(p.caseNo).replace(/\s+/g, ''));
            if (hit && !picked.some((x) => x.caseNo === hit.caseNo)) picked.push(hit);
        }
        // relevance 순서를 보존한다 (2 먼저).
        const rank = new Map((out.picks ?? []).map((p) => [p.caseNo, p.relevance]));
        picked.sort((a, b) => (rank.get(b.caseNo) ?? 0) - (rank.get(a.caseNo) ?? 0));
        return picked.slice(0, 3);
    } catch {
        // 리랭커가 죽으면 규칙 점수 상위만 남긴다 — 조사를 통째로 잃는 것보다 낫다.
        return candidates.slice(0, 2);
    }
}

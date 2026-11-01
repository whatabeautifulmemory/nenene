// 인용 검증기 자체를 시험한다. 파이프라인을 돌리지 않고도 게이트가 실제로 갈라지는지 본다.
//
// 여기서 확인하려는 것은 하나다: **검증기가 침묵하지 않는가.** 모든 인용에 verified 를 돌려주는
// 검증기는 검증기가 아니다. 없는 판례·없는 조문·틀린 선고일이 각각 다른 상태로 떨어져야 하고,
// 그 셋이 하나로 뭉개지지 않아야 한다.
import { verifyAuthority } from '../src/law/verify.ts';
import type { Authority } from '../src/schemas.ts';

const CASES: { why: string; a: Authority; expect: string }[] = [
    {
        why: '정상 조문 — 통과해야 한다',
        a: { type: 'statute', citation: '형사소송법 제215조', holding: '' },
        expect: 'verified',
    },
    {
        why: '없는 조문 — 통과하면 안 된다',
        a: { type: 'statute', citation: '형사소송법 제9999조', holding: '' },
        expect: 'article_missing',
    },
    {
        why: '헌법 조문 — 별칭 해석이 필요하다',
        a: { type: 'statute', citation: '대한민국헌법 제12조', holding: '' },
        expect: 'verified',
    },
    {
        why: '조문 생략 표기 — 제106조제3항',
        a: { type: 'statute', citation: '형사소송법 제106조제3항', holding: '' },
        expect: 'verified',
    },
    {
        why: '정상 판례',
        a: { type: 'precedent', citation: '대법원 2022. 6. 30. 선고 2022도1452 판결', holding: '' },
        expect: 'verified',
    },
    {
        why: '실재하는 판례, 틀린 선고일 — 없는 판례와 구별되어야 한다',
        a: { type: 'precedent', citation: '대법원 2022. 7. 1. 선고 2022도1452 판결', holding: '' },
        expect: 'date_mismatch',
    },
    {
        why: '없는 판례 — 지어낸 사건번호',
        a: { type: 'precedent', citation: '대법원 2023. 3. 15. 선고 2023도9999 판결', holding: '' },
        expect: 'not_found',
    },
    {
        why: '학설 — 코퍼스가 없으므로 통과가 아니라 "검증불가"',
        a: { type: 'scholarship', citation: '신동운, 형사소송법, 2020, 402면', holding: '' },
        expect: 'unverifiable',
    },
];

let failed = 0;
for (const { why, a, expect } of CASES) {
    const got = verifyAuthority(a);
    const ok = got.state === expect;
    if (!ok) failed++;
    console.log(`${ok ? '✓' : '✗'} ${a.citation}`);
    console.log(`    기대 ${expect} / 실제 ${got.state}  — ${why}`);
    if (got.note) console.log(`    ${got.note.slice(0, 160)}`);
}
console.log(`\n${CASES.length - failed}/${CASES.length} 통과`);
process.exit(failed ? 1 : 0);

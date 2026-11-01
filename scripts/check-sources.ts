// 원문 확보 사다리를 시험한다. 특히 **다른 논문을 읽지 않는지**.
//
// 이 검사가 존재하는 이유: 첫 구현이 arXiv 검색 결과의 첫 항목을 그대로 집어, "Attention Is All
// You Need" 로 검색했을 때 "Tool Attention Is All You Need: …" 라는 다른 논문의 PDF 62,000자를
// full_text 로 받아 왔다. 상태만 보면 완벽한 성공이었고, 내용은 다른 논문이었다.
//
//   npx tsx scripts/check-sources.ts            오프라인 검사 + 가능하면 네트워크
//   npx tsx scripts/check-sources.ts --offline  오프라인만
import { acquireSource, titleScore } from '../src/law/sources.ts';

let failed = 0;
const ok = (cond: boolean, label: string, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
};

// ---- 1. 제목 대조 (네트워크 불필요) ----------------------------------------------
const S = titleScore;
ok(S('Attention Is All You Need', 'Attention Is All You Need') === 1, '정확히 같은 제목 = 1.0');
ok(
    S('Attention Is All You Need', 'Tool Attention Is All You Need: Dynamic Tool Gating and Lazy Schema Loading') === 0,
    '부분집합 제목은 거부 — 이것이 다른 논문을 읽던 버그다',
);
ok(S('원격 압수수색의 법적 성격', '원격 압수수색의 법적 성격: 대법원 2022도1452 판결을 소재로') >= 0.8, '한국어 부제 붙은 제목은 허용');
ok(S('Attention Is All You Need', 'Attention Is All You Need (Revised)') >= 0.8, '괄호 부기 정도는 허용');

// ---- 2. 법령·판례는 로컬에서 결정적으로 ------------------------------------------
const statute = await acquireSource({ type: 'statute', citation: '형사소송법 제215조', holding: '' });
ok(statute.state === 'full_text', '법령 조문 → 전문', `${statute.state} ${statute.chars ?? 0}자`);

const precedent = await acquireSource({ type: 'precedent', citation: '대법원 2022. 6. 30. 선고 2022도1452 판결', holding: '' });
ok(precedent.state === 'full_text', '판례 → 전문', `${precedent.state} ${precedent.chars ?? 0}자`);

const fake = await acquireSource({ type: 'precedent', citation: '대법원 2023. 3. 15. 선고 2023도9999 판결', holding: '' });
ok(fake.state === 'not_found', '없는 판례 → not_found (통과시키면 안 된다)', fake.state);

// ---- 3. arXiv 오선택 방지 (네트워크) ---------------------------------------------
if (process.argv.includes('--offline')) {
    console.log('\n(--offline: arXiv/OpenAlex 검사 생략)');
} else {
    try {
        const byTitle = await acquireSource({
            type: 'scholarship',
            citation: 'Vaswani et al., "Attention Is All You Need", NeurIPS 2017',
            holding: '',
        });
        const rightPaper =
            byTitle.state === 'full_text' && (byTitle.url ?? '').includes('1706.03762');
        ok(rightPaper, 'arXiv 제목 검색이 올바른 논문을 고른다', `${byTitle.state} ${byTitle.url ?? ''}`);
        ok(!(byTitle.url ?? '').includes('2604.21816'), '다른 논문(2604.21816)을 집지 않는다', byTitle.url ?? '');
    } catch (e) {
        console.log(`- arXiv 검사 건너뜀 (네트워크): ${String(e).slice(0, 80)}`);
    }

    try {
        const paywalled = await acquireSource({
            type: 'comparative',
            citation: '10.1002/9781119053385.ch15',
            holding: '',
        });
        ok(paywalled.state !== 'full_text', '페이월 장(chapter)은 전문으로 취급하지 않는다', paywalled.state);
    } catch (e) {
        console.log(`- OpenAlex 검사 건너뜀 (네트워크): ${String(e).slice(0, 80)}`);
    }
}

console.log(failed ? `\n${failed}건 실패` : '\n전부 통과');
process.exit(failed ? 1 : 0);

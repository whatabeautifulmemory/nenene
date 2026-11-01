// 테스트셋 전처리 v3 — PDF 묶음에서 중복을 제거하고, 시험 입력(마크업)을 만든다.
//
//   1) 같은 논문/같은 주제의 중복을 찾아 **분량이 많은 쪽**을 남긴다.
//   2) 제목(부제 제외)을 뽑고, 초록에서 **결과·결론을 제외한 배경·검토 항목**만 남긴다.
//   3) 참고문헌만 뽑는다.
//   4) 파이프라인이 바로 먹을 수 있는 마크업(testset/papers/<id>/input.md)으로 저장한다.
//
// v2에서 고친 것: 제목은 파일명을 1차로 쓴다(저널 헤더 오염 제거). 초록은 layout·raw 두 추출을
// 모두 시도하고 길이 상한(2,500자)을 둔다. 참고문헌은 raw(비레이아웃) 텍스트의 마지막 절을 쓴다.
//
// v3에서 고친 것(정답지 결론이 입력에 새던 문제):
//   - 결과 표지에 규범 서술형(…해야 한다·되어야 한다·할 것이다·필요가 있다·판단된다·수 없다)과 영문 표지
//     (proposes·concludes·should·as a result)를 더했다. '결과'는 낱말로만 본다('분석결과물'은 배경이다).
//     "분석 결과," 같은 표지 뒤의 문장은 모두 결과로 본다(초록은 배경→방법→결과 순이다).
//   - 본문 결론 절 문장과 거의 같은 초록 문장(2-gram 80% 이상)은 표지가 없어도 입력에서 뺀다.
//     다 쓴 input.md를 정답지와 다시 대조해, 그래도 남은 편은 manifest에 표시하고 종료 코드 2로 끝낸다.
//   - 참고문헌 절은 영문 제목·로마자 저자·영문 초록 묶음 앞에서 끊는다(국문에서 지운 결과 문장의 번역이다).
//   - input.md 머리에 원 파일명(부제 포함)을 쓰지 않는다. 논문 ID는 --dir 를 절대경로로 바꿔 만든다(상대경로로 줘도 같은 ID).
//   - 원 논문 자신의 DOI·KCI ID·영문 제목(쪽머리·제목 묶음)·저자 약력을 참고문헌에서 지우고, 남으면 자기검사에 걸린다
//     (v2 실행에서 연구 단계는 입력에 남은 AFR의 DOI로 원 논문을 찾아왔다).
//   - 결과 거름이 배경까지 빼던 것을 줄였다: 연구 질문·범위 진술·동향 서술은 '사이' 규칙에서 빼고, 남의 말을 받는 꼴
//     ('필요하다는 주장')은 배경으로 둔다. '…위법하다고'·'…할 수 있을 것이다'·'제시함으로써'처럼 누구의 말인지에 따라 갈리는 꼴은
//     문장 첫머리의 주어·끝의 보고 동사·제안 문맥으로 가른다(RESULT_MARKS 위 설명). 원 논문의 로마자 저자도 meta.json 에 남긴다(누출 판정용).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name: string, fallback: string) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const SRC = argOf('--dir', process.env.TESTSET_DIR ?? path.resolve(process.cwd(), 'testset-pdfs'));
const OUT = argOf('--out', path.resolve(process.cwd(), 'testset'));

const PDFTOTEXT = ['/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext', 'pdftotext'];

function pdfText(file: string, layout: boolean): string | null {
    for (const bin of PDFTOTEXT) {
        try {
            return execFileSync(bin, [...(layout ? ['-layout'] : []), file, '-'], {
                maxBuffer: 80 * 1024 * 1024,
                encoding: 'utf8',
                timeout: 90_000,
            });
        } catch {
            /* 다음 후보 */
        }
    }
    return null;
}

const norm = (s: string) => s.replace(/\s+/g, '').replace(/[「」『』"“”'‘’<>《》〈〉.,:;?!·…\-–—()[\]]/g, '').toLowerCase();
const bigrams = (s: string) => {
    const t = norm(s);
    const out = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    return out;
};
const jac = (a: Set<string>, b: Set<string>) => {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
};

const sentences = (t: string) =>
    t
        .replace(/\s+/g, ' ')
        .split(/(?<=[.!?。])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 8);

/** 표지 줄의 장식(국❙문❙요❙약, 공백, 콜론)을 제거한 키. */
const headingKey = (line: string) => line.replace(/[\s❙|｜·ㆍ:：\[\]()<>《》]/g, '').replace(/[^가-힣A-Za-z0-9]/g, '').toLowerCase();

// 결과·결론 표지. 공백은 '\s*'(띄어 쓴 꼴)와 ''(공백 제거본) 두 가지로 바꿔 쓴다 — PDF 줄바꿈이 낱말 안에 공백을 넣어도 잡는다.
//
// 누구의 말인지에 따라 갈리는 꼴은 꼴만 보지 않고 문장 전체를 본다. 2차 조임은 '…하다고'·'…할 수 있을 것이다'·'제시함으로써'를
// 모두 배경으로 돌려 저자 자신의 유보형 결론("…위법하다고 할 수 있다", "…보장할 수 있을 것이다", 독일: "…개정안을 제시함으로써
// 이 글을 마무리하고자 한다")까지 입력에 남길 수 있었다(남은 안전망은 결론 절 80% 대조뿐이었다). 그래서:
//   - 남의 판단을 옮기는 꼴('…필요하다고'·'…위법하다고'·'…수 없다고'·'…다고 본다/주장한다/지적한다')은 2차처럼 결과 표지이고, 문장 첫머리의
//     주어가 남(판례는·대법원은·학설은·일부 학자들은 …)이거나 끝이 과거형 보고 동사('…다고 판시하였다')·의견 틀('…다는 지적이 있다')일 때만
//     남의 말(배경)이다(voiced 설명). 저자(본 연구·본고·필자·이하에서)가 나오면 결과다. 연구 질문("…볼 수 있는지 검토한다", "…위법한가?")과
//     범위 진술("…을 검토한다/살펴본다.")은 배경이다.
//   - 평가어 뒤의 '…다고 하겠다/할 수 있다/볼 수 있다/보인다/평가된다'는 저자의 유보형 결론이다 — 주어와 관계없이 결과다(연구 질문만 빼고).
//   - '…할 수 있을 것이다'는 제안의 효과·권고('…된다면'·도입·개선·개정·입법 …, '고려할 수 있을 것이다')일 때만 결과다 — 현재 상태의
//     가능성 서술(외국 ISP: "국내 서비스 제공자의 경우 수사기관은 … 확보할 수 있을 것이다")은 배경이다.
//   - '제시함으로써'·'제시하는'·'제시하고 있다'는 저자가 주어일 때만 결과다 — 딥페이크·판례·AI 수사기술이 주어면 배경이다.
// 조건은 앞보기로 RESULT 한 정규식 안에 넣는다(voiced) — 표지 단위 검사(re2·regress·flips)가 소스의 RESULT 를 그대로 쓴다.
const RESULT_MARKS = [
    '결론',
    // '결과'는 낱말로만 — '분석결과물'·'결과물'은 배경이다.
    '결과(?:(?![가-힣])|[는를로가와의에도만]|적으로)',
    // '…다고 밝혔다'(남의 판단을 옮기는 과거형 보고 동사)는 주어로 가른다(아래 voiced).
    '도출', '밝혀', '(?<![다라]고 )밝혔', '확인되었', '확인한', '확인하였다',
    // 남이 제시·제안한 것('제시되지만', '제안된')은 배경이다. '…을 제시함으로써', '제시하는 영장', '제시하고 있다'는 주어로 가른다(위).
    '제시(?!되|된|함으로써|하는|하고 있|한 바)', voiced('author', '제시(?:함으로써|하는|하고 있|한 바)'), '제언', '개선방안', '시사', '제안(?!된|되)',
    '분석한 결과', '검토한 결과', '검토하였다', '검토했다', '분석하였다', '분석했다', '고찰하였다',
    // 평가어 뒤의 '…다고'('위법하다고 판단하였다'·'필요하다고 본다')와 '…다고 보았다'는 주어로 가른다(위). '…다는 주장'은 배경이다.
    '이를 통해', '따라서', '결국', '요약하면', '(?<![다라]고 )보았다', '허용될 수 없다(?!는|고)', '초과한다', '위법하다(?!는|고)', '정당하다(?!는|고)', '타당하다(?!는|고)', '입증하였', '입증했',
    voiced('own', '(?:필요|위법|정당|타당|바람직)하다고|수 없다고|야 한다고|[다라]고 (?:본다|보았다|주장한다|주장하였다|지적한다|지적하였다|밝혔다)'),
    // 유보형은 평가어 뒤에서만 — '…를 의미한다고 할 수 있다'(수사 효율성 머리말의 정의)·'…뒤쳐졌다고 평가할 수 있다'(일본 머리말)는 배경이다.
    voiced('asked', '(?:(?:필요|위법|정당|타당|바람직)하|수 없|야 한)다고 (?:하겠다|할 수 있|볼 수 있|보인다|평가된다|평가할 수|판단된다|생각된다|사료된다|여겨진다)|(?:필요|위법|정당|타당|바람직)하다 하겠다'),
    // 규범 서술형 — 결론 문장은 대개 이 꼴로 끝난다(이뤄져야 한다, 형성되어야 한다, 아니라 할 것이다 …).
    // '…해야 한다는 개념', '…할 수 없다는 비판', '입법이 필요하다는 주장'처럼 남의 말을 받는 꼴은 배경이다.
    // '…필요가 있을 것이다'·'…라 할 것이다'·'바람직할 것이다'·'…로 볼 수 있을 것이다'(저자의 평가)는 그대로 결과다.
    '야 (?:한다(?!는|고)|할 것|하며|하고|함)', '[할될볼일줄] 것이다', '(?<!수 있)을 것이다', '(?:볼|평가할|판단할|이해할|해석할) 수 있을 것이다', voiced('proposal', '수 있을 것이다'),
    '필요가 있다', '필요성이 (?:있다|존재)', '필요하다(?!는|고)',
    '판단된다', '생각된다', '생각한다', '사료된다', '여겨진다', '해 보인다', '것으로 보인다', '바람직하다(?!는|고)', '요구된다',
    '기대된다', '기대한다', '희망한다', '전망된다', '기여할', '촉구', '드러났다', '나타났다', '알 수 있다', '볼 수 있다', '것일 수 있다', '수 없다(?!는|고)',
    '의미가 있다', '의의가 있다',
];
/**
 * 누구의 말인지에 따라 갈리는 표지 m 을 문장 전체의 앞보기로 감싼다(위 설명). 공백은 다른 표지처럼 RESULT·RESULT_FLAT 가 바꾼다.
 *   own      연구 질문이 아니고, 저자가 나오거나 남의 판단을 옮기는 꼴(첫머리 주어·과거형 보고 동사·의견 틀)이 아닐 때 결과
 *   asked    연구 질문·범위 진술이 아니면 결과(저자의 유보형 결론)
 *   author   저자가 주어일 때만 결과
 *   proposal 제안의 효과·조건·권고 문맥일 때만 결과
 * (함수 선언이라 RESULT_MARKS 보다 아래에 있어도 먼저 쓸 수 있다.)
 */
function voiced(when: 'own' | 'asked' | 'author' | 'proposal', m: string): string {
    const ANY = '[\\s\\S]*';
    // 남의 판단을 옮기는 문장은 아래 셋뿐이다(4차). 3차는 이름 있는 주어·출처 단서가 문장 **어디에든** 있으면 남의 말로 보아, 저자 자신의
    // 결론이 양보절("…다는 견해도 있으나, … 필요하다고 본다")·'…설이/견해가'("이 점에서 긍정설이 타당하다고 본다")·로마자 약칭 주제
    // ("GDPR은 … 필요하다고 본다")·사건번호("대법원 2017도9747 판결의 취지에 비추어 보면 …")와 함께 입력에 돌아왔다. 그래서 '…다고 본다'는
    // 2차처럼 그대로 결과 표지이고, 남의 말은 문장의 꼴로만 가른다:
    //   1) 첫 절의 주어가 남이다 — 문장 첫머리(첫 쉼표 앞, 꾸밈말 몇 자까지: '종래 판례는'·'미국 연방대법원은'·'일부 학자들은')의 판례·법원 이름·
    //      대상판결·동 결정·학설·학자·'X 교수는'·'X(2020)는'·사건번호를 단 판결. 앞에 담화 부사와 쉼표('한편, 판례는'·'한편, 이와 관련하여, 대법원은')는
    //      두 개까지 와도 된다(6·7차).
    //      로마자 이름('Kerr는')과 소송 당사자(검사·검찰·피고인·변호인·청구인 …)는 끝이 '주장한다·다투었다·항변하였다'처럼 말하는 동사일 때만이다 —
    //      약칭('GDPR은'·'CLOUD Act는')·서비스 이름('Telegram은 … 의무가 있다고 본다')은 저자가 평가하는 대상이고, '검사는 … 폐기하여야 한다고
    //      본다'·'검찰은 수사 관행을 개선하여야 한다고 본다'는 저자가 당사자에게 요구하는 말이다(5차는 당사자를, 6차까지는 검찰을 주어 목록에 넣어
    //      이 결론이 입력에 남았다 — 7차 R12).
    //      대조절(…으나·…하나·…지만·…는데·…음에도)이 있으면 뒷절은 저자의 말이다("학설은 이를 허용하나, … 필요하다고 본다"). 양보 조건(…더라도·…지라도)은
    //      옮기는 판단 안에 든 절이라 그렇지 않다("판례는 피의자가 동의하였더라도 영장 없는 압수는 위법하다고 본다" — 6차). 주어를 바로 평가하는 꼴
    //      ("이러한 견해는 타당하다고 본다")과 대상판결·이 판결·위 판결을 평가하고 '본다'로 끝나는 꼴("대상판결은 … 지나치게 좁게 해석하였다는 점에서
    //      타당하지 않다고 본다")도 저자의 말이다(평석의 결론). 다만 옮기는 판단에 제 주어(원심이·조항이·영장이·동의가)나 '원심(판결)에'가 있으면, 그 뒤의
    //      대조 어미·평가어는 옮기는 판단 안이다("판례는 영장이 발부되었음에도 이를 위법하다고 본다"·"해당 판결은 원심이 법리를 오해하였다고 본다" —
    //      7차 R9). '법원은·입법자는·정부는 …해야 한다고 본다'는 저자가 그 기관에 요구하는 말이라
    //      주어 목록에 넣지 않는다 — '(미국) 연방법원은'도 같다(6차: '미국 법원은 … 보았다'와 같게 결과로 본다).
    //   2) 끝의 본동사가 과거형 보고 동사다 — '…다고 판시하였다/판단하였다/주장하였다/밝혔다'(2차도 이 꼴은 배경이었다). '…다고 보았다'는
    //      2차처럼 결과다(1의 주어가 있을 때만 배경) — 초록은 저자의 결론을 과거형으로도 쓴다(클라우드: "… 보안 취약점 이용방안은 위법하다고 보았다").
    //   3) 끝이 남의 의견을 옮기는 틀이다 — '…다는 지적이 있다', '…다고 보는 견해가 있다'.
    // 저자(본 연구·본고·필자·이하에서)가 나오면 결과다. 관형격('판례의 태도는 타당하다고 하겠다')은 저자의 평가다.
    // 법원 이름 — 괄호 안 주어('독일 연방법원(BGH)은')는 이것만 본다. '이러한 해석(판례)은'의 '(판례)'는 풀이라 주어가 아니다(7차 R11).
    const COURT_NAME = '대법원|헌법재판소|헌재|연방대법원|연방헌법재판소|연방최고법원|유럽사법재판소|유럽인권재판소|BVerfG|BGH|CJEU|ECJ|ECtHR|EuGH';
    const COURT = `판례|대상 판결|(?:동|이|위|해당|본건) (?:판결|결정)|원심|원판결|하급심|항소심|제1심|${COURT_NAME}`;
    const OPINION = '학설|통설|(?:다수|소수|유력|반대|일부) (?:설|견해)|(?:긍정|부정|절충)설|견해|학자|논자|학계|선행 연구|기존 연구|종래의 연구';
    // 낱말 첫머리·끝 — 띄어 쓴 꼴은 앞뒤 글자로 본다. 공백을 지운 꼴은 경계가 없으므로 resultMarked 가 문장마다 띄어 쓴 문장의 낱말 첫머리 위치를
    // flatSlot() 자리에 넣는다 — 지운 꼴은 그 자리에서만 이름·안긴 주어를 찾는다(7차 R4). 6차는 지운 꼴의 이 조건을 아예 풀어, 긴 기관 이름의 끝 2~4음절
    // ('한국인터넷진흥원(2020)은'의 '흥원'·'국회입법조사처(2020)는'의 '조사처')까지 사람으로 보았다 — PDF 줄바꿈이 표지를 지운 꼴에만 남긴 문장
    // ('… 허용된다 고 본다')의 기관 주장이 배경에 남았다. 꾸밈말 뒤의 이름('또한 김철수 교수는'·'이에 대하여 김철수(2020)는')은 띄어 쓴 문장의
    // 낱말 첫머리라 그대로 이름이다.
    const FLAT_WS = `(?<=^${flatSlot()})`;
    const WS = `(?:(?<![가-힣])|${FLAT_WS})`;
    const WE = `(?:(?![가-힣])|${FLAT_WS})`;
    const INNER = `(?!${FLAT_WS})`;
    // 사람 이름만 — 한글 이름 2~4음절(낱말 첫머리에서 시작하고, 법령·문서 이름의 끝 — 법·령·규정·협약·지침·개정안·보고서·위원회·매뉴얼·조례 … — 으로
    // 끝나지 않는다) 또는 로마자 이름. 5차의 '[가-힣A-Za-z]+(연도)'는 'CLOUD Act(2018)는'·'GDPR(2016)은'·'형사소송법(2011)은'·
    // '개정 통신비밀보호법(2020)은'까지 남의 말 주어로 보아 그 문장의 저자 결론(…필요하다고 본다)을 입력에 남겼다(6차).
    // 로마자 이름은 성 하나, 또는 앞에 이름·머리글자 둘까지('Orin Kerr'·'Orin S. Kerr'·'Daniel J. Solove'), 성 안 대문자('LaFave'·'McCarthy'),
    // 성 앞 소문자 앞붙이('de Hert'·'van der Sloot'·'von Hirsch'), and/& 로 이은 두 사람('Kerr and Schmitt')이다. 사슬의 어느 낱말이든 단체·문서
    // 낱말(ORG — Foundation·Board·Manual·Center·Watch·Corporation …, 법령 낱말 Act·Law·Commission …)이면 사람이 아니고, 로마자·숫자 바로 뒤에서 시작하지 않는다
    // (6차의 '이름 + 성'은 'Electronic Frontier Foundation(2019)은'·'Tallinn Manual(2017)은'까지 사람으로 보았다 — 7차 R2). 한 낱말 서비스 이름
    // ('Telegram(2013)은')·두 낱말 'Google Spain(2014)은'은 꼴로 가를 수 없어 사람으로 남는다(TESTSET.md 남은 오판).
    // 한글 '외'는 '외 2인'까지('김철수 외 2인(2020)은'). 연도 괄호에는 쪽이 붙어도 된다('김철수(2020: 15)는'·'(2020, 15면)'·'(2020, p. 15)' — 7차 R3).
    const ORG =
        'Foundation|Board|Party|Working|Conference|Center|Centre|Watch|International|Corporation|Inc|Ltd|LLC|GmbH|Co|Company|Union|Manual|Institute|' +
        'Association|Council|Agency|Office|Group|Court|Commission|Committee|Society|Network|Coalition|Organi[sz]ation|Department|Ministry|Authority|' +
        'Initiative|Project|Forum|Alliance|Federation|Bureau|Service|University|College|School|Labs?|Protection|Rights|Data|Privacy|Electronic|' +
        'Telecommunication|European|Human|Act|Law|Code|Regulation|Rules?|Treaty|Convention|Agreement|Protocol|Directive|Guidelines?|Principles?|' +
        'Charter|Declaration|Recommendation|Decision|Judgment|Bill|Amendment|Report|Constitution';
    // 로마자 글자에는 라틴-1 보충·확장-A 의 발음 구별 글자도 든다('Müller'·'Pérez'·'Jürgen' — 성 하나 그대로 R2 의 사람이다). 7차 첫
    // 수정까지는 [A-Z][a-z] 만 보아 이 성을 사람으로 못 보고 그 보고를 뺐다.
    const LU = 'A-ZÀ-ÖØ-Þ\\u0100-\\u017f', LL = 'a-zß-öø-ÿ\\u0100-\\u017f';
    const LWORD = `[${LU}][${LL}]+(?:[${LU}][${LL}]+)?`;
    const LPERSON = `(?:(?:${LWORD}|[A-Z]\\.) ){0,2}(?:(?:de|van|von|der|den|del|della|di|da|du|le|la) ){0,2}${LWORD}`;
    const NAME =
        `${WS}[가-힣]{2,4}(?<!법|령|률|규정|규칙|예규|고시|조약|협약|협정|의정서|지침|원칙|헌장|선언|권고|결정|판결|법안|개정안|시안|보고서|백서|위원회|` +
        '매뉴얼|지침서|조례|규약|정부안|권고안)' +
        `|(?<![${LU}${LL}0-9]\\s?)(?![${LU}${LL}.& ]*?(?:${ORG})(?![${LL}]))${LPERSON}(?: (?:and|&) ${LPERSON})?`;
    const YEAR = '\\(\\d{4}[a-z]?(?:[:,] (?:pp?\\. )?\\d+(?:[-–]\\d+)?(?:면|쪽)?)?\\)';
    const PERSON = `(?:${NAME}) 교수|(?:${NAME})(?: (?:외(?: \\d+[인명])?|등|et al\\.))? ${YEAR}`;
    // 끝 — 마침표·각주 번호("…하였다.12)")까지.
    const END = '[.。]?(?:\\s?\\d{1,3}\\))?[.。]? $';
    // 말하는 동사로 끝나는 문장 — 로마자 이름·소송 당사자는 이때만 남의 말 주어다(위 1). '다투다'는 '…하다' 꼴이 아니라 활용형을 따로 적는다(7차 R12).
    const SAYS =
        `(?=${ANY}(?:(?:주장|지적|설명|강조|비판|항변|반박|요구)(?:한다|하였다|했다|하고 있다)|다(?:툰다|투었다|퉜다|투고 있다))${END})`;
    const LATIN = `(?<![${LU}${LL}]\\s?)[${LU}][${LL}]+(?: [${LU}][${LL}]+)?(?:\\s?\\([^)]*\\))?(?:은|는|도)${SAYS}`;
    // 당사자 — 복수(들)와 '검사 측'·'피고인 A' 같은 딸린 낱말 하나까지(7차 R12). 딸린 낱말은 띄어 쓴 다음 낱말이다(공백을 지운 꼴은 flatSlot() 자리).
    const PARTY =
        `(?:검사|검찰|피고인|변호인|피청구인|청구인|원고|피고|신청인)들?(?:(?:\\s|${FLAT_WS})(?:측|[A-Z가-힣]{1,3}))?(?:은|는|도)${SAYS}`;
    // 주어 앞의 담화 부사 + 쉼표 — 쉼표지만 절의 경계가 아니다(5차는 '한편, 판례는 …'의 주어를 못 보아 배경을 뺐다). 절이 될 수 없는 부사만
    // 적는다 — 6차 지시의 다섯 개에 '반면,'·'특히,'·'즉,'·'예컨대,'·'먼저,'·'우선,'·'물론,' 같은 같은 부류를 더했다. 7차 R10: 두 개까지
    // ('한편, 이와 관련하여, 대법원은'), '한편으로,'·'다른 한편으로,'. 목록 밖('이에,'·'그러므로,')은 절의 경계로 본다.
    const LEAD =
        '(?:(?:한편(?:으로)?|다른 한편으로|이와 관련하여|이에 대하여|이에 관하여|다만|또한|그런데|그러나|나아가|아울러|' +
        '반면에?|특히|즉|예컨대|예를 들어|먼저|우선|물론|하지만|그렇지만|그리고|더욱이|게다가|이처럼|실제로)[,，] ){0,2}';
    // 일반 이름 뒤 괄호의 법원 이름도 주어다 — '독일 연방법원(BGH)은'·'독일 연방법원(BGH 2007. 1. 31.)은'(Q7·7차 R7). 괄호 안이 법원 이름이 아니면
    // ('이러한 해석(판례)은'·'제한적 허용설(판례)은') 괄호 없는 꼴과 같다(7차 R11). 법원 이름 뒤에는 날짜(연도·연월일, 앞 쉼표 하나)만 붙는다 — 7차 첫
    // 수정은 아무 글이나 받아 평석의 판결 인용('대상결정(헌법재판소 2018. 6. 28. 선고 2012헌마191 결정)은'·'본 판결(대법원 2021도11170)은')까지
    // 남의 말 주어로 보았고, 그 평가('… 타당하다고 본다')가 입력에 남았다(6차는 뺐다).
    const COURT_PAREN = `\\((?:${COURT_NAME})(?:,? \\d{4}(?:\\.(?: \\d{1,2}\\.?){0,2})?)?\\)`;
    const SUBJECT =
        `^${LEAD}(?:(?:[^,，]{0,12}?(?:${COURT}|${OPINION}|${PERSON}|${COURT_PAREN})(?:\\s?\\([^)]*\\))?들?` +
        `|[^,，]{0,30}?\\d{2,4} (?:도|다|두|누|마|헌[가-힣]) \\d{2,}[^,，]{0,12}?(?:판결|결정))(?:은|는|도|에서는|에서도)|[^,，]{0,12}?(?:${LATIN}|${PARTY}))` +
        '(?! (?:타당|부당|정당|적절|바람직)하(?:지 않)?다고)';
    // 안긴 주어 — 옮기는 판단 안의 주격 명사(받침 있는 음절 뒤 '이', 받침 없는 음절 뒤 '가': 원심이·조항이·영장이·동의가)나 '원심(판결)에'. 이 단서부터
    // 그 판단을 맺는 '…다고/라고/다는/라는' 까지(EMBED)의 대조 어미·평가어는 옮기는 판단 안이다(7차 R9). 평가어 명사(타당성·부당성·정당성·설득력·잘못·오해 + 이/가)와
    // 부사·명사(없이·같이·많이·나아가·추가 …)는 단서가 아니다. 단서가 없으면 6차 규칙 그대로다(대조절·평가어는 저자의 말).
    // '-이' 부사는 끝으로 본다 — '…없이'·'…같이'로 끝나는 합성 부사(관계없이·끊임없이·예외없이·한결같이·똑같이)와 깨끗이·뚜렷이·일일이·낱낱이 …
    // 7차 첫 수정은 낱말 통째(없이·같이 …)만 빼서 '판례는 한결같이 이를 허용하지 않지만 학설은 …'의 '한결같이'를 주격으로 읽어 p1-k23 의 대조절을
    // 옮기는 판단 안에 숨겼다(R9 의 단서는 주격 명사뿐이다).
    const NB = Array.from({ length: 19 * 21 }, (_, i) => String.fromCharCode(0xac00 + i * 28)).join('');
    const ADV_I = '없|같|많|깊|높|굳|일찍|깨끗|뚜렷|버젓|반듯|따뜻|느긋|지긋|깊숙|끔찍|더욱|일일|낱낱|샅샅|틈틈|번번|곳곳|겹겹|다달|나날|줄줄';
    const CUE =
        `${WS}(?:원심(?:판결)?에|(?!(?:나아|추|대|부)가${WE})[가-힣](?:${INNER}[가-힣])*?` +
        `(?<!타당성|부당성|정당성|설득력|잘못|오해)${INNER}(?:(?<![${NB}])(?<!${ADV_I})이|(?<=[${NB}])가))${WE}`;
    const EMBED = `${CUE}[\\s\\S]*?[다라](?:고|는)${WE}`;
    const OPEN = `(?:${EMBED}|(?!${CUE})[\\s\\S])`;
    // 평석의 저자 결론 — 대상판결·이 판결·위 판결이 주어이고 평가어(타당·부당·오해·지나치게·잘못·설득력)가 있으며 '본다'로 끝난다. 5차의 가드는
    // 주어 바로 뒤의 평가어만 보아 "대상판결은 이 점에서 타당하다고 본다"·"이 판결은 … 오해한 것이라고 본다"를 남의 말로 보았다(6차).
    // 평석 대상을 가리키는 COURT 의 다른 이름(동·해당·본건 판결, 동·이·위 결정 — 5차 P1 이 대상판결에 견주어 함께 넣은 것)도 같다. 주어 뒤 괄호
    // ('대상판결(2021도11170)은'·'이 판결(대상판결)은')는 SUBJECT 처럼 건너뛰고(7차 R8), 안긴 주어 뒤의 평가어는 세지 않는다(위 EMBED).
    const JUDGED =
        `^${LEAD}[^,，]{0,12}?(?:대상 판결|(?:동|이|위|해당|본건) (?:판결|결정))(?:\\s?\\([^)]*\\))?(?:은|는)` +
        `(?=${OPEN}*?(?:타당|부당|오해|지나치게|잘못|설득력)${ANY}본다${END})`;
    // 대조 — 쉼표나 띄어쓰기가 뒤따를 때만('하나의'·'…요청이나 …'는 아니다). 양보 조건(…더라도·…지라도)은 넣지 않는다(위 1).
    // 옮기는 판단을 맺은 '…다고/라고' 뒤의 '보나'(보다 + -나 — 하나·되나와 같은 어미)도 대조다: "판례는 수사기관이 … 교부하지 않았음에도 압수를
    // 적법하다고 보나, 이는 타당하지 않다고 본다". 6차는 '…음에도'로 뺐고, R9 가 안긴 '…음에도'를 옮기는 판단 안으로 돌리자 입력에 남았다.
    // '…다고' 바로 뒤만 본다 — '개인정보나'의 조사 '나'는 아니다.
    const CONCESSIVE = '(?:으나|하나|되나|(?<=[다라]고 )보나|지만|는데|음에도)(?:[,，]|\\s)';
    const REPORT_END = '[다라]고 (?:(?:판시|판단|결정|설시|선언|인정|지적|주장)(?:하였다|했다|한 바 있다)|밝혔다)';
    // 의견 틀 — 이름 뒤의 괄호("…다고 보는 견해(긍정설)가 있다")와 PDF 각주 번호("…견해5)가 있다")는 건너뛴다(2차는 배경, 5차는 결과로 뺐다).
    // 복수('견해들이')와 괄호·각주 번호 여럿('견해5)6)가'·'견해(긍정설)5)가')도 같다(7차 R7).
    const FRAME_END =
        '(?:[다라]고 보는|[다라]고 하는|[다라]는) (?:견해|지적|비판|주장|입장|의견|우려|시각)들?(?:\\s?(?:\\([^)]*\\)|\\d{1,3}\\)))*(?:이|가|도)? ' +
        '(?:있다|있어 왔다|있었다|제기된다|제기되어 왔다|제기되고 있다|많다|유력하다|존재한다)';
    const REPORTED = `(?:(?!${JUDGED})${SUBJECT}(?!${OPEN}*?${CONCESSIVE})|${ANY}(?:${REPORT_END}|${FRAME_END})${END})`;
    const AUTHOR = '본 연구|본 논문|(?<![가-힣])본 고(?=[는에가의를서])|이 글|이 논문|필자|이하에서';
    // 연구 질문 — 물음표·'…는가/인가/것인가.'로 끝나는 문장, 끝 절의 '…인지/는지/할지 여부'·'…인지(를) 검토/살펴/논의/분석'
    // ('…볼 수 있는지에 대해서는 논란이 있다'까지). 3차의 '[는은한할인]지'는 아무 데나 걸려 '할지라도'·'인지한'·'…는지와 관계없이'·
    // "…허용되는지 의문이며, … 필요하다고 본다"의 저자 결론까지 질문으로 보았다 — 질문 뒤에 절이 이어지면(쉼표·…으나·…이며) 질문이 아니다.
    // 현재형 범위 진술(…을 검토한다·살펴본다.)도 배경이다.
    // ('…인지 여부와 관계없이'처럼 여부 뒤가 질문의 술어가 아니면 질문이 아니다.)
    // 질문 술어에는 학설 대립("…볼 수 있는지에 대하여는 견해가 대립한다"·"…긍정설과 부정설이 대립한다")과 범위 진술("…볼 수 있는지를 중심으로
    // 논의를 전개한다")도 든다 — 5차는 이 배경 문장을 뺐다(6차). 같은 학설 대립의 흔한 변형('…를 둘러싸고 견해가 대립한다'·'다양한 견해가'·
    // '학설은 긍정설과 부정설로 나뉜다'·'견해가 일치하지 않는다')도 질문 술어다(4차까지 배경, 5차와 6차 첫 수정은 뺐다).
    // 7차 R6: 이름꼴('견해의 대립이 있다'·'긍정설과 부정설의 대립이 존재한다')·셋 이상 나열('긍정설, 부정설, 절충설이'·'… 및 절충설이')·
    // '(학설상) 다툼이 있다'·'첨예하게 대립한다'·'견해들이'·'…를 둘러싼 논의가 계속되고(이어지고) 있다'도 같다(4·5차·2차 배경, 6차는 뺐다).
    // 술어의 '있·존재·계속되고 있'은 앞보기로만 본다 — 뒤의 '…있어 입법이 요청된다'(이유절)를 아래 AFTER_ASKED 가 그대로 본다.
    const SPLIT = '[가-힣]{0,4}설(?:(?:[,，]| 및|[과와]) [가-힣]{0,4}설)+';
    const VIEW = `(?:견해|학설|입장|의견|${SPLIT})들?`;
    const ASKED_AT =
        '[인는할은한]지 (?:여부 )?(?:를(?: 둘러싸고| 두고)?|가|는|도|에 (?:대해|대하여|관해|관하여|관한)(?:서)?(?:는|도)?)? ' +
        `(?:검토|살펴|논의|분석|고찰|규명|조명|문제|논란|쟁점|(?:[가-힣]{1,5} ){0,2}(?:${VIEW}(?:이|가|은|는)? ` +
        `(?:${SPLIT}로 )?(?:첨예하게 )?(?:대립|나뉘|나뉜|갈리|갈린|일치하지 (?:않|아니))|(?:${VIEW}|[가-힣]{1,4}설)의 대립이 (?=있|존재)|(?:학설상 )?다툼이 (?=있))` +
        '|중심으로 (?:논의|검토|살펴|분석|고찰)|둘러싼 논의가 (?=(?:(?:계속|진행)되|이어지)고 있))' +
        '|[인는할은한]지 여부(?:이다|다)?[.?？]? $';
    // 질문 뒤의 절 — 쉼표·이어 주는 어미, 이유절(…있어·…되어·…하여·…기 때문에·…므로, 같은 부류의 …있기에·…있으니·…는 만큼·…때문에 —
    // '…있어 왔다'의 보조용언은 아니다), 그리고 저자 결론을 옮기는 '…다고/라고'. 5차는 이유절을 몰라 "…볼 수 있는지 논란이 있어 입법적 해결이
    // 필요하다고 본다"·"…인지에 관한 논의가 필요하다고 본다"의 저자 결론을 질문으로 보았다(6차). '…위하여·대하여·관하여·통하여·의하여'는
    // 이유절이 아니다. 질문 술어 자체를 옮겨 말을 맺는 '…문제된다고 할 수 있다'·'…논란이 있다고 한다/하겠다'(2·4·5차 모두 배경 — 2차도 이 꼴만
    // 남기고 '…문제된다고 본다'는 뺐다)와 진행형 '…대립하고 있다'·'…검토하고 있다'(4차까지 배경)는 절이 아니다 — 6차 첫 수정의 '…다고 '·
    // '…하고 '는 이 배경까지 뺐다. 다만 평가어를 옮기는 '…필요하다고 할 수 있다'는 그대로 저자의 유보형 결론이다(결과 표지 asked 와 같다).
    // 보조용언은 다음 낱말 전체로 본다 — 첫 음절만 보면 '…있어 보완 입법이'·'…되어 오히려'·'…있어 가급적'의 보완·오히려·가급적까지
    // 보조용언으로 읽어 저자 결론을 질문으로 남겼다. 현재형 '…하여 본다'·'…있어 온다'·'…되어 간다'도 보조용언이다(4·5차 배경).
    // 7차 R1: 보조용언은 활용형을 통째로 적은 닫힌 목록이다(보도록·보겠다·보려·보자·두도록 …). 6차 후속은 둘째 음절 목록이라 '…하여 보도록 한다'를
    // 이유절로 읽어 범위 진술을 뺐고, 맨 낱말 '본·둘'(관형사·수사 — '…있어 본 조항의')과 '주어진·주기적·보이스피싱·오는'을 보조용언으로 읽어
    // 저자 결론을 질문으로 남겼다. 다른 낱말이 그 음절로 시작하지 않는 활용 줄기(왔·봤·갔·있·보았·보였 …)는 낱말 끝까지 받는다. 기본형
    // '보다·두다 …'는 문장 끝에서만이다 — '…있어 보다 명확한 입법이'의 '보다'는 부사다. '보여'는 R1 목록에도 6차의 '보이-' 꼴에도 없다 —
    // '…논란이 있어 보여 입법적 해결이 요청된다'의 '보여'는 그 자체가 이유를 잇는 말이다(6차처럼 결과).
    const AUX =
        '(?:(?:왔|봤|줬|갔|뒀|냈|있|버리|버린|버렸|보았|보였|두었|주었|놓았)[가-힣]*' +
        '|(?:본다|보겠다|보도록|보려고?|보자|보기로|보고자|보면|보아야|봐야|봄|보이다|보인다|보인|보일|보임|보이는|보이며|보이고|' +
        '둔다|두겠다|두도록|두고자|두기로|두어야|둬야|준다|주겠다|주도록|주어야|줘야|간다|가겠다|온다|오겠다|와서|와야|와|낸다|놓는다|놓겠다)(?![가-힣])' +
        `|(?:보|두|주|가|오)고 있|(?:보|두|주|가|오|내|놓)다${END})`;
    // 7차 R5: 질문 술어를 옮겨 맺는 '…다고/라고 할 수 있다·한다·하겠다'는 문장의 끝 술어일 때만 절이 아니다 — '…다고 한다면'·'…다고 한다는'·
    // '…다고 하여'는 절이다. 끝 술어 뒤의 인용 괄호('…문제된다고 한다(대법원 … 판결 참조).')와 마침표 앞 공백('…있다고 한다 .')은 끝 술어를
    // 바꾸지 않는다(6차 배경 — 7차 첫 수정은 END 만 보아 뺐다).
    // R13: 이유 어미 -아(많아·않아·같아·달라)와 '…는 까닭에'·'…는바/은바'도 이유절이다. -(으)ㄴ바·-ㄴ 까닭에는 모음 줄기·'이다' 뒤에서
    // '…된바'·'…쟁점인바'·'…쟁점인 까닭에'로도 쓴다(같은 어미). '…한바/된바 있다'는 '…한 바 있다'(경험)를 붙여 쓴 꼴이라 이유절이 아니다.
    // '되어'의 준말 '돼'도 '되어'와 같다('…논란이 계속돼 입법적 해결이 요청된다').
    const AFTER_ASKED =
        '[,，]|(?:으나|지만|이며|으며|하며|므로|는데|때문에|(?:있|없|되)기에|(?:으|되|이)니(?:까)?|[는은된한] 만큼|[는은인된한] 까닭에|' +
        '[는은인된한]바(?=\\s(?!있))|' +
        `(?:(?:필요|위법|정당|타당|바람직)하|수 없|야 한)다고)\\s|[다라]고\\s(?!(?:할 수 있다|한다|하겠다)(?:\\s?\\([^)]*\\))?\\s?${END})|하고\\s(?!있)` +
        `|(?:있어|되어|돼|많아|않아|같아|달라|(?<![위대관통의])하여)서?\\s(?!${AUX})`;
    const QUESTION =
        `[?？] $|[는인]가[.?？]*$|(?:${ASKED_AT})(?!${ANY}(?:${AFTER_ASKED}))` +
        '|(?:검토|분석|고찰|살펴|조명|규명|논의)(?:한다|하고자 한다|해 본다|본다)\\. $';
    const PROPOSAL = '[다하되]면|도입|개선|개정|입법|신설|마련|정비|명문화|제도화|(?:고려|검토|모색)할 수';
    const notAsked = `^(?!${ANY}(?:${QUESTION}))`;
    if (when === 'own') return `${notAsked}(?:(?=${ANY}(?:${AUTHOR}))|(?!${REPORTED}))${ANY}(?:${m})`;
    if (when === 'asked') return `${notAsked}${ANY}(?:${m})`;
    return `^(?=${ANY}(?:${when === 'author' ? AUTHOR : PROPOSAL}))${ANY}(?:${m})`;
}
/**
 * 공백을 지운 꼴(RESULT_FLAT)의 낱말 첫머리 자리 — 지운 꼴은 낱말 경계를 잃으므로 voiced 의 낱말 첫머리 조건(FLAT_WS)에 이 자리를 두고,
 * resultMarked 가 문장마다 띄어 쓴 문장의 낱말 첫머리 위치로 바꿔 끼운다(7차 R4). 바꾸지 않은 RESULT·RESULT_FLAT 에서는 늘 거짓이다
 * (사용 영역 문자 U+E000 은 본문에 없다). 함수 선언이라 RESULT_MARKS 를 만들 때(voiced) 이미 쓸 수 있다.
 */
function flatSlot(): string {
    return '\uE000';
}
const RESULT = new RegExp(RESULT_MARKS.map((m) => m.replace(/ /g, '\\s*')).join('|'));
const RESULT_FLAT = new RegExp(RESULT_MARKS.map((m) => m.replace(/ /g, '')).join('|'));
// 영문 초록(국문 초록이 없는 논문)의 결과 표지.
const RESULT_EN =
    /\b(?:propos(?:e|es|ed|ing)|conclu(?:de|des|ded|sion)|should|must|recommend\w*|suggest(?:s|ed)?|argu(?:e|es|ed)|as a result|results? (?:show|indicate|suggest)|finds|found that|findings|shows? that|showed|demonstrat\w*|reveal\w*|therefore|thus|hence|consequently|implications?|meaningful|contribut\w*)\b/i;
// 결과 구역의 시작 — 이 표지가 나온 문장부터 끝까지는 모두 결과다("분석 결과, …" 뒤의 문장은 표지 없이 결과를 잇는다).
const RESULT_START =
    /(?:분석|검토|연구|조사|고찰|비교)\s*결과(?:\s*[,，]|\s+(?![를을의에로]))|그\s*결과\s*[,，]|결론적으로|요컨대|결론에서는|\bas a result\b|\bthe results?\b|\bin conclusion\b|\bthis (?:paper|study|article) (?:finds|found|concludes|shows|reveals)\b|\bwe (?:find|found|conclude)\b/i;
const ISSUE = /검토|쟁점|문제|분석|고찰|살펴|규명|다루|대상으로|범위/;
// '사이' 규칙의 예외 — 물음표로 끝나는 연구 질문, "본고는 … 한다/본다" 꼴의 현재형 범위 진술, "최근 …"으로 여는 동향 서술.
// ('한편'·'그런데'는 넣지 않는다 — 결과 문단 안의 전환이기도 하다. 수사 효율성: "한편, … 기본권을 제한할 수밖에 없다"는 결론 절 문장이다.)
const BETWEEN_BG = /[?？]\s*$|^최근\s|(?:본\s*고|본\s*연구|본\s*논문|이\s*글|이\s*논문)(?:은|는|에서는).*(?:한다|본다)\.\s*$/;
const isEnglish = (s: string) => !/[가-힣]/.test(s) && (s.match(/[A-Za-z]/g) ?? []).length >= 20;

/**
 * 한 문장의 결과 표지 — 띄어 쓴 꼴(RESULT), 공백을 지운 꼴(RESULT_FLAT — PDF 줄바꿈이 낱말 안에 넣은 공백: "검토하 였다"·"… 허용된다 고 본다"),
 * 영문 표지(RESULT_EN). 지운 꼴에는 띄어 쓴 문장의 낱말 첫머리 위치를 flatSlot() 자리에 넣어(지운 꼴 앞부분의 길이), 사람 이름·안긴 주어·당사자의
 * 딸린 낱말은 그 자리에서만 찾는다(7차 R4 — voiced 의 WS 설명).
 */
function resultMarked(s: string): boolean {
    if (RESULT.test(s)) return true;
    const starts: number[] = [];
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        if (/\s/.test(s[i]!)) continue;
        if (i > 0 && /\s/.test(s[i - 1]!)) starts.push(n);
        n++;
    }
    const flat = starts.length ? new RegExp(RESULT_FLAT.source.replaceAll(flatSlot(), `(?:${starts.map((k) => `[\\s\\S]{${k}}`).join('|')})`)) : RESULT_FLAT;
    return flat.test(s.replace(/\s+/g, '')) || (isEnglish(s) && RESULT_EN.test(s));
}

// 정답지 메아리 — 입력 문장의 2-gram 중 정답지 한 문장에 든 비율이 이 이상이면 같은 문장으로 본다.
const ECHO = 0.8;

/** 정답지(본문 결론 절 또는 초록 결과 문장)를 문장 2-gram 집합으로. 마침표 없이 이어 붙은 긴 덩어리는 '다' 끝에서 더 자른다. */
function answerKey(text: string): Set<string>[] {
    return sentences(text)
        .flatMap((s) => (s.length > 300 ? s.split(/(?<=다)\s+/) : [s]))
        .map(bigrams)
        .filter((g) => g.size >= 8);
}

/** 문장 s가 정답지 문장과 얼마나 겹치는가 — s의 2-gram 중 한 정답 문장에 든 비율의 최댓값. 짧은 문장은 우연히 겹치므로 0. */
function echoOf(s: string, key: Set<string>[]): number {
    const g = bigrams(s);
    if (g.size < 15) return 0;
    let best = 0;
    for (const t of key) {
        // 훨씬 긴 덩어리는 흔한 2-gram을 다 갖고 있어 아무 문장이나 덮는다 — 비교하지 않는다.
        if (t.size > g.size * 3 + 30) continue;
        let hit = 0;
        for (const x of g) if (t.has(x)) hit++;
        best = Math.max(best, hit / g.size);
    }
    return best;
}

/** 파일명 → 메인 제목(부제 제외). 저널 헤더가 섞일 여지가 없다. */
function titleFromFilename(file: string): string {
    let t = path.basename(file).replace(/(\.pdf)+$/i, '').replace(/_+/g, ' ').trim();
    t = t.replace(/^【[^】]*】\s*/, '').replace(/^\[[^\]]*\]\s*/, '');
    t = t.replace(/[*❖◆★]+$/g, '').trim();
    // 부제 분리: " - ", " : ", " ― " — 왼쪽이 10자 이상이면 그쪽을 쓴다.
    const cut = t.split(/\s+[-–—]\s+|\s*[:：]\s+/)[0] ?? t;
    t = (cut.length >= 10 ? cut : t).replace(/^[「『"“'‘]+|[」』"”'’]+$/g, '').trim();
    // 구분자 없이 붙은 부제(파일명에만 있는 경우) — 흔한 꼴만 떼어 낸다.
    const strip = (re: RegExp) => {
        const next = t.replace(re, '').trim();
        if (next.length >= 10) t = next;
    };
    strip(/\s+(?:미국|일본|독일|중국|영국|EU|유럽|국내|외국)\s*사례를?\s*중심으로\s*$/);
    strip(/\s+\d+단계\s*모형에\s*따른.*$/);
    strip(/\s+.*의?\s*논의를?\s*참고한.*$/);
    return t.replace(/\s+/g, ' ').normalize('NFC');
}

/** 초록 후보를 layout/raw 에서 찾아 반환. 표지는 장식을 제거해 비교한다. */
function extractAbstract(layout: string, raw: string): string {
    const KEYS = new Set(['국문요약', '요약', '초록', '국문초록', 'abstract', '국문초록']);
    const END = /^(주제어|키워드|핵심어|keywords?|key\s*words?|[ⅠⅡⅢⅣⅤ]\.|i\.|서론|1\.서론)/;
    const tryIn = (text: string): string => {
        const lines = text.split('\n');
        let start = -1;
        for (let i = 0; i < Math.min(lines.length, 200); i++) {
            const k = headingKey(lines[i] ?? '');
            if (KEYS.has(k) || [...KEYS].some((x) => k.startsWith(x) && k.length <= x.length + 12)) {
                start = i + 1;
                break;
            }
            // 표지가 두 줄로 갈라진 경우("초 / 록", "[요 / 약]") — 다음 글자 줄과 이어 본다. 놓치면 뒤의 영문 초록을 국문 대신 쓴다.
            if (/^[가-힣]{1,2}$/.test(k)) {
                let j = i + 1;
                while (j < lines.length && j <= i + 3 && !headingKey(lines[j] ?? '')) j++;
                if (KEYS.has(k + headingKey(lines[j] ?? ''))) {
                    start = j + 1;
                    break;
                }
            }
        }
        if (start < 0) return '';
        let end = lines.length;
        for (let i = start; i < lines.length; i++) {
            const k = headingKey(lines[i] ?? '');
            if (!k) continue;
            if (END.test(k)) {
                end = i;
                break;
            }
            // 영문 초록 표지가 나오면 거기서 끊는다(국문 초록만 쓴다).
            if ((KEYS.has(k) || [...KEYS].some((x) => k.startsWith(x))) && i > start + 1) {
                end = i;
                break;
            }
        }
        let body = lines
            .slice(start, end)
            .join('\n')
            .replace(/^\s*[-–—]\s*\d+\s*[-–—]\s*$/gm, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        // DOI·저자 각주 같은 줄은 초록이 아니다.
        const noise = (l: string) =>
            /^\s*\*/.test(l) ||
            /(책임저자|교신저자|E-mail)/.test(l) ||
            /(제\s*\d+\s*권|제\s*\d+\s*호|통권|Vol\.|No\.)/.test(l) ||
            (/(대학교|대학원|법학전문대학원|연구원|연구소)/.test(l) && /(교수|박사|연구원|조교수|겸임)/.test(l));
        body = body
            .split('\n')
            .filter((l) => !/^\s*(DOI|https?:\/\/|\d{1,3}\s*$)/.test(l) && !noise(l))
            .join('\n')
            .trim();
        if (body.length > 3500) body = body.slice(0, 2500).trim();
        return body;
    };
    return tryIn(raw) || tryIn(layout) || '';
}

/** 원 논문의 접근방향 — 초록·머리말에서 방법·분석틀을 말하는 문장. 입력에서 뺀 문장(dropped)을 먼저 본다. */
function extractApproach(dropped: string[], abstract: string, background: string): string {
    const pick = (sents: string[]): string => {
        const marked = sents.filter(
            (s) => /(비교법|비교법적|판례|결정례|규범\s*분석|문헌|실증|사례|설문|인터뷰|통계|분석|검토|고찰|방법)/.test(s) && !/^(결론|따라서|결국)/.test(s),
        );
        return marked.slice(0, 2).join(' ');
    };
    // 입력에 남은 문장을 고르면 '원본 vs 생성' 비교가 '입력 vs 그 입력으로 쓴 글'이 된다.
    const fromDropped = pick(dropped);
    if (fromDropped.length >= 20) return fromDropped;
    const fromAbstract = pick(sentences(abstract));
    if (fromAbstract.length >= 20) return fromAbstract;
    const fromBackground = pick(sentences(background));
    return fromBackground.length >= 20 ? fromBackground : '(초록에서 방법 진술을 찾지 못함)';
}

/** 원 논문의 논지 — 초록·머리말에서 "본 논문은 …" 꼴을 우선 찾고, 없으면 앞 두 문장. 입력에서 뺀 문장을 먼저 본다. */
function extractThesis(dropped: string[], abstract: string, intro: string): string {
    const marked = (sents: string[]) =>
        sents.filter((s) => /(본\s*논문|본\s*연구|(?<![가-힣])본\s*고(?=[는에가의를])|이\s*글|이\s*논문|필자)/.test(s) && /(검토|논증|밝|제안|분석|고찰|살펴|규명|주장|제시)/.test(s));
    const fromDropped = marked(dropped).slice(0, 2).join(' ');
    if (fromDropped.length >= 20) return fromDropped;
    const pick = (text: string): string => {
        const sents = sentences(text);
        const m = marked(sents);
        if (m.length) return m.slice(0, 2).join(' ');
        return sents.slice(0, 2).join(' ');
    };
    const fromAbstract = pick(abstract);
    if (fromAbstract.length >= 20) return fromAbstract;
    return pick(intro);
}

/** 초록이 없는 논문은 머리말(서론) 첫 부분을 배경으로 쓴다. */
function introFallback(text: string): string {
    const lines = text.split('\n');
    const startRe = /^\s*(?:[ⅠI1]\.?\s*)?(?:머\s*리\s*말|서\s*론|서\s*언|들\s*어\s*가?\s*며|들어가는\s*말|글을\s*시작하며|문제의\s*제기)\s*$/;
    // 목차에도 "머리말"이 있다 — 본문이 충분히 긴 후보를 고른다.
    const starts: number[] = [];
    for (let i = 0; i < Math.min(lines.length, 800); i++) {
        if (startRe.test(lines[i] ?? '')) starts.push(i + 1);
    }
    let best = '';
    for (const start of starts) {
        let end = lines.length;
        for (let i = start; i < lines.length; i++) {
            if (/^\s*(?:Ⅱ|II|2)\.\s*\S/.test(lines[i] ?? '')) {
                end = i;
                break;
            }
        }
        const body = lines
            .slice(start, end)
            .join('\n')
            .replace(/^\s*\d{1,3}\s*$/gm, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
            .slice(0, 1800);
        if (body.length > best.length) best = body;
    }
    return best.length >= 200 ? best : '';
}

/**
 * 초록 → (배경, 검토 항목). 결과·결론 문장은 버리고(dropped), 결론 절과 거의 같은 문장도 뺀다(echoed).
 * 다 버려 배경이 비면 비운 채로 둔다 — 버린 문장을 다시 넣으면 정답지와 입력에 같은 문장이 남는다.
 * shaped=false(머리말)면 결과 구역·사이 문장 규칙을 쓰지 않는다 — 머리말은 논증 글이라 "그 결과"·"요컨대"가 결과의 시작이 아니다.
 */
function splitAbstract(abstract: string, key: Set<string>[], shaped = true): { background: string; items: string[]; dropped: string[]; echoed: string[] } {
    const all = sentences(abstract);
    const kept: string[] = [];
    const dropped: string[] = [];
    const echoed: string[] = [];
    let zone = false;
    const isResult = all.map((s, i) => {
        // PDF 줄바꿈이 낱말 안에 공백을 넣는다("검토하 였다") — 공백을 지운 꼴로도 검사한다(resultMarked).
        const en = isEnglish(s);
        // 영문 결과 문장은 국문 같은 서술 표지 없이 이어진다(Level 2 … involves …) — 셋째 문장 이후 첫 결과 표지부터 끝까지 결과로 본다.
        if (shaped && (RESULT_START.test(s) || (en && i >= 2 && RESULT_EN.test(s)))) zone = true;
        return zone || resultMarked(s);
    });
    all.forEach((s, i) => {
        // 결과 문장 사이에 낀 문장도 결과다 — 결과는 이어서 쓰고, 표지 없이 잇는 문장("Level 4는 … 해당한다")이 있다.
        // 다만 연구 질문("현행 절차는 과연 적정한가?"), 현재형 범위 진술("본고는 … 쟁점을 검토한다"), 동향 서술("최근 일본은 …")은
        // 결과 사이에 있어도 배경이다 — 방법 문장("…분석하였다")과 시사 문장 사이에 낀 사실 서술까지 빼면 배경이 한 문장만 남았다(역외).
        const between = shaped && i >= 2 && isResult[i - 1] && isResult[i + 1] && !BETWEEN_BG.test(s);
        if (isResult[i] || between) dropped.push(s);
        else kept.push(s);
    });
    // 결론 절이 없는 논문은 초록 결과 문장이 정답지다.
    const k = key.length ? key : dropped.map(bigrams);
    const base = kept.filter((s) => {
        if (echoOf(s, k) < ECHO) return true;
        echoed.push(s);
        return false;
    });
    const background = base.join(' ').slice(0, 3000);
    const items = base
        .filter((s) => ISSUE.test(s) || ISSUE.test(s.replace(/\s+/g, '')))
        .slice(0, 6)
        .map((s) => s.trim());
    return { background, items, dropped, echoed };
}

const hasHangul = (l: string) => /[가-힣]/.test(l);

/** 로마자 이름 낱말만 있는 줄인가 — 별표·각주 번호·구분자(･·,&)는 떼고 본다. */
function romanNamesOnly(t: string): boolean {
    const rest = t
        .replace(/^\d{1,3}\)\s*/, '')
        .replace(/(?<=[A-Za-z])\d+\)?/g, '')
        .replace(/[*･·∙・․,&＆]/g, ' ')
        .replace(/\band\b/g, ' ')
        .trim();
    const words = rest.split(/\s+/).filter(Boolean);
    return words.length >= 2 && words.length <= 14 && words.every((w) => /^[A-Z][A-Za-z'’-]*$/.test(w));
}

/** 로마자 저자 줄 — "Ko, Sanghyeob** ･ Lee, Kyungju***", "94)Ryu, Bu Gon*", "Geun Hye Kim1 · Kyu Dong Park2*". 영문 제목·초록 묶음의 표지다. */
function isRomanAuthorLine(line: string): boolean {
    const t = line.trim();
    if (!t.includes('*') || t.length > 120 || hasHangul(t)) return false;
    return romanNamesOnly(t);
}

/**
 * 제목 끝 줄에 붙은 로마자 저자 이름("… with the Right to Cross-Examination Changwon Baek*")의 시작 위치. 없으면 -1.
 * 이름 앞에 낱말이 셋 이상 있어야 하고, 그 앞부분이 또 이름이면 안 된다 — "Geun Hye Kim1 · Kyu Dong Park2*"는 저자 줄이고,
 * "Execution Methods*"(제목 각주 별표)는 따로 저자 줄 꼴로 본다.
 */
function trailingAuthorAt(line: string): number {
    const t = line.trimEnd();
    if (hasHangul(t) || t.length > 160) return -1;
    const m = /\s([A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+){1,2})\s*\d*\*+$/.exec(t);
    if (!m) return -1;
    const head = t.slice(0, m.index).trim();
    return head.split(/\s+/).length >= 3 && !romanNamesOnly(head) ? m.index : -1;
}

/** 저자 약력 머리 줄("김근혜(Geun Hye Kim)" 다음에 "2011년 : …" 학력·경력) — 원 논문의 저자 정보다. */
const isAuthorBio = (lines: string[], i: number) =>
    /^\s*[가-힣]{2,4}\s*\([A-Z][A-Za-z'’-]*(?:\s+[A-Z][A-Za-z'’-]*){1,3}\)\s*$/.test(lines[i] ?? '') &&
    lines.slice(i + 1, i + 5).some((x) => /^\s*(?:19|20)\d{2}\s*년/.test(x));

/** 저자 줄 i 바로 위의 영문 제목 줄들(빈 줄 하나까지 건너뜀)의 첫 줄 번호. 제목이 없으면 i. */
function englishTitleStart(lines: string[], i: number): number {
    let j = i - 1;
    // 제목과 저자 줄 사이의 빈 줄·각주 번호 줄("100)")은 건너뛴다.
    for (let n = 0; n < 2 && j >= 0 && /^\s*(?:\d{1,3}\))?\s*$/.test(lines[j] ?? ''); n++) j--;
    let start = i;
    for (let n = 0; n < 4 && j >= 0; n++, j--) {
        const l = lines[j] ?? '';
        if (!l.trim() || hasHangul(l) || !/[A-Za-z]{3,}/.test(l)) break;
        start = j;
    }
    return start;
}

/** 영문 주제어 줄 i 앞의 영문 문단 첫 줄 — 한글 줄이나 서지 꼴(연도·[n])이 나오면 멈춘다. */
function englishBlockStart(lines: string[], i: number): number {
    let start = i;
    for (let j = i - 1; j >= 0; j--) {
        const l = lines[j] ?? '';
        if (hasHangul(l) || /^\s*\[\d+\]|\b(?:19|20)\d{2}\b/.test(l)) break;
        start = j;
    }
    return start;
}

/** 참고문헌 절 — raw 텍스트의 **마지막** 참고문헌 표지부터. 표지는 장식을 제거해 비교한다. */
function extractReferences(layout: string, raw: string): string {
    const KEYS = new Set(['참고문헌', 'references', '參考文獻']);
    const tryIn = (text: string): string => {
        const lines = text.split('\n');
        let start = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
            const k = headingKey(lines[i] ?? '');
            if (KEYS.has(k) || k.startsWith('참고문헌') || k.startsWith('references')) {
                start = i + 1;
                break;
            }
        }
        if (start < 0) return '';
        let end = lines.length;
        for (let i = start; i < lines.length; i++) {
            const k = headingKey(lines[i] ?? '');
            if (/^(저자소개|부록|abstract|영문초록|국문초록|국문요약|요약|초록)$/.test(k)) {
                end = i;
                break;
            }
            // 'Abstract' 표지 없이 영문 제목·로마자 저자·영문 초록을 싣는 학술지가 많다 — 영문 초록은 국문에서 지운
            // 결과 문장의 번역이므로 제목 줄에서 끊는다. 이름이 제목 끝 줄에 붙은 꼴(AI 포렌식)은 그 줄도 제목이다.
            if (isRomanAuthorLine(lines[i] ?? '') || trailingAuthorAt(lines[i] ?? '') >= 0) {
                end = englishTitleStart(lines, i);
                break;
            }
            // 참고문헌 뒤에 바로 붙은 저자 약력(AFR) — 저자 이름·소속은 원 논문을 가리킨다.
            if (isAuthorBio(lines, i)) {
                end = i;
                break;
            }
            // 저자 줄을 못 알아봐도 영문 주제어 줄이 나오면 그 앞 영문 문단의 처음에서 끊는다.
            if (/^\s*key\s*-?\s*words?\s*[:：]/i.test(lines[i] ?? '')) {
                end = englishBlockStart(lines, i);
                break;
            }
        }
        const body = lines
            .slice(start, end)
            .join('\n')
            .replace(/^\s*\d{1,3}\s*$/gm, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        return body.length >= 100 ? body.slice(0, 20_000) : '';
    };
    return tryIn(raw) || tryIn(layout) || '';
}

/** 쪽머리 줄("수사목적 온라인 수색의 허용요건 - 독일의 논의를 참고한 입법론적 검토 ∙ 129")을 뺀다 — 부제가 그대로 들어 있다. */
function stripRunningHeads(refs: string, title: string): string {
    const t = norm(title);
    if (t.length < 8) return refs;
    return refs
        .split('\n')
        .filter((l) => !norm(l).includes(t))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** 원 논문 자신의 식별 정보 — v2 실행에서 연구 단계는 입력에 남은 DOI(AFR)·영문 제목으로 원 논문을 찾아왔다. */
interface Ident {
    doi: string;
    kciId: string;
    titleEn: string;
    /** 로마자 저자 — 지우지는 않고 meta.json 에 남겨 누출 판정이 쓴다. */
    authorsEn: string[];
}

/** 영문 제목 낱말(4자 이상) 중 줄에 든 비율 — testset-conclusion 의 누출 판정과 같은 셈. 낱말이 넷 미만이면 0. */
function englishCoverage(titleEn: string, line: string): number {
    const words = [...new Set(titleEn.toLowerCase().match(/[a-z]{4,}/g) ?? [])];
    if (words.length < 4) return 0;
    const c = line.toLowerCase();
    return words.filter((w) => c.includes(w)).length / words.length;
}

/**
 * 영문 제목 줄인가 — 제목 낱말 80% 이상을 담고, 거꾸로 그 줄 낱말의 75% 이상이 제목 낱말이어야 한다.
 * 쪽머리("… Digital Evidence 33")·제목 묶음은 제목 낱말뿐이지만, 비슷한 제목의 다른 문헌 서지
 * ("Henrichs, Axel, “Verdeckte personale Ermittlungen im Internet”" — 독일 논문 제목 낱말 4/5)는 저자·학술지 낱말이 섞인다.
 */
function isTitleEnText(titleEn: string, text: string): boolean {
    if (hasHangul(text) || englishCoverage(titleEn, text) < 0.8) return false;
    const t = titleEn.toLowerCase();
    const words = [...new Set(text.toLowerCase().match(/[a-z]{4,}/g) ?? [])];
    return words.length > 0 && words.filter((w) => t.includes(w)).length / words.length >= 0.75;
}

/**
 * 줄이 원 논문을 가리키는 까닭(없으면 ''). DOI는 빗금 둘레의 공백("10.22798 / kdfs…")을 허용하고, 뒤에 숫자·글자가 이어지면
 * 다른 논문으로 본다(같은 호의 "…19.1.1"과 "…19.1.14"). 줄 전체의 공백을 지우면 DOI 뒤의 쪽 번호("…2317     2318")가 붙어 놓친다.
 */
function ownIdentIn(line: string, id: Ident): string {
    const low = line.toLowerCase();
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('/', '\\s*/\\s*');
    if (id.doi && new RegExp(`${esc(id.doi)}(?![0-9a-z])`).test(low)) return 'DOI';
    if (id.kciId && low.includes(id.kciId.toLowerCase())) return 'KCI ID';
    if (id.titleEn && isTitleEnText(id.titleEn, line)) return '영문 제목';
    return '';
}

/** 참고문헌에서 원 논문 자신의 DOI·KCI ID·영문 제목 쪽머리 줄을 뺀다. */
function stripOwnIdent(refs: string, id: Ident): string {
    return refs
        .split('\n')
        .filter((l) => !ownIdentIn(l, id))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** 결론 절 — 본문 끝부분에서 "결론/맺는말/맺음말/결어/나가며" 표지를 찾아 참고문헌 앞까지. */
function extractConclusion(text: string): string {
    // 표지가 같은 줄에 본문·참고문헌과 붙어 있는 경우가 있다("참 고 문 헌 (References) [1] …") — 줄 끝을 요구하지 않는다.
    const refHead = /(?:^|\n)\s*[<《\[(]?\s*(?:참\s*고\s*문\s*헌|References|REFERENCES|參考文獻)/g;
    let refStart = text.length;
    for (const m of text.matchAll(refHead)) refStart = m.index ?? refStart;
    const body = text.slice(0, refStart);
    const lines = body.split('\n');
    const from = Math.floor(lines.length * 0.5);
    let start = -1;
    // 장 번호는 로마 숫자·아라비아 숫자("5. 결 론") 모두, 마침표는 없어도 된다("Ⅴ나 며" — pdftotext가 '가'를 빠뜨린다).
    const heading =
        /^\s*(?:(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]|[IVX]{1,4}|\d{1,2}|제\s*\d+\s*장)\s*[.．]?\s*)?(?:결\s*론(?:\s*(?:및|과|와)\s*\S+)?|맺\s*는\s*말|맺\s*음\s*말|결\s*어|나\s*[가오]?\s*며|마\s*치\s*며)\s*$/;
    for (let i = from; i < lines.length; i++) {
        if (heading.test(lines[i] ?? '')) {
            start = i;
        }
    }
    // "결론"이라는 표지가 없는 논문은 마지막 로마숫자 절(Ⅴ./V.)을 결론·제언으로 본다.
    if (start < 0) {
        for (let i = from; i < lines.length; i++) {
            if (/^\s*(?:[ⅠⅡⅢⅣⅤⅥⅦ]|[IVX]{1,4})\.\s+\S/.test(lines[i] ?? '')) start = i;
        }
    }
    if (start < 0) return '';
    const raw = lines.slice(start + 1).join('\n');
    const cut = /[<《\[(]?\s*참\s*고\s*문\s*헌|(?:^|\n)\s*References\b/.exec(raw);
    const out = (cut ? raw.slice(0, cut.index) : raw)
        .replace(/^\s*\d{1,3}\s*$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return out.length >= 250 ? out.slice(0, 20000) : '';
}

/** 원 논문의 DOI — 누출 판정(연구 단계가 원 논문을 찾아왔는가)과 입력에서 지우는 데 쓴다. "DOI : 10.22798 / kdfs…"처럼 빗금 둘레에 공백이 끼기도 한다. */
function extractDoi(text: string): string {
    const m = /\b10\.\d{4,9}\s*\/\s*[^\s"<>]+/.exec(text.slice(0, 8000));
    return m ? m[0].replace(/\s+/g, '').replace(/[.,;)\]]+$/, '').toLowerCase() : '';
}

/** 원 논문의 KCI 논문 ID(ART + 9자리) — KCI에서 받은 PDF 첫머리에 있다. */
function extractKciId(text: string): string {
    return /\bART\d{9}\b/.exec(text.slice(0, 8000))?.[0] ?? '';
}

/** 원 논문의 영문 제목 — 누출 판정(영문 서지로 찾아온 경우)과 입력에서 지우는 데 쓴다. 학술지마다 놓는 곳이 달라 세 곳을 본다. */
function extractTitleEn(raw: string): string {
    const lines = raw.split('\n');
    const clean = (t: string) => t.replace(/\s+/g, ' ').replace(/[\s*\d)]+$/, '').trim();
    // 학술지 이름·권호 줄을 제목으로 잡지 않는다.
    const ok = (t: string) => t.split(' ').length >= 4 && !/\bjournal of\b|\blaw review\b|\bvol\.|\bissn\b|\bsociety\b/i.test(t);
    const nextLine = (i: number) => {
        let j = i + 1;
        while (j < lines.length && !(lines[j] ?? '').trim()) j++;
        return lines[j] ?? '';
    };
    // 1) 로마자 저자 줄 위의 영문 줄. 제목 끝 줄에 이름이 붙은 꼴("… Cross-Examination Changwon Baek*")은 이름 앞까지 제목이다.
    //    제목 각주 별표가 붙은 끝 줄("Execution Methods*")도 저자 줄 꼴이다 — 구분자가 없고 다음 줄이 또 저자 줄이면 그 줄까지 제목이다.
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i] ?? '';
        const cut = trailingAuthorAt(l);
        if (cut < 0 && !isRomanAuthorLine(l)) continue;
        const tail = cut >= 0 ? [l.slice(0, cut)] : !/[,･·∙・․&＆]/.test(l) && isRomanAuthorLine(nextLine(i)) ? [l] : [];
        const t = clean([...lines.slice(englishTitleStart(lines, i), i), ...tail].join(' '));
        if (ok(t)) return t;
    }
    // 2) 영문 초록 표지 바로 뒤의 제목("[ABSTRACT] / 제목 / 97) / Lee, Keon-Su / *"). 별표 없는 이름 줄은 쉼표·가운뎃점이
    //    있어야 이름으로 본다("Human Rights Protection"은 제목의 끝 줄이다).
    for (let i = 0; i < lines.length; i++) {
        if (headingKey(lines[i] ?? '') !== 'abstract') continue;
        const title: string[] = [];
        for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
            const l = (lines[j] ?? '').trim();
            if (!l || /^(?:\d{1,3}\)|\*+)$/.test(l)) continue;
            if (hasHangul(l)) break;
            if (/[,･·∙・․]/.test(l) && l.length <= 120 && romanNamesOnly(l)) {
                const t = clean(title.join(' '));
                if (ok(t)) return t;
                break;
            }
            title.push(l);
        }
    }
    // 3) 영문 쪽머리("Limitations and Alternatives … Digital Evidence 33") — 쪽 번호를 뗀 같은 영문 줄이 다섯 번 이상 나온다
    //    (참고문헌 줄이 각주에 되풀이되는 것은 서너 번에 그친다).
    const count = new Map<string, number>();
    for (const l of lines) {
        const t = l.trim().replace(/^\d{1,4}\s+|\s+\d{1,4}$/g, '');
        if (!hasHangul(t) && !/https?:|doi/i.test(t) && ok(t)) count.set(t, (count.get(t) ?? 0) + 1);
    }
    const head = [...count].filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1])[0];
    return head ? clean(head[0]) : '';
}

/**
 * 원 논문의 로마자 저자 — 영문 제목 묶음의 저자 줄("Ko, Sanghyeob** ･ Lee, Kyungju***", "Geun Hye Kim1 · Kyu Dong Park2*",
 * 제목 끝 줄에 붙은 "… Changwon Baek*"). 누출 판정이 원 제목과 비슷한 다른 문헌(독일: Henrichs “Verdeckte personale Ermittlungen im
 * Internet”)을 가를 때 쓴다(testset-conclusion). 영문 제목이 바로 위 열두 줄 안에 있는 저자 줄만 본다 — 참고문헌의 로마자 이름을
 * 저자로 잡지 않는다. 영문 제목을 못 찾았으면 비운다.
 */
function extractAuthorsEn(raw: string, titleEn: string): string[] {
    if (!titleEn) return [];
    const lines = raw.split('\n');
    const title = titleEn.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i] ?? '';
        const cut = trailingAuthorAt(l);
        const named = cut >= 0 || isRomanAuthorLine(l) || (/[,･·∙・․]/.test(l) && l.trim().length <= 120 && !hasHangul(l) && romanNamesOnly(l.trim()));
        if (!named) continue;
        const text = cut >= 0 ? l.slice(cut) : l;
        // 제목 각주 별표가 붙은 끝 줄("Execution Methods*")은 저자 줄 꼴이지만 제목이다.
        const words = text.toLowerCase().match(/[a-z]{4,}/g) ?? [];
        if (words.length && words.every((w) => title.includes(w))) continue;
        if (englishCoverage(titleEn, lines.slice(Math.max(0, i - 12), i + 1).join(' ')) < 0.8) continue;
        return text
            .replace(/^\s*\d{1,3}\)\s*/, '')
            .replace(/(?<=[A-Za-z])\d+\)?/g, '')
            .replace(/\*+/g, '')
            .split(/[･·∙・․&＆]|\band\b/)
            .map((x) => x.trim().replace(/\s+/g, ' '))
            .filter((x) => /^[A-Z][A-Za-z'’-]/.test(x));
    }
    return [];
}

/**
 * 자기검사 — 다 쓴 input.md가 정답지를 담고 있는가. 배경·검토 항목 문장을 정답지 문장과 대조하고(2-gram 80% 이상),
 * 참고문헌에 영문 산문 문단(영문 초록 — 결과 문장의 번역)이 남았는지 본다. 참고문헌 줄은 정답지와 대조하지 않는다:
 * 결론 절에 섞인 쪽머리("형사정책연구 제35권 …")·각주 서지가 참고문헌과 같아 늘 겹친다.
 * 원 논문 자신의 DOI·KCI ID·영문 제목이 파일 어디에든 남았는지도 본다(영문 제목은 네 줄에 걸친 것까지).
 */
function selfCheck(md: string, key: Set<string>[], id: Ident): string[] {
    const flags: string[] = [];
    const mdLines = md.split('\n');
    for (let i = 0; i < mdLines.length; i++) {
        const l = mdLines[i]!;
        // 긴 영문 제목은 서너 줄에 걸쳐 남는다(AI 포렌식: 제목·부제 네 줄) — 이어지는 네 줄까지 붙여 본다.
        const span = (n: number) => mdLines.slice(i, i + n).join(' ');
        const why = ownIdentIn(l, id) || (id.titleEn && [2, 3, 4].some((n) => isTitleEnText(id.titleEn, span(n))) ? '영문 제목' : '');
        if (why) {
            flags.push(`원 논문 식별 정보(${why})가 남음: ${l.trim().slice(0, 60)}`);
            break;
        }
    }
    const bodyPart = md.split('\n## 참고문헌\n')[0] ?? md;
    const refsPart = md.split('\n## 참고문헌\n')[1] ?? '';
    const body = bodyPart
        .split('\n')
        .filter((l) => !/^\s*(#|>)/.test(l))
        .map((l) => l.replace(/^\s*-\s+/, ''))
        .join(' ');
    for (const s of sentences(body)) {
        const e = echoOf(s, key);
        if (e >= ECHO) flags.push(`정답지와 같은 문장(${Math.round(e * 100)}%): ${s.slice(0, 60)}`);
    }
    // 서지 꼴이 아닌 영문 산문 줄이 다섯 이상 이어지면 영문 초록이 남은 것이다(긴 영문 서지 제목은 서너 줄에 그친다).
    const refLines = refsPart.split('\n');
    const prose = (l: string) =>
        !hasHangul(l) &&
        l.trim().split(/\s+/).filter((w) => /[A-Za-z]{2,}/.test(w)).length >= 8 &&
        !/^\s*\[\d+\]|["“”«»]|\b(?:19|20)\d{2}\b|\bVol\.|\bpp?\.|https?:|doi/i.test(l);
    for (let i = 0; i + 4 < refLines.length; i++) {
        if ([0, 1, 2, 3, 4].every((d) => prose(refLines[i + d]!))) {
            flags.push(`참고문헌에 영문 산문 문단: ${refLines[i]!.trim().slice(0, 60)}`);
            break;
        }
    }
    return flags;
}

function slug(s: string): string {
    return s
        .normalize('NFC')
        .replace(/[\\/:*?"<>|]/g, ' ')
        .replace(/\s+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'paper';
}

interface Doc {
    file: string;
    bytes: number;
    text: string;
    hash: string;
    grams: Set<string>;
    title: string;
    abstract: string;
    background: string;
    items: string[];
    dropped: string[];
    echoed: string[];
    refs: string;
    abstractSource: 'abstract' | 'intro' | 'none';
    backgroundSource: 'abstract' | 'intro' | 'none';
    conclusion: string;
    key: Set<string>[];
    ident: Ident;
}

// ---- 1) 읽기 ------------------------------------------------------------------
const files = fs.readdirSync(SRC).filter((f) => /\.pdf$/i.test(f)).map((f) => path.join(SRC, f));
if (!files.length) {
    console.error('PDF 가 없습니다:', SRC);
    process.exit(1);
}
const docs: Doc[] = [];
for (const file of files) {
    const layout = pdfText(file, true);
    const raw = pdfText(file, false) ?? layout;
    const text = layout ?? raw;
    if (!text || text.trim().length < 500) {
        console.log(`SKIP(텍스트 없음): ${path.basename(file)}`);
        continue;
    }
    const hash = createHash('sha1').update(norm(text).slice(0, 200_000)).digest('hex').slice(0, 16);
    const title = titleFromFilename(file);
    let abstract = extractAbstract(layout ?? text, raw ?? text);
    let abstractSource: Doc['abstractSource'] = abstract ? 'abstract' : 'none';
    if (!abstract) {
        abstract = introFallback(text);
        if (abstract) abstractSource = 'intro';
    }
    // 원 논문 식별 정보 — 참고문헌에서 지우고, 자기검사·누출 판정에 쓴다.
    const titleEn = extractTitleEn(raw ?? text);
    const ident: Ident = { doi: extractDoi(raw ?? text), kciId: extractKciId(raw ?? text), titleEn, authorsEn: extractAuthorsEn(raw ?? text, titleEn) };
    // 정답지를 먼저 만든다 — 입력 배경은 정답지와 대조해 거른다.
    const conclusion = extractConclusion(raw ?? text);
    const key = answerKey(conclusion);
    let split = splitAbstract(abstract, key, abstractSource === 'abstract');
    let backgroundSource: Doc['backgroundSource'] = split.background ? abstractSource : 'none';
    // 초록 문장이 모두 결과·결론이면 머리말로 배경을 대신한다(같은 거름을 거친다).
    if (!split.background && abstractSource === 'abstract') {
        const intro = splitAbstract(introFallback(text), key, false);
        if (intro.background) {
            split = { ...intro, dropped: split.dropped, echoed: [...split.echoed, ...intro.echoed] };
            backgroundSource = 'intro';
        }
    }
    docs.push({
        file,
        bytes: fs.statSync(file).size,
        text,
        hash,
        grams: bigrams(text.slice(0, 4000)),
        title,
        abstract,
        background: split.background,
        items: split.items,
        dropped: split.dropped,
        echoed: split.echoed,
        refs: stripOwnIdent(stripRunningHeads(extractReferences(layout ?? text, raw ?? text), title), ident),
        abstractSource,
        backgroundSource,
        conclusion,
        key: key.length ? key : split.dropped.map(bigrams),
        ident,
    });
}
// 읽은 PDF가 하나도 없으면(pdftotext 없음 등) 기존 manifest를 빈 목록으로 덮어쓰지 않는다.
if (!docs.length) {
    console.error(`읽을 수 있는 PDF가 없습니다(${files.length}개 모두 텍스트 없음) — pdftotext 설치를 확인하십시오. manifest를 쓰지 않습니다.`);
    process.exit(1);
}

// ---- 2) 중복 제거 --------------------------------------------------------------
const parent = docs.map((_, i) => i);
const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[rb] = ra;
};
for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
        const a = docs[i]!, b = docs[j]!;
        if (a.hash === b.hash || jac(a.grams, b.grams) >= 0.85) union(i, j);
    }
}
const groups = new Map<number, number[]>();
docs.forEach((_, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), i]);
});

const kept: { doc: Doc; removed: { file: string; bytes: number }[] }[] = [];
for (const idxs of groups.values()) {
    const sorted = [...idxs].sort((a, b) => docs[b]!.bytes - docs[a]!.bytes || docs[b]!.text.length - docs[a]!.text.length);
    const best = docs[sorted[0]!]!;
    const removed = sorted.slice(1).map((k) => ({ file: docs[k]!.file, bytes: docs[k]!.bytes }));
    kept.push({ doc: best, removed });
}

// ---- 3) 쓰기 -------------------------------------------------------------------
fs.mkdirSync(path.join(OUT, 'papers'), { recursive: true });
const manifest: unknown[] = [];
const duplicates: unknown[] = [];
const flagged: { title: string; flags: string[] }[] = [];
const thin: string[] = [];
for (const { doc, removed } of kept) {
    // ID는 절대경로로 만든다 — --dir 를 상대경로로 주면 같은 PDF의 ID가 모두 바뀌어 23편을 다시 돌렸다.
    // (기본 --dir 의 ID는 그대로다. 폴더를 옮기면 ID가 바뀐다 — 같은 폴더를 쓴다.)
    const id = slug(doc.title) + '-' + createHash('sha1').update(path.resolve(doc.file)).digest('hex').slice(0, 6);
    const dir = path.join(OUT, 'papers', id);
    fs.mkdirSync(dir, { recursive: true });
    const itemsMd = doc.items.length
        ? doc.items.map((s) => `- ${s}`).join('\n')
        : '(초록에서 검토 항목을 따로 추출하지 못함 — 아래 배경에서 도출)';
    const fromIntro = doc.backgroundSource === 'intro';
    // 원 파일명·글자 수는 쓰지 않는다 — 파일명에는 부제가 그대로 있고, 이 파일은 통째로 프롬프트에 들어간다.
    const md = [
        `# ${doc.title}`,
        '',
        `> 이 파일은 시험 입력이다. ${fromIntro ? '배경은 **머리말에서 발췌**했다. ' : ''}초록의 **결과·결론 문장과 본문 결론과 겹치는 문장은 제거**되었고, 제목의 부제도 제외되었다.`,
        '',
        '## 배경·문제의식',
        '',
        doc.background || '(배경으로 쓸 문장이 남지 않음 — 초록 문장이 모두 결과·결론이었다)',
        '',
        '## 검토 항목',
        '',
        itemsMd,
        '',
        '## 참고문헌',
        '',
        doc.refs || '(참고문헌을 찾지 못함)',
        '',
    ].join('\n');
    const flags = selfCheck(md, doc.key, doc.ident);
    if (flags.length) flagged.push({ title: doc.title, flags });
    if (!doc.background) thin.push(doc.title);
    fs.writeFileSync(path.join(dir, 'input.md'), md, 'utf8');
    const thesisOriginal = extractThesis(doc.dropped, doc.abstract, doc.background);
    const approachOriginal = extractApproach(doc.dropped, doc.abstract, doc.background);
    // 원본 논지·접근방향 문장이 입력 배경에도 있는가 — 있으면 그 축의 비교는 입력과의 비교다.
    const inInput = (s: string) => {
        const bg = norm(doc.background);
        const ss = sentences(s);
        return ss.length > 0 && ss.every((x) => bg.includes(norm(x)));
    };
    fs.writeFileSync(path.join(dir, 'expected.json'), JSON.stringify({
        title: doc.title,
        abstract: doc.abstract,
        thesisOriginal,
        approachOriginal,
        thesisInInput: inInput(thesisOriginal),
        approachInInput: inInput(approachOriginal),
        // 초록에서 결과·결론으로 분류해 **입력에서 제외한** 문장들 — 비교의 정답지.
        resultSentences: doc.dropped,
        // 결과 표지는 없지만 결론 절과 거의 같아 입력에서 뺀 문장들(정답지에는 이미 들어 있다).
        echoSentences: doc.echoed,
        conclusionSection: doc.conclusion,
        conclusionSource: doc.conclusion ? 'section' : doc.dropped.length ? 'abstract' : 'none',
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
        id,
        title: doc.title,
        titleEn: doc.ident.titleEn,
        doi: doc.ident.doi,
        kciId: doc.ident.kciId,
        authorsEn: doc.ident.authorsEn,
        source: doc.file,
        bytes: doc.bytes,
        chars: doc.text.length,
        abstractChars: doc.abstract.length,
        backgroundChars: doc.background.length,
        items: doc.items.length,
        refsChars: doc.refs.length,
        droppedResultSentences: doc.dropped.length,
        echoRemoved: doc.echoed.length,
        abstractSource: doc.abstractSource,
        backgroundSource: doc.backgroundSource,
        selfCheck: flags,
    }, null, 2), 'utf8');
    if (removed.length) duplicates.push({ kept: path.basename(doc.file), removed: removed.map((r) => path.basename(r.file)), bytes: removed.map((r) => r.bytes) });
    manifest.push({ id, title: doc.title, source: path.basename(doc.file), bytes: doc.bytes, chars: doc.text.length, abstractChars: doc.abstract.length, abstractSource: doc.abstractSource, backgroundSource: doc.backgroundSource, items: doc.items.length, refsChars: doc.refs.length, dropped: doc.dropped.length, echoRemoved: doc.echoed.length, dupRemoved: removed.length, selfCheck: flags });
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), source: SRC, papers: manifest }, null, 2), 'utf8');
fs.writeFileSync(path.join(OUT, 'duplicates.json'), JSON.stringify(duplicates, null, 2), 'utf8');

console.log(`\n입력 ${docs.length}편 → 중복 제거 후 ${kept.length}편`);
for (const m of manifest as { title: string; abstractChars: number; items: number; refsChars: number; dropped: number; echoRemoved: number; dupRemoved: number }[]) {
    console.log(`- ${m.title}`);
    console.log(
        `  초록 ${m.abstractChars}자 · 결과 제거 ${m.dropped} · 결론 겹침 제거 ${m.echoRemoved} · 항목 ${m.items} · 참고문헌 ${m.refsChars}자${m.dupRemoved ? ` · 중복 ${m.dupRemoved} 제거` : ''}`,
    );
}
console.log(`\n출력: ${OUT}`);
// 식별 정보를 못 찾은 편은 입력에서 지우지도, 누출로 잡지도 못한다 — 알린다.
const noIdent = (k: 'doi' | 'titleEn' | 'authorsEn') => kept.filter(({ doc }) => !doc.ident[k].length).map(({ doc }) => doc.title.slice(0, 20));
for (const [k, label] of [['doi', 'DOI'], ['titleEn', '영문 제목'], ['authorsEn', '로마자 저자']] as const) {
    const miss = noIdent(k);
    console.log(`원 논문 ${label} ${kept.length - miss.length}/${kept.length}편${miss.length ? ` — 못 찾음: ${miss.join(' · ')}` : ''}`);
}
// 배경이 빈 편은 누출이 아니라 입력이 얇은 것이다 — 알리기만 한다.
if (thin.length) console.log(`\n배경 없음 ${thin.length}편(제목·검토 항목·참고문헌만 입력): ${thin.join(' · ')}`);
// 자기검사에 걸린 편은 입력이 정답지를 담고 있을 수 있다 — 파일은 썼지만 실패로 끝내 사람이 보게 한다.
if (flagged.length) {
    console.error(`\n⚠ 자기검사 ${flagged.length}편 — input.md를 확인하십시오(meta.json selfCheck):`);
    for (const f of flagged) console.error(`- ${f.title}\n  ${f.flags.join('\n  ')}`);
    process.exitCode = 2;
}

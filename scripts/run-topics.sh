#!/usr/bin/env bash
# 여러 주제를 프로젝트 폴더로 만들어 순서대로 돌린다.
#
# 앱과 같은 구조를 쓴다:
#   ~/Documents/Nenene/<id>/project.json
#                                   /references/
#                                   /runs/<시각>/{ledger.json,report.md,calls.jsonl,...}
# 그래서 앱을 열면 이 실행들이 그대로 보인다.
#
#   bash scripts/run-topics.sh            논문 없이 원장까지만
#   bash scripts/run-topics.sh --paper    논문까지 조립 (훨씬 오래 걸린다)
set -uo pipefail
cd "$(dirname "$0")/.."

WS="${LPS_WORKSPACE:-$HOME/Documents/Nenene}"
ISSUES="${LPS_ISSUES:-2}"
CLAIMS="${LPS_CLAIMS:-4}"
PAPER=""
[ "${1:-}" = "--paper" ] && PAPER="--paper"

mkdir -p "$WS"

topic() { # id  topic  context
    local id="$1" t="$2" ctx="$3"
    local dir="$WS/$id"
    mkdir -p "$dir/references" "$dir/runs" "$dir/sources"
    if [ ! -f "$dir/project.json" ]; then
        node -e '
            const fs=require("fs");
            const [dir,topic,context]=process.argv.slice(1);
            fs.writeFileSync(dir+"/project.json", JSON.stringify({version:1,topic,context,manuscript:"",savedAt:new Date().toISOString()},null,2));
        ' "$dir" "$t" "$ctx"
    fi
    echo "─── $id"
    npx tsx src/cli.ts \
        --assume-unavailable --quiet $PAPER \
        --issues "$ISSUES" --claims "$CLAIMS" \
        --out "$dir/runs/$(date +%Y-%m-%dT%H-%M-%S)" \
        --corpus "$dir/references" --scratch "$dir/sources" \
        -t "$t" -c "$ctx" \
        >"$dir/runs/last.log" 2>&1
    tail -3 "$dir/runs/last.log" | sed 's/^/    /'
}

topic "가상자산-위장수사" \
    "가상자산을 이용한 위장수사(넥스펀드AI 사례 등)의 형사법적 정당성과 국내법제의 시사점" \
    "미국 법집행기관이 위장 가상자산과 위장 거래소를 운영해 피의자에게 접근한 사안. 국내에는 위장수사 허용 근거가 마약류·아동청소년성보호법 등에만 있고, 가상자산 범죄에는 없다는 지적이 있다. 함정수사의 경계, 기망적 수사와 적법절차, 증거능력 문제를 검토한다."

topic "웹크롤링-형사법" \
    "웹 크롤링 행위에 대한 형사법적 평가 — 정보통신망침입죄와 저작권법의 경계" \
    "공개된 웹페이지를 자동 수집하는 행위가 정보통신망법상 침입(제48조)이나 업무방해·저작권법 위반이 되는지. 국내 판례는 크롤링 자체보다 접근 방식과 서버 부하를 본다는 흐름이고, 해외(Yahoo v. LICRA, hiQ v. LinkedIn, Van Buren) 판결도 참조한다."

topic "정보통신망침입죄-보호조치" \
    "정보통신망침입죄의 구성요건으로서 '보호조치' 개념의 적정성" \
    "정보통신망법 제48조 제1항의 '보호조치'가 구성요건표지로서 명확한지, 판례가 이를 '접근권한'과 어떻게 결합해 해석하는지. 보호조치가 없는 개방 시스템에 대한 접근이 침입인지, 명확성 원칙과 죄형법정주의 문제를 검토한다."

topic "보안취약점-침입판단" \
    "보안 취약점 악용 행위의 정보통신망침입죄 성립 여부 — 5개 취약점 유형별 판단" \
    "다음 다섯 유형을 선정해 침입 성립을 판단한다: (1) 인증 없이 노출된 관리자 페이지 (2) 기본 비밀번호 미변경 (3) SQL 인젝션 (4) 디렉터리 트래버설 (5) 무효화되지 않은 세션 토큰. 각 유형에서 '보호조치'의 존재와 접근권한 침해 여부가 어떻게 달라지는지 비교한다."

topic "취약점관리제도-비범죄화" \
    "보안 취약점 관리제도와 선의의 취약점 탐지행위의 비범죄화 방안" \
    "버그바운티·취약점 신고·모의해킹 등 선의의 탐지행위가 현행 정보통신망법상 침입죄로 포섭될 위험. 해외의 안전항변(safe harbor)·책임있는 공개 제도와 국내 신고제도를 비교하고, 비범죄화의 형식(구성요건 해석인지 위법성조각인지 입법인지)을 검토한다."

topic "랜섬웨어-지불규제" \
    "랜섬웨어 피해자의 랜섬 지불 행위 규제의 적정성 — 미국 법제를 중심으로" \
    "랜섬 지불을 금지·신고의무화하는 미국의 접근(OFAC 제재, 주법상 금지, CIRCIA 신고)과 국내 논의를 비교. 피해자 처벌이 역효과라는 비판, 지불 금지의 실효성, 금융기관·보험사의 역할을 다룬다."

topic "전기통신금융사기-기술조치" \
    "통신사업자의 전기통신금융사기 예방을 위한 기술적 조치 의무화 방안" \
    "전기통신금융사기(보이스피싱) 예방을 위해 통신사업자에게 요구할 수 있는 기술적 조치(번호 변작 탐지, 국제전화 식별표시, 통화 전 경고)와 그 법적 근거. 영업의 자유·통신의 비밀과의 긴장, 의무화의 수준(노력의무인지 결과의무인지)을 검토한다."

echo
echo "완료. 워크스페이스: $WS"

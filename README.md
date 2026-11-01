# Nenene

Nenene는 LLM 에이전트로 법학논문 초안을 작성하는 간단한 PoC다. 주제와 배경을 입력하면
자료 조사, 논지 설계, 초고 작성, 인용 확보, 적대적 검토, 수정, 조립을 거쳐 `paper.md`를 만든다.
완성된 논문을 자동으로 생산하는 도구가 아니라, 인용 검증과 검토 루프를 실험하는 코드다.

## 설계원칙

1. **초고 우선.** 검증 가능한 자료만 모아 조립하지 않는다. 먼저 논지를 세우고, 검증으로 깎는다.
2. **원문 우선.** 초록·서지로 전문을 대신하지 않는다. 전문이 없으면 인용을 지지로 인정하지 않는다.
3. **코드 강제.** 검증 규칙은 프롬프트가 아니라 인용 상태 기계·차단·상한으로 집행한다.
4. **사람 확인.** 확보하지 못한 인용은 사람에게 묻고, 답을 원장에 남긴다. 답이 없으면 검증된 것으로 저장하지 않는다.
5. **유계 반복.** 연쇄 탐색·보강·재검증·인용 대조는 상한을 두고 반복한다.

## 하는 일

1. 주제와 배경에서 쟁점과 논지를 설계한다.
2. 장별 초고를 쓰고, 인용을 원문에서 확보한다.
3. 확보하지 못한 인용은 사람에게 묻는다.
4. 장별 주장에 반대를 세우고 판정한다.
5. 판정에 따라 수정·재검증하고, 초록·각주·참고문헌을 붙여 조립한다.

출력은 `data/runs/<타임스탬프>/`의 `paper.md`, `ledger.json`, `report.md`다.

## 요구사항

- Node.js 20 이상
- `pdftotext` (PDF 원문 추출)
- 모델 API 키 (기본 DeepSeek)
- KCI OpenAPI 키 (KCI 검색을 쓸 때)

## 설치

```bash
npm install
cp .env.example .env
```

`.env`에 모델 키를 넣는다.

```bash
LEGAL_AGENT_PROVIDER=deepseek
DEEPSEEK_API_KEY=...
KCI_API_KEY=...
```

`KCI_API_KEY`가 없으면 KCI 검색을 건너뛴다. 법령·판례 코퍼스는 선택이며,
`LEGAL_AGENT_CORPUS`로 지정한다.

## 실행

```bash
npm run run:mock -- --assume-unavailable   # 키 없이 배관 확인
npm run run -- -t "주제" -c "배경"
```

## 데스크톱 앱

```bash
cd app
npm install
npm run dev
```

## 구조

```text
src/          파이프라인, LLM 호출, 검증
src/law/      법령·판례·KCI·원문 확보
app/          Electron 앱
scripts/      유틸리티와 시험 스크립트
```

## 설정

| 변수 | 설명 |
|---|---|
| `LEGAL_AGENT_PROVIDER` | 모델 공급자 (기본 `deepseek`) |
| `DEEPSEEK_API_KEY` | DeepSeek API 키 |
| `KCI_API_KEY` | KCI OpenAPI 인증키 |
| `LEGAL_AGENT_CORPUS` | 사전 제공 법령·판례 디렉터리 (선택) |

전체 변수는 `.env.example`에 있다.

## 한계

- PoC다. 생성된 논문은 사람이 읽고 검토해야 한다.
- 모델·프롬프트·자료 접근에 따라 결과가 달라진다.
- KCI·법령·판례 접근은 외부 사이트 구조에 의존한다.

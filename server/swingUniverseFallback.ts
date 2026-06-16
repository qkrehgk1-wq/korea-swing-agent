/**
 * Baked top market-cap universe snapshot (KOSPI + KOSDAQ), generated from Naver.
 * Offline fallback for resolveSwingUniverse() when every LIVE universe source
 * (Naver API, pykrx) is unreachable — e.g. a geo-blocked CI runner. Guarantees a
 * broad universe with zero network dependency.
 *
 * Snapshot: 2026-06-16. Regenerate when stale (top-cap names drift slowly).
 */
import type { NaverUniverseEntry } from "./koreaStockMcp";

export const SWING_UNIVERSE_FALLBACK: NaverUniverseEntry[] = [
  {
    "ticker": "005930",
    "name": "삼성전자",
    "market": "코스피"
  },
  {
    "ticker": "000660",
    "name": "SK하이닉스",
    "market": "코스피"
  },
  {
    "ticker": "402340",
    "name": "SK스퀘어",
    "market": "코스피"
  },
  {
    "ticker": "005935",
    "name": "삼성전자우",
    "market": "코스피"
  },
  {
    "ticker": "009150",
    "name": "삼성전기",
    "market": "코스피"
  },
  {
    "ticker": "005380",
    "name": "현대차",
    "market": "코스피"
  },
  {
    "ticker": "373220",
    "name": "LG에너지솔루션",
    "market": "코스피"
  },
  {
    "ticker": "032830",
    "name": "삼성생명",
    "market": "코스피"
  },
  {
    "ticker": "028260",
    "name": "삼성물산",
    "market": "코스피"
  },
  {
    "ticker": "329180",
    "name": "HD현대중공업",
    "market": "코스피"
  },
  {
    "ticker": "000270",
    "name": "기아",
    "market": "코스피"
  },
  {
    "ticker": "034020",
    "name": "두산에너빌리티",
    "market": "코스피"
  },
  {
    "ticker": "207940",
    "name": "삼성바이오로직스",
    "market": "코스피"
  },
  {
    "ticker": "105560",
    "name": "KB금융",
    "market": "코스피"
  },
  {
    "ticker": "012450",
    "name": "한화에어로스페이스",
    "market": "코스피"
  },
  {
    "ticker": "012330",
    "name": "현대모비스",
    "market": "코스피"
  },
  {
    "ticker": "055550",
    "name": "신한지주",
    "market": "코스피"
  },
  {
    "ticker": "034730",
    "name": "SK",
    "market": "코스피"
  },
  {
    "ticker": "006400",
    "name": "삼성SDI",
    "market": "코스피"
  },
  {
    "ticker": "267260",
    "name": "HD현대일렉트릭",
    "market": "코스피"
  },
  {
    "ticker": "042660",
    "name": "한화오션",
    "market": "코스피"
  },
  {
    "ticker": "068270",
    "name": "셀트리온",
    "market": "코스피"
  },
  {
    "ticker": "010120",
    "name": "LS ELECTRIC",
    "market": "코스피"
  },
  {
    "ticker": "066570",
    "name": "LG전자",
    "market": "코스피"
  },
  {
    "ticker": "035420",
    "name": "NAVER",
    "market": "코스피"
  },
  {
    "ticker": "298040",
    "name": "효성중공업",
    "market": "코스피"
  },
  {
    "ticker": "086790",
    "name": "하나금융지주",
    "market": "코스피"
  },
  {
    "ticker": "042700",
    "name": "한미반도체",
    "market": "코스피"
  },
  {
    "ticker": "009540",
    "name": "HD한국조선해양",
    "market": "코스피"
  },
  {
    "ticker": "005490",
    "name": "POSCO홀딩스",
    "market": "코스피"
  },
  {
    "ticker": "069500",
    "name": "KODEX 200",
    "market": "코스피"
  },
  {
    "ticker": "000810",
    "name": "삼성화재",
    "market": "코스피"
  },
  {
    "ticker": "011070",
    "name": "LG이노텍",
    "market": "코스피"
  },
  {
    "ticker": "006800",
    "name": "미래에셋증권",
    "market": "코스피"
  },
  {
    "ticker": "000150",
    "name": "두산",
    "market": "코스피"
  },
  {
    "ticker": "010130",
    "name": "고려아연",
    "market": "코스피"
  },
  {
    "ticker": "051910",
    "name": "LG화학",
    "market": "코스피"
  },
  {
    "ticker": "015760",
    "name": "한국전력",
    "market": "코스피"
  },
  {
    "ticker": "010140",
    "name": "삼성중공업",
    "market": "코스피"
  },
  {
    "ticker": "064350",
    "name": "현대로템",
    "market": "코스피"
  },
  {
    "ticker": "316140",
    "name": "우리금융지주",
    "market": "코스피"
  },
  {
    "ticker": "079550",
    "name": "LIG디펜스앤에어로스페이스",
    "market": "코스피"
  },
  {
    "ticker": "017670",
    "name": "SK텔레콤",
    "market": "코스피"
  },
  {
    "ticker": "267250",
    "name": "HD현대",
    "market": "코스피"
  },
  {
    "ticker": "011200",
    "name": "HMM",
    "market": "코스피"
  },
  {
    "ticker": "272210",
    "name": "한화시스템",
    "market": "코스피"
  },
  {
    "ticker": "307950",
    "name": "현대오토에버",
    "market": "코스피"
  },
  {
    "ticker": "360750",
    "name": "TIGER 미국S&P500",
    "market": "코스피"
  },
  {
    "ticker": "033780",
    "name": "KT&G",
    "market": "코스피"
  },
  {
    "ticker": "138040",
    "name": "메리츠금융지주",
    "market": "코스피"
  },
  {
    "ticker": "096770",
    "name": "SK이노베이션",
    "market": "코스피"
  },
  {
    "ticker": "003670",
    "name": "포스코퓨처엠",
    "market": "코스피"
  },
  {
    "ticker": "024110",
    "name": "기업은행",
    "market": "코스피"
  },
  {
    "ticker": "018260",
    "name": "삼성에스디에스",
    "market": "코스피"
  },
  {
    "ticker": "035720",
    "name": "카카오",
    "market": "코스피"
  },
  {
    "ticker": "003550",
    "name": "LG",
    "market": "코스피"
  },
  {
    "ticker": "086280",
    "name": "현대글로비스",
    "market": "코스피"
  },
  {
    "ticker": "000720",
    "name": "현대건설",
    "market": "코스피"
  },
  {
    "ticker": "047810",
    "name": "한국항공우주",
    "market": "코스피"
  },
  {
    "ticker": "278470",
    "name": "에이피알",
    "market": "코스피"
  },
  {
    "ticker": "030200",
    "name": "KT",
    "market": "코스피"
  },
  {
    "ticker": "071050",
    "name": "한국금융지주",
    "market": "코스피"
  },
  {
    "ticker": "396500",
    "name": "TIGER 반도체TOP10",
    "market": "코스피"
  },
  {
    "ticker": "006260",
    "name": "LS",
    "market": "코스피"
  },
  {
    "ticker": "010950",
    "name": "S-Oil",
    "market": "코스피"
  },
  {
    "ticker": "102110",
    "name": "TIGER 200",
    "market": "코스피"
  },
  {
    "ticker": "005940",
    "name": "NH투자증권",
    "market": "코스피"
  },
  {
    "ticker": "133690",
    "name": "TIGER 미국나스닥100",
    "market": "코스피"
  },
  {
    "ticker": "323410",
    "name": "카카오뱅크",
    "market": "코스피"
  },
  {
    "ticker": "047050",
    "name": "포스코인터내셔널",
    "market": "코스피"
  },
  {
    "ticker": "443060",
    "name": "HD현대마린솔루션",
    "market": "코스피"
  },
  {
    "ticker": "047040",
    "name": "대우건설",
    "market": "코스피"
  },
  {
    "ticker": "122630",
    "name": "KODEX 레버리지",
    "market": "코스피"
  },
  {
    "ticker": "016360",
    "name": "삼성증권",
    "market": "코스피"
  },
  {
    "ticker": "028050",
    "name": "삼성E&A",
    "market": "코스피"
  },
  {
    "ticker": "259960",
    "name": "크래프톤",
    "market": "코스피"
  },
  {
    "ticker": "003490",
    "name": "대한항공",
    "market": "코스피"
  },
  {
    "ticker": "039490",
    "name": "키움증권",
    "market": "코스피"
  },
  {
    "ticker": "379800",
    "name": "KODEX 미국S&P500",
    "market": "코스피"
  },
  {
    "ticker": "005830",
    "name": "DB손해보험",
    "market": "코스피"
  },
  {
    "ticker": "352820",
    "name": "하이브",
    "market": "코스피"
  },
  {
    "ticker": "278530",
    "name": "KODEX 200TR",
    "market": "코스피"
  },
  {
    "ticker": "007660",
    "name": "이수페타시스",
    "market": "코스피"
  },
  {
    "ticker": "064400",
    "name": "LG씨엔에스",
    "market": "코스피"
  },
  {
    "ticker": "379810",
    "name": "KODEX 미국나스닥100",
    "market": "코스피"
  },
  {
    "ticker": "005387",
    "name": "현대차2우B",
    "market": "코스피"
  },
  {
    "ticker": "000880",
    "name": "한화",
    "market": "코스피"
  },
  {
    "ticker": "161390",
    "name": "한국타이어앤테크놀로지",
    "market": "코스피"
  },
  {
    "ticker": "003230",
    "name": "삼양식품",
    "market": "코스피"
  },
  {
    "ticker": "180640",
    "name": "한진칼",
    "market": "코스피"
  },
  {
    "ticker": "353200",
    "name": "대덕전자",
    "market": "코스피"
  },
  {
    "ticker": "488770",
    "name": "KODEX 머니마켓액티브",
    "market": "코스피"
  },
  {
    "ticker": "001440",
    "name": "대한전선",
    "market": "코스피"
  },
  {
    "ticker": "062040",
    "name": "산일전기",
    "market": "코스피"
  },
  {
    "ticker": "267270",
    "name": "HD건설기계",
    "market": "코스피"
  },
  {
    "ticker": "078930",
    "name": "GS",
    "market": "코스피"
  },
  {
    "ticker": "009830",
    "name": "한화솔루션",
    "market": "코스피"
  },
  {
    "ticker": "091160",
    "name": "KODEX 반도체",
    "market": "코스피"
  },
  {
    "ticker": "004170",
    "name": "신세계",
    "market": "코스피"
  },
  {
    "ticker": "498400",
    "name": "KODEX 200타겟위클리커버드콜",
    "market": "코스피"
  },
  {
    "ticker": "011790",
    "name": "SKC",
    "market": "코스피"
  },
  {
    "ticker": "381180",
    "name": "TIGER 미국필라델피아반도체나스닥",
    "market": "코스피"
  },
  {
    "ticker": "459580",
    "name": "KODEX CD금리액티브(합성)",
    "market": "코스피"
  },
  {
    "ticker": "454910",
    "name": "두산로보틱스",
    "market": "코스피"
  },
  {
    "ticker": "034220",
    "name": "LG디스플레이",
    "market": "코스피"
  },
  {
    "ticker": "326030",
    "name": "SK바이오팜",
    "market": "코스피"
  },
  {
    "ticker": "032640",
    "name": "LG유플러스",
    "market": "코스피"
  },
  {
    "ticker": "000990",
    "name": "DB하이텍",
    "market": "코스피"
  },
  {
    "ticker": "241560",
    "name": "두산밥캣",
    "market": "코스피"
  },
  {
    "ticker": "090430",
    "name": "아모레퍼시픽",
    "market": "코스피"
  },
  {
    "ticker": "021240",
    "name": "코웨이",
    "market": "코스피"
  },
  {
    "ticker": "377300",
    "name": "카카오페이",
    "market": "코스피"
  },
  {
    "ticker": "310970",
    "name": "TIGER MSCI Korea TR",
    "market": "코스피"
  },
  {
    "ticker": "000100",
    "name": "유한양행",
    "market": "코스피"
  },
  {
    "ticker": "029780",
    "name": "삼성카드",
    "market": "코스피"
  },
  {
    "ticker": "010060",
    "name": "OCI홀딩스",
    "market": "코스피"
  },
  {
    "ticker": "005385",
    "name": "현대차우",
    "market": "코스피"
  },
  {
    "ticker": "066970",
    "name": "엘앤에프",
    "market": "코스피"
  },
  {
    "ticker": "138930",
    "name": "BNK금융지주",
    "market": "코스피"
  },
  {
    "ticker": "036570",
    "name": "NC",
    "market": "코스피"
  },
  {
    "ticker": "023530",
    "name": "롯데쇼핑",
    "market": "코스피"
  },
  {
    "ticker": "128940",
    "name": "한미약품",
    "market": "코스피"
  },
  {
    "ticker": "001040",
    "name": "CJ",
    "market": "코스피"
  },
  {
    "ticker": "018880",
    "name": "한온시스템",
    "market": "코스피"
  },
  {
    "ticker": "175330",
    "name": "JB금융지주",
    "market": "코스피"
  },
  {
    "ticker": "148020",
    "name": "RISE 200",
    "market": "코스피"
  },
  {
    "ticker": "271560",
    "name": "오리온",
    "market": "코스피"
  },
  {
    "ticker": "229200",
    "name": "KODEX 코스닥150",
    "market": "코스피"
  },
  {
    "ticker": "088980",
    "name": "맥쿼리인프라",
    "market": "코스피"
  },
  {
    "ticker": "052690",
    "name": "한전기술",
    "market": "코스피"
  },
  {
    "ticker": "196170",
    "name": "알테오젠",
    "market": "코스닥"
  },
  {
    "ticker": "247540",
    "name": "에코프로비엠",
    "market": "코스닥"
  },
  {
    "ticker": "086520",
    "name": "에코프로",
    "market": "코스닥"
  },
  {
    "ticker": "277810",
    "name": "레인보우로보틱스",
    "market": "코스닥"
  },
  {
    "ticker": "036930",
    "name": "주성엔지니어링",
    "market": "코스닥"
  },
  {
    "ticker": "950160",
    "name": "코오롱티슈진",
    "market": "코스닥"
  },
  {
    "ticker": "240810",
    "name": "원익IPS",
    "market": "코스닥"
  },
  {
    "ticker": "058470",
    "name": "리노공업",
    "market": "코스닥"
  },
  {
    "ticker": "028300",
    "name": "HLB",
    "market": "코스닥"
  },
  {
    "ticker": "000250",
    "name": "삼천당제약",
    "market": "코스닥"
  },
  {
    "ticker": "039030",
    "name": "이오테크닉스",
    "market": "코스닥"
  },
  {
    "ticker": "298380",
    "name": "에이비엘바이오",
    "market": "코스닥"
  },
  {
    "ticker": "403870",
    "name": "HPSP",
    "market": "코스닥"
  },
  {
    "ticker": "087010",
    "name": "펩트론",
    "market": "코스닥"
  },
  {
    "ticker": "141080",
    "name": "리가켐바이오",
    "market": "코스닥"
  },
  {
    "ticker": "440110",
    "name": "파두",
    "market": "코스닥"
  },
  {
    "ticker": "222800",
    "name": "심텍",
    "market": "코스닥"
  },
  {
    "ticker": "178320",
    "name": "서진시스템",
    "market": "코스닥"
  },
  {
    "ticker": "319660",
    "name": "피에스케이",
    "market": "코스닥"
  },
  {
    "ticker": "108490",
    "name": "로보티즈",
    "market": "코스닥"
  },
  {
    "ticker": "095340",
    "name": "ISC",
    "market": "코스닥"
  },
  {
    "ticker": "084370",
    "name": "유진테크",
    "market": "코스닥"
  },
  {
    "ticker": "214370",
    "name": "케어젠",
    "market": "코스닥"
  },
  {
    "ticker": "319400",
    "name": "현대무벡스",
    "market": "코스닥"
  },
  {
    "ticker": "347850",
    "name": "디앤디파마텍",
    "market": "코스닥"
  },
  {
    "ticker": "310210",
    "name": "보로노이",
    "market": "코스닥"
  },
  {
    "ticker": "080220",
    "name": "제주반도체",
    "market": "코스닥"
  },
  {
    "ticker": "067310",
    "name": "하나마이크론",
    "market": "코스닥"
  },
  {
    "ticker": "095610",
    "name": "테스",
    "market": "코스닥"
  },
  {
    "ticker": "005290",
    "name": "동진쎄미켐",
    "market": "코스닥"
  },
  {
    "ticker": "064760",
    "name": "티씨케이",
    "market": "코스닥"
  },
  {
    "ticker": "214450",
    "name": "파마리서치",
    "market": "코스닥"
  },
  {
    "ticker": "010170",
    "name": "대한광통신",
    "market": "코스닥"
  },
  {
    "ticker": "145020",
    "name": "휴젤",
    "market": "코스닥"
  },
  {
    "ticker": "357780",
    "name": "솔브레인",
    "market": "코스닥"
  },
  {
    "ticker": "214150",
    "name": "클래시스",
    "market": "코스닥"
  },
  {
    "ticker": "131970",
    "name": "두산테스나",
    "market": "코스닥"
  },
  {
    "ticker": "043260",
    "name": "성호전자",
    "market": "코스닥"
  },
  {
    "ticker": "131290",
    "name": "티에스이",
    "market": "코스닥"
  },
  {
    "ticker": "032820",
    "name": "우리기술",
    "market": "코스닥"
  },
  {
    "ticker": "031980",
    "name": "피에스케이홀딩스",
    "market": "코스닥"
  },
  {
    "ticker": "226950",
    "name": "올릭스",
    "market": "코스닥"
  },
  {
    "ticker": "237690",
    "name": "에스티팜",
    "market": "코스닥"
  },
  {
    "ticker": "263750",
    "name": "펄어비스",
    "market": "코스닥"
  },
  {
    "ticker": "098460",
    "name": "고영",
    "market": "코스닥"
  },
  {
    "ticker": "257720",
    "name": "실리콘투",
    "market": "코스닥"
  },
  {
    "ticker": "089970",
    "name": "브이엠",
    "market": "코스닥"
  },
  {
    "ticker": "183300",
    "name": "코미코",
    "market": "코스닥"
  },
  {
    "ticker": "089030",
    "name": "테크윙",
    "market": "코스닥"
  },
  {
    "ticker": "218410",
    "name": "RFHIC",
    "market": "코스닥"
  },
  {
    "ticker": "082920",
    "name": "비츠로셀",
    "market": "코스닥"
  },
  {
    "ticker": "058610",
    "name": "에스피지",
    "market": "코스닥"
  },
  {
    "ticker": "290650",
    "name": "엘앤씨바이오",
    "market": "코스닥"
  },
  {
    "ticker": "083650",
    "name": "비에이치아이",
    "market": "코스닥"
  },
  {
    "ticker": "030530",
    "name": "원익홀딩스",
    "market": "코스닥"
  },
  {
    "ticker": "078600",
    "name": "대주전자재료",
    "market": "코스닥"
  },
  {
    "ticker": "035900",
    "name": "JYP Ent.",
    "market": "코스닥"
  },
  {
    "ticker": "007390",
    "name": "네이처셀",
    "market": "코스닥"
  },
  {
    "ticker": "068760",
    "name": "셀트리온제약",
    "market": "코스닥"
  },
  {
    "ticker": "140410",
    "name": "메지온",
    "market": "코스닥"
  },
  {
    "ticker": "041510",
    "name": "에스엠",
    "market": "코스닥"
  },
  {
    "ticker": "420770",
    "name": "기가비스",
    "market": "코스닥"
  },
  {
    "ticker": "140860",
    "name": "파크시스템스",
    "market": "코스닥"
  },
  {
    "ticker": "347700",
    "name": "스피어",
    "market": "코스닥"
  },
  {
    "ticker": "060370",
    "name": "LS마린솔루션",
    "market": "코스닥"
  },
  {
    "ticker": "437730",
    "name": "삼현",
    "market": "코스닥"
  },
  {
    "ticker": "100790",
    "name": "미래에셋벤처투자",
    "market": "코스닥"
  },
  {
    "ticker": "323280",
    "name": "태성",
    "market": "코스닥"
  },
  {
    "ticker": "031330",
    "name": "에스에이엠티",
    "market": "코스닥"
  },
  {
    "ticker": "096530",
    "name": "씨젠",
    "market": "코스닥"
  },
  {
    "ticker": "039200",
    "name": "오스코텍",
    "market": "코스닥"
  },
  {
    "ticker": "476830",
    "name": "알지노믹스",
    "market": "코스닥"
  },
  {
    "ticker": "166090",
    "name": "하나머티리얼즈",
    "market": "코스닥"
  },
  {
    "ticker": "475830",
    "name": "오름테라퓨틱",
    "market": "코스닥"
  },
  {
    "ticker": "101490",
    "name": "에스앤에스텍",
    "market": "코스닥"
  },
  {
    "ticker": "090710",
    "name": "휴림로봇",
    "market": "코스닥"
  },
  {
    "ticker": "232140",
    "name": "와이씨",
    "market": "코스닥"
  },
  {
    "ticker": "127120",
    "name": "제이에스링크",
    "market": "코스닥"
  },
  {
    "ticker": "038500",
    "name": "삼표시멘트",
    "market": "코스닥"
  },
  {
    "ticker": "003380",
    "name": "하림지주",
    "market": "코스닥"
  },
  {
    "ticker": "458870",
    "name": "씨어스",
    "market": "코스닥"
  },
  {
    "ticker": "417200",
    "name": "LS머트리얼즈",
    "market": "코스닥"
  },
  {
    "ticker": "099320",
    "name": "쎄트렉아이",
    "market": "코스닥"
  },
  {
    "ticker": "195940",
    "name": "HK이노엔",
    "market": "코스닥"
  },
  {
    "ticker": "036540",
    "name": "SFA반도체",
    "market": "코스닥"
  },
  {
    "ticker": "065350",
    "name": "신성델타테크",
    "market": "코스닥"
  },
  {
    "ticker": "085660",
    "name": "차바이오텍",
    "market": "코스닥"
  },
  {
    "ticker": "281740",
    "name": "레이크머티리얼즈",
    "market": "코스닥"
  },
  {
    "ticker": "032500",
    "name": "케이엠더블유",
    "market": "코스닥"
  },
  {
    "ticker": "491000",
    "name": "리브스메드",
    "market": "코스닥"
  }
];

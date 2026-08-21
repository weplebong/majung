// 인천공항 도착편 조회 — 공용 로직
//
// 웹 화면(api/arrival.js)과 MCP 서버(api/mcp.js)가 함께 씁니다.
//
// 실사로 확인된 사실 (2026-08-20):
// - 상위 API(getPassengerArrivalsDeOdp)는 from_time/to_time 을 실제로
//   필터링하지 않습니다. 무엇을 넣어도 조회일 기준 D-3~D+6(약 10일치, 1만 건
//   가까이)을 그대로 돌려주고, scheduleDatetime 오름차순으로 정렬돼 있습니다.
// - 그래서 원하는 구간은 이 모듈에서 걸러냅니다. 전체를 다 받으면 페이지당
//   500건이라 매 호출마다 상위 API를 최대 20번씩 불러야 하고, 정보나루
//   계정의 하루 호출 한도를 금방 소진합니다. 대신 오름차순 정렬을 이용해
//   날짜 경계를 이진 탐색으로 찾고, 그 지점부터만 순차로 읽어 목표 구간을
//   벗어나면 바로 멈춥니다.
// - 환경변수: ODP_SERVICE_KEY (공공데이터포털 일반 인증키 Decoding 값)

export const BASE =
  "http://apis.data.go.kr/B551177/StatusOfPassengerFlightsDeOdp/getPassengerArrivalsDeOdp";

export const PAGE_SIZE = 500;
const MAX_SCAN_PAGES = 8; // 목표 구간을 벗어나면 즉시 멈추므로 안전장치 성격

// 공공데이터 응답의 키 표기가 문서와 다를 때가 있어 후보를 여러 개 둡니다.
export const FIELDS = {
  flightId: ["flightId", "flight_id", "flightid"],
  airline: ["airline", "airlineKorean", "airline_korean"],
  origin: ["airport", "city", "airportKorean", "origin"],
  scheduled: ["scheduleDatetime", "scheduleDateTime", "schedule_datetime", "std"],
  estimated: ["estimatedDatetime", "estimatedDateTime", "estimated_datetime", "eta"],
  terminal: ["terminalid", "terminalId", "terminal"],
  gate: ["gatenumber", "gateNumber", "gate"],
  carousel: ["carousel", "carousels", "baggage"],
  exit: ["exitnumber", "exitNumber", "exit"],
  status: ["remark", "status", "remarkKorean"],
  codeshare: ["codeshare", "codeShare", "masterFlightId", "masterflightid"],
};

export function pick(row, candidates) {
  for (const key of candidates) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== "") {
      return String(row[key]).trim();
    }
  }
  // 대소문자 무시하고 한 번 더
  const lower = {};
  for (const k of Object.keys(row)) lower[k.toLowerCase()] = row[k];
  for (const key of candidates) {
    const v = lower[key.toLowerCase()];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

export function normalize(row) {
  const out = { raw: row };
  for (const [name, candidates] of Object.entries(FIELDS)) {
    out[name] = pick(row, candidates);
  }
  return out;
}

// "202608191635" -> "16:35"
export function hhmm(v) {
  if (!v) return "";
  const digits = v.replace(/\D/g, "");
  if (digits.length >= 12) return `${digits.slice(8, 10)}:${digits.slice(10, 12)}`;
  if (digits.length === 4) return `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
  return v;
}

// "202608191635" -> "2026-08-19 16:35"
export function fmtFull(v) {
  const digits = (v || "").replace(/\D/g, "");
  if (digits.length < 12) return "";
  return (
    `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)} ` +
    `${digits.slice(8, 10)}:${digits.slice(10, 12)}`
  );
}

function toEpochMinutes(v) {
  const d = (v || "").replace(/\D/g, "");
  if (d.length < 12) return null;
  return (
    Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(8, 10), +d.slice(10, 12)) /
    60000
  );
}

// 실제도착시각(변경시각 우선)이 예정시각보다 몇 분 늦었는지. 이르면 음수,
// 같거나 판단 불가면 0. scheduled/actual 모두 KST 벽시계 기준 문자열이라
// Date.UTC 로 파싱해도 두 값의 차이는 타임존과 무관하게 정확합니다.
function delayMinutes(scheduled, actual) {
  const s = toEpochMinutes(scheduled);
  const a = toEpochMinutes(actual);
  return s == null || a == null ? 0 : a - s;
}

// 편명 비교용: 공백/0 제거. "VN0414", "VN 414", "vn414" 를 모두 같게 봅니다.
export function flightKey(v) {
  const s = (v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const m = s.match(/^([A-Z0-9]{2,3}?)0*(\d+)$/);
  return m ? `${m[1]}${m[2]}` : s;
}

// P01/P02/P03 -> T1/탑승동/T2
const TERMINAL_LABELS = { P01: "T1", P02: "탑승동", P03: "T2" };
export function terminalLabel(code) {
  return TERMINAL_LABELS[code] || code || "";
}
// UI 에서 T1/T2 로 필터링할 때 쓰는 역변환
const TERMINAL_CODES = { T1: "P01", T2: "P03" };
export function terminalCode(label) {
  return TERMINAL_CODES[(label || "").toUpperCase()] || "";
}

// airline 필터: 입력이 영문 2~3자면 편명 접두어로 먼저 매칭하고,
// 결과가 없으면(또는 애초에 영문 2~3자가 아니면) 항공사명 부분일치로 본다.
export function filterByAirline(rows, airline) {
  const q = (airline || "").trim();
  if (!q) return rows;
  if (/^[A-Za-z]{2,3}$/.test(q)) {
    const prefix = q.toUpperCase();
    const byPrefix = rows.filter((r) => r.flightId.toUpperCase().startsWith(prefix));
    if (byPrefix.length) return byPrefix;
  }
  return rows.filter((r) => r.airline.includes(q));
}

// Asia/Seoul 기준 날짜/시각 파트. 서버는 UTC 로 도는 경우가 많아 new Date() 를
// 그대로 쓰면 안 되고 타임존 변환이 필요합니다.
export function kstParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const o = {};
  for (const p of parts) if (p.type !== "literal") o[p.type] = p.value;
  return o;
}

// yyyyMMddHHmm (API 의 scheduleDatetime 표기와 동일한 12자리 형식)
export function fmt12(parts) {
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}`;
}

export function dayOf(v) {
  return (v || "").slice(0, 8);
}

export class UpstreamParseError extends Error {
  constructor(detail) {
    super("UPSTREAM_NOT_JSON");
    this.detail = detail;
  }
}

async function fetchPage(baseParams, pageNo) {
  const params = new URLSearchParams(baseParams);
  params.set("pageNo", String(pageNo));
  const url = `${BASE}?${params.toString()}`;

  const upstream = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await upstream.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // 인증 실패 등은 XML 로 돌아옵니다.
    throw new UpstreamParseError(text.slice(0, 500));
  }

  const body = json?.response?.body ?? json?.body ?? {};
  let items = body?.items ?? [];
  if (items && items.item) items = items.item;
  if (!Array.isArray(items)) items = items ? [items] : [];

  const totalCount = Number(body?.totalCount ?? items.length) || items.length;
  return { items, totalCount };
}

const rowDay = (row) => dayOf(pick(row, FIELDS.scheduled));

// scheduleDatetime 오름차순 정렬을 전제로, [startDay, endDay] 구간의 원본 행만
// 모아서 반환합니다. 목표 구간 앞부분은 이진 탐색으로 건너뛰고, 구간을 벗어나는
// 순간 바로 멈춰서 상위 API 호출 횟수를 최소화합니다.
export async function fetchWindow(baseParams, startDay, endDay) {
  const first = await fetchPage(baseParams, 1);
  if (first.items.length === 0) return [];

  const totalPages = Math.max(1, Math.ceil(first.totalCount / PAGE_SIZE));
  const cache = new Map([[1, first.items]]);
  const pageItems = async (p) => {
    if (!cache.has(p)) {
      const r = await fetchPage(baseParams, p);
      cache.set(p, r.items);
    }
    return cache.get(p);
  };

  let lo = 1;
  let hi = totalPages;
  let startPage = totalPages;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const items = await pageItems(mid);
    if (!items.length) {
      hi = mid - 1;
      continue;
    }
    if (rowDay(items[0]) >= startDay) {
      startPage = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  const collected = [];
  const scanLimit = Math.min(totalPages, startPage + MAX_SCAN_PAGES);
  for (let p = startPage; p <= scanLimit; p++) {
    const items = await pageItems(p);
    if (!items.length) break;
    let pastEnd = false;
    for (const row of items) {
      const d = rowDay(row);
      if (d > endDay) {
        pastEnd = true;
        break;
      }
      if (d >= startDay) collected.push(row);
    }
    if (pastEnd) break;
  }
  return collected;
}

function buildBaseParams(key, terminal) {
  const baseParams = {
    serviceKey: key,
    type: "json",
    numOfRows: String(PAGE_SIZE),
    lang: "K",
  };
  if (terminal) baseParams.terminal_id = terminal;
  return baseParams;
}

// 실제도착시각: 변경시각(estimated)이 있으면 그걸, 없으면 예정시각(scheduled).
// queryWindow 의 창 필터와 listUpcoming 의 정렬이 공유하는 기준이라 여기서
// 한 번만 계산해 둡니다.
function toRows(raw) {
  return raw.map(normalize).map((r) => {
    const actual = r.estimated || r.scheduled;
    return {
      ...r,
      scheduledText: hhmm(r.scheduled),
      estimatedText: hhmm(r.estimated),
      actual,
      actualText: hhmm(actual),
      delayMinutes: delayMinutes(r.scheduled, actual),
    };
  });
}

// 코드셰어 중복 제거: codeshare 가 없거나 "Master" 인 행만 남깁니다.
// (같은 편에 대해 codeshare 행은 codeshare 필드에 마스터 편명이 들어있습니다.)
function masterOnly(rows) {
  return rows.filter((r) => !r.codeshare || r.codeshare === "Master");
}

// [fromFull, toFull] (yyyyMMddHHmm) 구간의 도착편을 그대로 반환합니다.
// 웹 화면(api/arrival.js)이 쓰는 원본 형태 그대로 — raw 필드 포함.
export async function queryWindow({ key, fromFull, toFull, terminal }) {
  const baseParams = buildBaseParams(key, terminal);
  const raw = await fetchWindow(baseParams, dayOf(fromFull), dayOf(toFull));
  return toRows(raw).filter((r) => r.actual && r.actual >= fromFull && r.actual <= toFull);
}

// 편명으로 검색. days 는 오늘부터 며칠치를 뒤질지 (기본 2일 = 오늘+내일).
// 같은 편명이 창 안에 여러 번 나오면(매일 운항) 지금 시각에 가장 가까운
// 미래 편을 우선하고, 없으면 가장 최근 편을 돌려줍니다.
export async function findByFlight({ key, flightId, days = 2, now = new Date() }) {
  const startDay = dayOf(fmt12(kstParts(now)));
  const endDayDate = new Date(now.getTime() + (days - 1) * 24 * 60 * 60 * 1000);
  const endDay = dayOf(fmt12(kstParts(endDayDate)));

  const baseParams = buildBaseParams(key);
  const raw = await fetchWindow(baseParams, startDay, endDay);
  const want = flightKey(flightId);

  const matches = toRows(raw).filter(
    (r) => flightKey(r.flightId) === want || flightKey(r.codeshare) === want
  );
  if (!matches.length) return null;

  matches.sort((a, b) => (a.scheduled || "").localeCompare(b.scheduled || ""));
  const nowFull = fmt12(kstParts(now));
  const upcoming = matches.find((r) => (r.estimated || r.scheduled) >= nowFull);
  return upcoming || matches[matches.length - 1];
}

// withinMinutes 분 안에 도착하는 편 목록. 국내선/코드셰어 중복은 제외하고,
// origin(부분일치)·terminal(T1/T2)·airline(항공사명 부분일치 또는 편명 접두어)
// 으로 추가로 걸러낼 수 있습니다.
export async function listUpcoming({ key, withinMinutes = 120, origin, terminal, airline, now = new Date() }) {
  const fromFull = fmt12(kstParts(now));
  const toFull = fmt12(kstParts(new Date(now.getTime() + withinMinutes * 60 * 1000)));

  let rows = await queryWindow({ key, fromFull, toFull });
  rows = masterOnly(rows).filter((r) => r.exit !== "국내선");

  if (origin) {
    rows = rows.filter((r) => r.origin.includes(origin));
  }
  if (terminal) {
    const code = terminalCode(terminal);
    if (code) rows = rows.filter((r) => r.terminal === code);
  }
  if (airline) {
    rows = filterByAirline(rows, airline);
  }

  rows.sort((a, b) => a.actual.localeCompare(b.actual));
  return rows;
}

// MCP 툴 출력 형식(두 툴 공통) — raw 필드는 빼고 지정된 한글 필드만.
export function toMcpRow(r) {
  return {
    편명: r.flightId,
    항공사: r.airline,
    출발지: r.origin,
    예정시각: fmtFull(r.scheduled) || r.scheduledText || "-",
    변경시각: fmtFull(r.estimated) || r.estimatedText || "-",
    실제도착시각: fmtFull(r.actual) || r.actualText || "-",
    지연여부: r.delayMinutes,
    터미널: terminalLabel(r.terminal) || "-",
    도착게이트: r.gate || "-",
    수하물수취대: r.carousel || "-",
    입국장출구: r.exit || "미배정",
    운항상태: r.status || "-",
  };
}

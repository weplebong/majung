// 인천공항 도착편 조회 프록시
//
// 브라우저에서 apis.data.go.kr 을 직접 부르면 CORS 로 막힙니다.
// 서비스키도 프론트에 노출되면 안 되므로 서버에서 대신 호출합니다.
//
// 환경변수: ODP_SERVICE_KEY (공공데이터포털 일반 인증키 Decoding 값)
//
// 실사로 확인된 사실 (2026-08-20):
// - 이 API 는 from_time/to_time 을 실제로 필터링하지 않습니다. 무엇을 넣어도
//   조회일 기준 D-3~D+6 전체(약 10일치, 1만 건 가까이)를 그대로 돌려주고,
//   scheduleDatetime 오름차순으로 정렬돼 있습니다.
// - 그래서 우리가 원하는 시간대는 서버(이 프록시)에서 걸러내야 합니다.
//   전체를 다 받으면 페이지당 500건이라 매 요청마다 최대 20번씩 상위 API를
//   불러야 하고, 정보나루 계정의 하루 호출 한도를 금방 소진합니다.
//   대신 오름차순 정렬을 이용해 날짜 경계를 이진 탐색으로 찾고, 그 지점부터만
//   순차로 읽어 목표 구간을 벗어나면 바로 멈춥니다.

const BASE =
  "http://apis.data.go.kr/B551177/StatusOfPassengerFlightsDeOdp/getPassengerArrivalsDeOdp";

const PAGE_SIZE = 500;
const MAX_SCAN_PAGES = 8; // 목표 구간을 벗어나면 즉시 멈추므로 안전장치 성격

// 공공데이터 응답의 키 표기가 문서와 다를 때가 있어 후보를 여러 개 둡니다.
const FIELDS = {
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

function pick(row, candidates) {
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

function normalize(row) {
  const out = { raw: row };
  for (const [name, candidates] of Object.entries(FIELDS)) {
    out[name] = pick(row, candidates);
  }
  return out;
}

// "202608191635" -> "16:35"
function hhmm(v) {
  if (!v) return "";
  const digits = v.replace(/\D/g, "");
  if (digits.length >= 12) return `${digits.slice(8, 10)}:${digits.slice(10, 12)}`;
  if (digits.length === 4) return `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
  return v;
}

// 편명 비교용: 공백/0 제거. "VN0414", "VN 414", "vn414" 를 모두 같게 봅니다.
function flightKey(v) {
  const s = (v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const m = s.match(/^([A-Z0-9]{2,3}?)0*(\d+)$/);
  return m ? `${m[1]}${m[2]}` : s;
}

// Asia/Seoul 기준 날짜/시각 파트. 서버는 UTC 로 도는 경우가 많아 new Date() 를
// 그대로 쓰면 안 되고 타임존 변환이 필요합니다.
function kstParts(date) {
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
function fmt12(parts) {
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}`;
}

function dayOf(v) {
  return (v || "").slice(0, 8);
}

class UpstreamParseError extends Error {
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
async function fetchWindow(baseParams, startDay, endDay) {
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

export default async function handler(req, res) {
  const key = process.env.ODP_SERVICE_KEY;
  if (!key) {
    return res.status(500).json({
      error: "서비스키가 설정되지 않았습니다.",
      hint: "Vercel 프로젝트 설정에서 환경변수 ODP_SERVICE_KEY 를 추가하세요.",
    });
  }

  const now = new Date();
  const { flight = "", from = "", to = "", terminal = "" } = req.query;

  // 기본값: Asia/Seoul 기준 지금부터 3시간 뒤까지. 쿼리로 명시하면 그대로 존중.
  const queryFrom = from || fmt12(kstParts(now));
  const queryTo = to || fmt12(kstParts(new Date(now.getTime() + 3 * 60 * 60 * 1000)));

  const baseParams = {
    serviceKey: key,
    type: "json",
    numOfRows: String(PAGE_SIZE),
    lang: "K",
  };
  if (terminal) baseParams.terminal_id = terminal;

  try {
    const raw = await fetchWindow(baseParams, dayOf(queryFrom), dayOf(queryTo));

    let rows = raw
      .map(normalize)
      .map((r) => ({
        ...r,
        scheduledText: hhmm(r.scheduled),
        estimatedText: hhmm(r.estimated),
      }))
      .filter((r) => {
        const t = r.estimated || r.scheduled;
        return t && t >= queryFrom && t <= queryTo;
      });

    if (flight) {
      const want = flightKey(flight);
      rows = rows.filter(
        (r) => flightKey(r.flightId) === want || flightKey(r.codeshare) === want
      );
    }

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=30");
    return res.status(200).json({
      fetchedAt: now.toISOString(),
      queriedFrom: queryFrom,
      queriedTo: queryTo,
      count: rows.length,
      rows,
    });
  } catch (err) {
    if (err instanceof UpstreamParseError) {
      return res.status(502).json({
        error: "응답을 JSON 으로 읽지 못했습니다.",
        detail: err.detail,
      });
    }
    return res.status(502).json({ error: "공공데이터포털 호출 실패", detail: String(err) });
  }
}

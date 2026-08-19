// 인천공항 도착편 조회 프록시
//
// 브라우저에서 apis.data.go.kr 을 직접 부르면 CORS 로 막힙니다.
// 서비스키도 프론트에 노출되면 안 되므로 서버에서 대신 호출합니다.
//
// 환경변수: ODP_SERVICE_KEY (공공데이터포털 일반 인증키 Decoding 값)

const BASE =
  "http://apis.data.go.kr/B551177/StatusOfPassengerFlightsDeOdp/getPassengerArrivalsDeOdp";

const PAGE_SIZE = 500;
const MAX_PAGES = 20; // 안전장치: 최대 10,000건

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

// numOfRows(500) 한 페이지로 잘리지 않도록 totalCount 를 보고 필요한 만큼 더 받아옵니다.
async function fetchAll(baseParams) {
  const all = [];
  let pageNo = 1;
  let totalCount = Infinity;

  while (all.length < totalCount && pageNo <= MAX_PAGES) {
    const { items, totalCount: tc } = await fetchPage(baseParams, pageNo);
    totalCount = tc;
    if (items.length === 0) break;
    all.push(...items);
    pageNo += 1;
  }

  return all;
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

  // 자정을 넘는 구간이면 오늘치/내일치로 나눠 각각 호출 후 합칩니다.
  const ranges =
    dayOf(queryFrom) === dayOf(queryTo)
      ? [{ from: queryFrom, to: queryTo }]
      : [
          { from: queryFrom, to: `${dayOf(queryFrom)}2359` },
          { from: `${dayOf(queryTo)}0000`, to: queryTo },
        ];

  try {
    const rawBatches = await Promise.all(
      ranges.map((r) => {
        const baseParams = {
          serviceKey: key,
          type: "json",
          numOfRows: String(PAGE_SIZE),
          lang: "K",
          from_time: r.from,
          to_time: r.to,
        };
        if (terminal) baseParams.terminal_id = terminal;
        return fetchAll(baseParams);
      })
    );

    let rows = rawBatches
      .flat()
      .map(normalize)
      .map((r) => ({
        ...r,
        scheduledText: hhmm(r.scheduled),
        estimatedText: hhmm(r.estimated),
      }));

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

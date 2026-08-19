// 인천공항 도착편 조회 프록시
//
// 브라우저에서 apis.data.go.kr 을 직접 부르면 CORS 로 막힙니다.
// 서비스키도 프론트에 노출되면 안 되므로 서버에서 대신 호출합니다.
//
// 환경변수: ODP_SERVICE_KEY (공공데이터포털 일반 인증키 Decoding 값)

const BASE =
  "http://apis.data.go.kr/B551177/StatusOfPassengerFlightsDeOdp/getPassengerArrivalsDeOdp";

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

export default async function handler(req, res) {
  const key = process.env.ODP_SERVICE_KEY;
  if (!key) {
    return res.status(500).json({
      error: "서비스키가 설정되지 않았습니다.",
      hint: "Vercel 프로젝트 설정에서 환경변수 ODP_SERVICE_KEY 를 추가하세요.",
    });
  }

  const { flight = "", from = "", to = "", terminal = "" } = req.query;

  const params = new URLSearchParams({
    serviceKey: key,
    type: "json",
    numOfRows: "500",
    pageNo: "1",
    lang: "K",
  });
  if (from) params.set("from_time", from);
  if (to) params.set("to_time", to);
  if (terminal) params.set("terminal_id", terminal);

  const url = `${BASE}?${params.toString()}`;

  try {
    const upstream = await fetch(url, { headers: { Accept: "application/json" } });
    const text = await upstream.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      // 인증 실패 등은 XML 로 돌아옵니다.
      return res.status(502).json({
        error: "응답을 JSON 으로 읽지 못했습니다.",
        detail: text.slice(0, 500),
      });
    }

    const body = json?.response?.body ?? json?.body ?? {};
    let items = body?.items ?? [];
    if (items && items.item) items = items.item;
    if (!Array.isArray(items)) items = items ? [items] : [];

    let rows = items.map(normalize).map((r) => ({
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

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json({ count: rows.length, rows });
  } catch (err) {
    return res.status(502).json({ error: "공공데이터포털 호출 실패", detail: String(err) });
  }
}

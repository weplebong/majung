// 인천공항 도착편 조회 프록시
//
// 브라우저에서 apis.data.go.kr 을 직접 부르면 CORS 로 막힙니다.
// 서비스키도 프론트에 노출되면 안 되므로 서버에서 대신 호출합니다.
// 실제 조회 로직은 lib/arrivals.js 에 있고, MCP 서버(api/mcp.js)와 공유합니다.

import { kstParts, fmt12, flightKey, queryWindow, UpstreamParseError } from "../lib/arrivals.js";

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

  try {
    let rows = await queryWindow({ key, fromFull: queryFrom, toFull: queryTo, terminal });

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

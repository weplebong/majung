// 인천공항 도착편 MCP 서버
//
// 인증 없음 — 공공데이터 조회용이라 공개로 둡니다. OAuth 설정 없음.
// 실제 조회 로직은 lib/arrivals.js 를 웹 화면(api/arrival.js)과 공유합니다.

import { z } from "zod";
import { createMcpHandler } from "mcp-handler";
import { findByFlight, listUpcoming, toMcpRow } from "../lib/arrivals.js";

function noKeyResult() {
  return {
    content: [{ type: "text", text: "서비스키(ODP_SERVICE_KEY)가 설정되지 않았습니다." }],
    isError: true,
  };
}

function errorResult(err) {
  return {
    content: [{ type: "text", text: `조회 중 오류가 발생했습니다: ${String(err)}` }],
    isError: true,
  };
}

const handler = createMcpHandler(
  (server) => {
  server.tool(
    "searchArrivalByFlight",
    "인천공항에 도착하는 특정 항공편의 입국장 출구(A~F), 수하물 수취대 번호, 터미널, 예정/변경 도착시각, 운항상태를 조회한다. 마중 나갈 때 어느 출구 앞에서 기다려야 하는지 알고 싶을 때 사용한다. 편명을 알고 있을 때 쓴다.",
    {
      flightId: z
        .string()
        .describe('편명. 예: "KE1409", "TW248". 대소문자와 공백은 무시하고 매칭한다.'),
    },
    async ({ flightId }) => {
      const key = process.env.ODP_SERVICE_KEY;
      if (!key) return noKeyResult();
      try {
        const row = await findByFlight({ key, flightId, days: 2 });
        if (!row) {
          return {
            content: [
              { type: "text", text: `${flightId} 편을 찾을 수 없습니다. (오늘~내일 도착편 기준)` },
            ],
          };
        }
        return { content: [{ type: "text", text: JSON.stringify(toMcpRow(row), null, 2) }] };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "listUpcomingArrivals",
    "현재 시각 기준으로 곧 인천공항에 도착하는 항공편 목록을 조회한다. 편명을 모를 때, 또는 특정 도시에서 오는 편을 찾을 때 사용한다. 항공사로도 필터링할 수 있다.",
    {
      withinMinutes: z
        .number()
        .int()
        .min(1)
        .max(720)
        .optional()
        .describe("지금부터 몇 분 안에 도착하는 편까지 볼지. 기본 120."),
      origin: z.string().optional().describe('출발지 도시명 부분일치. 예: "도쿄", "홍콩".'),
      terminal: z.enum(["T1", "T2"]).optional().describe("터미널로 필터링."),
      airline: z
        .string()
        .optional()
        .describe('항공사명 부분일치 또는 편명 접두어. 예: "대한항공", "KE".'),
    },
    async ({ withinMinutes, origin, terminal, airline }) => {
      const key = process.env.ODP_SERVICE_KEY;
      if (!key) return noKeyResult();
      try {
        const rows = await listUpcoming({
          key,
          withinMinutes: withinMinutes ?? 120,
          origin,
          terminal,
          airline,
        });
        if (!rows.length) {
          const cond = [`withinMinutes=${withinMinutes ?? 120}`];
          if (origin) cond.push(`origin="${origin}"`);
          if (terminal) cond.push(`terminal=${terminal}`);
          if (airline) cond.push(`airline="${airline}"`);
          return {
            content: [
              {
                type: "text",
                text: `해당 조건(${cond.join(", ")})에 맞는 도착편을 찾을 수 없습니다. withinMinutes를 늘리면 나올 수 있습니다.`,
              },
            ],
          };
        }
        return { content: [{ type: "text", text: JSON.stringify(rows.map(toMcpRow), null, 2) }] };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
  },
  { serverInfo: { name: "majung-arrivals", version: "1.0.0" } },
  { basePath: "/api" }
);

export { handler as GET, handler as POST, handler as DELETE };

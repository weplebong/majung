#!/usr/bin/env python3
"""인천공항 도착편 조회 (CLI)

사용법:
    export ODP_SERVICE_KEY="공공데이터포털_일반인증키_Decoding값"
    python check_flight.py VN414

옵션:
    --raw   응답 원본 필드를 그대로 출력 (필드명 확인용)
"""

import os
import re
import sys
import json
import urllib.parse
import urllib.request

BASE = ("http://apis.data.go.kr/B551177/StatusOfPassengerFlightsDeOdp"
        "/getPassengerArrivalsDeOdp")

FIELDS = {
    "flightId":  ["flightId", "flight_id", "flightid"],
    "airline":   ["airline", "airlineKorean"],
    "origin":    ["airport", "city", "airportKorean"],
    "scheduled": ["scheduleDatetime", "scheduleDateTime", "std"],
    "estimated": ["estimatedDatetime", "estimatedDateTime", "eta"],
    "terminal":  ["terminalid", "terminalId", "terminal"],
    "gate":      ["gatenumber", "gateNumber", "gate"],
    "carousel":  ["carousel", "baggage"],
    "exit":      ["exitnumber", "exitNumber", "exit"],
    "status":    ["remark", "status"],
    "codeshare": ["codeshare", "masterFlightId", "masterflightid"],
}


def pick(row, keys):
    lower = {k.lower(): v for k, v in row.items()}
    for k in keys:
        v = row.get(k, lower.get(k.lower()))
        if v not in (None, ""):
            return str(v).strip()
    return ""


def hhmm(v):
    d = re.sub(r"\D", "", v or "")
    if len(d) >= 12:
        return f"{d[8:10]}:{d[10:12]}"
    if len(d) == 4:
        return f"{d[:2]}:{d[2:]}"
    return v or "—"


def flight_key(v):
    s = re.sub(r"[^A-Z0-9]", "", (v or "").upper())
    m = re.match(r"^([A-Z0-9]{2,3}?)0*(\d+)$", s)
    return f"{m.group(1)}{m.group(2)}" if m else s


def fetch(service_key):
    params = {
        "serviceKey": service_key,
        "type": "json",
        "numOfRows": "500",
        "pageNo": "1",
        "lang": "K",
    }
    url = f"{BASE}?{urllib.parse.urlencode(params)}"
    try:
        with urllib.request.urlopen(url, timeout=15) as res:
            text = res.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:600]
        if e.code == 403:
            raise SystemExit(
                "403 Forbidden — 서비스키가 올바르지 않거나 아직 승인 전입니다.\n"
                "Encoding 키가 아니라 Decoding 키를 넣었는지 확인하세요.\n\n"
                f"{body}"
            )
        raise SystemExit(f"HTTP {e.code} 오류\n\n{body}")
    except urllib.error.URLError as e:
        raise SystemExit(f"연결 실패: {e.reason}")

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        # 인증 오류는 XML 로 돌아옵니다.
        raise SystemExit(f"JSON 이 아닌 응답입니다. 서비스키를 확인하세요.\n\n{text[:600]}")

    items = (data.get("response", {}).get("body", {}) or data.get("body", {})).get("items", [])
    if isinstance(items, dict):
        items = items.get("item", [])
    if isinstance(items, dict):
        items = [items]
    return items or []


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    raw = "--raw" in sys.argv

    key = os.environ.get("ODP_SERVICE_KEY")
    if not key:
        raise SystemExit("환경변수 ODP_SERVICE_KEY 가 없습니다.")
    if not args:
        raise SystemExit("편명을 넣어주세요.  예)  python check_flight.py VN414")

    want = flight_key(args[0])
    rows = fetch(key)

    if raw and rows:
        print("── 응답 원본 필드 ──")
        print(json.dumps(rows[0], ensure_ascii=False, indent=2))
        print()

    hits = []
    for row in rows:
        r = {name: pick(row, keys) for name, keys in FIELDS.items()}
        if flight_key(r["flightId"]) == want or flight_key(r["codeshare"]) == want:
            hits.append(r)

    if not hits:
        print(f"{args[0]} 편이 목록에 없습니다.")
        print("이 API 는 지금 기준 앞뒤 2시간 안에 도착하는 편만 담습니다.")
        print(f"현재 조회된 편: {len(rows)}건")
        return

    for r in hits:
        exit_no = r["exit"] or "미배정"
        print()
        print(f"  {r['flightId']}   {r['origin']} → 인천")
        print("  " + "─" * 34)
        print(f"  입국장 출구   {exit_no}")
        print(f"  수하물 벨트   {r['carousel'] or '—'}")
        print(f"  터미널        {('제' + r['terminal'] + '여객터미널') if r['terminal'] else '—'}")
        print(f"  도착 게이트   {r['gate'] or '—'}")
        print(f"  예정 / 변경   {hhmm(r['scheduled'])}  /  {hhmm(r['estimated'])}")
        print(f"  현황          {r['status'] or '—'}")
        print()


if __name__ == "__main__":
    main()
#!/usr/bin/env python3
"""인천공항 도착편 조회 (CLI)

사용법:
    export ODP_SERVICE_KEY="공공데이터포털_일반인증키_Decoding값"
    python check_flight.py VN414

옵션:
    --raw   응답 원본 필드를 그대로 출력 (필드명 확인용)
"""

import os
import re
import sys
import json
import urllib.parse
import urllib.request

BASE = ("http://apis.data.go.kr/B551177/StatusOfPassengerFlightsDeOdp"
        "/getPassengerArrivalsDeOdp")

FIELDS = {
    "flightId":  ["flightId", "flight_id", "flightid"],
    "airline":   ["airline", "airlineKorean"],
    "origin":    ["airport", "city", "airportKorean"],
    "scheduled": ["scheduleDatetime", "scheduleDateTime", "std"],
    "estimated": ["estimatedDatetime", "estimatedDateTime", "eta"],
    "terminal":  ["terminalid", "terminalId", "terminal"],
    "gate":      ["gatenumber", "gateNumber", "gate"],
    "carousel":  ["carousel", "baggage"],
    "exit":      ["exitnumber", "exitNumber", "exit"],
    "status":    ["remark", "status"],
    "codeshare": ["codeshare", "masterFlightId", "masterflightid"],
}


def pick(row, keys):
    lower = {k.lower(): v for k, v in row.items()}
    for k in keys:
        v = row.get(k, lower.get(k.lower()))
        if v not in (None, ""):
            return str(v).strip()
    return ""


def hhmm(v):
    d = re.sub(r"\D", "", v or "")
    if len(d) >= 12:
        return f"{d[8:10]}:{d[10:12]}"
    if len(d) == 4:
        return f"{d[:2]}:{d[2:]}"
    return v or "—"


def flight_key(v):
    s = re.sub(r"[^A-Z0-9]", "", (v or "").upper())
    m = re.match(r"^([A-Z0-9]{2,3}?)0*(\d+)$", s)
    return f"{m.group(1)}{m.group(2)}" if m else s


def fetch(service_key):
    params = {
        "serviceKey": service_key,
        "type": "json",
        "numOfRows": "500",
        "pageNo": "1",
        "lang": "K",
    }
    url = f"{BASE}?{urllib.parse.urlencode(params)}"
    try:
        with urllib.request.urlopen(url, timeout=15) as res:
            text = res.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:600]
        if e.code == 403:
            raise SystemExit(
                "403 Forbidden — 서비스키가 올바르지 않거나 아직 승인 전입니다.\n"
                "Encoding 키가 아니라 Decoding 키를 넣었는지 확인하세요.\n\n"
                f"{body}"
            )
        raise SystemExit(f"HTTP {e.code} 오류\n\n{body}")
    except urllib.error.URLError as e:
        raise SystemExit(f"연결 실패: {e.reason}")

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        # 인증 오류는 XML 로 돌아옵니다.
        raise SystemExit(f"JSON 이 아닌 응답입니다. 서비스키를 확인하세요.\n\n{text[:600]}")

    items = (data.get("response", {}).get("body", {}) or data.get("body", {})).get("items", [])
    if isinstance(items, dict):
        items = items.get("item", [])
    if isinstance(items, dict):
        items = [items]
    return items or []


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    raw = "--raw" in sys.argv

    key = os.environ.get("ODP_SERVICE_KEY")
    if not key:
        raise SystemExit("환경변수 ODP_SERVICE_KEY 가 없습니다.")
    if not args:
        raise SystemExit("편명을 넣어주세요.  예)  python check_flight.py VN414")

    want = flight_key(args[0])
    rows = fetch(key)

    if raw and rows:
        print("── 응답 원본 필드 ──")
        print(json.dumps(rows[0], ensure_ascii=False, indent=2))
        print()

    hits = []
    for row in rows:
        r = {name: pick(row, keys) for name, keys in FIELDS.items()}
        if flight_key(r["flightId"]) == want or flight_key(r["codeshare"]) == want:
            hits.append(r)

    if not hits:
        print(f"{args[0]} 편이 목록에 없습니다.")
        print("이 API 는 지금 기준 앞뒤 2시간 안에 도착하는 펼만 담습니다.")
        print(f"현재 조회된 편: {len(rows)}건")
        return

    for r in hits:
        exit_no = r["exit"] or "미배정"
        print()
        print(f"  {r['flightId']}   {r['origin']} → 인천")
        print("  " + "─" * 34)
        print(f"  입국장 출구   {exit_no}")
        print(f"  수하물 벨트   {r['carousel'] or '—'}")
        print(f"  터미널        {('제' + r['terminal'] + '여객터미널') if r['terminal'] else '—'}")
        print(f"  도착 게이트   {r['gate'] or '—'}")
        print(f"  예정 / 변경   {hhmm(r['scheduled'])}  /  {hhmm(r['estimated'])}")
        print(f"  현황          {r['status'] or '—'}")
        print()


if __name__ == "__main__":
    main()

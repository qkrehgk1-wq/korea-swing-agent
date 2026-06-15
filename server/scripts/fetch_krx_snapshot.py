import json
import re
import sys
import urllib.request
from html import unescape


def parse_int(value: str):
    digits = re.sub(r"[^0-9-]", "", value or "")
    return int(digits) if digits else None


def search(pattern: str, html: str):
    match = re.search(pattern, html, re.DOTALL)
    if not match:
        return None
    return match.group(1).strip()


def normalize_market(value: str | None):
    if not value:
        return None
    if "코스피" in value or "KOSPI" in value:
        return "KOSPI"
    if "코스닥" in value or "KOSDAQ" in value:
        return "KOSDAQ"
    if "코넥스" in value or "KONEX" in value:
        return "KONEX"
    return None


def clean_text(value: str):
    text = re.sub(r"<[^>]+>", " ", value)
    text = unescape(text)
    text = text.replace("\xa0", " ").replace("&nbsp;", " ")
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def percent_change(base: int | None, current: int | None):
    if base in (None, 0) or current is None:
        return None
    return ((current - base) / base) * 100


def extract_financials(html: str):
    caption_index = html.find("기업실적분석 테이블")
    if caption_index < 0:
        return None

    section = html[caption_index:caption_index + 60000]
    thead_match = re.search(r"<thead>(.*?)</thead>", section, re.DOTALL)
    tbody_match = re.search(r"<tbody>(.*?)</tbody>", section, re.DOTALL)
    if not thead_match or not tbody_match:
        return None

    header_rows = re.findall(r"<tr.*?>(.*?)</tr>", thead_match.group(1), re.DOTALL)
    if len(header_rows) < 2:
        return None

    annual_headers = [
        clean_text(match)
        for match in re.findall(r"<th[^>]*scope=\"col\"[^>]*>(.*?)</th>", header_rows[1], re.DOTALL)
    ][:4]
    if len(annual_headers) < 2:
        return None

    def extract_annual_row(label: str):
        row_match = re.search(
            rf"<tr[^>]*>\s*<th[^>]*><strong>{re.escape(label)}</strong></th>(.*?)</tr>",
            tbody_match.group(1),
            re.DOTALL,
        )
        if not row_match:
            return []
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row_match.group(1), re.DOTALL)
        return [parse_int(clean_text(cell)) for cell in cells[:4]]

    revenue_values = extract_annual_row("매출액")
    operating_values = extract_annual_row("영업이익")
    net_income_values = extract_annual_row("당기순이익")

    actual_pairs = []
    for index, header in enumerate(annual_headers):
        if "(E)" in header:
            continue
        actual_pairs.append(
            {
                "header": header,
                "revenue": revenue_values[index] if index < len(revenue_values) else None,
                "operatingProfit": operating_values[index] if index < len(operating_values) else None,
                "netIncome": net_income_values[index] if index < len(net_income_values) else None,
            }
        )

    actual_pairs = [pair for pair in actual_pairs if any(pair[key] is not None for key in ["revenue", "operatingProfit", "netIncome"])]
    if len(actual_pairs) < 2:
        return None

    previous_pair = actual_pairs[-2]
    current_pair = actual_pairs[-1]
    current_year = current_pair["header"].split(".")[0]

    return {
        "year": current_year,
        "revenue": current_pair["revenue"] * 100000000 if current_pair["revenue"] is not None else None,
        "operatingProfit": current_pair["operatingProfit"] * 100000000 if current_pair["operatingProfit"] is not None else None,
        "netIncome": current_pair["netIncome"] * 100000000 if current_pair["netIncome"] is not None else None,
        "revenueYoY": percent_change(previous_pair["revenue"], current_pair["revenue"]),
        "operatingProfitYoY": percent_change(previous_pair["operatingProfit"], current_pair["operatingProfit"]),
        "netIncomeYoY": percent_change(previous_pair["netIncome"], current_pair["netIncome"]),
    }


def fetch_snapshot(ticker: str):
    url = f"https://finance.naver.com/item/main.naver?code={ticker}"
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})

    with urllib.request.urlopen(request, timeout=20) as response:
        html = response.read().decode("utf-8", errors="ignore")

    title = search(r"<title>\s*([^:<]+?)\s*:\s*Npay 증권\s*</title>", html)
    market_alt = search(r'alt="(코스피|코스닥|코넥스)"\s+class="kos', html)
    if market_alt is None:
        market_alt = search(r'alt="(코스피|코스닥|코넥스)"', html)

    market_cap_eok = search(r"시가총액\(억\)</span></th>\s*<td>([^<]+)</td>", html)
    shares_outstanding = search(r"상장주식수</th>\s*<td><em>([^<]+)</em></td>", html)
    par_value = search(r"액면가<span class=\"bar\">l</span>매매단위</th>\s*<td>\s*<em>([^<]+)</em>원", html)
    trading_value_million = search(r"거래대금\s*([^<]+?)백만</dd>", html)
    financials = extract_financials(html)

    return {
        "ticker": ticker,
        "companyName": title,
        "market": normalize_market(market_alt),
        "marketCategory": normalize_market(market_alt),
        "marketCap": parse_int(market_cap_eok) * 100000000 if parse_int(market_cap_eok) is not None else None,
        "tradingValue": parse_int(trading_value_million) * 1000000 if parse_int(trading_value_million) is not None else None,
        "sharesOutstanding": parse_int(shares_outstanding),
        "parValue": parse_int(par_value),
        "financials": financials,
    }


def main():
    tickers = [arg.strip() for arg in sys.argv[1:] if arg.strip()]
    payload = [fetch_snapshot(ticker) for ticker in tickers]
    if len(payload) == 1:
        print(json.dumps(payload[0], ensure_ascii=False))
        return
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()

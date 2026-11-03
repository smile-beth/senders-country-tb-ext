#!/usr/bin/env python3
"""Download the DB-IP Lite country CSV and convert it to the add-on's compact range index."""

import csv
import gzip
import io
import json
import sys
import urllib.request
from pathlib import Path
from io import TextIOWrapper


def parse_ip(value):
    import ipaddress

    address = ipaddress.ip_address(value)
    return address.version, int(address)


def main():
    if len(sys.argv) != 3:
        raise SystemExit("Usage: python scripts/update-db.py YEAR MONTH")
    year, month = sys.argv[1:]
    if not (year.isdigit() and len(year) == 4 and month.isdigit() and 1 <= int(month) <= 12):
        raise SystemExit("YEAR must be YYYY and MONTH must be 1-12")

    url = f"https://download.db-ip.com/free/dbip-country-lite-{year}-{int(month):02d}.csv.gz"
    request = urllib.request.Request(url, headers={"User-Agent": "ipaddr2country-thunderbird-addon/0.1"})
    with urllib.request.urlopen(request, timeout=90) as response:
        content = response.read()

    ranges = {4: [], 6: []}
    with gzip.GzipFile(fileobj=io.BytesIO(content)) as zipped:
        reader = csv.reader(TextIOWrapper(zipped, encoding="utf-8", errors="replace", newline=""))
        for row in reader:
            if len(row) < 3:
                continue
            try:
                first_version, first = parse_ip(row[0])
                last_version, last = parse_ip(row[1])
            except ValueError:
                continue
            if first_version != last_version:
                continue
            country = row[2].strip().upper()
            if len(country) != 2 or country == "--":
                continue
            if first > last:
                continue
            if first_version == 4:
                ranges[4].append([str(first), str(last), country])
            else:
                ranges[6].append([f"{first:032x}", f"{last:032x}", country])

    ranges[4].sort(key=lambda item: int(item[0]))
    ranges[6].sort(key=lambda item: item[0])

    total = len(ranges[4]) + len(ranges[6])
    if total == 0:
        raise SystemExit(
            "The downloaded CSV contained no valid IP ranges. DB-IP Lite country CSV rows use: "
            "ip_start,ip_end,country (for example, 8.8.8.0,8.8.8.255,US)."
        )

    destination = Path("data/ip-country.json")
    destination.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "source": "DB-IP Lite",
        "release": f"{year}-{int(month):02d}",
        "ipv4": ranges[4],
        "ipv6": ranges[6],
    }
    with destination.open("w", encoding="utf-8", newline="\n") as output:
        json.dump(payload, output, separators=(",", ":"))
        output.write("\n")
    print(f"Wrote {destination} ({len(ranges[4]):,} IPv4 and {len(ranges[6]):,} IPv6 ranges)")


if __name__ == "__main__":
    main()


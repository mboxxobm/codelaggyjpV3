#!/usr/bin/env python3
"""Convert a transaction-history CSV into chart marker data."""
from __future__ import annotations

import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

if len(sys.argv) != 3:
    raise SystemExit('Usage: import-actual-trades.py INPUT.csv OUTPUT.json')

rows = []
with open(sys.argv[1], encoding='utf-8-sig', newline='') as source:
    for row in csv.DictReader(source):
        if not row.get('symbol_code') or not row.get('trade_date'):
            continue
        def display_time(clock: str) -> int:
            return int(datetime.strptime(f"{row['trade_date']} {clock}", '%Y-%m-%d %H:%M').replace(tzinfo=timezone.utc).timestamp())
        rows.append({
            **row,
            'symbol_code': str(row['symbol_code']),
            'entry_side': str(row.get('entry_side', '')).upper(),
            'entry_display_time': display_time(row['entry_time']),
            'exit_display_time': display_time(row['exit_time']),
        })

Path(sys.argv[2]).write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'{len(rows)} trades → {sys.argv[2]}')

#!/usr/bin/env python3
"""Sync non-empty daily tick CSVs from the private Cloudflare R2 bucket.

Credentials are read only from environment variables and are never stored in
this project. Required: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

import boto3

if len(sys.argv) != 2 or not re.fullmatch(r'[0-9A-Za-z]{4}', sys.argv[1]):
    raise SystemExit('Usage: sync-private-r2-symbol.py 5803')

code = sys.argv[1].upper()
for name in ('R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT'):
    if not os.getenv(name):
        raise SystemExit(f'Missing {name}')

root = Path(__file__).resolve().parent
bucket = os.getenv('R2_BUCKET', 'jpayuminecsv')
s3 = boto3.client(
    's3', endpoint_url=os.environ['R2_ENDPOINT'], region_name='auto',
    aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
    aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
)

chosen: dict[str, dict] = {}
for page in s3.get_paginator('list_objects_v2').paginate(Bucket=bucket):
    for obj in page.get('Contents', []):
        match = re.search(rf'qr-{re.escape(code)}-(2026(?:0[5-8])\d{{2}})\.csv$', obj['Key'])
        if not match or obj['Size'] < 1024:
            continue
        date = match.group(1)
        if date not in chosen or obj['Size'] > chosen[date]['Size']:
            chosen[date] = obj

if not chosen:
    raise SystemExit(f'{code}: no non-empty CSVs found')

target = root / 'r2-downloads' / code
target.mkdir(parents=True, exist_ok=True)
for date, obj in sorted(chosen.items()):
    output = target / f'qr-{code}-{date}.csv'
    s3.download_file(bucket, obj['Key'], str(output))
    print(f'{date}: {obj["Size"]:,} bytes')

# Build a same-origin manifest; Safari can load these local files without CORS.
entries = []
for path in sorted(target.glob(f'qr-{code}-????????.csv')):
    match = re.search(r'-(2026\d{4})\.csv$', path.name)
    if match and path.stat().st_size >= 1024:
        entries.append({'code': code, 'date': match.group(1), 'key': str(path.relative_to(root)), 'size': path.stat().st_size})
manifest_path = root / 'local-r2-manifest.json'
try:
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
except (FileNotFoundError, json.JSONDecodeError):
    manifest = {'version': 1, 'publicBaseUrl': '.', 'files': []}
other = [row for row in manifest.get('files', []) if str(row.get('code')) != code]
manifest.update({'version': 1, 'publicBaseUrl': '.', 'files': sorted(other + entries, key=lambda row: (str(row['code']), row['date']))})
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
# Archive a single date-ordered CSV as well. The chart loads daily files for
# speed, while this file is convenient for backup and external analysis.
header = None
rows: list[str] = []
for item in entries:
    source = root / item['key']
    lines = [line for line in source.read_text(encoding='utf-8-sig').splitlines() if line.strip()]
    if not lines:
        continue
    if header is None:
        header = lines[0]
    rows.extend(lines[1:])
if header:
    archive = target / f'qr-{code}-{entries[0]["date"]}-{entries[-1]["date"]}-combined.csv'
    archive.write_text('\ufeff' + header + '\n' + '\n'.join(rows) + '\n', encoding='utf-8')
    print(f'combined archive: {archive.name} ({len(rows):,} rows)')
print(f'{code}: {len(entries)} trading days in local manifest')

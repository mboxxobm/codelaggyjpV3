#!/usr/bin/env python3
"""Download one symbol's public R2 CSV files and create a date-ordered combined CSV."""
from __future__ import annotations

import csv
import json
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

MANIFEST = 'https://pub-78d970a1967a4820a5c10a48300d5d1c.r2.dev/chart-data/manifest-live.json'

def get(url: str) -> bytes:
    return subprocess.run(
        ['/usr/bin/curl', '--fail', '--silent', '--show-error', '--location', '--max-time', '90', url],
        check=True,
        stdout=subprocess.PIPE,
    ).stdout

def main() -> None:
    if len(sys.argv) != 2 or not sys.argv[1].isdigit():
        raise SystemExit('Usage: fetch-r2-symbol.py 5803')
    code = sys.argv[1]
    root = Path(__file__).resolve().parent
    manifest = json.loads(get(MANIFEST))
    files = sorted((x for x in manifest['files'] if str(x.get('code')) == code), key=lambda x: x['date'])
    if not files:
        raise SystemExit(f'{code}: no R2 data')
    target = root / 'r2-downloads' / code
    target.mkdir(parents=True, exist_ok=True)
    base = manifest['publicBaseUrl'].rstrip('/')
    text_parts: list[str] = []
    header = ''
    for row in files:
        key = '/'.join(quote(part) for part in row['key'].split('/'))
        text = get(f'{base}/{key}').decode('utf-8-sig')
        lines = [line for line in text.splitlines() if line.strip()]
        if not lines:
            continue
        if not header:
            header = lines[0]
        text_parts.extend(lines[1:])
        (target / f'qr-{code}-{row["date"]}.csv').write_text(text, encoding='utf-8')
        print(f'{code}: {row["date"]} {len(lines)-1:,} rows')
    combined = target / f'qr-{code}-{files[0]["date"]}-{files[-1]["date"]}-combined.csv'
    combined.write_text('\ufeff' + header + '\n' + '\n'.join(text_parts) + '\n', encoding='utf-8')
    manifest_path = root / 'local-r2-manifest.json'
    try:
        local_manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    except (FileNotFoundError, json.JSONDecodeError):
        local_manifest = {'version': 1, 'publicBaseUrl': '.', 'files': []}
    other = [row for row in local_manifest.get('files', []) if str(row.get('code')) != code]
    own = [{'code': code, 'date': row['date'], 'key': f'r2-downloads/{code}/qr-{code}-{row["date"]}.csv', 'size': (target / f'qr-{code}-{row["date"]}.csv').stat().st_size} for row in files]
    local_manifest.update({'version': 1, 'publicBaseUrl': '.', 'files': sorted(other + own, key=lambda row: (str(row['code']), row['date']))})
    manifest_path.write_text(json.dumps(local_manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'combined: {combined} ({len(text_parts):,} rows)')

if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Upload backup files to SharePoint and prune old ones.

Files go to <library>/Backups/<kind>/<YYYY-MM-DD>/ on the site BACKUP_SP_SITE_ID (default document library,
or BACKUP_SP_DRIVE_ID). Day folders older than RETAIN_DAYS (default 90) are deleted. The Graph token comes
from the Azure CLI session opened by azure/login (GitHub OIDC; the app has Sites.Selected on this site only).
"""
import datetime as dt, json, os, subprocess, sys, urllib.error, urllib.parse, urllib.request

G = 'https://graph.microsoft.com/v1.0'
TOKEN = subprocess.run(['az', 'account', 'get-access-token', '--resource-type', 'ms-graph', '--query', 'accessToken', '-o', 'tsv'],
                       check=True, capture_output=True, text=True).stdout.strip()
CHUNK = 320 * 1024 * 32  # 10 MiB, a multiple of 320 KiB as Graph requires


def call(method, url, body=None, headers=None, auth=True):
    h = dict(headers or {})
    if auth: h['Authorization'] = f'Bearer {TOKEN}'
    data = body
    if isinstance(body, (dict, list)):
        data = json.dumps(body).encode(); h['Content-Type'] = 'application/json'
    req = urllib.request.Request(url if url.startswith('http') else G + url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raise SystemExit(f'Graph {method} {url} -> {e.code}: {e.read()[:300]!r}')


def main():
    kind, files = sys.argv[1], sys.argv[2:]
    site = os.environ['BACKUP_SP_SITE_ID']
    drive = os.environ.get('BACKUP_SP_DRIVE_ID') or call('GET', f'/sites/{site}/drive?$select=id')['id']
    day = dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%d')
    folder = f'Backups/{kind}/{day}'
    for f in files:
        name = os.path.basename(f); size = os.path.getsize(f)
        path = urllib.parse.quote(f'{folder}/{name}')
        s = call('POST', f'/drives/{drive}/root:/{path}:/createUploadSession', {'item': {'@microsoft.graph.conflictBehavior': 'replace'}})
        with open(f, 'rb') as fh:
            pos = 0
            while pos < size:
                part = fh.read(CHUNK)
                call('PUT', s['uploadUrl'], part, {'Content-Range': f'bytes {pos}-{pos + len(part) - 1}/{size}',
                                                    'Content-Length': str(len(part))}, auth=False)
                pos += len(part)
        print(f'uploaded {folder}/{name} ({size} bytes)')
    keep = int(os.environ.get('RETAIN_DAYS', '90'))
    cutoff = (dt.date.today() - dt.timedelta(days=keep)).isoformat()
    kids = call('GET', f'/drives/{drive}/root:/{urllib.parse.quote("Backups/" + kind)}:/children?$select=id,name&$top=999').get('value', [])
    for k in kids:
        if len(k['name']) == 10 and k['name'] < cutoff:
            call('DELETE', f'/drives/{drive}/items/{k["id"]}'); print(f'pruned Backups/{kind}/{k["name"]}')


if __name__ == '__main__':
    main()

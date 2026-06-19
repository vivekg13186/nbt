#!/usr/bin/env python3
"""nbtcli — a tiny command-line client for an NBT server.

List, upload (import), download (export) and run workflows over the NBT HTTP
API. Pure standard library (urllib) — no third-party packages required.

    nbtcli list                              # all workflows
    nbtcli list --folder Billing             # one folder ("" = ungrouped)
    nbtcli upload flow.yaml                   # import a .json/.yaml file
    nbtcli upload flow.json --folder Billing  # ...into a folder
    nbtcli download "My Flow"                 # save My Flow.json
    nbtcli download "My Flow" --format yaml   # save My Flow.yaml
    nbtcli download 9f1c2ab34d5e --out f.json # by id, to a path
    nbtcli run "My Flow"                      # run, print result, exit 0/1
    nbtcli run "My Flow" --env staging        # run with an environment

A workflow argument may be a flow id or a (case-insensitive) name.
The server defaults to http://localhost:8000 — override with --server URL or
the NBT_SERVER environment variable.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import uuid
from urllib import error, request


# --------------------------------------------------------------------------
# HTTP helpers (stdlib only)
# --------------------------------------------------------------------------
class ApiError(Exception):
    pass


def _server(args) -> str:
    base = args.server or os.environ.get("NBT_SERVER") or "http://localhost:8000"
    return base.rstrip("/")


def _read(resp):
    data = resp.read()
    ctype = resp.headers.get("Content-Type", "")
    if "application/json" in ctype:
        return json.loads(data.decode("utf-8") or "null"), resp
    return data, resp


def _request(method, url, *, data=None, headers=None):
    req = request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with request.urlopen(req) as resp:  # noqa: S310 (trusted, user-set URL)
            return _read(resp)
    except error.HTTPError as e:
        body = e.read()
        detail = e.reason
        try:
            j = json.loads(body.decode("utf-8"))
            detail = j.get("detail", detail)
        except Exception:
            if body:
                detail = body.decode("utf-8", "replace")[:300]
        raise ApiError(f"{e.code} {detail}")
    except error.URLError as e:
        raise ApiError(f"cannot reach server at {url}: {e.reason}")


def api_get_json(base, path):
    obj, _ = _request("GET", base + path,
                      headers={"Accept": "application/json"})
    return obj


def api_get_raw(base, path):
    return _request("GET", base + path)  # (bytes, resp)


def api_post_json(base, path, body):
    obj, _ = _request(
        "POST", base + path,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json",
                 "Accept": "application/json"})
    return obj


def api_post_multipart(base, path, fields, file_field, filename, file_bytes):
    boundary = "----nbtcli" + uuid.uuid4().hex
    out = bytearray()
    for k, v in fields.items():
        if v is None:
            continue
        out += (f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{k}"\r\n\r\n'
                f"{v}\r\n").encode("utf-8")
    out += (f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{file_field}"; '
            f'filename="{filename}"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n").encode("utf-8")
    out += file_bytes + b"\r\n"
    out += f"--{boundary}--\r\n".encode("utf-8")
    obj, _ = _request(
        "POST", base + path, data=bytes(out),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}",
                 "Accept": "application/json"})
    return obj


# --------------------------------------------------------------------------
# Flow resolution
# --------------------------------------------------------------------------
def resolve_flow(base, ref):
    """Return a flow summary matching `ref` (an id or a name)."""
    flows = api_get_json(base, "/api/flows")
    for f in flows:
        if f["id"] == ref:
            return f
    exact = [f for f in flows if f["name"] == ref]
    if len(exact) == 1:
        return exact[0]
    ci = [f for f in flows if f["name"].lower() == ref.lower()]
    if len(ci) == 1:
        return ci[0]
    if not exact and not ci:
        raise ApiError(f"no workflow matching {ref!r}")
    raise ApiError(f"{ref!r} is ambiguous; use the flow id instead "
                   f"({', '.join(f['id'] for f in (exact or ci))})")


def _safe_filename(s):
    return re.sub(r"[^A-Za-z0-9 _.\-]+", "_", s or "").strip() or "flow"


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------
def cmd_list(args):
    base = _server(args)
    flows = api_get_json(base, "/api/flows")
    if args.folder is not None:
        flows = [f for f in flows if (f.get("folder") or "") == args.folder]
    if args.json:
        print(json.dumps(flows, indent=2))
        return 0
    if not flows:
        print("(no workflows)")
        return 0
    widths = {
        "id": max(2, *(len(f["id"]) for f in flows)),
        "name": max(4, *(len(f["name"]) for f in flows)),
        "folder": max(6, *(len(f.get("folder") or "-") for f in flows)),
    }
    header = (f'{"ID":<{widths["id"]}}  {"NAME":<{widths["name"]}}  '
              f'{"FOLDER":<{widths["folder"]}}')
    print(header)
    print("-" * len(header))
    for f in sorted(flows, key=lambda x: (x.get("folder") or "",
                                          x["name"].lower())):
        print(f'{f["id"]:<{widths["id"]}}  {f["name"]:<{widths["name"]}}  '
              f'{(f.get("folder") or "-"):<{widths["folder"]}}')
    return 0


def cmd_upload(args):
    base = _server(args)
    path = args.file
    if not os.path.isfile(path):
        raise ApiError(f"file not found: {path}")
    with open(path, "rb") as fh:
        data = fh.read()
    flow = api_post_multipart(
        base, "/api/flows/import",
        {"folder": args.folder}, "file", os.path.basename(path), data)
    folder = flow.get("folder")
    print(f"imported '{flow['name']}' (id {flow['id']})"
          + (f" -> folder '{folder}'" if folder else ""))
    return 0


def cmd_download(args):
    base = _server(args)
    flow = resolve_flow(base, args.flow)
    fmt = args.format
    body, resp = api_get_raw(
        base, f"/api/flows/{flow['id']}/export?format={fmt}")
    out = args.out
    if not out:
        # honour the server's suggested filename if present
        cd = resp.headers.get("Content-Disposition", "")
        m = re.search(r'filename="([^"]+)"', cd)
        out = m.group(1) if m else f"{_safe_filename(flow['name'])}.{fmt}"
    with open(out, "wb") as fh:
        fh.write(body)
    print(f"saved {out} ({len(body)} bytes)")
    return 0


def cmd_run(args):
    base = _server(args)
    flow = resolve_flow(base, args.flow)
    print(f"running '{flow['name']}'"
          + (f" (env {args.env})" if args.env else "") + " ...")
    res = api_post_json(base, f"/api/flows/{flow['id']}/run",
                        {"environment": args.env})
    status = res.get("status")
    line = f"{status.upper()}  (execution {res.get('execution_id')})"
    if res.get("error"):
        line += f"\n  {res['error']}"
    print(line)
    return 0 if status == "passed" else 1


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def build_parser():
    p = argparse.ArgumentParser(
        prog="nbtcli", description="Command-line client for an NBT server.")
    p.add_argument("--server", help="NBT server URL "
                   "(default $NBT_SERVER or http://localhost:8000)")
    sub = p.add_subparsers(dest="cmd", required=True)

    pl = sub.add_parser("list", help="list workflows")
    pl.add_argument("--folder", help='only this folder ("" = ungrouped)')
    pl.add_argument("--json", action="store_true", help="raw JSON output")
    pl.set_defaults(func=cmd_list)

    pu = sub.add_parser("upload", help="import a .json/.yaml workflow file")
    pu.add_argument("file", help="path to the workflow file")
    pu.add_argument("--folder", help="import into this folder (overrides the "
                    "folder named in the file)")
    pu.set_defaults(func=cmd_upload)

    pd = sub.add_parser("download", help="export a workflow to a file")
    pd.add_argument("flow", help="workflow name or id")
    pd.add_argument("--format", choices=["json", "yaml"], default="json")
    pd.add_argument("--out", help="output path (default <name>.<ext>)")
    pd.set_defaults(func=cmd_download)

    pr = sub.add_parser("run", help="run a workflow and print the result")
    pr.add_argument("flow", help="workflow name or id")
    pr.add_argument("--env", help="environment name to run with")
    pr.set_defaults(func=cmd_run)

    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except ApiError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())

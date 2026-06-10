"""HTTP request node (stdlib only)."""

import json
import urllib.error
import urllib.request

from nbt.core.node_base import BaseNode, NodeError


class HttpRequest(BaseNode):
    type_name = "http_request"
    label = "HTTP Request"
    category = "Network"
    inputs = {"url": "https://", "method": "GET", "body": "", "timeout": 15}
    outputs = ["status", "body", "json"]

    def run(self, inputs, ctx):
        url = str(inputs["url"]).strip()
        if not url.startswith(("http://", "https://")):
            raise NodeError(f"invalid url: {url!r}")
        data = str(inputs["body"]).encode() if inputs["body"] else None
        req = urllib.request.Request(
            url, data=data, method=str(inputs["method"]).upper() or "GET",
            headers={"User-Agent": "nbt/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=float(inputs["timeout"])) as r:
                status, body = r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            status, body = e.code, e.read().decode("utf-8", "replace")
        except Exception as e:
            raise NodeError(f"request failed: {e}") from e
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = None
        return {"status": status, "body": body, "json": parsed}

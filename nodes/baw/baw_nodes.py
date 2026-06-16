"""IBM Business Automation Workflow (BAW) nodes (category: BAW).

Start a BAW service through the REST API "Service: POST start":
    POST {base_url}/rest/bpm/wle/v1/service/{shortname@service-name}/start

The query parameters ``parts=all`` and ``createTask=false`` are fixed; the
service's input variables are passed as a JSON object in the ``params`` query
parameter. Two auth modes are supported: HTTP basic (username/password) and
bearer token.

Docs: https://www.ibm.com/docs/en/baw/23.0.x?topic=service-post-start
"""

import json
import urllib.parse

import requests

from nbt.core.node_base import BaseNode, NodeError

TIMEOUT = 60


class BawStartService(BaseNode):
    type_name = "baw_start_service"
    label = "BAW: Start Service"
    category = "BAW"
    inputs = {
        "base_url": "",          # e.g. https://baw-host:9443
        "service": "",           # identifier: shortname@service-name
        "params": "{}",          # JSON object of service input variables
        "auth_type": "basic",    # "basic" or "bearer"
        "username": "",          # for basic auth
        "password": "",          # for basic auth
        "token": "",             # for bearer auth
        "verify_ssl": True,      # set False for self-signed certs
    }
    outputs = ["status_code", "ok", "data"]

    def run(self, inputs, ctx):
        base = str(inputs["base_url"]).strip().rstrip("/")
        service = str(inputs["service"]).strip()
        if not base:
            raise NodeError("base_url is required "
                            "(e.g. https://baw-host:9443)")
        if not service:
            raise NodeError("service is required (shortname@service-name)")

        # service input variables -> JSON string in the `params` query param
        raw = inputs["params"]
        params_json = None
        if isinstance(raw, (dict, list)):
            params_json = json.dumps(raw)
        else:
            s = str(raw or "").strip()
            if s:
                try:
                    params_json = json.dumps(json.loads(s))
                except Exception as e:
                    raise NodeError(f"params is not valid JSON: {e}")

        url = (f"{base}/rest/bpm/wle/v1/service/"
               f"{urllib.parse.quote(service, safe='@')}/start")
        query = {"parts": "all", "createTask": "false"}
        if params_json is not None:
            query["params"] = params_json

        headers = {"Accept": "application/json"}
        auth = None
        atype = str(inputs["auth_type"]).strip().lower()
        if atype == "bearer":
            token = str(inputs["token"]).strip()
            if not token:
                raise NodeError("token is required for bearer auth")
            headers["Authorization"] = "Bearer " + token
        else:  # basic
            user = str(inputs["username"]).strip()
            if not user:
                raise NodeError("username is required for basic auth")
            auth = (user, str(inputs["password"]))

        verify = bool(inputs["verify_ssl"])
        log = ctx.get("log")
        if callable(log):
            log(f"POST {url} (parts=all, createTask=false)")
        try:
            r = requests.post(url, params=query, headers=headers, auth=auth,
                              verify=verify, timeout=TIMEOUT)
        except requests.RequestException as e:
            raise NodeError(f"request failed: {type(e).__name__}: {e}")

        try:
            data = r.json()
        except ValueError:
            data = r.text
        if not r.ok:
            msg = data if isinstance(data, str) else json.dumps(data)[:400]
            raise NodeError(f"BAW {r.status_code}: {msg}")
        if callable(log):
            log(f"started service -> {r.status_code}")
        return {"status_code": r.status_code, "ok": r.ok, "data": data}

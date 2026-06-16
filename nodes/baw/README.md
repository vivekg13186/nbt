# nbt-baw-nodes

A node package for **NBT** that adds a **BAW** category for IBM Business
Automation Workflow.

## BAW: Start Service

Calls the REST API **Service: POST start**:

```
POST {base_url}/rest/bpm/wle/v1/service/{shortname@service-name}/start
        ?parts=all&createTask=false&params=<json>
```

`parts=all` and `createTask=false` are fixed. Inputs:

- `base_url` — e.g. `https://baw-host:9443`
- `service` — the service identifier `shortname@service-name`
- `params` — JSON object of the service's input variables (e.g.
  `{ "orderId": 42 }`); pass `{{ last }}`/an alias to feed an object
- `auth_type` — `basic` or `bearer`
- `username` / `password` — for basic auth
- `token` — for bearer auth
- `verify_ssl` — set `false` for self-signed certificates

Outputs: `status_code`, `ok`, `data` (parsed JSON response).

Docs: <https://www.ibm.com/docs/en/baw/23.0.x?topic=service-post-start>

Keep credentials out of the graph: put them in an NBT **Environment** and
reference them via templates, e.g. `username` = `{{ baw_user }}`,
`password` = `{{ baw_pass }}` (or `token` = `{{ baw_token }}`).

## Install

In the NBT UI open the **Packages** view and **Upload** `baw-1.0.0.nbtpack`
(or drag it on / install from a git repo). Installs into `nodes/baw/`.

## Build the bundle

```bash
python tools/bundle_package.py packages/nbt-baw-nodes   # -> baw-1.0.0.nbtpack
```

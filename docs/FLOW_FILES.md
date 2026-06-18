# Workflow files (.json / .yaml)

NBT imports and exports workflows as **JSON** or **YAML** files. The two
formats are interchangeable — same shape, pick whichever you prefer. A file
wraps the graph together with the flow's **name** and **folder** so they travel
with the file (instead of the flow name being guessed from the file name).

## Top-level shape

```yaml
name: My Flow            # the flow name (used on import; required-ish, see below)
folder: Billing          # optional; omit or null = top level (ungrouped)
graph:
  nodes: [ ... ]         # the nodes (see below)
  links: [ ... ]         # execution-order edges between nodes
  groups: [ ... ]        # optional: group boxes (UI only)
  notes:  [ ... ]        # optional: note annotations (UI only)
```

The same in JSON:

```json
{
  "name": "My Flow",
  "folder": "Billing",
  "graph": { "nodes": [], "links": [] }
}
```

On **import**:

- **Name** comes from the file's `name`. If it's missing, the file name is used
  (e.g. `My Flow.yaml` → `My Flow`). If a flow with that name already exists,
  NBT appends ` (1)`, ` (2)`, … so import never fails on a clash.
- **Folder** comes from the file's `folder`, so the flow lands in the right
  folder automatically. Importing into a specific folder can override this
  (the `folder` form field on `POST /api/flows/import`); otherwise the file's
  folder wins, and a flow with no folder stays at the top level.

A **bare graph** file (top level is just `nodes` / `links`, with no `name` or
`graph` wrapper) is still accepted for backward compatibility — its name comes
from the file name and it has no folder.

## Nodes

Each entry in `graph.nodes` describes one node:

```yaml
- id: n1                 # unique id within the flow
  type: set_value        # node type (must be installed; see the palette)
  name: greeting         # display name; also how other nodes reference it
  params:                # node inputs (keys depend on the node type)
    value: hello
  pre: ""                # optional: expression; falsy -> node is skipped
  post: ""               # optional: expression; falsy -> node fails
  out_aliases:           # optional: publish an output as a flat variable
    value: greeting      #   output "value" -> usable later as `greeting`
  pos: [40, 120]         # optional: canvas position (UI only)
  size: [240, 120]       # optional: node box size (UI only)
```

Field notes:

- **`params`** are the node's inputs. String params support `{{ expression }}`
  templating evaluated against the run context.
- **`pre` / `post`** are Python expressions (see the main README). `pre` gates
  whether the node runs; `post` asserts after it runs.
- **`out_aliases`** maps an output name to a context variable name, so later
  nodes can use it directly (e.g. `out_aliases: {value: casenumber}` lets a
  later node read `casenumber` / `{{ casenumber }}`).
- **`pos` / `size`** are editor-only; the engine ignores them.

## Links

`graph.links` is a list of `[source_id, target_id]` pairs that set execution
order (a node runs after the parents linked into it). Nodes may have multiple
parents (joins) and multiple children (branches); the only rule is no cycles.

```yaml
links:
  - [n1, n2]
  - [n2, n3]
```

In JSON: `"links": [["n1", "n2"], ["n2", "n3"]]`.

## Importing / exporting

- **Editor:** the tab menu → **Export ▸ JSON / YAML**, the toolbar **Export**
  button (download icon → JSON / YAML), or drag a `.json` / `.yaml` file onto
  the window. The **Import** button (up arrow) accepts `.json`, `.yaml`, `.yml`.
- **Bulk:** the Workflows sidebar exports **all workflows** (header download)
  or **a single folder** (download on the folder header) as a `.zip` of
  `<folder>/<name>.<ext>` files, in JSON or YAML. Re-importing those files
  restores each flow's name and folder.
- **API:** `GET /api/flows/{id}/export?format=json|yaml`,
  `GET /api/flows/export?folder=&format=json|yaml` (zip), and
  `POST /api/flows/import` (multipart `file`, optional `folder`).

## Minimal example (YAML)

```yaml
name: Hello
folder: Demos
graph:
  nodes:
    - id: n1
      type: set_value
      name: greeting
      params: { value: hello }
      out_aliases: { value: greeting }
    - id: n2
      type: assert_equals
      name: verify
      params: { actual: "{{ greeting }}", expected: hello }
  links:
    - [n1, n2]
```

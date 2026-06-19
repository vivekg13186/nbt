// NBT Flows — a VS Code extension that exposes workflows on an NBT server as
// virtual YAML files. Open a flow to download it, save (Ctrl+S) to upload it
// back to the same flow, and run it from the tree or the editor title bar.
//
// Runtime dependency-free: uses Node's global fetch / FormData / Blob (VS Code
// ships Node 18+).

import * as vscode from "vscode";

interface Flow {
  id: string;
  name: string;
  folder: string | null;
}

interface Step {
  status: string;
  node_name: string | null;
  node_type: string | null;
  error: string | null;
}

let output: vscode.OutputChannel;

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
function serverUrl(): string {
  const url = vscode.workspace
    .getConfiguration("nbt")
    .get<string>("serverUrl", "http://localhost:8000");
  return url.replace(/\/+$/, "");
}

async function apiError(res: Response): Promise<string> {
  let detail = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { detail?: string };
    if (body?.detail) detail = body.detail;
  } catch {
    /* non-JSON error body */
  }
  return detail;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(serverUrl() + path, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(await apiError(res));
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(serverUrl() + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await apiError(res));
  return (await res.json()) as T;
}

async function listFlows(): Promise<Flow[]> {
  return getJson<Flow[]>("/api/flows");
}

// ---------------------------------------------------------------------------
// URIs: nbt:/<flow id>/<display name>.yaml  (the id is the stable key)
// ---------------------------------------------------------------------------
function uriForFlow(f: Flow): vscode.Uri {
  const safe = (f.name || "flow").replace(/[\\/:*?"<>|]+/g, "_");
  return vscode.Uri.from({ scheme: "nbt", path: `/${f.id}/${safe}.yaml` });
}

function flowIdFromUri(uri: vscode.Uri): string {
  return uri.path.split("/").filter(Boolean)[0] || "";
}

// ---------------------------------------------------------------------------
// Virtual filesystem: read = download (export YAML), write = upload (update)
// ---------------------------------------------------------------------------
class NbtFs implements vscode.FileSystemProvider {
  private emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  onDidChangeFile = this.emitter.event;
  private meta = new Map<string, { mtime: number; size: number }>();

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const parts = uri.path.split("/").filter(Boolean);
    if (parts.length <= 1) {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    const m = this.meta.get(uri.toString());
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: m?.mtime ?? Date.now(),
      size: m?.size ?? 0,
    };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const id = flowIdFromUri(uri);
    const res = await fetch(
      `${serverUrl()}/api/flows/${id}/export?format=yaml`,
    );
    if (!res.ok) {
      if (res.status === 404) throw vscode.FileSystemError.FileNotFound(uri);
      throw new Error(await apiError(res));
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    this.meta.set(uri.toString(), { mtime: Date.now(), size: bytes.length });
    return bytes;
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const id = flowIdFromUri(uri);
    const name = uri.path.split("/").filter(Boolean)[1] || "flow.yaml";
    // Send the raw file to the server, which parses YAML/JSON and updates this
    // flow in place — so the extension needs no YAML parser of its own.
    const form = new FormData();
    form.append("flow_id", id);
    form.append("file", new Blob([content]), name);
    const res = await fetch(`${serverUrl()}/api/flows/import`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) throw new Error(await apiError(res));
    this.meta.set(uri.toString(), { mtime: Date.now(), size: content.length });
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    vscode.commands.executeCommand("nbt.refresh");
  }

  // Browsing happens through the tree view, not the Explorer.
  readDirectory(): [string, vscode.FileType][] {
    return [];
  }
  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions("read-only filesystem");
  }
  delete(): void {
    throw vscode.FileSystemError.NoPermissions(
      "delete a flow from the NBT view instead",
    );
  }
  rename(): void {
    throw vscode.FileSystemError.NoPermissions(
      "rename by editing the file's `name:` field, then save",
    );
  }
}

// ---------------------------------------------------------------------------
// Tree view: folders -> flows
// ---------------------------------------------------------------------------
type Node =
  | { kind: "folder"; folder: string }
  | { kind: "flow"; flow: Flow };

class NbtTree implements vscode.TreeDataProvider<Node> {
  private emitter = new vscode.EventEmitter<Node | undefined | void>();
  onDidChangeTreeData = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "folder") {
      const item = new vscode.TreeItem(
        node.folder,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.iconPath = new vscode.ThemeIcon("folder");
      item.contextValue = "folder";
      return item;
    }
    const item = new vscode.TreeItem(node.flow.name);
    item.iconPath = new vscode.ThemeIcon("symbol-event");
    item.description = node.flow.id;
    item.tooltip = `${node.flow.name}\nid: ${node.flow.id}`;
    item.contextValue = "flow";
    item.resourceUri = uriForFlow(node.flow);
    item.command = {
      command: "nbt.openFlow",
      title: "Open Flow",
      arguments: [node.flow],
    };
    return item;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    let flows: Flow[];
    try {
      flows = await listFlows();
    } catch (e) {
      if (!element) {
        vscode.window.showErrorMessage(
          `NBT: cannot reach ${serverUrl()} — ${(e as Error).message}`,
        );
      }
      return [];
    }
    if (element && element.kind === "folder") {
      return flows
        .filter((f) => (f.folder || "") === element.folder)
        .sort(byName)
        .map((flow) => ({ kind: "flow" as const, flow }));
    }
    if (element) return [];
    const folders = [
      ...new Set(flows.map((f) => (f.folder || "").trim()).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b));
    const ungrouped = flows
      .filter((f) => !(f.folder || "").trim())
      .sort(byName)
      .map((flow) => ({ kind: "flow" as const, flow }));
    return [
      ...folders.map((folder) => ({ kind: "folder" as const, folder })),
      ...ungrouped,
    ];
  }
}

function byName(a: Flow, b: Flow): number {
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function openFlow(flow: Flow): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uriForFlow(flow));
  await vscode.languages.setTextDocumentLanguage(doc, "yaml");
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function resolveRunTarget(arg: unknown): Promise<string | undefined> {
  if (arg && (arg as Node).kind === "flow") return (arg as { flow: Flow }).flow.id;
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === "nbt") return flowIdFromUri(active);
  const flows = await listFlows();
  const pick = await vscode.window.showQuickPick(
    flows.map((f) => ({
      label: f.name,
      description: f.folder || "",
      id: f.id,
    })),
    { placeHolder: "Run which workflow?" },
  );
  return pick?.id;
}

async function runFlow(arg: unknown): Promise<void> {
  const id = await resolveRunTarget(arg);
  if (!id) return;
  const env = vscode.workspace
    .getConfiguration("nbt")
    .get<string>("environment", "")
    .trim();
  output.show(true);
  output.appendLine(
    `▶ running ${id}${env ? ` (env ${env})` : ""} …`,
  );
  try {
    const res = await postJson<{
      execution_id: string;
      status: string;
      error: string | null;
    }>(`/api/flows/${id}/run`, { environment: env || null });
    try {
      const detail = await getJson<{ steps: Step[] }>(
        `/api/executions/${res.execution_id}`,
      );
      for (const s of detail.steps) {
        output.appendLine(
          `  [${s.status.padStart(7)}] ${s.node_name} (${s.node_type})` +
            (s.error ? `\n      ${s.error.split("\n")[0]}` : ""),
        );
      }
    } catch {
      /* steps are best-effort */
    }
    const msg = `${res.status.toUpperCase()} — execution ${res.execution_id}`;
    output.appendLine(`◼ ${msg}`);
    if (res.status === "passed") vscode.window.showInformationMessage(`NBT: ${msg}`);
    else
      vscode.window.showErrorMessage(
        `NBT: ${msg}${res.error ? " — " + res.error : ""}`,
      );
  } catch (e) {
    vscode.window.showErrorMessage(`NBT run failed: ${(e as Error).message}`);
  }
}

async function newFlow(tree: NbtTree): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: "New workflow name",
  });
  if (!name) return;
  const folder = await vscode.window.showInputBox({
    prompt: "Folder (optional)",
  });
  try {
    const flow = await postJson<Flow>("/api/flows", {
      name: name.trim(),
      graph: { nodes: [], links: [] },
      folder: folder?.trim() || null,
    });
    tree.refresh();
    await openFlow(flow);
  } catch (e) {
    vscode.window.showErrorMessage(`NBT: ${(e as Error).message}`);
  }
}

async function deleteFlow(tree: NbtTree, arg: unknown): Promise<void> {
  if (!arg || (arg as Node).kind !== "flow") return;
  const flow = (arg as { flow: Flow }).flow;
  const ok = await vscode.window.showWarningMessage(
    `Delete workflow "${flow.name}"? This cannot be undone.`,
    { modal: true },
    "Delete",
  );
  if (ok !== "Delete") return;
  try {
    const res = await fetch(`${serverUrl()}/api/flows/${flow.id}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(await apiError(res));
    tree.refresh();
  } catch (e) {
    vscode.window.showErrorMessage(`NBT: ${(e as Error).message}`);
  }
}

async function setServer(tree: NbtTree): Promise<void> {
  const url = await vscode.window.showInputBox({
    prompt: "NBT server URL",
    value: serverUrl(),
  });
  if (!url) return;
  await vscode.workspace
    .getConfiguration("nbt")
    .update("serverUrl", url.trim(), vscode.ConfigurationTarget.Global);
  tree.refresh();
}

// ---------------------------------------------------------------------------
export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("NBT");
  const fs = new NbtFs();
  const tree = new NbtTree();

  context.subscriptions.push(
    output,
    vscode.workspace.registerFileSystemProvider("nbt", fs, {
      isCaseSensitive: true,
    }),
    vscode.window.registerTreeDataProvider("nbtFlows", tree),
    vscode.commands.registerCommand("nbt.refresh", () => tree.refresh()),
    vscode.commands.registerCommand("nbt.openFlow", (flow: Flow) =>
      openFlow(flow),
    ),
    vscode.commands.registerCommand("nbt.run", (arg) => runFlow(arg)),
    vscode.commands.registerCommand("nbt.newFlow", () => newFlow(tree)),
    vscode.commands.registerCommand("nbt.deleteFlow", (arg) =>
      deleteFlow(tree, arg),
    ),
    vscode.commands.registerCommand("nbt.setServer", () => setServer(tree)),
  );
}

export function deactivate(): void {
  /* nothing to clean up */
}

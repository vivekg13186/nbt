import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App as AntApp,
  Button,
  Empty,
  Input,
  Space,
  Table,
  Tag,
  Tooltip,
} from "antd";
import { GitBranch, RefreshCw, Trash2, Upload } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import type { LoadError, NodePackage } from "../types";

export default function PackagesPage() {
  const { message, modal } = AntApp.useApp();
  const loadNodes = useStore((s) => s.loadNodes);
  const [rows, setRows] = useState<NodePackage[]>([]);
  const [errors, setErrors] = useState<LoadError[]>([]);
  const [loading, setLoading] = useState(false);
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    setLoading(true);
    try {
      const r = await api.listPackages();
      setRows(r.packages);
      setErrors(r.load_errors);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function applyResult(r: { packages: NodePackage[]; load_errors: LoadError[] }) {
    setRows(r.packages);
    setErrors(r.load_errors);
    loadNodes(); // refresh the node palette
  }

  async function installGit() {
    if (!url.trim()) return;
    setBusy(true);
    try {
      const r = await api.installGit(url.trim(), ref.trim() || null);
      applyResult(r);
      message.success(`Installed "${r.package.name}"`);
      setUrl("");
      setRef("");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function installZip(file: File) {
    setBusy(true);
    try {
      const r = await api.installZip(file);
      applyResult(r);
      message.success(`Installed "${r.package.name}"`);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function update(name: string) {
    try {
      applyResult(await api.updatePackage(name));
      message.success(`Updated "${name}"`);
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  function remove(name: string) {
    modal.confirm({
      title: `Remove package "${name}"?`,
      content: "This deletes its node files and unloads its nodes.",
      okType: "danger",
      okText: "Remove",
      onOk: async () => {
        try {
          applyResult(await api.removePackage(name));
          message.success(`Removed "${name}"`);
        } catch (e) {
          message.error((e as Error).message);
        }
      },
    });
  }

  const columns = [
    {
      title: "Package",
      dataIndex: "name",
      render: (name: string, r: NodePackage) => (
        <span>
          <strong>{name}</strong>
          {r.version && (
            <Tag style={{ marginLeft: 8 }}>v{r.version}</Tag>
          )}
          {r.description && (
            <div style={{ fontSize: 12, color: "var(--nbt-muted)" }}>
              {r.description}
            </div>
          )}
        </span>
      ),
    },
    {
      title: "Source",
      dataIndex: "source",
      render: (s: NodePackage["source"]) => {
        const color =
          s.type === "git" ? "blue" : s.type === "zip" ? "green" : "default";
        return (
          <Tooltip title={s.url || s.filename || "added manually"}>
            <Tag color={color}>{s.type}</Tag>
          </Tooltip>
        );
      },
    },
    {
      title: "Nodes",
      dataIndex: "node_count",
      width: 80,
    },
    {
      title: "Requirements",
      dataIndex: "requirements",
      render: (reqs: string[]) =>
        reqs && reqs.length ? (
          <span>
            {reqs.map((q) => (
              <Tag key={q} style={{ marginBottom: 2 }}>
                {q}
              </Tag>
            ))}
          </span>
        ) : (
          <span style={{ opacity: 0.4 }}>—</span>
        ),
    },
    {
      title: "",
      key: "actions",
      render: (_: unknown, r: NodePackage) => (
        <Space>
          {r.source.type === "git" && (
            <Button
              size="small"
              icon={<RefreshCw size={13} />}
              onClick={() => update(r.name)}
            >
              Update
            </Button>
          )}
          <Button
            size="small"
            danger
            icon={<Trash2 size={13} />}
            onClick={() => remove(r.name)}
          >
            Remove
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="nbt-editor-pane">
      <strong style={{ fontSize: 16 }}>Node packages</strong>
      <p style={{ color: "var(--nbt-muted)", fontSize: 12, marginTop: 4 }}>
        Install groups of custom nodes from a git repository or a{" "}
        <code>.nbtpack</code> / <code>.zip</code> bundle. Declared pip
        requirements are installed automatically. Node files execute Python on
        the server — only install packages you trust.
      </p>

      <div
        style={{
          border: "1px solid var(--nbt-border)",
          borderRadius: 8,
          padding: 12,
          margin: "12px 0",
        }}
      >
        <Space.Compact style={{ width: "100%", marginBottom: 8 }}>
          <Input
            addonBefore={<GitBranch size={14} />}
            placeholder="https://github.com/you/nbt-nodes-foo.git"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onPressEnter={installGit}
          />
          <Input
            placeholder="ref (optional)"
            style={{ maxWidth: 160 }}
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            onPressEnter={installGit}
          />
          <Button type="primary" loading={busy} onClick={installGit}>
            Install
          </Button>
        </Space.Compact>
        <Button
          icon={<Upload size={14} />}
          loading={busy}
          onClick={() => fileRef.current?.click()}
        >
          Upload .nbtpack / .zip
        </Button>
        <span style={{ marginLeft: 10, fontSize: 12, color: "var(--nbt-muted)" }}>
          …or drag a bundle anywhere onto the window.
        </span>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,.nbtpack"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) installZip(f);
            e.target.value = "";
          }}
        />
      </div>

      {errors.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="Some node files failed to load"
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {errors.map((e, i) => (
                <li key={i}>
                  <code>{e.file}</code>: {e.error}
                </li>
              ))}
            </ul>
          }
        />
      )}

      <Table
        rowKey="name"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={false}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No packages installed yet"
            />
          ),
        }}
      />
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { App as AntApp, Button, Empty, Input, Space, Tag } from "antd";
import { Save } from "lucide-react";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { vscodeDark } from "@uiw/codemirror-theme-vscode";
import { useStore } from "../store";
import { api } from "../api";

export default function EnvEditor() {
  const { message } = AntApp.useApp();
  const envs = useStore((s) => s.envs);
  const activeEnvName = useStore((s) => s.activeEnvName);
  const refreshEnvs = useStore((s) => s.refreshEnvs);
  const setActiveEnv = useStore((s) => s.setActiveEnv);

  const env = useMemo(
    () => envs.find((e) => e.name === activeEnvName),
    [envs, activeEnvName],
  );

  const [text, setText] = useState("{}");
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (env) {
      setText(JSON.stringify(env.vars, null, 2));
      setName(env.name);
      setErr(null);
    }
  }, [env?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function validate(value: string) {
    setText(value);
    try {
      const parsed = JSON.parse(value || "{}");
      if (typeof parsed !== "object" || Array.isArray(parsed)) {
        setErr("Top-level value must be a JSON object");
      } else {
        setErr(null);
      }
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function save() {
    if (!env || err) return;
    setSaving(true);
    try {
      const vars = JSON.parse(text || "{}");
      await api.updateEnv(env.id, { name: name.trim(), vars });
      await refreshEnvs();
      if (name.trim() !== env.name) setActiveEnv(name.trim());
      message.success("Environment saved");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!env) {
    return (
      <div className="nbt-empty">
        <Empty
          description="Select or create an environment from the sidebar"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      </div>
    );
  }

  return (
    <div className="nbt-editor-pane">
      <Space style={{ marginBottom: 12, width: "100%" }} wrap>
        <Input
          addonBefore="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ width: 280 }}
        />
        <Button
          type="primary"
          icon={<Save size={15} />}
          onClick={save}
          loading={saving}
          disabled={!!err}
        >
          Save
        </Button>
        {err ? (
          <Tag color="error">{err}</Tag>
        ) : (
          <Tag color="success">valid JSON</Tag>
        )}
      </Space>
      <div
        style={{
          border: "1px solid var(--nbt-border)",
          borderRadius: 6,
          overflow: "hidden",
        }}
      >
        <CodeMirror
          value={text}
          height="calc(100vh - 240px)"
          theme={vscodeDark}
          extensions={[json()]}
          onChange={validate}
        />
      </div>
      <p style={{ color: "var(--nbt-muted)", marginTop: 10, fontSize: 12 }}>
        A JSON object of variables, e.g.{" "}
        <code>{`{ "base_url": "https://stg.example.com", "token": "abc" }`}</code>
        . Used as <code>{`{{ base_url }}`}</code> in inputs and{" "}
        <code>base_url</code> / <code>env['token']</code> in expressions.
      </p>
    </div>
  );
}

import { useEffect, useState } from "react";
import { Modal, Segmented, Space } from "antd";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { vscodeDark } from "@uiw/codemirror-theme-vscode";
import type { Extension } from "@codemirror/state";

type Lang = "auto" | "json" | "html" | "javascript" | "python" | "text";

function guess(text: string): Exclude<Lang, "auto"> {
  const t = text.trim();
  if (!t) return "text";
  if ((t.startsWith("{") && t.endsWith("}")) ||
      (t.startsWith("[") && t.endsWith("]"))) {
    return "json";
  }
  if (/^<(!doctype|\/?[a-z][\w-]*)[\s/>]/i.test(t)) return "html";
  return "text";
}

function extFor(lang: Exclude<Lang, "auto">): Extension[] {
  switch (lang) {
    case "json":
      return [json()];
    case "html":
      return [html()];
    case "javascript":
      return [javascript()];
    case "python":
      return [python()];
    default:
      return [];
  }
}

export default function ValueEditorModal({
  open,
  title,
  initialValue,
  onSave,
  onCancel,
}: {
  open: boolean;
  title: string;
  initialValue: string;
  onSave: (v: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [lang, setLang] = useState<Lang>("auto");

  useEffect(() => {
    if (open) {
      setValue(initialValue);
      setLang("auto");
    }
  }, [open, initialValue]);

  const effective = lang === "auto" ? guess(value) : lang;

  return (
    <Modal
      title={
        <Space>
          <span>Edit “{title}”</span>
          <Segmented
            size="small"
            value={lang}
            onChange={(v) => setLang(v as Lang)}
            options={[
              { label: `Auto (${guess(value)})`, value: "auto" },
              { label: "JSON", value: "json" },
              { label: "HTML", value: "html" },
              { label: "JS", value: "javascript" },
              { label: "Python", value: "python" },
              { label: "Text", value: "text" },
            ]}
          />
        </Space>
      }
      open={open}
      width={840}
      onOk={() => onSave(value)}
      onCancel={onCancel}
      okText="Apply"
      destroyOnClose
    >
      <div style={{ border: "1px solid var(--nbt-border)", borderRadius: 6 }}>
        <CodeMirror
          value={value}
          height="58vh"
          theme={vscodeDark}
          extensions={extFor(effective)}
          onChange={setValue}
        />
      </div>
    </Modal>
  );
}

import {
  Button,
  Collapse,
  ColorPicker,
  Input,
  InputNumber,
  Space,
  Switch,
  Tag,
} from "antd";
import { Code2, Trash2, X } from "lucide-react";
import type { Node } from "@xyflow/react";
import type { NodeMeta } from "../types";
import type { NbtData } from "../flow/serialize";

interface EditReq {
  title: string;
  value: string;
  apply: (v: string) => void;
}

interface Props {
  node: Node;
  meta?: NodeMeta;
  onChange: (patch: Partial<NbtData>) => void;
  onEditCode: (req: EditReq) => void;
  onDelete: () => void;
  onClose: () => void;
}

// A text field with a `</>` button that opens the code-editor dialog.
function CodeField({
  label,
  value,
  placeholder,
  onChange,
  onEdit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  onEdit: () => void;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="nbt-pp-label">{label}</div>
      <Space.Compact style={{ width: "100%" }}>
        <Input
          size="small"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        <Button
          size="small"
          icon={<Code2 size={13} />}
          title="Edit in code editor"
          onClick={onEdit}
        />
      </Space.Compact>
    </div>
  );
}

export default function PropertyPanel({
  node,
  meta,
  onChange,
  onEditCode,
  onDelete,
  onClose,
}: Props) {
  const d = node.data as unknown as NbtData;
  const setParam = (name: string, val: unknown) =>
    onChange({ params: { ...d.params, [name]: val } });
  const setAlias = (out: string, val: string) =>
    onChange({ aliases: { ...d.aliases, [out]: val } });

  const general = (
    <div>
      <div style={{ marginBottom: 10 }}>
        <div className="nbt-pp-label">Name</div>
        <Input
          size="small"
          value={d.name}
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </div>
      <div className="nbt-pp-row">
        <span className="nbt-pp-label">Color</span>
        <ColorPicker
          size="small"
          value={d.color || null}
          allowClear
          onChangeComplete={(c) => onChange({ color: c.toHexString() })}
          onClear={() => onChange({ color: undefined })}
          presets={[
            {
              label: "Presets",
              colors: [
                "#5b8fd9",
                "#faad14",
                "#52c41a",
                "#f5222d",
                "#722ed1",
                "#13c2c2",
                "#eb2f96",
                "#8c8c8c",
              ],
            },
          ]}
        />
      </div>
      <CodeField
        label={d.isTrigger ? "Pre (event filter)" : "Pre (skip if falsy)"}
        value={d.pre}
        placeholder="expression"
        onChange={(v) => onChange({ pre: v })}
        onEdit={() =>
          onEditCode({
            title: "pre",
            value: d.pre,
            apply: (v) => onChange({ pre: v }),
          })
        }
      />
      {!d.isTrigger && (
        <CodeField
          label="Post (fail if falsy)"
          value={d.post}
          placeholder="expression"
          onChange={(v) => onChange({ post: v })}
          onEdit={() =>
            onEditCode({
              title: "post",
              value: d.post,
              apply: (v) => onChange({ post: v }),
            })
          }
        />
      )}
    </div>
  );

  const inputs = !meta || meta.params.length === 0 ? (
    <div className="nbt-pp-muted">No inputs</div>
  ) : (
    <div>
      {meta.params.map((p) => {
        const val = d.params[p.name];
        if (p.kind === "bool") {
          return (
            <div key={p.name} className="nbt-pp-row">
              <span className="nbt-pp-label">{p.name}</span>
              <Switch
                size="small"
                checked={!!val}
                onChange={(v) => setParam(p.name, v)}
              />
            </div>
          );
        }
        if (p.kind === "int" || p.kind === "float") {
          return (
            <div key={p.name} style={{ marginBottom: 10 }}>
              <div className="nbt-pp-label">{p.name}</div>
              <InputNumber
                size="small"
                style={{ width: "100%" }}
                value={val as number}
                step={p.kind === "int" ? 1 : 0.1}
                onChange={(v) => setParam(p.name, v ?? 0)}
              />
            </div>
          );
        }
        return (
          <CodeField
            key={p.name}
            label={p.name}
            value={val == null ? "" : String(val)}
            onChange={(v) => setParam(p.name, v)}
            onEdit={() =>
              onEditCode({
                title: p.name,
                value: val == null ? "" : String(val),
                apply: (v) => setParam(p.name, v),
              })
            }
          />
        );
      })}
    </div>
  );

  const outputs = !meta || meta.outputs.length === 0 ? (
    <div className="nbt-pp-muted">No outputs</div>
  ) : (
    <div>
      <div className="nbt-pp-muted" style={{ marginBottom: 8 }}>
        Name an output to publish it as a variable for downstream nodes.
      </div>
      {meta.outputs.map((o) => (
        <div key={o} style={{ marginBottom: 10 }}>
          <div className="nbt-pp-label">→ {o}</div>
          <Input
            size="small"
            placeholder={`alias (e.g. ${o})`}
            value={d.aliases[o] || ""}
            onChange={(e) => setAlias(o, e.target.value)}
          />
        </div>
      ))}
    </div>
  );

  return (
    <div className="nbt-property-panel">
      <div className="nbt-pp-head">
        <span style={{ flex: 1, fontWeight: 600 }}>{d.label}</span>
        <Tag style={{ marginInlineEnd: 0 }}>{d.nbtType}</Tag>
        <Button
          type="text"
          size="small"
          icon={<X size={15} />}
          onClick={onClose}
        />
      </div>
      <div className="nbt-pp-body">
        <Collapse
          accordion={false}
          defaultActiveKey={["general", "inputs", "outputs"]}
          size="small"
          items={[
            { key: "general", label: "General", children: general },
            { key: "inputs", label: "Inputs", children: inputs },
            { key: "outputs", label: "Outputs", children: outputs },
          ]}
        />
      </div>
      <div className="nbt-pp-foot">
        <Button
          size="small"
          danger
          icon={<Trash2 size={14} />}
          onClick={onDelete}
          block
        >
          Delete node
        </Button>
      </div>
    </div>
  );
}

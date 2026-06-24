import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { NbtData } from "../flow/serialize";

// A canvas node: just a title with one input edge (left) and one output edge
// (right). Triggers have no input. All config is edited in the property panel.
function NbtNode({ data, selected }: NodeProps) {
  const d = data as unknown as NbtData;
  const marker = d.isTrigger ? " ⚡" : d.isSplit ? " ⑂" : "";
  // a custom colour overrides the default trigger/split accent stripe
  const style = d.color
    ? { borderColor: d.color, borderLeft: `4px solid ${d.color}` }
    : undefined;
  return (
    <div
      style={style}
      className={
        "nbt-rf-node" +
        (selected ? " selected" : "") +
        (d.isTrigger ? " trigger" : "") +
        (d.isSplit ? " split" : "")
      }
    >
      {!d.isTrigger && (
        <Handle type="target" position={Position.Left} id="in" />
      )}
      <span className="nbt-rf-title">{d.name}</span>
      {marker && <span className="nbt-rf-marker">{marker}</span>}
      <Handle type="source" position={Position.Right} id="out" />
    </div>
  );
}

export default memo(NbtNode);

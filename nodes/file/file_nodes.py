"""File system nodes (category: File).

Read / write / append text, read & write JSON, list a directory, test for
existence and delete. These run with the server's filesystem permissions —
this is an internal, single-user tool, so keep it on a trusted machine.
"""

import json
from pathlib import Path

from nbt.core.node_base import BaseNode, NodeError


class ReadFile(BaseNode):
    type_name = "read_file"
    label = "Read File"
    category = "File"
    inputs = {"path": "", "encoding": "utf-8"}
    outputs = ["content", "size", "path"]

    def run(self, inputs, ctx):
        path = str(inputs["path"]).strip()
        if not path:
            raise NodeError("path is required")
        try:
            text = Path(path).read_text(encoding=inputs["encoding"] or "utf-8")
        except FileNotFoundError:
            raise NodeError(f"file not found: {path}")
        except Exception as e:
            raise NodeError(f"read failed: {type(e).__name__}: {e}")
        log = ctx.get("log")
        if callable(log):
            log(f"read {len(text)} chars from {path}")
        return {"content": text, "size": len(text), "path": path}


class WriteFile(BaseNode):
    type_name = "write_file"
    label = "Write File"
    category = "File"
    # mkdirs: create parent folders; append: add instead of overwrite
    inputs = {"path": "", "content": "", "encoding": "utf-8",
              "mkdirs": True, "append": False}
    outputs = ["path", "bytes"]

    def run(self, inputs, ctx):
        path = str(inputs["path"]).strip()
        if not path:
            raise NodeError("path is required")
        p = Path(path)
        if inputs["mkdirs"] and p.parent and not p.parent.exists():
            p.parent.mkdir(parents=True, exist_ok=True)
        content = "" if inputs["content"] is None else str(inputs["content"])
        mode = "a" if inputs["append"] else "w"
        try:
            with open(p, mode, encoding=inputs["encoding"] or "utf-8") as f:
                n = f.write(content)
        except Exception as e:
            raise NodeError(f"write failed: {type(e).__name__}: {e}")
        log = ctx.get("log")
        if callable(log):
            log(f"{'appended' if inputs['append'] else 'wrote'} "
                f"{n} chars to {path}")
        return {"path": str(p), "bytes": n}


class AppendFile(BaseNode):
    type_name = "append_file"
    label = "Append File"
    category = "File"
    inputs = {"path": "", "content": "", "encoding": "utf-8",
              "newline": True, "mkdirs": True}
    outputs = ["path", "bytes"]

    def run(self, inputs, ctx):
        path = str(inputs["path"]).strip()
        if not path:
            raise NodeError("path is required")
        p = Path(path)
        if inputs["mkdirs"] and p.parent and not p.parent.exists():
            p.parent.mkdir(parents=True, exist_ok=True)
        text = "" if inputs["content"] is None else str(inputs["content"])
        if inputs["newline"]:
            text += "\n"
        try:
            with open(p, "a", encoding=inputs["encoding"] or "utf-8") as f:
                n = f.write(text)
        except Exception as e:
            raise NodeError(f"append failed: {type(e).__name__}: {e}")
        return {"path": str(p), "bytes": n}


class ReadJson(BaseNode):
    type_name = "read_json"
    label = "Read JSON"
    category = "File"
    inputs = {"path": "", "encoding": "utf-8"}
    outputs = ["data"]

    def run(self, inputs, ctx):
        path = str(inputs["path"]).strip()
        if not path:
            raise NodeError("path is required")
        try:
            raw = Path(path).read_text(encoding=inputs["encoding"] or "utf-8")
        except FileNotFoundError:
            raise NodeError(f"file not found: {path}")
        try:
            return {"data": json.loads(raw)}
        except json.JSONDecodeError as e:
            raise NodeError(f"invalid JSON in {path}: {e}")


class WriteJson(BaseNode):
    type_name = "write_json"
    label = "Write JSON"
    category = "File"
    # `data` accepts any value — pass `{{ last }}` or an alias to write objects
    inputs = {"path": "", "data": "", "indent": 2, "mkdirs": True}
    outputs = ["path"]

    def run(self, inputs, ctx):
        path = str(inputs["path"]).strip()
        if not path:
            raise NodeError("path is required")
        p = Path(path)
        if inputs["mkdirs"] and p.parent and not p.parent.exists():
            p.parent.mkdir(parents=True, exist_ok=True)
        try:
            indent = int(inputs["indent"])
        except Exception:
            indent = 2
        try:
            p.write_text(json.dumps(inputs["data"], indent=indent,
                                    default=str))
        except Exception as e:
            raise NodeError(f"write failed: {type(e).__name__}: {e}")
        return {"path": str(p)}


class ListDir(BaseNode):
    type_name = "list_dir"
    label = "List Directory"
    category = "File"
    inputs = {"path": ".", "pattern": "*", "recursive": False}
    outputs = ["files", "count"]

    def run(self, inputs, ctx):
        path = str(inputs["path"]).strip() or "."
        base = Path(path)
        if not base.exists():
            raise NodeError(f"directory not found: {path}")
        pattern = inputs["pattern"] or "*"
        matches = (base.rglob(pattern) if inputs["recursive"]
                   else base.glob(pattern))
        files = sorted(str(p) for p in matches)
        return {"files": files, "count": len(files)}


class FileExists(BaseNode):
    type_name = "file_exists"
    label = "File Exists"
    category = "File"
    inputs = {"path": ""}
    outputs = ["exists", "is_file", "is_dir"]

    def run(self, inputs, ctx):
        p = Path(str(inputs["path"]).strip())
        return {"exists": p.exists(), "is_file": p.is_file(),
                "is_dir": p.is_dir()}


class DeleteFile(BaseNode):
    type_name = "delete_file"
    label = "Delete File"
    category = "File"
    inputs = {"path": "", "missing_ok": True}
    outputs = ["deleted", "path"]

    def run(self, inputs, ctx):
        path = str(inputs["path"]).strip()
        if not path:
            raise NodeError("path is required")
        p = Path(path)
        if not p.exists():
            if inputs["missing_ok"]:
                return {"deleted": False, "path": str(p)}
            raise NodeError(f"file not found: {path}")
        if p.is_dir():
            raise NodeError(f"refusing to delete a directory: {path}")
        try:
            p.unlink()
        except Exception as e:
            raise NodeError(f"delete failed: {type(e).__name__}: {e}")
        log = ctx.get("log")
        if callable(log):
            log(f"deleted {path}")
        return {"deleted": True, "path": str(p)}

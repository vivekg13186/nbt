"""Display nodes (category: Display).

These nodes don't transform data so much as surface it in the UI. Their
outputs are rendered specially in the execution detail view:

* **Display Code** — shows text/code with a language label (JSON, JS, etc.).
  If you feed it an object (e.g. `{{ last }}`), it is pretty-printed as JSON.
* **Show Image** — renders an image from a local file path, an http(s) URL, or
  a data URI. Local files are inlined as a base64 data URI so the browser can
  display them without a separate file server.
"""

import base64
import json
import mimetypes
from pathlib import Path

from nbt.core.node_base import BaseNode, NodeError


class DisplayCode(BaseNode):
    type_name = "display_code"
    label = "Display Code"
    category = "Display"
    # language hints the viewer: json, javascript, python, text, ...
    inputs = {"content": "", "language": "json"}
    outputs = ["content", "language"]

    def run(self, inputs, ctx):
        content = inputs["content"]
        language = (inputs.get("language") or "text").strip().lower()
        # objects / non-strings: render as pretty JSON
        if not isinstance(content, str):
            try:
                content = json.dumps(content, indent=2, default=str)
                language = "json"
            except Exception:
                content = str(content)
        elif language == "json":
            # if it's a JSON string, re-indent it for readability
            try:
                content = json.dumps(json.loads(content), indent=2)
            except Exception:
                pass
        return {"content": content, "language": language}


class ShowImage(BaseNode):
    type_name = "show_image"
    label = "Show Image"
    category = "Display"
    # source: a file path, an http(s) URL, or a data: URI
    inputs = {"source": "", "alt": ""}
    outputs = ["src", "format"]

    def run(self, inputs, ctx):
        source = str(inputs["source"]).strip()
        if not source:
            raise NodeError("source is required (file path, URL or data URI)")
        low = source.lower()
        if low.startswith(("http://", "https://", "data:")):
            fmt = "data-uri" if low.startswith("data:") else "url"
            return {"src": source, "format": fmt}
        # local file
        p = Path(source)
        if not p.is_file():
            raise NodeError(f"image file not found: {source}")
        fmt = p.suffix.lstrip(".").lower() or "png"
        log = ctx.get("log")

        # Preferred: copy into the server's media folder and serve by URL
        # (robust for large images, keeps execution records small).
        media = ctx.get("media")
        if callable(media):
            try:
                url = media(str(p))
            except Exception as e:
                raise NodeError(f"could not publish image: {e}")
            if callable(log):
                log(f"published image {p.name} -> {url}")
            return {"src": url, "format": fmt}

        # Fallback (e.g. headless CLI with no server): inline as a data URI.
        mime = mimetypes.guess_type(p.name)[0] or "image/png"
        try:
            data = p.read_bytes()
        except Exception as e:
            raise NodeError(f"read failed: {type(e).__name__}: {e}")
        b64 = base64.b64encode(data).decode("ascii")
        if callable(log):
            log(f"loaded image {p.name} ({len(data)} bytes)")
        return {"src": f"data:{mime};base64,{b64}", "format": fmt}

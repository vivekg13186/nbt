# nbt-file-nodes

A node package for **NBT** that adds a **File** category: Read File, Write
File, Append File, Read JSON, Write JSON, List Directory, File Exists, Delete
File. Pure standard library — no dependencies.

## Install

In the NBT UI, open the **Packages** view and either:

- **Upload** `nbt-file-nodes.nbtpack` (or drag it anywhere onto the window), or
- **Install from git** by entering this repo's URL.

It installs into `nodes/file/` and the nodes appear under the **File** category
in the Nodes palette. Update or Remove it from the same Packages view.

## Build the bundle

Use the bundler script (validates the manifest, skips junk, nests under the
package name):

```bash
python tools/bundle_package.py packages/nbt-file-nodes
# -> file-1.0.0.nbtpack
```

## Layout

```
nbt-file-nodes/
  nbt-package.json   # name "file", version, requirements
  file_nodes.py      # the node classes (category = "File")
  README.md
```

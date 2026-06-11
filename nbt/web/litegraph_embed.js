// NBT LiteGraph embed. __METAS__ is replaced server-side with the node
// type metadata from the registry. Exposes window.nbt with:
//   addNode(type), exportGraph() -> nbt graph json, importGraph(json)
window.addEventListener('load', function () {
  var NBT_TYPES = {};
  var METAS = __METAS__;
  METAS.forEach(function (m) { NBT_TYPES[m.type] = m; });

  // only our node types in the right-click menu
  LiteGraph.registered_node_types = {};
  LiteGraph.searchbox_extras = {};

  function makeNodeClass(meta) {
    function N() {
      if (!meta.is_trigger) this.addInput('in', 'flow');
      this.addOutput('out', 'flow');
      this.w = {};   // param widgets
      var self = this;
      meta.params.forEach(function (p) {
        if (p.kind === 'bool') {
          self.w[p.name] = self.addWidget('toggle', p.name, !!p.default, function () {});
        } else if (p.kind === 'int') {
          self.w[p.name] = self.addWidget('number', p.name, Number(p.default),
            function () {}, { step: 10, precision: 0 });
        } else if (p.kind === 'float') {
          self.w[p.name] = self.addWidget('number', p.name, Number(p.default),
            function () {}, { step: 1, precision: 2 });
        } else {
          self.w[p.name] = self.addWidget('text', p.name, String(p.default), function () {});
        }
      });
      this.cw = this.addWidget('text',
        meta.is_trigger ? 'condition (filter)' : 'condition', '', function () {});
      if (!meta.is_trigger) {
        this.aw = this.addWidget('text', 'assert', '', function () {});
      }
      this.ow = {};  // output alias widgets
      meta.outputs.forEach(function (o) {
        self.ow[o] = self.addWidget('text', '→ ' + o, '', function () {});
      });
      this.properties = { nbt_id: null, nbt_name: null };
      this.serialize_widgets = true;
      this.size = this.computeSize();
      this.size[0] = Math.max(this.size[0], 230);
    }
    N.title = meta.label + (meta.is_trigger ? ' ⚡' : '');
    N.prototype.nbtType = meta.type;
    return N;
  }

  METAS.forEach(function (m) {
    LiteGraph.registerNodeType('nbt/' + m.type, makeNodeClass(m));
  });

  var canvasEl = document.getElementById('nbt-canvas');
  var graph = new LGraph();
  var lcanvas = new LGraphCanvas(canvasEl, graph);
  lcanvas.allow_searchbox = true;

  window.nbt = { graph: graph, canvas: lcanvas, counter: 0, _orphans: [] };

  function resize() {
    var r = canvasEl.parentElement.getBoundingClientRect();
    canvasEl.width = r.width;
    canvasEl.height = r.height;
    lcanvas.resize();
  }
  window.addEventListener('resize', resize);
  resize();
  graph.start();

  graph.onNodeAdded = function (node) {
    if (node.properties && !node.properties.nbt_id) {
      node.properties.nbt_id = 'n' + (++window.nbt.counter);
      node.properties.nbt_name =
        (node.nbtType || 'node') + '_' + node.properties.nbt_id;
    }
  };

  window.nbt.addNode = function (type) {
    var n = LiteGraph.createNode('nbt/' + type);
    if (!n) return;
    var c = lcanvas.ds ? lcanvas.ds.offset : [0, 0];
    n.pos = [80 - c[0] + Math.random() * 140, 80 - c[1] + Math.random() * 140];
    graph.add(n);
  };

  function coerce(meta, name, value) {
    var p = null;
    meta.params.forEach(function (q) { if (q.name === name) p = q; });
    if (!p) return value;
    if (p.kind === 'int') return Math.round(Number(value) || 0);
    if (p.kind === 'float') return Number(value) || 0.0;
    if (p.kind === 'bool') return !!value;
    return String(value === undefined || value === null ? '' : value);
  }

  window.nbt.exportGraph = function () {
    var nodes = [];
    var links = [];
    graph._nodes.forEach(function (n) {
      if (!n.nbtType || !NBT_TYPES[n.nbtType]) return;
      var meta = NBT_TYPES[n.nbtType];
      var params = {};
      for (var k in n.w) params[k] = coerce(meta, k, n.w[k].value);
      var aliases = {};
      for (var o in n.ow) {
        var v = String(n.ow[o].value || '').trim();
        if (v) aliases[o] = v;
      }
      nodes.push({
        id: n.properties.nbt_id,
        type: n.nbtType,
        name: n.properties.nbt_name,
        params: params,
        condition: n.cw ? String(n.cw.value || '') : '',
        assert: n.aw ? String(n.aw.value || '') : '',
        out_aliases: aliases,
        pos: [Math.round(n.pos[0]), Math.round(n.pos[1])],
      });
    });
    for (var id in graph.links) {
      var l = graph.links[id];
      if (!l) continue;
      var a = graph.getNodeById(l.origin_id);
      var b = graph.getNodeById(l.target_id);
      if (a && b && a.properties.nbt_id && b.properties.nbt_id) {
        links.push([a.properties.nbt_id, b.properties.nbt_id]);
      }
    }
    // nodes whose type went missing on import are preserved untouched
    window.nbt._orphans.forEach(function (nd) { nodes.push(nd); });
    return { nodes: nodes, links: links };
  };

  window.nbt.importGraph = function (data) {
    graph.clear();
    graph.onNodeAdded = null;  // ids come from the data during import
    window.nbt.counter = 0;
    window.nbt._orphans = [];
    var byId = {};
    (data.nodes || []).forEach(function (nd) {
      var node = LiteGraph.createNode('nbt/' + nd.type);
      if (!node) {  // type no longer in nodes/: keep data, skip rendering
        console.warn('nbt: unknown node type', nd.type);
        window.nbt._orphans.push(nd);
        return;
      }
      node.pos = [(nd.pos && nd.pos[0]) || 60, (nd.pos && nd.pos[1]) || 60];
      graph.add(node);
      node.properties.nbt_id = nd.id;
      node.properties.nbt_name = nd.name || null;
      var m = parseInt(String(nd.id).replace(/^n/, ''), 10);
      if (!isNaN(m) && m > window.nbt.counter) window.nbt.counter = m;
      for (var k in (nd.params || {})) {
        if (node.w[k] !== undefined) node.w[k].value = nd.params[k];
      }
      if (node.cw) node.cw.value = nd.condition || '';
      if (node.aw) node.aw.value = nd['assert'] || '';
      for (var o in (nd.out_aliases || {})) {
        if (node.ow[o]) node.ow[o].value = nd.out_aliases[o];
      }
      byId[nd.id] = node;
    });
    (data.links || []).forEach(function (l) {
      var a = byId[l[0]];
      var b = byId[l[1]];
      if (a && b) a.connect(0, b, 0);
    });
    graph.onNodeAdded = function (node) {
      if (node.properties && !node.properties.nbt_id) {
        node.properties.nbt_id = 'n' + (++window.nbt.counter);
        node.properties.nbt_name =
          (node.nbtType || 'node') + '_' + node.properties.nbt_id;
      }
    };
    lcanvas.setDirty(true, true);
    return true;
  };
});

// Figma → Affinity (Đình) — xuất frame đang chọn ra file .figaf
// File .figaf = "FIGAF1" + độ dài JSON (4 byte, little-endian) + JSON (UTF-8) + dữ liệu ảnh RGBA.
// Script Affinity "figaf-import.js" đọc file này và dựng lại thành object gốc của Affinity.

const FORMAT_VERSION = 1;
const PLUGIN_VERSION = '0.2.0-beta';

figma.showUI(__html__, { width: 380, height: 320 });

const warnings = [];
let imageList = [];      // [{ hash }]
let imageIndex = {};     // hash -> index
let stats = {};
let warns_path_unsupported = false;
let smoothingWarned = false;

function warn(node, msg) {
  warnings.push((node ? '"' + node.name + '": ' : '') + msg);
}

function count(kind) {
  stats[kind] = (stats[kind] || 0) + 1;
}

// ---------- hình học ----------

function apply(m, x, y) {
  return [m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2]];
}

function isAxisAligned(m) {
  return Math.abs(m[0][1]) < 1e-6 && Math.abs(m[1][0]) < 1e-6 && m[0][0] > 0 && m[1][1] > 0;
}

function mul(A, B) { // A·B, cả hai dạng [[a,b,tx],[c,d,ty]]
  return [
    [A[0][0] * B[0][0] + A[0][1] * B[1][0], A[0][0] * B[0][1] + A[0][1] * B[1][1], A[0][0] * B[0][2] + A[0][1] * B[1][2] + A[0][2]],
    [A[1][0] * B[0][0] + A[1][1] * B[1][0], A[1][0] * B[0][1] + A[1][1] * B[1][1], A[1][0] * B[0][2] + A[1][1] * B[1][2] + A[1][2]]
  ];
}

function invert(t) {
  const a = t[0][0], b = t[0][1], c = t[0][2];
  const d = t[1][0], e = t[1][1], f = t[1][2];
  const det = a * e - b * d;
  if (Math.abs(det) < 1e-12) return null;
  return [
    [e / det, -b / det, (b * f - c * e) / det],
    [-d / det, a / det, (c * d - a * f) / det]
  ];
}

// Phân tích path SVG (Figma dùng M L Q C Z, có thể có H V) và đổi sang toạ độ tuyệt đối trên page.
// Kết quả: [['M',x,y], ['L',x,y], ['C',x1,y1,x2,y2,x,y], ['Z']]
function parsePath(d, m) {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  const out = [];
  let i = 0, cmd = '', cx = 0, cy = 0, sx = 0, sy = 0;
  function num() { return parseFloat(tokens[i++]); }
  function pt(x, y) { return apply(m, x, y); }
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === 'Z') {
      out.push(['Z']);
      cx = sx; cy = sy;
      continue;
    }
    if (C === 'M' || C === 'L') {
      let x = num(), y = num();
      if (rel) { x += cx; y += cy; }
      const p = pt(x, y);
      out.push([C, p[0], p[1]]);
      cx = x; cy = y;
      if (C === 'M') { sx = x; sy = y; cmd = rel ? 'l' : 'L'; }
    } else if (C === 'H') {
      let x = num(); if (rel) x += cx;
      const p = pt(x, cy); out.push(['L', p[0], p[1]]); cx = x;
    } else if (C === 'V') {
      let y = num(); if (rel) y += cy;
      const p = pt(cx, y); out.push(['L', p[0], p[1]]); cy = y;
    } else if (C === 'C') {
      let x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
      if (rel) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy; }
      const p1 = pt(x1, y1), p2 = pt(x2, y2), p = pt(x, y);
      out.push(['C', p1[0], p1[1], p2[0], p2[1], p[0], p[1]]);
      cx = x; cy = y;
    } else if (C === 'Q') {
      let qx = num(), qy = num(), x = num(), y = num();
      if (rel) { qx += cx; qy += cy; x += cx; y += cy; }
      // đổi bezier bậc 2 sang bậc 3
      const x1 = cx + 2 / 3 * (qx - cx), y1 = cy + 2 / 3 * (qy - cy);
      const x2 = x + 2 / 3 * (qx - x), y2 = y + 2 / 3 * (qy - y);
      const p1 = pt(x1, y1), p2 = pt(x2, y2), p = pt(x, y);
      out.push(['C', p1[0], p1[1], p2[0], p2[1], p[0], p[1]]);
      cx = x; cy = y;
    } else {
      // S, T hiếm gặp trong dữ liệu Figma: bỏ qua phần còn lại để không làm hỏng hình
      warns_path_unsupported = true;
      break;
    }
  }
  return out;
}
function geometryPaths(geom, m) {
  const res = [];
  for (const g of geom || []) {
    res.push({ winding: g.windingRule, cmds: parsePath(g.data, m) });
  }
  return res;
}

// ---------- màu và paint ----------

function rgba(c, opacity) {
  return {
    r: Math.round(c.r * 255),
    g: Math.round(c.g * 255),
    b: Math.round(c.b * 255),
    a: (c.a === undefined ? 1 : c.a) * (opacity === undefined ? 1 : opacity)
  };
}

function mapPaints(node, paints) {
  if (!paints || paints === figma.mixed) return [];
  const out = [];
  for (const p of paints) {
    if (p.visible === false) continue;
    if (p.type === 'SOLID') {
      const c = rgba(p.color, p.opacity);
      c.type = 'SOLID';
      out.push(c);
    } else if (p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL' || p.type === 'GRADIENT_ANGULAR' || p.type === 'GRADIENT_DIAMOND') {
      const inv = invert(p.gradientTransform);
      const m = node.absoluteTransform;
      const w = node.width, h = node.height;
      function toAbs(gx, gy) {
        const u = inv ? apply(inv, gx, gy) : [gx, gy];
        return apply(m, u[0] * w, u[1] * h);
      }
      const radial = p.type !== 'GRADIENT_LINEAR';
      if (p.type === 'GRADIENT_DIAMOND') {
        warn(node, 'gradient dạng kim cương (diamond) được chuyển thành gradient tròn (radial).');
      }
      out.push({
        type: p.type === 'GRADIENT_ANGULAR' ? 'ANGULAR' : (radial ? 'RADIAL' : 'LINEAR'),
        opacity: p.opacity === undefined ? 1 : p.opacity,
        stops: p.gradientStops.map(function (s) {
          const c = rgba(s.color, p.opacity);
          c.pos = s.position;
          return c;
        }),
        start: radial ? toAbs(0.5, 0.5) : toAbs(0, 0.5),
        end: toAbs(1, 0.5),
        // Ma trận đầy đủ: toạ độ gradient của Figma -> toạ độ page (giữ cả lật, xoay, kéo méo).
        gx: mul(m, mul([[w, 0, 0], [0, h, 0]], inv || [[1, 0, 0], [0, 1, 0]]))
      });
    } else if (p.type === 'IMAGE') {
      if (!p.imageHash) continue;
      if (imageIndex[p.imageHash] === undefined) {
        imageIndex[p.imageHash] = imageList.length;
        imageList.push({ hash: p.imageHash });
      }
      if (p.scaleMode === 'TILE') warn(node, 'ảnh dạng lặp (tile) được đặt như ảnh phủ kín (fill).');
      out.push({
        type: 'IMAGE',
        image: imageIndex[p.imageHash],
        scaleMode: p.scaleMode,
        imageTransform: p.imageTransform || null,
        rotation: p.rotation || 0,
        opacity: p.opacity === undefined ? 1 : p.opacity
      });
    } else {
      warn(node, 'kiểu paint ' + p.type + ' chưa hỗ trợ, đã bỏ qua.');
    }
  }
  return out;
}

function mapEffects(node) {
  const out = [];
  for (const e of node.effects || []) {
    if (e.visible === false) continue;
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      out.push({
        type: e.type,
        color: rgba(e.color),
        offset: e.offset,
        radius: e.radius,
        spread: e.spread || 0,
        behind: e.type === 'DROP_SHADOW' ? !!e.showShadowBehindNode : undefined
      });
    } else if (e.type === 'LAYER_BLUR') {
      out.push({ type: 'LAYER_BLUR', radius: e.radius });
    } else {
      warn(node, 'hiệu ứng ' + e.type + ' chưa hỗ trợ, đã bỏ qua.');
    }
  }
  return out;
}

function cornerRadii(node) {
  if (!('cornerRadius' in node)) return null;
  if (node.cornerSmoothing > 0 && !smoothingWarned) {
    smoothingWarned = true;
    warn(node, 'corner smoothing (bo góc kiểu iOS) không có trong Affinity, dùng bo góc tròn thường. Góc sẽ hơi khác một chút.');
  }
  if (node.cornerRadius !== figma.mixed) {
    const r = node.cornerRadius || 0;
    return r ? { tl: r, tr: r, br: r, bl: r } : null;
  }
  return {
    tl: node.topLeftRadius || 0,
    tr: node.topRightRadius || 0,
    br: node.bottomRightRadius || 0,
    bl: node.bottomLeftRadius || 0
  };
}

function strokeInfo(node, out) {
  if (!('strokes' in node)) return;
  const strokes = mapPaints(node, node.strokes).filter(function (p) { return p.type !== 'IMAGE'; });
  if (!strokes.length) return;
  let weight = node.strokeWeight;
  if (weight === figma.mixed) {
    weight = Math.max(node.strokeTopWeight || 0, node.strokeRightWeight || 0, node.strokeBottomWeight || 0, node.strokeLeftWeight || 0);
    warn(node, 'độ dày viền khác nhau từng cạnh, dùng độ dày lớn nhất.');
  }
  if (!weight) return;
  out.strokes = strokes;
  out.strokeWeight = weight;
  out.strokeAlign = node.strokeAlign || 'CENTER';
  let cap = node.strokeCap;
  if (cap === figma.mixed && node.vectorNetwork) {
    // Vector có đầu nét khác nhau từng điểm: lấy kiểu đầu nét đầu tiên khác NONE.
    const v = node.vectorNetwork.vertices.filter(function (x) { return x.strokeCap && x.strokeCap !== 'NONE'; })[0];
    cap = v ? v.strokeCap : 'NONE';
  }
  if (typeof cap === 'string') out.strokeCap = cap;
  if (typeof node.strokeJoin === 'string') out.strokeJoin = node.strokeJoin;
  if (node.dashPattern && node.dashPattern.length) {
    out.dashPattern = node.dashPattern.slice();
    warn(node, 'viền nét đứt được chuyển thành viền liền.');
  }
}

// ---------- lưới và guide ----------

function gridGuides(node) {
  const v = [], h = [];
  if (!isAxisAligned(node.absoluteTransform)) return { v: v, h: h };
  const m = node.absoluteTransform;
  const W = node.width, H = node.height;
  const ox = m[0][2], oy = m[1][2];
  for (const g of node.layoutGrids || []) {
    if (g.visible === false) continue;
    if (g.pattern === 'GRID') {
      warn(node, 'lưới ô vuông (grid ' + g.sectionSize + 'px) không chuyển thành guide.');
      continue;
    }
    const isCol = g.pattern === 'COLUMNS';
    const size = isCol ? W : H;
    let n = g.count;
    if (!n || n < 1 || !isFinite(n)) {
      warn(node, 'lưới ' + g.pattern + ' không có số cột cố định, đã bỏ qua.');
      continue;
    }
    const gutter = g.gutterSize || 0;
    const offset = g.offset || 0;
    let cell, start;
    if (g.alignment === 'STRETCH') {
      cell = (size - 2 * offset - gutter * (n - 1)) / n;
      start = offset;
    } else {
      cell = g.sectionSize;
      const total = n * cell + (n - 1) * gutter;
      if (g.alignment === 'MIN') start = offset;
      else if (g.alignment === 'MAX') start = size - offset - total;
      else start = (size - total) / 2;
    }
    for (let i = 0; i < n; i++) {
      const a = start + i * (cell + gutter);
      const list = isCol ? v : h;
      const base = isCol ? ox : oy;
      list.push(base + a, base + a + cell);
    }
  }
  for (const gd of node.guides || []) {
    if (gd.axis === 'X') v.push(ox + gd.offset);
    else h.push(oy + gd.offset);
  }
  function uniq(arr) {
    const seen = {};
    return arr.filter(function (x) {
      const k = Math.round(x * 100);
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });
  }
  return { v: uniq(v), h: uniq(h) };
}

// ---------- text ----------

function serializeText(node, out) {
  const segs = node.getStyledTextSegments([
    'fontName', 'fontSize', 'fontWeight', 'fills', 'letterSpacing',
    'lineHeight', 'textDecoration', 'textCase'
  ]);
  out.text = {
    autoResize: node.textAutoResize,
    alignH: node.textAlignHorizontal,
    alignV: node.textAlignVertical,
    paragraphSpacing: node.paragraphSpacing || 0,
    paragraphIndent: node.paragraphIndent || 0,
    segments: segs.map(function (s) {
      const fills = mapPaints(node, s.fills);
      const solid = fills.filter(function (f) { return f.type === 'SOLID'; })[0];
      if (fills.length && !solid) warn(node, 'màu chữ dạng gradient hoặc ảnh được thay bằng màu đầu tiên.');
      let color = solid;
      if (!color && fills.length && fills[0].stops) color = fills[0].stops[0];
      if (s.textDecoration && s.textDecoration !== 'NONE') warn(node, 'gạch chân hoặc gạch ngang chữ chưa được chuyển.');
      let chars = s.characters;
      let smallCaps = false;
      if (s.textCase === 'UPPER') chars = chars.toUpperCase();
      else if (s.textCase === 'LOWER') chars = chars.toLowerCase();
      else if (s.textCase === 'SMALL_CAPS' || s.textCase === 'SMALL_CAPS_FORCED') {
        chars = chars.toUpperCase();
        smallCaps = true;
      }
      else if (s.textCase && s.textCase !== 'ORIGINAL') warn(node, 'kiểu chữ ' + s.textCase + ' chưa được chuyển.');
      if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(chars) &&
          !/CJK|JP|KR|SC|TC|HK|Han|PingFang|Hiragino|Gothic|Mincho|Meiryo|Songti|Heiti|Kaiti|Ming|Hei|Song/i.test(s.fontName.family)) {
        warn(node, 'chữ Hán/Nhật/Hàn đang dùng font "' + s.fontName.family + '" không có các ký tự này. Figma tự lấy font khác để hiển thị, Affinity sẽ lấy font khác nữa nên chữ có thể lệch. Nên chọn hẳn font CJK cho đoạn này, hoặc outline nếu là logo.');
      }
      return {
        chars: chars,
        family: s.fontName.family,
        style: s.fontName.style,
        weight: s.fontWeight,
        size: s.fontSize,
        color: color || { r: 0, g: 0, b: 0, a: 1 },
        letterSpacing: s.letterSpacing,
        lineHeight: s.lineHeight,
        smallCaps: smallCaps
      };
    })
  };
}

// ---------- duyệt cây ----------

function serialize(node, asMask) {
  if (node.isMask && !asMask) return null; // mask được xử lý trong serializeChildren
  const out = {
    name: node.name,
    figmaType: node.type,
    visible: node.visible !== false,
    opacity: 'opacity' in node ? node.opacity : 1,
    w: node.width,
    h: node.height,
    m: node.absoluteTransform
  };
  if ('blendMode' in node && node.blendMode !== 'PASS_THROUGH' && node.blendMode !== 'NORMAL') {
    out.blendMode = node.blendMode;
    warn(node, 'blend mode ' + node.blendMode + ' chưa được chuyển.');
  }
  if ('effects' in node) {
    const fx = mapEffects(node);
    if (fx.length) out.effects = fx;
  }
  const aligned = isAxisAligned(node.absoluteTransform);

  switch (node.type) {
    case 'TEXT':
      out.kind = 'text';
      serializeText(node, out);
      count('text');
      return out;

    case 'FRAME':
    case 'COMPONENT':
    case 'COMPONENT_SET':
    case 'INSTANCE':
    case 'SECTION': {
      out.kind = 'frame';
      out.fills = mapPaints(node, node.fills);
      strokeInfo(node, out);
      out.radius = cornerRadii(node);
      out.clips = node.type === 'SECTION' ? false : !!node.clipsContent;
      if (!aligned) {
        out.bgPaths = geometryPaths(node.fillGeometry, node.absoluteTransform);
      }
      if (node.layoutMode && node.layoutMode !== 'NONE') count('autoLayoutFlattened');
      out.children = serializeChildren(node);
      count('frame');
      return out;
    }

    case 'GROUP':
      out.kind = 'group';
      out.children = serializeChildren(node);
      count('group');
      return out;

    case 'RECTANGLE':
    case 'ELLIPSE': {
      out.fills = mapPaints(node, node.fills);
      strokeInfo(node, out);
      let simple = aligned;
      if (node.type === 'ELLIPSE') {
        const a = node.arcData;
        if (a && (a.innerRadius > 0 || Math.abs((a.endingAngle - a.startingAngle) - 2 * Math.PI) > 1e-3)) simple = false;
      }
      if (simple) {
        out.kind = node.type === 'RECTANGLE' ? 'rect' : 'ellipse';
        if (node.type === 'RECTANGLE') out.radius = cornerRadii(node);
      } else {
        out.kind = 'path';
        out.paths = geometryPaths(node.fillGeometry, node.absoluteTransform);
      }
      count(out.kind);
      return out;
    }

    case 'VECTOR':
    case 'STAR':
    case 'POLYGON':
    case 'BOOLEAN_OPERATION':
    case 'LINE': {
      out.kind = 'path';
      out.fills = mapPaints(node, node.fills);
      strokeInfo(node, out);
      if (node.type === 'LINE') {
        const p0 = apply(node.absoluteTransform, 0, 0);
        const p1 = apply(node.absoluteTransform, node.width, 0);
        out.paths = [{ winding: 'NONZERO', open: true, cmds: [['M', p0[0], p0[1]], ['L', p1[0], p1[1]]] }];
      } else if (node.type === 'VECTOR' && !out.fills.length && out.strokes) {
        // vector chỉ có viền: dùng path gốc để giữ viền chỉnh sửa được
        out.paths = node.vectorPaths.map(function (vp) {
          return { winding: vp.windingRule, open: !/z\s*$/i.test(vp.data), cmds: parsePath(vp.data, node.absoluteTransform) };
        });
      } else {
        out.paths = geometryPaths(node.fillGeometry, node.absoluteTransform);
        if (!out.paths.length && out.strokes) {
          out.paths = geometryPaths(node.strokeGeometry, node.absoluteTransform);
          out.fills = out.strokes;
          delete out.strokes;
        }
      }
      if (node.type === 'BOOLEAN_OPERATION') count('booleanFlattened');
      count('path');
      return out;
    }

    default:
      warn(node, 'loại layer ' + node.type + ' chưa hỗ trợ, đã bỏ qua.');
      return null;
  }
}

function hasVisibleFill(n) {
  if (!Array.isArray(n.fills)) return false;
  return n.fills.some(function (f) {
    if (f.visible === false || f.opacity === 0) return false;
    if (f.type === 'SOLID' && f.color && f.color.a === 0) return false;
    return true;
  });
}

// Hình dạng thật của layer mask (mask alpha của Figma lấy phần có màu của layer và các layer con).
function maskGeometry(n) {
  if (n.visible === false) return [];
  let res = [];
  if ('fillGeometry' in n && n.fillGeometry && n.fillGeometry.length && hasVisibleFill(n)) {
    res = res.concat(geometryPaths(n.fillGeometry, n.absoluteTransform));
  }
  if ('children' in n) {
    for (const ch of n.children) res = res.concat(maskGeometry(ch));
  }
  return res;
}

function sameBox(s, bb) {
  if (!isAxisAligned(s.m)) return false;
  const x = s.m[0][2], y = s.m[1][2];
  return Math.abs(x - bb.x) < 1 && Math.abs(y - bb.y) < 1 && Math.abs(s.w - bb.width) < 1 && Math.abs(s.h - bb.height) < 1;
}

// Mask là frame/instance không màu chứa đúng một rectangle không xoay -> trả về rectangle đó.
function maskRectChild(n) {
  if (n.type === 'RECTANGLE') return isAxisAligned(n.absoluteTransform) ? n : null;
  if (!('children' in n) || hasVisibleFill(n)) return null;
  const kids = n.children.filter(function (ch) { return ch.visible !== false; });
  if (kids.length !== 1 || kids[0].type !== 'RECTANGLE' || !isAxisAligned(kids[0].absoluteTransform)) return null;
  return kids[0];
}

// Trong Figma, layer mask cắt mọi layer nằm trên nó trong cùng nhóm.
// Xuất thành { kind: 'mask', shape: <hình mask>, children: [các layer bị cắt] }.
function serializeChildren(node) {
  const res = [];
  let current = res;
  for (const c of node.children || []) {
    if (c.isMask) {
      let shape = serialize(c, true);
      let ok = shape && (shape.kind === 'rect' || shape.kind === 'ellipse' || shape.kind === 'path' || shape.kind === 'frame');
      if (!ok && shape && shape.kind === 'group') {
        // Mask là một nhóm: hình mask là hợp các hình có màu bên trong nhóm.
        const gg = maskGeometry(c);
        if (gg.length) {
          shape = { kind: 'path', name: c.name, figmaType: c.type, visible: true, opacity: 1, w: c.width, h: c.height, m: c.absoluteTransform,
            paths: gg, fills: [{ type: 'SOLID', r: 255, g: 255, b: 255, a: 1 }] };
          ok = true;
        }
      }
      if (!ok) {
        warn(c, 'mask dạng ' + c.type + ' chưa hỗ trợ, các layer phía trên không bị cắt.');
        continue;
      }
      if (c.maskType === 'LUMINANCE') warn(c, 'mask độ sáng (luminance) được chuyển thành mask theo hình dạng.');
      if (shape.kind === 'frame') delete shape.children;
      // Dùng hình học thật của mask (đã gồm bo góc, corner smoothing) thay cho khung chữ nhật.
      // Mask là frame/instance/group thì hình dạng nằm ở các layer con của nó.
      const geo = maskGeometry(c);
      const rectChild = maskRectChild(c);
      if (rectChild) {
        // Mask chỉ là một hình chữ nhật bo góc: giữ dạng rectangle để chỉnh được độ bo góc trong Affinity.
        shape.kind = 'rect';
        shape.w = rectChild.width; shape.h = rectChild.height;
        shape.m = rectChild.absoluteTransform;
        shape.radius = cornerRadii(rectChild);
        delete shape.paths; delete shape.bgPaths;
      } else if (geo.length) {
        shape.kind = 'path';
        shape.paths = geo;
      }
      shape.maskInfo = {
        type: c.type,
        cornerRadius: 'cornerRadius' in c ? (c.cornerRadius === figma.mixed ? 'mixed' : c.cornerRadius) : null,
        smoothing: 'cornerSmoothing' in c ? c.cornerSmoothing : null,
        maskType: c.maskType || null,
        fills: Array.isArray(c.fills) ? c.fills.map(function (f) { return f.type + (f.visible === false ? '(ẩn)' : '') + (f.opacity < 1 ? '@' + f.opacity : ''); }).join('+') : '',
        children: 'children' in c ? c.children.map(function (ch) { return ch.type + ' ' + ch.name; }).join(', ') : '',
        subpaths: geo.length
      };
      const m = { kind: 'mask', name: c.name, figmaType: 'MASK', visible: true, opacity: 1, w: c.width, h: c.height, m: c.absoluteTransform, shape: shape, children: [] };
      // Nền nằm ngay dưới mask có cùng khung với mask: đưa vào trong mask.
      // Nhìn không đổi, nhưng tránh vệt mảnh màu nền lộ ra ở mép (hai mép trùng nhau khử răng cưa riêng).
      const prev = res[res.length - 1];
      const mb = c.absoluteBoundingBox;
      if (prev && prev.kind !== 'mask' && !(prev.effects && prev.effects.length) && mb && sameBox(prev, mb)) {
        res.pop();
        m.children.push(prev);
      }
      res.push(m);
      current = m.children;
      count('mask');
      continue;
    }
    const s = serialize(c);
    if (s) current.push(s);
  }
  return res;
}

// ---------- xuất ----------

async function exportSelection() {
  warnings.length = 0;
  imageList = [];
  imageIndex = {};
  stats = {};
  warns_path_unsupported = false;
  smoothingWarned = false;

  const sel = figma.currentPage.selection;
  if (!sel.length) {
    figma.ui.postMessage({ type: 'error', message: 'Hãy chọn ít nhất một frame trước khi xuất.' });
    return;
  }

  const roots = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of sel) {
    const s = serialize(node);
    if (!s) continue;
    const bb = node.absoluteBoundingBox || { x: node.absoluteTransform[0][2], y: node.absoluteTransform[1][2], width: node.width, height: node.height };
    s.bbox = bb;
    if ('layoutGrids' in node || 'guides' in node) s.guides = gridGuides(node);
    roots.push(s);
    minX = Math.min(minX, bb.x); minY = Math.min(minY, bb.y);
    maxX = Math.max(maxX, bb.x + bb.width); maxY = Math.max(maxY, bb.y + bb.height);
  }
  if (warns_path_unsupported) warn(null, 'một số path có lệnh S/T chưa hỗ trợ, hình có thể thiếu.');

  figma.ui.postMessage({ type: 'progress', message: 'Đang đọc ' + imageList.length + ' ảnh…' });
  const images = [];
  for (let i = 0; i < imageList.length; i++) {
    const img = figma.getImageByHash(imageList[i].hash);
    const bytes = img ? await img.getBytesAsync() : null;
    images.push(bytes);
  }

  const doc = {
    format: 'figaf',
    version: FORMAT_VERSION,
    source: { file: figma.root.name, page: figma.currentPage.name, exportedAt: new Date().toISOString(), pluginVersion: PLUGIN_VERSION },
    origin: { x: minX, y: minY },
    size: { w: maxX - minX, h: maxY - minY },
    roots: roots,
    stats: stats,
    warnings: warnings.slice(0, 500),
    images: []
  };

  const baseName = (roots.length === 1 ? roots[0].name : figma.root.name).replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || 'figma-export';
  figma.ui.postMessage({ type: 'payload', doc: doc, images: images, fileName: baseName + '.figaf' });
}

figma.ui.onmessage = function (msg) {
  if (msg.type === 'export') {
    exportSelection().catch(function (e) {
      figma.ui.postMessage({ type: 'error', message: 'Lỗi khi xuất: ' + (e && e.message ? e.message : String(e)) });
    });
  } else if (msg.type === 'done') {
    figma.notify('Đã xuất ' + msg.fileName);
  } else if (msg.type === 'close') {
    figma.closePlugin();
  }
};

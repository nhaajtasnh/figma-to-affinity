/**
 * name: Figma → Affinity (beta)
 * description: Mở file .figaf (xuất từ plugin Figma của Đình) và dựng lại thành document Affinity chỉnh sửa được.
 * version: 0.2.0-beta
 * author: Đình Collective
 */

'use strict';

// ===================================================================
//  Tuỳ chỉnh
// ===================================================================

const SCRIPT_VERSION = '0.2.0-beta';
// Bật để in chi tiết từng layer ra console (dùng khi báo lỗi).
const DEBUG = false;

// Nới khung text tự co giãn của Figma một chút để Affinity không xuống dòng
// sai do khác biệt đo chữ giữa hai phần mềm.
const AUTO_WIDTH_SLACK = 1.0;     // nhân chiều rộng khung text auto-width
const AUTO_HEIGHT_SLACK = 1.1;   // nhân chiều cao khung text auto-height
// Chữ auto-width của Figma dựng thành Artistic Text (giữ đúng bề rộng, không tự xuống dòng).
const AUTO_WIDTH_AS_ARTISTIC = true;
const ADD_GUIDES = true;         // chuyển layout grid / guide của Figma thành guide
// Frame lồng nhau có "Clip content": true = cắt nội dung bằng shape (dễ lỗi hiển thị),
// false = chuyển thành layer nhóm kèm nền (an toàn hơn).
const CLIP_NESTED_FRAMES = true;
// Mask của Figma dựng thành mask layer thật của Affinity (shape trắng gắn vào nhóm làm mask)
// thay vì cắt nội dung bằng shape (clip). Đặt false để quay lại cách clip.
const MASK_AS_LAYER = true;
// Shape mask có fill gần như trong suốt thay cho "không fill".
const MASK_HAIRLINE_FILL = true;
// Làm tròn vị trí và kích thước về số nguyên pixel (như "snap to pixel"), tránh vệt mảnh ở mép.
// Hình có thể xê dịch tối đa 0,5px so với Figma. Đặt false để giữ toạ độ lẻ như Figma.
const ROUND_TO_PIXEL = true;
// Độ mờ bóng đổ: radius của Affinity = blur của Figma × hệ số này.
const SHADOW_BLUR_SCALE = 1.0;
const LAYER_BLUR_SCALE = 0.5;

// ===================================================================
//  Module SDK
// ===================================================================

function dlog(msg) { if (DEBUG) dlog(msg); }

function safeRequire(path) {
  try { return require(path); } catch (e) { return {}; }
}

const { app } = require('/application');
const { Document, NewDocumentOptions } = require('/document');
const { File } = require('/fs');
const { UnitType } = require('/units');
const { AddChildNodesCommandBuilder, DocumentCommand, InsertionMode } = require('/commands');
const NodeMoveType = safeRequire('/commands').NodeMoveType || safeRequire('affinity:dom').NodeMoveType;
const NodeChildType = safeRequire('affinity:dom').NodeChildType || safeRequire('/nodes').NodeChildType || safeRequire('/commands').NodeChildType;
const { ShapeNodeDefinition, FrameTextNodeDefinition, ArtTextNodeDefinition, ContainerNodeDefinition,
        PolyCurveNodeDefinition, ImageNodeDefinition } = require('/nodes');
const { Shape, ShapeType, ShapeRectangle, ShapeCornerType } = require('/shapes');
const { Rectangle, CurveBuilder, PolyCurve, Transform } = require('/geometry');
const { Colour, Gradient } = require('/colours');
const { FillDescriptor, GradientFill } = require('/fills');
const { GradientFillType } = safeRequire('affinity:fills');
const { BlendMode } = safeRequire('affinity:common');
const { LineStyle, LineStyleDescriptor, StrokeAlignment } = require('/linestyle');
const { StoryBuilder } = require('/storybuilder');
const { Font, FontFamily } = require('/fonts');
const { ParagraphAlignXType, ParagraphLeadingType } = require('/paragraphatts');
const { Selection } = require('/selections');
const { PixelBuffer, RasterFormat } = require('/rasterobject');
const LayerFx = safeRequire('/layereffects');

// ===================================================================
//  Báo cáo
// ===================================================================

const report = {
  created: {},
  failed: [],
  missingFonts: {},
  notes: []
};

function created(kind) { report.created[kind] = (report.created[kind] || 0) + 1; }
function failed(name, what, e) {
  report.failed.push('"' + name + '" (' + what + '): ' + (e && e.message ? e.message : String(e)));
}

// ===================================================================
//  Đọc file .figaf
// ===================================================================

function bytesOf(buf) {
  if (!buf) return null;
  if (buf.array) return buf.array;
  if (buf.buffer) return new Uint8Array(buf.buffer);
  return null;
}

function utf8Decode(bytes) {
  let out = '';
  let i = 0;
  const chunk = [];
  while (i < bytes.length) {
    let c = bytes[i++];
    let cp;
    if (c < 0x80) cp = c;
    else if (c < 0xE0) cp = ((c & 0x1F) << 6) | (bytes[i++] & 0x3F);
    else if (c < 0xF0) cp = ((c & 0x0F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F);
    else cp = ((c & 0x07) << 18) | ((bytes[i++] & 0x3F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F);
    if (cp > 0xFFFF) {
      cp -= 0x10000;
      chunk.push(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
    } else {
      chunk.push(cp);
    }
    if (chunk.length > 8000) { out += String.fromCharCode.apply(null, chunk); chunk.length = 0; }
  }
  return out + String.fromCharCode.apply(null, chunk);
}

function readFigaf(path) {
  // Thử đường dẫn từ hộp chọn file, rồi thử lại bằng đường dẫn Desktop do Affinity cung cấp.
  const name = String(path).split(/[\\/]/).pop();
  const candidates = [String(path)];
  try { candidates.push(desktopPath() + '/' + name); } catch (e) { /* bỏ qua */ }
  let buf = null;
  const errors = [];
  for (const p of candidates) {
    try {
      buf = File.readAll(p);
      if (buf) break;
    } catch (e) {
      errors.push(p + '\n  → ' + (e && e.message ? e.message : String(e)));
    }
  }
  if (!buf) {
    const raw = errors.join('\n');
    let hint = '';
    if (/PERMISSION_DENIED|NOT_ALLOWED/.test(raw)) {
      hint = '\n\nAffinity đang chặn script đọc file. Cần làm đủ 2 bước:\n1. Settings → Scripting → File System access: thêm thư mục chứa file .figaf (ví dụ Desktop).\n2. Bấm biểu tượng bánh răng của script và bật quyền File System.\nSau đó chạy lại.\n\nAffinity is blocking file access: add the folder under Settings → Scripting → File System access, and enable File System permission in the script settings (gear icon).';
    }
    throw new Error('Không đọc được file .figaf.\n\n' + raw + hint);
  }
  const bytes = bytesOf(buf);
  if (!bytes) throw new Error('Không đọc được nội dung file.');
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
  if (magic !== 'FIGAF1') throw new Error('Đây không phải file .figaf do plugin Figma của Đình xuất ra.');
  const len = bytes[6] | (bytes[7] << 8) | (bytes[8] << 16) | (bytes[9] * 16777216);
  const doc = JSON.parse(utf8Decode(bytes.subarray(10, 10 + len)));
  return { doc: doc, bytes: bytes, dataStart: 10 + len };
}

// ===================================================================
//  Tiện ích hình học / màu
// ===================================================================

let ORIGIN = { x: 0, y: 0 };
let FILE = null;   // { doc, bytes, dataStart }
let DOC = null;    // Affinity document

function desktopPath() {
  return app.userDesktopPath || app.getUserDesktopPath;
}

// Thông số chữ trong Affinity tính bằng point; quy từ px của Figma theo dpi của document.
function pt(v) { return v * 72 / ((DOC && DOC.dpi) || 72); }

function px(x) { return x - ORIGIN.x; }
function py(y) { return y - ORIGIN.y; }

// Ma trận Figma [[a,b,tx],[c,d,ty]] (toạ độ page) -> Transform Affinity (toạ độ spread)
function toTransform(m) {
  return new Transform(m[0][0], m[0][1], px(m[0][2]), m[1][0], m[1][1], py(m[1][2]));
}

function mul(A, B) { // A·B, cả hai dạng [[a,b,tx],[c,d,ty]]
  return [
    [A[0][0] * B[0][0] + A[0][1] * B[1][0], A[0][0] * B[0][1] + A[0][1] * B[1][1], A[0][0] * B[0][2] + A[0][1] * B[1][2] + A[0][2]],
    [A[1][0] * B[0][0] + A[1][1] * B[1][0], A[1][0] * B[0][1] + A[1][1] * B[1][1], A[1][0] * B[0][2] + A[1][1] * B[1][2] + A[1][2]]
  ];
}

function inv(t) {
  const a = t[0][0], b = t[0][1], c = t[0][2], d = t[1][0], e = t[1][1], f = t[1][2];
  const det = a * e - b * d;
  if (Math.abs(det) < 1e-12) return null;
  return [[e / det, -b / det, (b * f - c * e) / det], [-d / det, a / det, (c * d - a * f) / det]];
}

function isAxisAligned(m) {
  return Math.abs(m[0][1]) < 1e-6 && Math.abs(m[1][0]) < 1e-6 && m[0][0] > 0 && m[1][1] > 0;
}

function boxOf(node) {
  // Hộp chữ nhật trên spread cho node không xoay
  return new Rectangle(px(node.m[0][2]), py(node.m[1][2]), Math.max(node.w, 0.01), Math.max(node.h, 0.01));
}

function colourOf(c) {
  return Colour.createRGBA8({
    r: c.r, g: c.g, b: c.b,
    alpha: Math.max(0, Math.min(255, Math.round((c.a === undefined ? 1 : c.a) * 255)))
  });
}

function noFill() { return FillDescriptor.createNone(); }

function lerpColour(a, b, t) {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t };
}

// Gradient góc của Figma nối vòng từ stop cuối về stop đầu; Affinity thì không,
// nên thêm stop ở 0 và 1 cùng một màu để không có đường nối (vệt chéo).
function wrapAngularStops(stops) {
  if (!stops.length) return stops;
  const first = stops[0], last = stops[stops.length - 1];
  const gap = (1 - last.pos) + first.pos;
  const t = gap > 1e-6 ? (1 - last.pos) / gap : 0;
  const c = lerpColour(last, first, t);
  const out = stops.slice();
  if (first.pos > 1e-4) out.unshift(Object.assign({}, c, { pos: 0 }));
  if (last.pos < 1 - 1e-4) out.push(Object.assign({}, c, { pos: 1 }));
  return out;
}

function gradientDescriptor(p) {
  const src = p.type === 'ANGULAR' ? wrapAngularStops(p.stops) : p.stops;
  const stops = src.map(function (s) {
    return { colour: colourOf(s), position: s.pos, midpoint: 0.5 };
  });
  let type;
  if (p.type === 'ANGULAR') {
    type = enumValue(GradientFillType, ['Conical', 'Conic', 'Angular', 'Sweep']);
    if (type === undefined) {
      report.notes.push('Gradient dạng góc (angular) được chuyển thành gradient tròn vì không tìm thấy kiểu Conical. Các kiểu có: ' + Object.keys(GradientFillType || {}).join(', '));
      type = enumValue(GradientFillType, ['Radial', 'Elliptical']);
    }
  } else if (p.type === 'RADIAL') {
    type = enumValue(GradientFillType, ['Radial', 'Elliptical']);
  } else {
    type = enumValue(GradientFillType, ['Linear']);
  }
  const gf = GradientFill.create(Gradient.create(stops), type);
  let xf;
  if (p.gx) {
    // Fill của Affinity: gradient tuyến tính chạy từ (0,0) đến (1,0); gradient tròn/góc có tâm (0,0), bán kính 1.
    // Figma: tuyến tính chạy từ (0,0.5) đến (1,0.5); tròn/góc có tâm (0.5,0.5), bán kính 0.5.
    const local = p.type === 'LINEAR' ? [[1, 0, 0], [0, 1, 0.5]] : [[0.5, 0, 0.5], [0, 0.5, 0.5]];
    xf = toTransform(mul(p.gx, local));
  } else {
    const x0 = px(p.start[0]), y0 = py(p.start[1]);
    const dx = px(p.end[0]) - x0, dy = py(p.end[1]) - y0;
    xf = new Transform(dx, -dy, x0, dy, dx, y0);
  }
  return FillDescriptor.create(gf, true, xf, BlendMode ? BlendMode.Normal : 0, false);
}

// Fill chính (không phải ảnh) cho shape: lấy paint trên cùng.
// Shape có nhiều lớp màu được dựng bằng nhiều shape chồng lên nhau (xem needsFillStack).
function brushFillFor(node) {
  const paints = (node.fills || []).filter(function (p) { return p.type !== 'IMAGE'; });
  if (!paints.length) return noFill();
  return fillOfPaint(node, paints[paints.length - 1]);
}

function fillOfPaint(node, p) {
  if (!p || p.type === 'IMAGE') return noFill();
  try {
    if (p.type === 'SOLID') return FillDescriptor.createSolid(colourOf(p));
    return gradientDescriptor(p);
  } catch (e) {
    failed(node.name, 'gradient', e);
    const s = p.stops ? p.stops[0] : p;
    return FillDescriptor.createSolid(colourOf(s));
  }
}

const LS = safeRequire('/linestyle');
let capJoinReported = false;

// Đầu nét (cap) và góc nối (join) của Figma -> LineStyle của Affinity.
function applyCapJoin(ls, node) {
  const capName = { ROUND: ['Round'], SQUARE: ['Square'], NONE: ['Butt', 'Flat', 'None'] }[node.strokeCap || 'NONE'];
  const joinName = { ROUND: ['Round'], BEVEL: ['Bevel'], MITER: ['Mitre', 'Miter'] }[node.strokeJoin || 'MITER'];
  const capEnum = LS.LineCap || LS.LineCapType || LS.CapType;
  const joinEnum = LS.LineJoin || LS.LineJoinType || LS.JoinType;
  const cap = capName && enumValue(capEnum, capName);
  const join = joinName && enumValue(joinEnum, joinName);
  let okCap = cap === undefined, okJoin = join === undefined;
  for (const k of ['cap', 'lineCap', 'capType']) {
    if (cap !== undefined && k in ls) { try { ls[k] = cap; okCap = true; break; } catch (e) { /* thử tên khác */ } }
  }
  for (const k of ['join', 'lineJoin', 'joinType']) {
    if (join !== undefined && k in ls) { try { ls[k] = join; okJoin = true; break; } catch (e) { /* thử tên khác */ } }
  }
  if ((!okCap || !okJoin || (!capEnum && node.strokeCap && node.strokeCap !== 'NONE')) && !capJoinReported) {
    capJoinReported = true;
    report.notes.push('Chưa đặt được đầu nét/góc nối. Module linestyle có: ' + Object.keys(LS).join(', ') +
                      '. LineStyle có: ' + Object.keys(ls).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(ls) || {})).join(', '));
  }
}

function strokeParts(node, isOpen) {
  if (!node.strokes || !node.strokes.length || !node.strokeWeight) return null;
  const p = node.strokes[node.strokes.length - 1];
  let pen;
  try {
    pen = p.type === 'SOLID' ? FillDescriptor.createSolid(colourOf(p)) : gradientDescriptor(p);
  } catch (e) {
    pen = FillDescriptor.createSolid(colourOf(p.stops ? p.stops[0] : p));
  }
  let align = StrokeAlignment.Centre;
  if (!isOpen && node.strokeAlign === 'INSIDE') align = StrokeAlignment.Inside;
  if (!isOpen && node.strokeAlign === 'OUTSIDE') align = StrokeAlignment.Outside;
  let line;
  try {
    const ls = LineStyle.createDefaultWithWeight(node.strokeWeight);
    applyCapJoin(ls, node);
    line = LineStyleDescriptor.create(ls, { strokeAlignment: align });
  } catch (e) {
    line = LineStyleDescriptor.createDefault(node.strokeWeight);
  }
  return { pen: pen, line: line };
}

// ===================================================================
//  Thêm node vào document
// ===================================================================

function addDef(def, target, childType, kind) {
  const b = AddChildNodesCommandBuilder.create();
  b.setInsertionTarget(target);
  // Dùng chế độ chèn mặc định: layer thêm sau nằm trên (giống các script mẫu của cộng đồng).
  // Inside_AtFront đã làm đảo thứ tự, khiến nền trắng phủ lên mọi thứ.
  if (kind === 'container') b.addContainerNode(def);
  else if (kind === 'shape') b.addShapeNode(def);
  else if (kind === 'curve') b.addPolyCurveNode(def);
  else if (kind === 'image') b.addImageNode(def);
  else b.addNode(def);
  const cmd = b.createCommand(false, childType || NodeChildType.Main);
  DOC.executeCommand(cmd);
  return cmd.newNodes[0];
}

function rectShape(w, h, radius) {
  const sh = ShapeRectangle.create();
  if (radius) {
    try {
      sh.setAbsoluteSizes(true, w, h);
      const map = { topLeft: radius.tl, topRight: radius.tr, bottomLeft: radius.bl, bottomRight: radius.br };
      for (const k in map) {
        const r = Math.min(map[k] || 0, w / 2, h / 2);
        if (r > 0) {
          sh[k].cornerType = ShapeCornerType.Round;
          sh[k].setRadius(r, w, h);
        }
      }
    } catch (e) { report.notes.push('Không đặt được bo góc: ' + e.message); }
  }
  return sh;
}

function ellipseShape() {
  if (Shape && ShapeType && ShapeType.Ellipse !== undefined) return Shape.create(ShapeType.Ellipse);
  const { ShapeEllipse } = require('/shapes');
  return ShapeEllipse.create();
}

function polyCurveFrom(paths, forceOpen) {
  const pc = PolyCurve.create();
  for (const p of paths || []) {
    let cb = null;
    let started = false;
    const flush = function (close) {
      if (!cb || !started) return;
      if (close) cb.close();
      pc.addCurve(cb.createCurve());
      cb = null; started = false;
    };
    for (const c of p.cmds) {
      if (c[0] === 'M') {
        flush(false);
        cb = CurveBuilder.create();
        cb.beginXY(px(c[1]), py(c[2]));
        started = true;
      } else if (c[0] === 'L' && cb) {
        cb.lineToXY(px(c[1]), py(c[2]));
      } else if (c[0] === 'C' && cb) {
        cb.addBezierXY(px(c[1]), py(c[2]), px(c[3]), py(c[4]), px(c[5]), py(c[6]));
      } else if (c[0] === 'Z') {
        flush(!forceOpen && !p.open);
      }
    }
    flush(false);
  }
  return pc;
}

// Tạo shape đại diện cho node (rect / ellipse / path / nền frame).
function shapeDefFor(node, fill, withStroke) {
  const isOpen = node.paths && node.paths.some(function (p) { return p.open; });
  const st = withStroke ? strokeParts(node, isOpen) : null;
  let def, kind;
  if (node.kind === 'path' || node.bgPaths) {
    const pc = polyCurveFrom(node.paths || node.bgPaths);
    const line = st ? st.line : LineStyleDescriptor.createDefault(0);
    const pen = st ? st.pen : noFill();
    try {
      // Thứ tự tham số trong Affinity 3.3: brush, pen, line style, transparency
      def = PolyCurveNodeDefinition.create(pc, fill, pen, line, noFill());
    } catch (e) {
      def = PolyCurveNodeDefinition.create(pc, fill, line, pen, noFill());
    }
    kind = 'curve';
  } else {
    const shape = node.kind === 'ellipse' ? ellipseShape() : rectShape(node.w, node.h, node.radius);
    def = ShapeNodeDefinition.create(shape, boxOf(node), fill, null, null, null);
    if (st) def.setLineDescriptors(st.pen, st.line, 0);
    kind = 'shape';
  }
  return { def: def, kind: kind };
}

// Đặt ảnh (Image fill của Figma) làm layer con bị cắt trong shape.
function addImageFill(node, paint, target) {
  try {
    addImageFillUnsafe(node, paint, target);
  } catch (e) {
    failed(node.name, 'ảnh', e);
  }
}

function addImageFillUnsafe(node, paint, target) {
  const meta = FILE.doc.images[paint.image];
  if (!meta) { report.notes.push('"' + node.name + '": thiếu dữ liệu ảnh.'); return; }
  const pb = PixelBuffer.create(meta.w, meta.h, RasterFormat.RGBA8);
  const arr = new Uint8Array(pb.buffer);
  const start = FILE.dataStart + meta.offset;
  const src = FILE.bytes;
  const n = meta.length;
  // Chép từng byte (giống các script mẫu), tránh trường hợp .set() không ghi vào bộ đệm của Affinity.
  for (let i = 0; i < n; i++) arr[i] = src[start + i];
  let sum = 0, alphaSum = 0;
  for (let i = 0; i < n; i += Math.max(4, Math.floor(n / 4000) * 4)) { sum += src[start + i]; alphaSum += src[start + i + 3]; }
  const back = new Uint8Array(pb.buffer);
  dlog('  (dữ liệu ảnh) ' + node.name + ': ' + meta.w + '×' + meta.h + ', mẫu màu ' + sum + ', mẫu alpha ' + alphaSum +
              ', đọc lại ' + back[0] + '/' + src[start] + ' ' + back[n - 1] + '/' + src[start + n - 1]);
  const bitmap = pb.createCompatibleBitmap(true);

  // Ánh xạ: điểm ảnh -> toạ độ trong node (0..w, 0..h) -> page
  const W = node.w, H = node.h, iw = meta.w, ih = meta.h;
  let L;
  if (paint.scaleMode === 'CROP' && paint.imageTransform) {
    const T = inv(paint.imageTransform) || [[1, 0, 0], [0, 1, 0]];
    // pixel -> unit ảnh -> unit node -> local
    L = mul([[W, 0, 0], [0, H, 0]], mul(T, [[1 / iw, 0, 0], [0, 1 / ih, 0]]));
  } else {
    const s = paint.scaleMode === 'FIT' ? Math.min(W / iw, H / ih) : Math.max(W / iw, H / ih);
    L = [[s, 0, (W - iw * s) / 2], [0, s, (H - ih * s) / 2]];
  }
  const M = mul(node.m, L);
  const def = ImageNodeDefinition.create(RasterFormat.RGBA8);
  def.bitmap = bitmap;
  def.transform = toTransform(M);
  def.userDescription = 'Ảnh';
  // Thêm ảnh cạnh shape (cùng cha) rồi chuyển vào trong shape để bị cắt theo shape.
  // Cách này giữ đúng toạ độ trên spread, giống lệnh "kéo vào trong" của Affinity.
  const parent = target.parent || target;
  const img = addDef(def, parent, NodeChildType.Main, 'image');
  logBox('ảnh trước khi cắt', node.name, img);
  try {
    DOC.executeCommand(DocumentCommand.createMoveNodes(Selection.create(DOC, img), target, NodeMoveType.Inside, NodeChildType.Main));
    logBox('ảnh sau khi cắt', node.name, img);
  } catch (e) {
    report.notes.push('"' + node.name + '": không cắt được ảnh theo khung (' + e.message + '), ảnh được đặt nguyên.');
  }
  if (paint.opacity !== undefined && paint.opacity < 1) setOpacity(img, paint.opacity);
  created('image');
}

function setOpacity(n, o) {
  try { DOC.executeCommand(DocumentCommand.createSetOpacity(Selection.create(DOC, n), o)); }
  catch (e) { report.notes.push('Không đặt được độ trong suốt: ' + e.message); }
}

// Affinity chỉ có một Outer Shadow / Inner Shadow cho mỗi layer: giữ hiệu ứng đầu tiên mỗi loại.
// Bóng đổ thứ 2 trở đi của shape được dựng bằng bản sao nằm ngay dưới (xem addExtraShadowCopies).
function primaryEffects(node) {
  const seen = {};
  const out = [];
  for (const fx of node._effectsOverride || node.effects || []) {
    if (seen[fx.type]) {
      if (!(fx.type === 'DROP_SHADOW' && node._extraShadowsDone)) {
        report.notes.push('"' + node.name + '": có nhiều hiệu ứng ' + fx.type + ', Affinity chỉ giữ được hiệu ứng đầu tiên.');
      }
      continue;
    }
    seen[fx.type] = true;
    out.push(fx);
  }
  return out;
}

function isHardShadow(fx) {
  return fx.type === 'DROP_SHADOW' && (fx.radius || 0) < 0.5 && !(fx.spread);
}

// Bóng đổ của shape được tách ra:
// - bóng không blur (bóng cứng): dựng thành bản sao tô màu bóng, dời đúng độ lệch (Affinity không vẽ bóng blur 0);
// - bóng mờ thứ 2 trở đi: bản sao cùng màu nằm ngay dưới, mang bóng đó (Affinity chỉ có một Outer Shadow mỗi layer);
// - bóng mờ đầu tiên giữ trên shape gốc.
function addExtraShadowCopies(node, target, childType) {
  const drops = (node.effects || []).filter(function (fx) { return fx.type === 'DROP_SHADOW'; });
  const hard = drops.filter(isHardShadow);
  const soft = drops.filter(function (fx) { return !isHardShadow(fx); });
  if (!hard.length && soft.length < 2) return;
  let k = 2;
  for (let j = soft.length - 1; j >= 1; j--) {
    const copy = Object.assign({}, node, { name: node.name + ' (bóng ' + (k++) + ')', strokes: null, effects: [soft[j]] });
    try { applyCommon(copy, buildLeaf(copy, target, childType)); }
    catch (e) { failed(node.name, 'bóng đổ phụ', e); }
  }
  for (let j = hard.length - 1; j >= 0; j--) {
    const fx = hard[j];
    const fill = { type: 'SOLID', r: fx.color.r, g: fx.color.g, b: fx.color.b, a: fx.color.a };
    const copy = Object.assign({}, node, { name: node.name + ' (bóng cứng)', strokes: null, effects: [], fills: [fill],
                                           opacity: node.opacity === undefined ? 1 : node.opacity });
    try {
      const c = buildLeaf(copy, target, childType);
      DOC.executeCommand(DocumentCommand.createTransform(Selection.create(DOC, c), Transform.createTranslate(fx.offset.x, fx.offset.y), { mergeable: false }));
      applyCommon(copy, c);
      created('effect');
    } catch (e) {
      failed(node.name, 'bóng cứng', e);
    }
  }
  const others = (node.effects || []).filter(function (fx) { return fx.type !== 'DROP_SHADOW'; });
  node._effectsOverride = (soft.length ? [soft[0]] : []).concat(others);
  node._extraShadowsDone = true;
}

function applyCommon(node, n) {
  if (!n) return;
  if (node.opacity !== undefined && node.opacity < 1) setOpacity(n, node.opacity);
  if (node.visible === false) {
    try { DOC.executeCommand(DocumentCommand.createSetVisibility(Selection.create(DOC, n), false)); } catch (e) { /* bỏ qua */ }
  }
  for (const fx of primaryEffects(node)) {
    const idx = 0;
    try {
      const sel = Selection.create(DOC, n);
      if (fx.type === 'LAYER_BLUR' && LayerFx.GaussianBlurLayerEffect) {
        const blur = LayerFx.GaussianBlurLayerEffect.create();
        blur.enabled = true;
        blur.radius = fx.radius * LAYER_BLUR_SCALE;
        DOC.executeCommand(DocumentCommand.createSetGaussianBlurLayerEffect(sel, blur));
      } else if (fx.type === 'DROP_SHADOW' && LayerFx.OuterShadowLayerEffect) {
        dlog('  (bóng đổ Figma) ' + node.name + ': x ' + fx.offset.x + ', y ' + fx.offset.y + ', blur ' + fx.radius + ', spread ' + (fx.spread || 0) + ', alpha ' + fx.color.a.toFixed(2));
        const sh = LayerFx.OuterShadowLayerEffect.create();
        sh.enabled = true;
        sh.radius = fx.radius * SHADOW_BLUR_SCALE;
        sh.offset = Math.hypot(fx.offset.x, fx.offset.y);
        sh.angle = Math.atan2(-fx.offset.y, fx.offset.x);
        sh.colour = colourOf({ r: fx.color.r, g: fx.color.g, b: fx.color.b, a: 1 });
        sh.opacity = fx.color.a;
        // Figma cho nhiều bóng đổ trên một layer: mỗi bóng một vị trí (index) riêng.
        DOC.executeCommand(DocumentCommand.createSetOuterShadowLayerEffect(sel, sh, idx));
      } else if (fx.type === 'INNER_SHADOW' && LayerFx.InnerShadowLayerEffect) {
        const sh = LayerFx.InnerShadowLayerEffect.create();
        sh.enabled = true;
        sh.radius = fx.radius * SHADOW_BLUR_SCALE;
        sh.offset = Math.hypot(fx.offset.x, fx.offset.y);
        sh.angle = Math.atan2(-fx.offset.y, fx.offset.x);
        sh.colour = colourOf({ r: fx.color.r, g: fx.color.g, b: fx.color.b, a: 1 });
        sh.opacity = fx.color.a;
        DOC.executeCommand(DocumentCommand.createSetInnerShadowLayerEffect(sel, sh, idx));
      } else {
        report.notes.push('"' + node.name + '": hiệu ứng ' + fx.type + ' chưa chuyển được.');
        continue;
      }
      created('effect');
    } catch (e) {
      failed(node.name, 'hiệu ứng ' + fx.type, e);
    }
  }
}

// ===================================================================
//  Chữ
// ===================================================================

const fontCache = {};

function norm(s) { return String(s || '').toLowerCase().replace(/[\s_-]+/g, ''); }

function findFont(family, style, weight) {
  const key = family + '|' + style;
  if (fontCache[key] !== undefined) return fontCache[key];
  let result = null;
  try {
    const all = FontFamily.all;
    // Figma đôi khi đặt tên font biến thiên kiểu "Inter V" / "Inter Variable": thử thêm tên gốc.
    const names = [family, family.replace(/\s+(V|Variable|VF)$/i, '')];
    let fam = null;
    for (const nm of names) {
      fam = all.find(function (f) { return norm(f.name) === norm(nm); });
      if (fam) break;
    }
    if (fam) {
      const faces = fam.fonts;
      const wantStyle = norm(style);
      result = faces.find(function (f) {
        return norm(f.styleName) === wantStyle || norm(f.style) === wantStyle ||
               norm(f.faceName) === wantStyle || norm(f.postscriptName).endsWith(wantStyle);
      }) || null;
      if (!result) {
        const italic = /italic|oblique/i.test(style);
        const pool = faces.filter(function (f) { return !!f.isItalic === italic; });
        const list = pool.length ? pool : faces;
        const w = weight || 400;
        result = list.slice().sort(function (a, b) { return Math.abs(a.weight - w) - Math.abs(b.weight - w); })[0] || null;
      }
    }
  } catch (e) { result = null; }
  if (!result) report.missingFonts[family + ' ' + style] = true;
  fontCache[key] = result;
  return result;
}

function enumValue(E, names) {
  if (!E) return undefined;
  for (const n of names) if (E[n] !== undefined) return E[n];
  return undefined;
}

function paragraphAttsFor(sb, t, seg) {
  const pa = sb.paragraphAtts;
  const align = { LEFT: ['Left'], CENTER: ['Centre', 'Center'], RIGHT: ['Right'], JUSTIFIED: ['Justify', 'JustifyLeft', 'Justified'] }[t.alignH] || ['Left'];
  const a = enumValue(ParagraphAlignXType, align);
  if (a !== undefined) pa.alignXType = a;
  pa.spaceBefore = 0;
  pa.spaceAfter = pt(t.paragraphSpacing || 0);
  if (t.paragraphIndent) pa.firstLineIndent = pt(t.paragraphIndent);
  const lh = seg && seg.lineHeight;
  if (lh && lh.unit === 'PIXELS') {
    const v = enumValue(ParagraphLeadingType, ['ExactlyAbsolute', 'Exactly', 'Absolute']);
    if (v !== undefined) { pa.leadingType = v; pa.absoluteLeading = pt(lh.value); }
  } else if (lh && lh.unit === 'PERCENT') {
    const v = enumValue(ParagraphLeadingType, ['RelativeToHeight']);
    if (v !== undefined) { pa.leadingType = v; pa.relativeLeading = lh.value / 100; }
  }
  sb.setParagraphAtts(pa);
}

function glyphAttsFor(sb, seg) {
  const ga = sb.glyphAtts;
  ga.height = pt(seg.size * (seg.smallCaps ? 0.8 : 1));
  const face = findFont(seg.family, seg.style, seg.weight);
  if (face) ga.font = face;
  ga.brushFill = FillDescriptor.createSolid(colourOf(seg.color));
  const ls = seg.letterSpacing;
  if (ls && ls.value) {
    ga.characterSpacing = ls.unit === 'PERCENT' ? ls.value / 100 : ls.value / seg.size;
  } else {
    ga.characterSpacing = 0;
  }
  sb.setGlyphAtts(ga);
}

function buildStory(t, artistic) {
  const sb = StoryBuilder.create();
  if (artistic) sb.setToArtisticTextDefaultStyle(DOC.dpi, DOC.format);
  else sb.setToFrameTextDefaultStyle(DOC.dpi, DOC.format);
  let atParagraphStart = true;
  for (const seg of t.segments) {
    glyphAttsFor(sb, seg);
    const parts = seg.chars.replace(/\u2028/g, '\n').split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) { sb.addParagraphBreak(); atParagraphStart = true; }
      if (atParagraphStart) { paragraphAttsFor(sb, t, seg); atParagraphStart = false; }
      if (parts[i].length) sb.addText(parts[i]);
    }
  }
  return sb;
}

// Chữ "auto width" của Figma -> Artistic Text của Affinity: tự co giãn theo nội dung,
// không bao giờ tự xuống dòng, nên giữ đúng chiều rộng như Figma.
function addArtisticText(node, target, childType) {
  const t = node.text;
  const sb = buildStory(t, true);
  const x0 = px(node.m[0][2]), y0 = py(node.m[1][2]);
  const firstSize = t.segments.length ? t.segments[0].size : 12;
  const def = ArtTextNodeDefinition.createFromStoryBuilder({ x: x0, y: y0 + firstSize }, sb);
  def.userDescription = node.name;
  const n = addDef(def, target, childType || NodeChildType.Main, 'node');
  // Đo hộp thật rồi dời cho khớp vị trí Figma (theo kiểu canh lề).
  const b = n.getSpreadBaseBox(false);
  let tx = x0 - b.x;
  if (t.alignH === 'CENTER') tx = (x0 + node.w / 2) - (b.x + b.width / 2);
  else if (t.alignH === 'RIGHT') tx = (x0 + node.w) - (b.x + b.width);
  const ty = (y0 + node.h / 2) - (b.y + b.height / 2);
  if (Math.abs(tx) > 0.01 || Math.abs(ty) > 0.01) {
    DOC.executeCommand(DocumentCommand.createTransform(Selection.create(DOC, n), Transform.createTranslate(tx, ty), { mergeable: false }));
  }
  return n;
}

function addText(node, target, childType) {
  const t = node.text;
  const rotated = !isAxisAligned(node.m);
  if (AUTO_WIDTH_AS_ARTISTIC && t.autoResize === 'WIDTH_AND_HEIGHT' && !rotated) {
    try {
      const n = addArtisticText(node, target, childType);
      created('text');
      return n;
    } catch (e) {
      report.notes.push('"' + node.name + '": không tạo được artistic text (' + e.message + '), dùng frame text.');
    }
  }
  const sb = buildStory(t, false);

  let w = node.w, h = node.h;
  if (t.autoResize === 'WIDTH_AND_HEIGHT') { w = w * AUTO_WIDTH_SLACK + 2; h *= AUTO_HEIGHT_SLACK; }
  else if (t.autoResize === 'HEIGHT') { h *= AUTO_HEIGHT_SLACK; }
  // Với chữ canh phải/giữa, giữ mép phải/giữa đúng chỗ khi nới rộng khung.
  let dx = 0;
  if (t.autoResize === 'WIDTH_AND_HEIGHT') {
    if (t.alignH === 'RIGHT') dx = node.w - w;
    else if (t.alignH === 'CENTER') dx = (node.w - w) / 2;
  }

  const rect = rotated ? new Rectangle(dx, 0, w, h) : new Rectangle(px(node.m[0][2]) + dx, py(node.m[1][2]), w, h);
  const def = FrameTextNodeDefinition.createFromStoryBuilder(rect, sb);
  def.userDescription = node.name;
  const n = addDef(def, target, childType || NodeChildType.Main, 'node');
  if (rotated) {
    DOC.executeCommand(DocumentCommand.createTransform(Selection.create(DOC, n), toTransform(node.m), { mergeable: false }));
  }
  created('text');
  return n;
}

// ===================================================================
//  Dựng cây
// ===================================================================

function imagePaints(node) {
  return (node.fills || []).filter(function (p) { return p.type === 'IMAGE'; });
}

// Một shape chỉ có một fill. Khi Figma có nhiều lớp màu, mỗi lớp thành một shape riêng
// chồng theo đúng thứ tự (lớp đầu tiên của Figma nằm dưới cùng).
// Trường hợp [màu, ảnh] vẫn dùng một shape: màu làm nền, ảnh nằm bên trong.
function needsFillStack(node) {
  const f = node.fills || [];
  if (f.length <= 1) return false;
  if (f.length === 2 && f[0].type !== 'IMAGE' && f[1].type === 'IMAGE') return false;
  return true;
}

function asShapeNode(node) {
  if (node.kind === 'rect' || node.kind === 'ellipse' || node.kind === 'path') return node;
  return Object.assign({}, node, { kind: node.bgPaths ? 'path' : 'rect' });
}

// Thêm một shape cho mỗi lớp màu vào target. Viền đặt ở lớp trên cùng.
function addFillLayers(node, target, namePrefix, fromIndex) {
  const f = node.fills || [];
  const sn = asShapeNode(node);
  let last = null;
  for (let i = fromIndex || 0; i < f.length; i++) {
    const p = f[i];
    const s = shapeDefFor(sn, fillOfPaint(node, p), i === f.length - 1);
    s.def.userDescription = namePrefix + ' ' + (i + 1);
    last = addDef(s.def, target, NodeChildType.Main, s.kind);
    if (p.type === 'IMAGE') addImageFill(node, p, last);
  }
  return last;
}

function buildLeaf(node, target, childType) {
  if (needsFillStack(node)) {
    const g = addDef(ContainerNodeDefinition.create(node.name), target, childType, 'container');
    addFillLayers(node, g, 'Lớp màu');
    return g;
  }
  const s = shapeDefFor(node, brushFillFor(node), true);
  s.def.userDescription = node.name;
  const n = addDef(s.def, target, childType, s.kind);
  for (const p of imagePaints(node)) addImageFill(node, p, n);
  return n;
}

// Mask của Figma -> shape không màu làm layer cha, các layer bị cắt nằm bên trong.
function buildMask(node, target, childType) {
  if (MASK_AS_LAYER) {
    try { return buildMaskLayer(node, target, childType); }
    catch (e) { report.notes.push('"' + node.name + '": không tạo được mask layer (' + e.message + '), dùng cách clip.'); }
  }
  const sn = asShapeNode(node.shape);
  // Shape không có fill có thể chỉ cắt theo khung chữ nhật, nên dùng màu gần như trong suốt (alpha 1/255).
  const s = shapeDefFor(sn, MASK_HAIRLINE_FILL ? FillDescriptor.createSolid(colourOf({ r: 0, g: 0, b: 0, a: 1 / 255 })) : noFill(), false);
  dlog('  (mask) ' + node.name + ': ' + sn.kind + ', ' + JSON.stringify(node.shape.maskInfo || {}));
  s.def.userDescription = (node.name || 'Mask') + ' (mask)';
  const n = addDef(s.def, target, childType, s.kind);
  for (const c of node.children) build(c, n, NodeChildType.Main);
  created('mask');
  return n;
}

// Nhóm chứa các layer bị cắt; shape mask (màu trắng, đục) gắn vào nhóm dưới dạng Enclosure = mask layer.
function buildMaskLayer(node, target, childType) {
  const g = addDef(ContainerNodeDefinition.create((node.name || 'Mask') + ' (nhóm mask)'), target, childType, 'container');
  for (const c of node.children) build(c, g, NodeChildType.Main);
  const sn = asShapeNode(node.shape);
  const s = shapeDefFor(sn, FillDescriptor.createSolid(colourOf({ r: 255, g: 255, b: 255, a: 1 })), false);
  s.def.userDescription = (node.name || 'Mask') + ' (mask)';
  addDef(s.def, g, NodeChildType.Enclosure, s.kind);
  dlog('  (mask layer) ' + node.name);
  created('mask');
  return g;
}

function build(node, target, childType) {
  try {
    let n = null;
    switch (node.kind) {
      case 'text':
        n = addText(node, target, childType);
        break;
      case 'group': {
        n = addDef(ContainerNodeDefinition.create(node.name), target, childType, 'container');
        for (const c of node.children) build(c, n, NodeChildType.Main);
        created('group');
        break;
      }
      case 'frame':
        n = buildFrame(node, target, childType);
        break;
      case 'rect':
      case 'ellipse':
      case 'path':
        addExtraShadowCopies(node, target, childType);
        n = buildLeaf(node, target, childType);
        created(node.kind);
        break;
      case 'mask':
        n = buildMask(node, target, childType);
        break;
      default:
        return null;
    }
    applyCommon(node, n);
    debugNode(node, n);
    return n;
  } catch (e) {
    failed(node.name, node.kind, e);
    return null;
  }
}

function logBox(label, name, n) {
  try {
    const b = n.getSpreadBaseBox(false);
    dlog('  (' + label + ') ' + name + ' → x ' + b.x.toFixed(1) + ', y ' + b.y.toFixed(1) + ', ' + b.width.toFixed(1) + '×' + b.height.toFixed(1));
  } catch (e) { /* bỏ qua */ }
}

let debugCount = 0;
function debugNode(node, n) {
  if (!n || debugCount++ > 400) return;
  try {
    const b = n.getSpreadBaseBox(false);
    dlog('[' + node.kind + '] ' + node.name + ' → x ' + b.x.toFixed(1) + ', y ' + b.y.toFixed(1) + ', ' + b.width.toFixed(1) + '×' + b.height.toFixed(1));
  } catch (e) { /* bỏ qua */ }
}

function frameHasBackground(node) {
  return (node.fills && node.fills.length) || (node.strokes && node.strokes.length);
}

// Nền của frame (một hoặc nhiều lớp màu) đặt vào container g.
function addFrameBackground(node, g) {
  if (!frameHasBackground(node)) return;
  if (needsFillStack(node)) { addFillLayers(node, g, 'Nền'); return; }
  const s = shapeDefFor(asShapeNode(node), brushFillFor(node), true);
  s.def.userDescription = 'Nền';
  const bg = addDef(s.def, g, NodeChildType.Main, s.kind);
  for (const p of imagePaints(node)) addImageFill(node, p, bg);
}

function buildFrame(node, target, childType) {
  if (node.clips && CLIP_NESTED_FRAMES) {
    // Frame cắt nội dung: shape nền là layer cha, nội dung nằm bên trong (bị cắt theo shape).
    const stack = needsFillStack(node);
    const f = node.fills || [];
    const first = stack ? f[0] : null;
    const s = shapeDefFor(asShapeNode(node), stack ? fillOfPaint(node, first) : brushFillFor(node), true);
    s.def.userDescription = node.name;
    const n = addDef(s.def, target, childType, s.kind);
    if (stack) {
      if (first.type === 'IMAGE') addImageFill(node, first, n);
      // Các lớp màu còn lại: shape cùng kích thước nằm bên trong, dưới nội dung.
      addFillLayers(Object.assign({}, node, { strokes: null }), n, 'Lớp màu', 1);
    } else {
      for (const p of imagePaints(node)) addImageFill(node, p, n);
    }
    for (const c of node.children) build(c, n, NodeChildType.Main);
    created('frame');
    return n;
  }
  const g = addDef(ContainerNodeDefinition.create(node.name), target, childType, 'container');
  addFrameBackground(node, g);
  for (const c of node.children) build(c, g, NodeChildType.Main);
  created('frame');
  return g;
}

function buildRoot(root, spread) {
  const bb = root.bbox;
  const abDef = ShapeNodeDefinition.createDefault();
  abDef.shape = ShapeRectangle.create();
  abDef.setBoundingRectangle(new Rectangle(px(bb.x), py(bb.y), bb.width, bb.height));
  abDef.userDescription = root.name;
  const add = DocumentCommand.createAddArtboard(abDef);
  DOC.executeCommand(add);
  const artboard = add.newNodes[0];
  // Affinity có thể đặt artboard mới ở vị trí khác: dời về đúng chỗ để khớp với nội dung và guide.
  try {
    const b = artboard.getSpreadBaseBox(false);
    const dx = px(bb.x) - b.x, dy = py(bb.y) - b.y;
    dlog('Artboard ' + root.name + ': tạo ở x ' + b.x + ', y ' + b.y + ', cần ở x ' + px(bb.x) + ', y ' + py(bb.y));
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
      DOC.executeCommand(DocumentCommand.createTransform(Selection.create(DOC, artboard), Transform.createTranslate(dx, dy), { mergeable: false }));
    }
  } catch (e) { report.notes.push('Không kiểm tra được vị trí artboard: ' + e.message); }
  try { DOC.executeCommand(DocumentCommand.createSetDescription(Selection.create(DOC, artboard), root.name)); } catch (e) { /* bỏ qua */ }
  created('artboard');

  if (root.kind === 'frame') {
    // Artboard thay cho frame gốc: vẽ nền rồi đặt các layer con vào trong.
    addFrameBackground(root, artboard);
    for (const c of root.children) build(c, artboard, NodeChildType.Main);
  } else {
    build(root, artboard, NodeChildType.Main);
  }

  if (ADD_GUIDES && root.guides) {
    let nGuides = 0;
    for (const x of root.guides.v || []) {
      try { DOC.executeCommand(DocumentCommand.createAddGuide(false, px(x))); nGuides++; } catch (e) { /* bỏ qua */ }
    }
    for (const y of root.guides.h || []) {
      try { DOC.executeCommand(DocumentCommand.createAddGuide(true, py(y))); nGuides++; } catch (e) { /* bỏ qua */ }
    }
    if (nGuides) report.created.guide = (report.created.guide || 0) + nGuides;
  }
}

// ===================================================================
//  Chạy
// ===================================================================

function writeReport(text, baseName) {
  try {
    const path = desktopPath() + '/' + baseName + ' - bao cao chuyen doi.txt';
    const f = File.create(path, 'wb');
    f.writeString(text);
    f.close();
    return path;
  } catch (e) {
    return null;
  }
}

// ===================================================================
//  Làm tròn toạ độ
// ===================================================================

function snapV(v, o) { return Math.round(v - o) + o; }

function shiftCmds(paths, dx, dy) {
  for (const p of paths || []) {
    for (const c of p.cmds) {
      for (let i = 1; i + 1 < c.length; i += 2) { c[i] += dx; c[i + 1] += dy; }
    }
  }
}

// Mỗi layer được làm tròn độc lập theo lưới pixel của document.
// Rect / ellipse / frame / mask: làm tròn cả 4 mép. Path và text: chỉ dời, giữ nguyên hình và chiều rộng.
function snapNode(node) {
  if (!node || !node.m) return;
  if (isAxisAligned(node.m)) {
    const x = node.m[0][2], y = node.m[1][2];
    const nx = snapV(x, ORIGIN.x), ny = snapV(y, ORIGIN.y);
    const dx = nx - x, dy = ny - y;
    const sx = node.m[0][0], sy = node.m[1][1];
    let dw = 0, dh = 0;
    if (node.kind === 'rect' || node.kind === 'ellipse' || node.kind === 'frame' || node.kind === 'mask') {
      // Làm tròn kích thước riêng (không làm tròn mép phải/dưới) để hình vuông vẫn vuông.
      const nw = Math.max(1, Math.round(node.w * sx)) / sx, nh = Math.max(1, Math.round(node.h * sy)) / sy;
      dw = nw - node.w; dh = nh - node.h;
      node.w = nw; node.h = nh;
    }
    node.m = [[node.m[0][0], node.m[0][1], nx], [node.m[1][0], node.m[1][1], ny]];
    shiftCmds(node.paths, dx, dy);
    shiftCmds(node.bgPaths, dx, dy);
    for (const f of (node.fills || []).concat(node.strokes || [])) {
      if (f.gx) { f.gx = [[f.gx[0][0], f.gx[0][1], f.gx[0][2] + dx], [f.gx[1][0], f.gx[1][1], f.gx[1][2] + dy]]; }
      if (f.start) { f.start = [f.start[0] + dx, f.start[1] + dy]; f.end = [f.end[0] + dx, f.end[1] + dy]; }
    }
  }
  if (node.shape) snapNode(node.shape);
  for (const c of node.children || []) snapNode(c);
}

function snapRoot(root) {
  if (root.bbox) {
    const x0 = snapV(root.bbox.x, ORIGIN.x), y0 = snapV(root.bbox.y, ORIGIN.y);
    const x1 = snapV(root.bbox.x + root.bbox.width, ORIGIN.x), y1 = snapV(root.bbox.y + root.bbox.height, ORIGIN.y);
    root.bbox = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }
  if (root.guides) {
    root.guides.v = (root.guides.v || []).map(function (v) { return snapV(v, ORIGIN.x); });
    root.guides.h = (root.guides.h || []).map(function (v) { return snapV(v, ORIGIN.y); });
  }
  snapNode(root);
}

function main() {
  const path = app.chooseFile();
  if (!path) return;

  FILE = readFigaf(path);
  const data = FILE.doc;
  if (!data.roots || !data.roots.length) throw new Error('File không có frame nào.');

  // Document 72 dpi, đơn vị pixel: 1 px Figma = 1 px Affinity.
  const PAD = 0;
  ORIGIN = { x: data.origin.x - PAD, y: data.origin.y - PAD };
  const opts = NewDocumentOptions.createDefault();
  opts.units = UnitType.Pixel;
  opts.width = Math.ceil(data.size.w + PAD * 2);
  opts.height = Math.ceil(data.size.h + PAD * 2);
  opts.dpi = 72;
  opts.isLandscape = opts.width > opts.height;
  opts.createArtboard = false;
  opts.marginsEnabled = false;
  DOC = Document.create(opts);
  if (!DOC) throw new Error('Không tạo được document mới.');

  if (ROUND_TO_PIXEL) {
    for (const root of data.roots) snapRoot(root);
    report.notes.push('Đã làm tròn toạ độ về số nguyên pixel (ROUND_TO_PIXEL = true).');
  }
  dlog('Document: ' + DOC.widthPixels + 'x' + DOC.heightPixels + ' px, dpi ' + DOC.dpi);
  const spread = DOC.currentSpread || DOC.spreads.first;
  for (const root of data.roots) {
    try { buildRoot(root, spread); } catch (e) { failed(root.name, 'artboard', e); }
  }

  // Báo cáo
  const c = report.created;
  const lines = [];
  lines.push('Nguồn: ' + (data.source ? data.source.file + ' / ' + data.source.page : path));
  lines.splice(0, 0, 'Figma → Affinity ' + SCRIPT_VERSION + ' (plugin ' + ((data.source && data.source.pluginVersion) || 'không rõ') + ')');
  lines.push('Đã tạo: ' + Object.keys(c).map(function (k) { return k + ' ' + c[k]; }).join(', '));
  const fonts = Object.keys(report.missingFonts);
  if (fonts.length) lines.push('\nFont chưa cài trên máy (đang dùng font thay thế):\n- ' + fonts.join('\n- '));
  if (data.stats && data.stats.autoLayoutFlattened) lines.push('\nAuto layout: ' + data.stats.autoLayoutFlattened + ' frame được chuyển thành vị trí cố định.');
  if (report.failed.length) lines.push('\nLỗi khi dựng (' + report.failed.length + '):\n- ' + report.failed.slice(0, 200).join('\n- '));
  const notes = (data.warnings || []).concat(report.notes);
  if (notes.length) lines.push('\nGhi chú (' + notes.length + '):\n- ' + notes.slice(0, 300).join('\n- '));
  const text = lines.join('\n');
  const baseName = String(path).split(/[\\/]/).pop().replace(/\.figaf$/i, '');
  const reportPath = writeReport(text, baseName);

  let short = 'Xong! ' + lines[2];
  if (fonts.length) short += '\nThiếu ' + fonts.length + ' font.';
  if (report.failed.length) short += '\nCó ' + report.failed.length + ' layer lỗi.';
  if (reportPath) short += '\n\nBáo cáo chi tiết: ' + reportPath;
  short += '\n\nKiểm tra lại rồi lưu bằng File → Save As (.af).';
  console.log(text);
  app.alert(short, 'Figma → Affinity');
}

try {
  main();
} catch (e) {
  console.log(e && e.stack ? e.stack : String(e));
  app.alert(e && e.message ? e.message : String(e), 'Figma → Affinity: lỗi');
}

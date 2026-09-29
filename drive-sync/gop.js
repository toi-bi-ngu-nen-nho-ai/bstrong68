// Tự gộp đồng bộ Drive (28/09): gộp dữ liệu máy này với bản lưu của các máy khác bằng Yjs (CRDT), không hỏi chọn bản.
// Hàm thuần: không IndexedDB, không mạng. Vào và ra đều là payload dạng exportAll() (nhị phân { __u8 }, ngày { __date }).
import * as Y from './vendor/yjs-gop.mjs';
import { encodeBackupValue as encode, decodeBackupValue as decode } from '../bstr-backup.js';

/**
 * Bản mới nhất của từng máy khác mà máy này chưa gộp (files: listVersions, mới nhất trước). Bản chưa có nhãn thiết bị
 * là một nhóm. Bỏ bản máy này đang theo (state.fileId) và các bản đã gộp (state.daGop).
 */
export function banCanGop(files, state, myId) {
  const daThay = new Set([state?.fileId, ...(state?.daGop || [])].filter(Boolean));
  const moiNhat = new Map();
  for (const f of files) {
    const thietBi = f.appProperties?.bstrThietBi || '';
    if (thietBi === myId || moiNhat.has(thietBi)) continue;
    moiNhat.set(thietBi, f);
  }
  return [...moiNhat.values()].filter((f) => !daThay.has(f.id));
}

const loiGop = (message) => Object.assign(new Error(message), { code: 'BSTR_GOP_LOI' });
const banGhiTaiLieu = (stores) => [...(stores.snapshots || []), ...(stores.updates || [])];
const idTaiLieu = (stores) => new Set(banGhiTaiLieu(stores).map((r) => r?.docId).filter(Boolean));

function binsCua(stores, docId) {
  const bins = [];
  for (const r of banGhiTaiLieu(stores)) {
    if (r?.docId !== docId || !r.bin) continue;
    const bin = decode(r.bin);
    if (!(bin instanceof Uint8Array)) throw loiGop(`Tài liệu ${docId} có dữ liệu không đọc được`);
    if (bin.length) bins.push(bin);
  }
  return bins;
}

/**
 * Hợp theo khoá: bản của máy này thắng; máy này đánh dấu xoá mà bên kia còn thì lấy bên kia (không bao giờ mất ảnh).
 * Trả [bản ghi, các bản ghi lấy từ bên kia].
 */
function hopTheoKhoa(cua, khac, khoa) {
  const ra = new Map((cua || []).map((r) => [r?.[khoa], r]));
  const lay = [];
  for (const r of khac || []) {
    const k = r?.[khoa];
    if (k === undefined) continue;
    const cu = ra.get(k);
    if (!cu || (cu.deletedAt && !r.deletedAt)) { ra.set(k, r); lay.push(r); }
  }
  return [[...ra.values()], lay];
}

/** Trạng thái Yjs (state vector và phần đã xoá) của các bản cập nhật: xoá không làm tăng state vector, so nó thôi là sót. */
function trangThai(bins) {
  const d = new Y.Doc();
  Y.applyUpdate(d, bins.length === 1 ? bins[0] : Y.mergeUpdates(bins));
  return Y.snapshot(d);
}

/**
 * Gộp workspace `khac` vào `ws` (ws là bản sao, được sửa tại chỗ). Tài liệu gộp xong y như bản trên máy thì để nguyên
 * snapshot, updates và clock của nó: hai máy không có gì mới thì không gộp qua lại mãi. Tài liệu đổi hoặc thêm: một
 * snapshot, giờ gộp (updatedAt = now để lượt gộp update của app đang chạy không ghi đè snapshot này). Trả id tài liệu
 * đổi hoặc thêm và số bản ghi ảnh lấy từ bên kia.
 */
function gopWorkspace(ws, khac, now) {
  const s = ws.stores, k = khac.stores;
  const doi = new Set();
  if (!s.snapshots && idTaiLieu(k).size) throw loiGop(`Workspace ${ws.id} không có kho snapshots`);
  const cu = new Map((s.snapshots || []).map((r) => [r.docId, r]));
  const cuKhac = new Map((k.snapshots || []).map((r) => [r.docId, r]));
  const moi = [];
  for (const docId of idTaiLieu(k)) {
    const cua = binsCua(s, docId);
    const bins = [...cua, ...binsCua(k, docId)];
    if (!bins.length) throw loiGop(`Tài liệu ${docId} không có dữ liệu`);
    const bin = bins.length === 1 ? bins[0] : Y.mergeUpdates(bins);
    if (cua.length && Y.equalSnapshots(trangThai(cua), trangThai([bin]))) continue;
    doi.add(docId);
    moi.push({ docId, bin: encode(bin), createdAt: cu.get(docId)?.createdAt ?? cuKhac.get(docId)?.createdAt ?? encode(now), updatedAt: encode(now) });
  }
  if (doi.size) s.snapshots = s.snapshots.filter((r) => !doi.has(r.docId)).concat(moi);
  // Update của máy này đã nằm trong snapshot mới: restore xoá đúng chúng (theo khoá), update ghi vào máy sau lúc xuất thì còn.
  const boCapNhat = (s.updates || []).filter((r) => doi.has(r.docId)).map((r) => ({ docId: r.docId, createdAt: r.createdAt }));
  if (s.updates) s.updates = s.updates.filter((r) => !doi.has(r.docId));
  if (s.clocks) s.clocks = s.clocks.filter((r) => !doi.has(r.docId)).concat([...doi].map((docId) => ({ docId, timestamp: encode(now) })));
  const anh = {};
  for (const ten of ['blobs', 'blobData']) {
    // Tự gộp đợt 2: bản lưu mới không mang blobData (ảnh là tệp riêng trên Drive). Bản cũ của máy kia còn mang thì lấy ảnh
    // của nó dù bản xuất của máy này không có kho đó: restore chỉ thêm ảnh, không xoá ảnh đang có.
    if (!s[ten] && !k[ten]) continue;
    const [ra, lay] = hopTheoKhoa(s[ten], k[ten], 'key');
    s[ten] = ra;
    if (lay.length) anh[ten] = lay;
  }
  return { doi, anh, boCapNhat };
}

const dungDinhDang = (p) => p?.format === 'bstr-drive-sync/1' && Array.isArray(p.workspaces)
  && p.workspaces.every((ws) => ws && typeof ws.id === 'string' && ws.id && ws.stores && typeof ws.stores === 'object');

/**
 * Gộp payload máy này với các bản của máy khác. Tài liệu có ở bên kia: Y.mergeUpdates mọi bản của hai bên thành một
 * snapshot (Yjs giữ đủ thay đổi của cả hai, xoá bên nào thì xoá theo). Tài liệu, workspace chỉ một bên có: giữ. Ảnh hợp
 * theo khoá. Kết quả thiếu bất kỳ tài liệu nào của đầu vào thì dừng (BSTR_GOP_LOI), không trả kết quả nửa vời.
 * thongKe: taiLieuGop (tài liệu đổi hoặc thêm, kể cả trong workspace mới), wsMoi, anhGop (bản ghi ảnh lấy từ bên kia);
 * cả ba bằng 0 là máy này không đổi gì.
 */
export function gopPayload(mayNay, cacBan, now = new Date()) {
  if (!dungDinhDang(mayNay) || !Array.isArray(cacBan) || !cacBan.every(dungDinhDang)) throw loiGop('Bản lưu không đúng định dạng');
  const ra = structuredClone(mayNay);
  const theoId = new Map(ra.workspaces.map((ws) => [ws.id, ws]));
  const daDoi = new Set(), wsTao = new Set(), thayDoi = {};
  let wsMoi = 0, anhGop = 0;
  for (const ban of cacBan) {
    for (const wsKhac of ban.workspaces) {
      let ws = theoId.get(wsKhac.id);
      if (!ws) {
        wsTao.add(wsKhac.id);
        // Workspace chỉ bên kia: dựng tài liệu lại như tài liệu thêm mới (một snapshot, giờ máy này). Chép nguyên mốc giờ
        // của máy kia thì máy kia chạy nhanh giờ làm kho lưu trữ từ chối snapshot mới hơn của máy này và bỏ luôn updates.
        ws = structuredClone(wsKhac);
        for (const ten of ['snapshots', 'updates', 'clocks']) if (ws.stores[ten]) ws.stores[ten] = [];
        ra.workspaces.push(ws);
        theoId.set(ws.id, ws);
        wsMoi++;
      }
      const { doi, anh, boCapNhat } = gopWorkspace(ws, wsKhac, now);
      for (const docId of doi) daDoi.add(`${ws.id}\n${docId}`);
      anhGop += Object.values(anh).reduce((n, ds) => n + ds.length, 0);
      if (wsTao.has(ws.id) || doi.size || Object.keys(anh).length) {
        const t = (thayDoi[ws.id] ??= { moi: wsTao.has(ws.id), taiLieu: [], boCapNhat: [], anh: {} });
        for (const docId of doi) if (!t.taiLieu.includes(docId)) t.taiLieu.push(docId);
        t.boCapNhat.push(...boCapNhat);
        for (const [ten, ds] of Object.entries(anh)) (t.anh[ten] ??= []).push(...ds);
      }
    }
  }
  for (const ban of [mayNay, ...cacBan]) {
    for (const ws of ban.workspaces) {
      const con = idTaiLieu(theoId.get(ws.id).stores);
      for (const docId of idTaiLieu(ws.stores)) if (!con.has(docId)) throw loiGop(`Kết quả gộp thiếu tài liệu ${docId}`);
    }
  }
  ra.savedAt = now.toISOString();
  return { payload: ra, thongKe: { taiLieuGop: daDoi.size, wsMoi, anhGop }, thayDoi };
}

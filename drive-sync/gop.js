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

/** Hợp theo khoá: bản của máy này thắng; máy này đánh dấu xoá mà bên kia còn thì lấy bên kia (không bao giờ mất ảnh). */
function hopTheoKhoa(cua, khac, khoa) {
  const ra = new Map((cua || []).map((r) => [r?.[khoa], r]));
  for (const r of khac || []) {
    const k = r?.[khoa];
    if (k === undefined) continue;
    const cu = ra.get(k);
    if (!cu || (cu.deletedAt && !r.deletedAt)) ra.set(k, r);
  }
  return [...ra.values()];
}

/** Gộp workspace `khac` vào `ws` (ws là bản sao, được sửa tại chỗ). Trả số tài liệu đã gộp. */
function gopWorkspace(ws, khac, now) {
  const s = ws.stores, k = khac.stores;
  const gop = new Set(idTaiLieu(k));
  if (s.snapshots) {
    const cu = new Map(s.snapshots.map((r) => [r.docId, r]));
    const cuKhac = new Map((k.snapshots || []).map((r) => [r.docId, r]));
    const moi = [...gop].map((docId) => {
      const bins = [...binsCua(s, docId), ...binsCua(k, docId)];
      if (!bins.length) throw loiGop(`Tài liệu ${docId} không có dữ liệu`);
      const bin = bins.length === 1 ? bins[0] : Y.mergeUpdates(bins);
      return { docId, bin: encode(bin), createdAt: cu.get(docId)?.createdAt ?? cuKhac.get(docId)?.createdAt ?? encode(now), updatedAt: encode(now) };
    });
    s.snapshots = s.snapshots.filter((r) => !gop.has(r.docId)).concat(moi);
  }
  if (s.updates) s.updates = s.updates.filter((r) => !gop.has(r.docId));
  if (s.clocks) s.clocks = s.clocks.filter((r) => !gop.has(r.docId)).concat([...gop].map((docId) => ({ docId, timestamp: encode(now) })));
  if (s.blobs) s.blobs = hopTheoKhoa(s.blobs, k.blobs, 'key');
  if (s.blobData) s.blobData = hopTheoKhoa(s.blobData, k.blobData, 'key');
  return gop.size;
}

const dungDinhDang = (p) => p?.format === 'bstr-drive-sync/1' && Array.isArray(p.workspaces)
  && p.workspaces.every((ws) => ws && typeof ws.id === 'string' && ws.id && ws.stores && typeof ws.stores === 'object');

/**
 * Gộp payload máy này với các bản của máy khác. Tài liệu có ở bên kia: Y.mergeUpdates mọi bản của hai bên thành một
 * snapshot (Yjs giữ đủ thay đổi của cả hai, xoá bên nào thì xoá theo). Tài liệu, workspace chỉ một bên có: giữ. Ảnh hợp
 * theo khoá. Kết quả thiếu bất kỳ tài liệu nào của đầu vào thì dừng (BSTR_GOP_LOI), không trả kết quả nửa vời.
 */
export function gopPayload(mayNay, cacBan, now = new Date()) {
  if (!dungDinhDang(mayNay) || !Array.isArray(cacBan) || !cacBan.every(dungDinhDang)) throw loiGop('Bản lưu không đúng định dạng');
  const ra = structuredClone(mayNay);
  const theoId = new Map(ra.workspaces.map((ws) => [ws.id, ws]));
  let taiLieuGop = 0, wsMoi = 0;
  for (const ban of cacBan) {
    for (const wsKhac of ban.workspaces) {
      const ws = theoId.get(wsKhac.id);
      if (ws) { taiLieuGop += gopWorkspace(ws, wsKhac, now); continue; }
      const moi = structuredClone(wsKhac);
      ra.workspaces.push(moi);
      theoId.set(moi.id, moi);
      wsMoi++;
    }
  }
  for (const ban of [mayNay, ...cacBan]) {
    for (const ws of ban.workspaces) {
      const con = idTaiLieu(theoId.get(ws.id).stores);
      for (const docId of idTaiLieu(ws.stores)) if (!con.has(docId)) throw loiGop(`Kết quả gộp thiếu tài liệu ${docId}`);
    }
  }
  ra.savedAt = now.toISOString();
  return { payload: ra, thongKe: { taiLieuGop, wsMoi } };
}

// Ảnh là tệp riêng trên Drive (tự gộp đợt 2, 28/09). Bản lưu chỉ mang chữ và siêu dữ liệu ảnh (blobs); dữ liệu ảnh
// (blobData) đi riêng: mỗi ảnh một tệp, đẩy một lần, máy khác tải nền sau khi đã đọc và gõ được.
import { CONFIG } from './config.js';
import { anhCoDuLieu, docAnh, ghiAnh, anhThieu } from './store.js';
import { listAnh, uploadAnh, downloadAnh } from './drive.js';

/** Chạy các việc, tối đa n việc một lúc (bắt đầu theo thứ tự). Kết quả theo thứ tự: { ok, value } hoặc { ok: false, error }. */
export async function chayGioiHan(viec, n) {
  const kq = new Array(viec.length);
  let tiep = 0;
  const tho = async () => {
    while (tiep < viec.length) {
      const i = tiep++;
      try { kq[i] = { ok: true, value: await viec[i]() }; } catch (error) { kq[i] = { ok: false, error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, viec.length) }, tho));
  return kq;
}

/** Thứ tự tải: ảnh của tài liệu đang mở, rồi ảnh của tài liệu sửa gần nhất; ảnh không tài liệu nào nhắc tới sau cùng. */
export function thuTuTai(ds, docDangMo) {
  const dangMo = (a) => (docDangMo && a.docIds.includes(docDangMo) ? 1 : 0);
  return [...ds].sort((a, b) => (dangMo(b) - dangMo(a)) || ((b.moiNhat ?? -1) - (a.moiNhat ?? -1)));
}

/**
 * Đẩy lên Drive mọi ảnh máy này có mà Drive chưa có, tối đa CONFIG.anhSongSong ảnh một lúc. Ảnh nào hỏng thì ném lỗi của
 * nó SAU khi các ảnh khác đã xong: người gọi không được lưu bản chữ (máy khác sẽ gộp được chữ mà thiếu ảnh), lần sau
 * chỉ đẩy phần còn thiếu. Trả số ảnh đã đẩy.
 */
export async function dayAnh(token, folderId) {
  const coTren = await listAnh(token, folderId);
  const canDay = new Map();
  for (const a of await anhCoDuLieu()) if (!coTren.has(a.key) && !canDay.has(a.key)) canDay.set(a.key, a);
  const kq = await chayGioiHan([...canDay.values()].map((a) => async () => {
    const bytes = await docAnh(a.wsId, a.key);
    if (bytes) await uploadAnh(token, folderId, a.key, bytes, a.mime);
  }), CONFIG.anhSongSong);
  const hong = kq.find((r) => !r.ok);
  if (hong) throw hong.error;
  return canDay.size;
}

/**
 * Tải các ảnh máy này cần mà chưa có (sau khi gộp hay lấy dữ liệu từ Drive), CONFIG.anhSongSong ảnh một lúc theo
 * thuTuTai; tải xong ảnh nào ghi ngay ảnh đó. baoTienDo(n, tong) sau mỗi ảnh. Ảnh không có trên Drive thì đếm vào
 * thieuTrenDrive, ảnh tải hỏng thì đếm vào loi (lần mở app sau tải tiếp).
 */
export async function taiAnhThieu(token, folderId, { docDangMo = null, baoTienDo = () => {} } = {}) {
  const ds = thuTuTai(await anhThieu(), docDangMo);
  if (!ds.length) return { daTai: 0, thieuTrenDrive: 0, loi: 0 };
  const coTren = await listAnh(token, folderId);
  const coThe = ds.filter((a) => coTren.has(a.key));
  let daTai = 0;
  const kq = await chayGioiHan(coThe.map((a) => async () => {
    await ghiAnh(a.wsId, a.key, await downloadAnh(token, coTren.get(a.key)));
    baoTienDo(++daTai, coThe.length);
  }), CONFIG.anhSongSong);
  return { daTai, thieuTrenDrive: ds.length - coThe.length, loi: kq.filter((r) => !r.ok).length };
}

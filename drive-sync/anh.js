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
 * Khoá ảnh nằm trong tên tệp và nhãn bstrAnh (Drive giới hạn một nhãn 124 byte). Khoá thường là băm 44 ký tự; khoá lạ
 * (không phải chuỗi, quá 100 byte: gói chia sẻ ?nhan= mang nguyên văn) không bao giờ đẩy lên Drive.
 */
export const khoaAnhHopLe = (key) => typeof key === 'string' && new TextEncoder().encode(key).length <= 100;

/**
 * Đẩy lên Drive mọi ảnh máy này có mà Drive chưa có, tối đa CONFIG.anhSongSong ảnh một lúc. Ảnh nào hỏng thì ném lỗi của
 * nó SAU khi các ảnh khác đã xong: người gọi không được lưu bản chữ (máy khác sẽ gộp được chữ mà thiếu ảnh), lần sau
 * chỉ đẩy phần còn thiếu. Trả số ảnh đã đẩy; baoTienDo(n, tong) sau mỗi ảnh đẩy xong.
 * Khoá lạ (khoaAnhHopLe) thì bỏ qua, không thì hỏng mãi và không lưu được bản chữ nào nữa. Một khoá có ở nhiều workspace
 * thì lấy byte ở workspace đầu tiên có; không đâu có byte thì không đẩy.
 */
export async function dayAnh(token, folderId, { baoTienDo = () => {} } = {}) {
  const coTren = await listAnh(token, folderId);
  const canDay = new Map(); // khoá -> mọi { wsId, mime } có khoá đó
  for (const a of await anhCoDuLieu()) {
    if (!khoaAnhHopLe(a.key)) console.warn('[drive-sync] bỏ qua ảnh khoá không hợp lệ', a.key);
    else if (!coTren.has(a.key)) canDay.set(a.key, [...(canDay.get(a.key) || []), a]);
  }
  let daDay = 0;
  const kq = await chayGioiHan([...canDay].map(([key, noiCo]) => async () => {
    for (const a of noiCo) {
      const bytes = await docAnh(a.wsId, key);
      if (!bytes) continue;
      await uploadAnh(token, folderId, key, bytes, a.mime);
      baoTienDo(++daDay, canDay.size);
      return;
    }
  }), CONFIG.anhSongSong);
  const hong = kq.find((r) => !r.ok);
  if (hong) throw hong.error;
  return daDay;
}

/**
 * Tải các ảnh máy này cần mà chưa có (sau khi gộp hay lấy dữ liệu từ Drive), CONFIG.anhSongSong ảnh một lúc theo
 * thuTuTai; tải xong ảnh nào ghi ngay ảnh đó vào mọi workspace cần nó (mỗi khoá tải một lần). baoTienDo(n, tong) sau
 * mỗi ảnh. Đếm theo khoá: ảnh không có trên Drive vào thieuTrenDrive, ảnh tải hỏng vào loi (lần mở app sau tải tiếp),
 * daTai là ảnh vừa ghi mới vào ít nhất một workspace.
 * chiTaiLieu: chỉ tải ảnh của tài liệu đó (gộp xong, trước khi tải lại trang). Ảnh khoá lạ không bao giờ có trên Drive
 * (dayAnh bỏ qua): không tải, không đếm.
 */
export async function taiAnhThieu(token, folderId, { docDangMo = null, baoTienDo = () => {}, chiTaiLieu = null } = {}) {
  const ds = thuTuTai((await anhThieu()).filter((a) => khoaAnhHopLe(a.key) && (!chiTaiLieu || a.docIds.includes(chiTaiLieu))), docDangMo);
  if (!ds.length) return { daTai: 0, thieuTrenDrive: 0, loi: 0 };
  const canO = new Map(); // khoá -> các workspace cần, giữ thứ tự ưu tiên của lần gặp đầu
  for (const a of ds) canO.set(a.key, [...(canO.get(a.key) || []), a.wsId]);
  const coTren = await listAnh(token, folderId);
  const coThe = [...canO].filter(([key]) => coTren.has(key));
  let daTai = 0, xong = 0;
  const kq = await chayGioiHan(coThe.map(([key, wsIds]) => async () => {
    const bytes = await downloadAnh(token, coTren.get(key));
    let moi = false;
    for (const wsId of wsIds) if (await ghiAnh(wsId, key, bytes)) moi = true;
    if (moi) daTai++;
    baoTienDo(++xong, coThe.length);
  }), CONFIG.anhSongSong);
  return { daTai, thieuTrenDrive: canO.size - coThe.length, loi: kq.filter((r) => !r.ok).length };
}

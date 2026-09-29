// Khoá kho kẹt (Phần A2, 29/09). Worker kho của app ghi một bản ghi vào bảng `locks` của IndexedDB mỗi lần gộp bản sửa của một
// tài liệu, và chờ mọi bản ghi dưới 30 giây tuổi (không kiểm người giữ còn sống). Trang bị tắt đúng lúc đang giữ khoá (tải lại,
// đóng tab, iPhone dọn trang) để lại bản ghi kẹt: lần mở kế tiếp trong 30 giây, tài liệu chỉ hiện sau khi bản ghi hết hạn.
// Cách sửa: mỗi trang giữ một Web Lock chia sẻ suốt đời (trình duyệt tự nhả khi trang chết). Lúc khởi động, TRƯỚC khi app và
// kho khởi động, không còn trang nào khác giữ khoá đó thì mọi bản ghi khoá đều của trang đã chết và được xoá. Chỉ ghi vào bảng
// `locks`; lỗi gì cũng bỏ qua (kho tự hết hạn khoá sau 30 giây như trước).
export const TEN_KHOA_TRANG = 'bstr-trang-song';
export const TIEN_TO_CSDL = 'local:workspace:';
export const CHO_TRANG_KHAC_MS = 1500;
export const NHIP_MS = 100;

const doi = (ms) => new Promise((r) => setTimeout(r, ms));
const yeuCau = (r) => new Promise((ok, loi) => { r.onsuccess = () => ok(r.result); r.onerror = () => loi(r.error); });

/** Kho thật: các CSDL kho tài liệu (tên bắt đầu bằng tienTo) có bảng `locks`. Chỉ mở CSDL đã có, không bao giờ tạo hay nâng cấp. */
export function khoIndexedDB({ idb = globalThis.indexedDB, tienTo = TIEN_TO_CSDL } = {}) {
  const mo = (ten) => new Promise((ok, loi) => {
    const q = idb.open(ten);
    q.onupgradeneeded = () => q.transaction.abort();
    q.onsuccess = () => { q.result.onversionchange = () => q.result.close(); ok(q.result); }; // không bao giờ chặn lần nâng cấp của chính app
    q.onerror = () => loi(q.error);
  });
  return {
    async cacCsdl() {
      return (await idb.databases()).map((d) => d.name).filter((n) => typeof n === 'string' && n.startsWith(tienTo));
    },
    async demKhoa(ten) {
      const db = await mo(ten);
      try {
        return db.objectStoreNames.contains('locks') ? await yeuCau(db.transaction('locks').objectStore('locks').count()) : 0;
      } finally { db.close(); }
    },
    async xoaKhoa(ten) {
      const db = await mo(ten);
      try {
        if (!db.objectStoreNames.contains('locks')) return 0;
        const tx = db.transaction('locks', 'readwrite'), os = tx.objectStore('locks');
        const n = await yeuCau(os.count());
        os.clear();
        await new Promise((ok, loi) => { tx.oncomplete = ok; tx.onerror = () => loi(tx.error); tx.onabort = () => loi(tx.error || new Error('giao dịch bị huỷ')); });
        return n;
      } finally { db.close(); }
    },
  };
}

// Khoá trang giữ một lần cho cả trang (theo đối tượng locks): giữ hai khoá thì trang tự coi là có trang khác.
const daGiu = new WeakMap();
function giuKhoaTrang(locks) {
  if (!daGiu.has(locks)) {
    daGiu.set(locks, new Promise((xong, loi) => {
      locks.request(TEN_KHOA_TRANG, { mode: 'shared' }, () => { xong(); return new Promise(() => {}); }).catch(loi);
    }));
  }
  return daGiu.get(locks);
}

async function soTrangSong(locks) {
  const { held = [] } = await locks.query();
  return held.filter((l) => l.name === TEN_KHOA_TRANG).length;
}

/**
 * Gọi MỘT lần lúc khởi động, trước khi nạp app (bstr-bootstrap.js): sau khi app và kho chạy thì bản ghi khoá có thể là của chính
 * trang này. Trả { bo, lyDo }: bo = số bản ghi khoá đã xoá; lyDo: 'khong-ho-tro' | 'khong-co' | 'co-trang-khac' | 'het-gio' | 'xong' | 'loi'.
 * signal (AbortSignal, hay bất cứ thứ gì có `aborted` kiểu boolean): bootstrap bật khi hết giờ và đi tiếp khởi động app; từ lúc đó
 * hàm không được chờ hay xoá thêm gì nữa (app và kho đã chạy thì bản ghi khoá có thể là khoá sống), trả lyDo 'het-gio'.
 */
export async function giaiPhongKhoaKet({ kho = khoIndexedDB(), locks = globalThis.navigator?.locks, cho = doi, choTrangKhacMs = CHO_TRANG_KHAC_MS, signal } = {}) {
  try {
    if (!locks?.request || !locks?.query || !kho) return { bo: 0, lyDo: 'khong-ho-tro' };
    await giuKhoaTrang(locks);
    const coKhoa = [];
    for (const ten of await kho.cacCsdl()) {
      try { if ((await kho.demKhoa(ten)) > 0) coKhoa.push(ten); } catch (e) { console.warn('[bstr] chưa đọc được bảng khoá của', ten, e); }
    }
    if (!coKhoa.length) return { bo: 0, lyDo: 'khong-co' };
    // Trang khác còn sống có thể đang giữ khoá thật; trang vừa bị tải lại có thể chưa nhả khoá trang: chờ tối đa choTrangKhacMs.
    for (let daCho = 0; ; daCho += NHIP_MS) {
      if (signal?.aborted) return { bo: 0, lyDo: 'het-gio' };
      const n = await soTrangSong(locks);
      if (n < 1) return { bo: 0, lyDo: 'loi' }; // khoá trang của chính mình phải thấy được; không thấy thì không dám kết luận
      if (n === 1) break;
      if (daCho >= choTrangKhacMs) return { bo: 0, lyDo: 'co-trang-khac' };
      await cho(NHIP_MS);
    }
    let bo = 0;
    for (const ten of coKhoa) {
      if (signal?.aborted) return { bo, lyDo: 'het-gio' };
      try { bo += await kho.xoaKhoa(ten); } catch (e) { console.warn('[bstr] chưa xoá được khoá kẹt của', ten, e); }
    }
    return { bo, lyDo: 'xong' };
  } catch (e) {
    console.warn('[bstr] chưa dọn được khoá kho kẹt', e);
    return { bo: 0, lyDo: 'loi' };
  }
}

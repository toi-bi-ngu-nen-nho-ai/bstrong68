import { CONFIG } from './config.js';
import { convertDocumentUpdate } from '../bstr-backup.js';
import * as store from './store.js';
import { ensureToken, folder, saoLuuTruocKhiGhiDe } from './sync.js';
import { uploadJson, moChoMoiNguoiDoc, taiJsonCongKhai, listShares, prune } from './drive.js';
import { setStatus } from './ui.js';
import { taiAnhThieu } from './anh.js';

/**
 * Chia sẻ MỘT tài liệu kiểu AnkiWeb: A đưa gói lên Drive và lấy đường dẫn công
 * khai; B dán đường dẫn, gói được ghi thẳng vào IndexedDB của B. Dán lại đường
 * dẫn cũ thì GỘP bản mới của A vào bản của B (giữ phần B đã sửa) chứ không tạo
 * bản thứ hai. B sửa bản của mình thoải mái — không có đường quay ngược về A.
 *
 * Yjs nằm trong drive-sync/vendor/, được dùng chung với bước kiểm tra dữ liệu
 * khi khởi động, qua bản gộp một tệp yjs-gop.mjs (sinh từ yjs.mjs + lib0/).
 */

let napXong = null;
const napYjs = () => (napXong ||= import('./vendor/yjs-gop.mjs'));

// ─────────────────────────────── tiện ích Yjs ───────────────────────────────

/** Gộp snapshot + các updates chưa gộp thành MỘT update duy nhất. */
function gopBins(Y, bins) {
  if (bins.length === 1) return bins[0];
  const d = new Y.Doc();
  for (const b of bins) Y.applyUpdate(d, b);
  return Y.encodeStateAsUpdate(d);
}

/** Giá trị JS thuần -> kiểu Y tương ứng, giống native2Y của thư viện editor. */
function thanhY(Y, v) {
  if (Array.isArray(v)) {
    const a = new Y.Array();
    a.insert(0, v.map((x) => thanhY(Y, x)));
    return a;
  }
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const m = new Y.Map();
    for (const [k, x] of Object.entries(v)) m.set(k, thanhY(Y, x));
    return m;
  }
  return v;
}

const layId = (row) => (row && typeof row.get === 'function' ? row.get('id') : row?.id);
const layTieuDe = (row) => (row && typeof row.get === 'function' ? row.get('title') : row?.title);

const KY_TU_ID = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
/** Id tài liệu kiểu nanoid 21 ký tự — cùng dạng id ứng dụng sinh cho tài liệu mới. */
const taoIdTaiLieu = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(21)), (b) => KY_TU_ID[b & 63]).join('');

export const TIEN_TO_NHAN = '[Nhận] ';

/**
 * Đặt tiền tố vào tiêu đề NẰM TRONG chính tài liệu, không chỉ trong meta.pages.
 * Ứng dụng đồng bộ ngược tiêu đề của khối `bstr:page` ra `meta.pages` ngay
 * lần đầu mở tài liệu — sửa mỗi meta thì tiền tố biến mất ngay sau cú nhấp đầu
 * tiên và người nhận không còn dấu hiệu nào cho biết tài liệu này từ đâu tới.
 * Trả về update mới của tài liệu (đã gộp) kèm tiêu đề cuối cùng.
 */
function datTienToNhan(Y, snapshotBin, tieuDeGoi) {
  const d = new Y.Doc();
  try {
    Y.applyUpdate(d, convertDocumentUpdate(snapshotBin).bytes);
    let tieuDe = tieuDeGoi;
    for (const b of d.getMap('blocks').values()) {
      if (!b || typeof b.get !== 'function' || b.get('sys:flavour') !== 'bstr:page') continue;
      const t = b.get('prop:title');
      if (!t || typeof t.insert !== 'function') continue;
      // Gộp với bản sao đã có tiền tố: chữ người gửi thêm ở đầu tiêu đề có thể đứng trước tiền tố (Yjs xếp chữ chèn cùng chỗ
      // theo clientID). Bỏ mọi tiền tố không ở đầu rồi đặt đúng một cái ở đầu.
      for (let i = t.toString().lastIndexOf(TIEN_TO_NHAN); i > 0; i = t.toString().lastIndexOf(TIEN_TO_NHAN)) {
        t.delete(i, TIEN_TO_NHAN.length);
      }
      if (!t.toString().startsWith(TIEN_TO_NHAN)) t.insert(0, TIEN_TO_NHAN);
      tieuDe = t.toString();
      break;
    }
    return { bin: Y.encodeStateAsUpdate(d), tieuDe };
  } finally { d.destroy(); }
}

/**
 * Kiểm kê tài liệu gốc: danh sách id trong meta.pages (giữ nguyên thứ tự, CÓ
 * lặp nếu trùng) và các khoá trong spaces. Đây là thứ đem ra so trước/sau.
 */
export async function kiemKeRoot(bin) {
  const Y = await napYjs();
  const d = new Y.Doc();
  Y.applyUpdate(d, bin);
  const pages = d.getMap('meta').get('pages');
  const ids = pages && typeof pages.toArray === 'function' ? pages.toArray().map(layId) : null;
  return { ids, spaces: [...d.getMap('spaces').keys()] };
}

const thieuSo = (a, b) => {
  const co = new Set(b);
  return [...new Set(a)].filter((x) => !co.has(x));
};

/**
 * Tài liệu gốc hỏng là mất CẢ workspace, nên phép ghi chỉ được phép làm đúng
 * một việc: thêm `themId`. Bất kỳ sai khác nào khác — mất tài liệu cũ, mọc
 * thêm tài liệu lạ, sinh dòng trùng trong meta.pages, meta.pages biến mất —
 * đều là hỏng, và người gọi PHẢI không ghi gì cả.
 */
export function kiemTraToanVen(truoc, sau, themId) {
  const loi = [];
  if (!Array.isArray(truoc.ids)) loi.push('bản gốc trước khi sửa không đọc được meta.pages');
  if (!Array.isArray(sau.ids)) loi.push('bản gốc sau khi sửa không còn meta.pages');
  if (loi.length) return { ok: false, loi };

  const mat = thieuSo(truoc.ids, sau.ids);
  if (mat.length) loi.push(`mất ${mat.length} tài liệu khỏi meta.pages: ${mat.join(', ')}`);
  const la = thieuSo(sau.ids, truoc.ids).filter((id) => id !== themId);
  if (la.length) loi.push(`mọc thêm tài liệu lạ trong meta.pages: ${la.join(', ')}`);
  if (!sau.ids.includes(themId)) loi.push(`không thấy tài liệu ${themId} trong meta.pages sau khi sửa`);
  if (new Set(sau.ids).size !== sau.ids.length) loi.push('meta.pages có dòng trùng id');
  if (sau.ids.some((id) => typeof id !== 'string' || !id)) loi.push('meta.pages có dòng thiếu id');

  const matSpace = thieuSo(truoc.spaces, sau.spaces);
  if (matSpace.length) loi.push(`mất ${matSpace.length} mục trong spaces: ${matSpace.join(', ')}`);
  const laSpace = thieuSo(sau.spaces, truoc.spaces).filter((id) => id !== themId);
  if (laSpace.length) loi.push(`mọc thêm mục lạ trong spaces: ${laSpace.join(', ')}`);
  if (!sau.spaces.includes(themId)) loi.push(`không thấy spaces[${themId}] sau khi sửa`);

  const dung = truoc.ids.length + (truoc.ids.includes(themId) ? 0 : 1);
  if (sau.ids.length !== dung) loi.push(`meta.pages có ${sau.ids.length} dòng, phải là ${dung}`);

  return { ok: loi.length === 0, loi };
}

const TRUONG_META = ['title', 'tags', 'createDate', 'updatedDate', 'favorite', 'trash'];

/**
 * Gói tới từ mạng nên là DỮ LIỆU LẠ: chỉ lấy đúng các trường của DocMeta và
 * đúng kiểu của chúng. Nhét nguyên gói vào tài liệu gốc là mở cửa cho một tệp
 * bất kỳ ghi khoá tuỳ ý vào thứ mà cả workspace phụ thuộc.
 */
function locMeta(raw, docId) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const meta = { id: docId };
  meta.title = typeof o.title === 'string' ? o.title : 'Tài liệu';
  meta.tags = Array.isArray(o.tags) ? o.tags.filter((t) => typeof t === 'string') : [];
  meta.createDate = Number.isFinite(o.createDate) ? o.createDate : Date.now();
  if (Number.isFinite(o.updatedDate)) meta.updatedDate = o.updatedDate;
  if (typeof o.favorite === 'boolean') meta.favorite = o.favorite;
  if (typeof o.trash === 'boolean') meta.trash = o.trash;
  for (const k of Object.keys(o)) {
    if (k !== 'id' && !TRUONG_META.includes(k)) {
      console.warn(`[drive-sync] bỏ qua trường lạ trong meta: ${k}`);
    }
  }
  return meta;
}

// ───────────────────────────────── phía A ─────────────────────────────────

/**
 * Đóng gói một tài liệu (kèm ảnh của nó) rồi đưa lên Drive và mở quyền đọc cho
 * bất kỳ ai có đường dẫn. Chỉ ĐỌC dữ liệu trên máy — không sửa, không xoá gì.
 */
export async function chiaSeTaiLieu(docId) {
  if (typeof docId !== 'string' || !docId) throw new Error('chiaSeTaiLieu(docId): thiếu docId');
  setStatus('Đang đóng gói tài liệu để chia sẻ...');
  // Ảnh là tệp riêng trên Drive (tự gộp đợt 2): máy có thể chưa tải xong byte ảnh của tài liệu này (máy mới, vừa gộp).
  // Tải trước, không thì người nhận thiếu ảnh mãi. Hỏng (mất mạng) thì vẫn chia sẻ với ảnh máy có.
  try {
    await taiAnhThieu(await ensureToken(), await folder(), { chiTaiLieu: docId });
  } catch (e) {
    console.warn('[drive-sync] tải ảnh còn thiếu trước khi chia sẻ thất bại, gói chỉ mang ảnh máy có', e);
  }
  const Y = await napYjs();
  const nguon = await store.nguonChiaSe(docId);

  const rootBin = gopBins(Y, nguon.rootBins);
  const rootDoc = new Y.Doc();
  Y.applyUpdate(rootDoc, rootBin);
  const pages = rootDoc.getMap('meta').get('pages');
  const yRow = pages && typeof pages.toArray === 'function'
    ? pages.toArray().find((r) => layId(r) === docId) : null;
  if (!yRow) throw new Error(`Tài liệu ${docId} không có trong meta.pages — không chia sẻ được`);
  const meta = locMeta(typeof yRow.toJSON === 'function' ? yRow.toJSON() : yRow, docId);

  const goi = {
    format: 'bstr-chia-se/1',
    sharedAt: new Date().toISOString(),
    doc: { id: docId, meta, snapshot: store.maHoa(gopBins(Y, nguon.bins)) },
    blobs: nguon.blobs,
    blobData: nguon.blobData,
  };

  setStatus('Đang đưa gói chia sẻ lên Drive...');
  const token = await ensureToken();
  const ten = `${CONFIG.sharePrefix}${docId}-${goi.sharedAt.replace(/[:.]/g, '-')}.json`;
  const up = await uploadJson(token, await folder(), ten, goi);
  if (!up?.id || !up.name?.startsWith(CONFIG.sharePrefix)) {
    throw new Error('Tệp tải lên không mang đúng tiền tố chia sẻ — dừng để khỏi lẫn vào bản đồng bộ');
  }
  await moChoMoiNguoiDoc(token, up.id);

  const link = `https://drive.google.com/file/d/${up.id}/view`;
  setStatus('Đã tạo đường dẫn chia sẻ');
  console.log(
    `[drive-sync] đã chia sẻ "${meta.title}" (${docId})\n`
    + `Đường dẫn gửi cho người khác: ${link}\n`
    + `Id tệp trên Drive: ${up.id}\n`
    + `Ảnh kèm theo: ${nguon.blobKeys.length ? nguon.blobKeys.join(', ') : '(không có)'}`
  );
  return { link, fileId: up.id, docId, title: meta.title, blobKeys: nguon.blobKeys, goi };
}

/**
 * Như chiaSeTaiLieu(), nhưng dọn bớt các bản chia sẻ CŨ của CÙNG tài liệu này
 * sau khi bản mới tải lên xong — giữ tối đa `giuBanCu` bản cũ (cộng bản vừa
 * tạo), để bấm lại nút chia sẻ nhiều lần không chất đống file trên Drive.
 * Dọn dẹp lỗi thì bỏ qua, không ảnh hưởng tới liên kết vừa tạo (đã trả về).
 */
export async function chiaSeVaDonDep(docId, { giuBanCu = 2 } = {}) {
  const ket = await chiaSeTaiLieu(docId);
  try {
    const token = await ensureToken();
    const cuaTaiLieu = (await listShares(token, await folder()))
      .filter((f) => f.name.startsWith(`${CONFIG.sharePrefix}${docId}-`));
    await prune(token, cuaTaiLieu, giuBanCu + 1);
  } catch (e) {
    console.warn('[drive-sync] dọn bản chia sẻ cũ thất bại (không ảnh hưởng liên kết vừa tạo)', e);
  }
  return ket;
}

// ───────────────────────────────── phía B ─────────────────────────────────

/** Lấy id tệp Drive từ mọi dạng đường dẫn hay gặp, hoặc từ id dán thẳng. */
export function idTuLink(link) {
  const s = String(link || '').trim();
  const m = s.match(/\/file\/d\/([A-Za-z0-9_-]+)/)
    || s.match(/[?&]id=([A-Za-z0-9_-]+)/)
    || s.match(/\/d\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{16,}$/.test(s)) return s;
  throw new Error('Không nhận ra id tệp Google Drive trong đường dẫn đã dán');
}

function kiemTraGoi(goi) {
  if (!goi || typeof goi !== 'object') throw new Error('Gói chia sẻ rỗng hoặc không phải JSON');
  if (goi.format !== 'bstr-chia-se/1') throw new Error(`Không hiểu định dạng gói: ${goi.format}`);
  const id = goi.doc?.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new Error('Gói chia sẻ thiếu id tài liệu hợp lệ');
  }
  if (typeof goi.doc?.snapshot?.__u8 !== 'string') throw new Error('Gói chia sẻ thiếu nội dung tài liệu');
  if (goi.blobs && !Array.isArray(goi.blobs)) throw new Error('Gói chia sẻ có trường blobs hỏng');
  if (goi.blobData && !Array.isArray(goi.blobData)) throw new Error('Gói chia sẻ có trường blobData hỏng');
}

/**
 * Bước 1–2 của nhanGoi(), không đụng IndexedDB hay mạng: dựng bản gốc mới trong
 * bộ nhớ rồi đối chiếu. Sai một li là ném lỗi — người gọi không được ghi gì.
 * `banCu`: bytes (snapshot + updates) của tài liệu goi.doc.id đang có trên máy.
 */
export async function dungBanNhan(Y, truocBin, goi, taoId = taoIdTaiLieu, banCu = []) {
  const truoc = await kiemKeRoot(truocBin);
  if (!Array.isArray(truoc.ids)) {
    throw new Error('Tài liệu gốc trên máy không đọc được meta.pages — dừng, không ghi gì');
  }

  const root = new Y.Doc();
  Y.applyUpdate(root, truocBin);
  const pages = root.getMap('meta').get('pages');
  if (!pages || typeof pages.toArray !== 'function') {
    throw new Error('Tài liệu gốc trên máy không có meta.pages — dừng, không ghi gì');
  }
  const cu = pages.toArray().find((r) => layId(r) === goi.doc.id);
  // Trùng id với tài liệu GỐC của máy này (tiêu đề không mang tiền tố nhận) thì
  // nhận thành bản sao id mới, như cách nhập Snapshot — không bao giờ ghi đè
  // tài liệu của chính mình. Trùng với bản đã nhận thì vẫn cập nhật tại chỗ.
  const banSao = cu !== undefined && !String(layTieuDe(cu) ?? '').startsWith(TIEN_TO_NHAN);
  const docId = banSao ? taoId() : goi.doc.id;

  // Nhận lại bản đã nhận (chủ dự án chọn 29/09): GỘP bản mới của người gửi vào bản trên máy — Yjs giữ phần sửa của cả hai
  // bên, bên nào xoá thì xoá theo — thay vì để bản người gửi thay hẳn và mất phần máy này đã sửa.
  const gop = !banSao && cu !== undefined && banCu.length > 0;
  const guiDen = store.giaiMa(goi.doc.snapshot);

  const meta = locMeta(goi.doc.meta, docId);
  // Tiêu đề phải nói rõ đây là bản nhận về, để không ai nhầm với tài liệu của
  // chính mình. Nhận lại lần nữa thì KHÔNG được chồng thêm tiền tố.
  const daSua = datTienToNhan(Y, gop ? Y.mergeUpdates([...banCu, guiDen]) : guiDen, meta.title);
  meta.title = daSua.tieuDe.startsWith(TIEN_TO_NHAN) ? daSua.tieuDe : TIEN_TO_NHAN + daSua.tieuDe;
  meta.updatedDate = Date.now();

  if (cu === undefined || banSao) {
    pages.push([thanhY(Y, meta)]);
  } else if (cu && typeof cu.set === 'function') {
    // Sửa TẠI CHỖ đúng dòng của tài liệu này. Xoá rồi thêm lại sẽ đẩy nó xuống
    // cuối danh sách và làm dòng cũ biến mất khỏi mọi bản sao đang mở.
    for (const [k, v] of Object.entries(meta)) cu.set(k, thanhY(Y, v));
  } else {
    throw new Error(`meta.pages[${docId}] không phải Y.Map — dừng, không ghi gì`);
  }
  const spaces = root.getMap('spaces');
  if (!spaces.get(docId)) spaces.set(docId, new Y.Doc({ guid: docId }));

  const rootBin = Y.encodeStateAsUpdate(root);
  const sau = await kiemKeRoot(rootBin);
  const kiem = kiemTraToanVen(truoc, sau, docId);
  if (!kiem.ok) {
    console.error('[drive-sync] bản gốc sửa xong KHÔNG toàn vẹn — không ghi gì:', kiem.loi);
    throw new Error(
      `Bản tài liệu gốc sau khi sửa không toàn vẹn (${kiem.loi.join('; ')}) `
      + '— đã huỷ, không ghi gì lên máy'
    );
  }
  return { docId, meta, snapshotBin: daSua.bin, rootBin, truoc, sau, gop };
}

/**
 * Ghi gói đã có sẵn trong tay vào máy này. Thứ tự KHÔNG được đổi:
 *   1) dựng bản gốc mới trong bộ nhớ,
 *   2) giải mã lại và đối chiếu — sai một li là không ghi gì,
 *   3) sao lưu toàn bộ máy lên Drive — hỏng là không ghi gì,
 *   4) mới ghi IndexedDB trong một giao dịch.
 * Cả bốn bước giữ khoá đồng bộ 'bstr-drive-sync' (chờ tới lượt, mọi tab): lượt gộp ghi bản gốc giữa lúc đọc (1) và ghi (4)
 * thì bước 4 ghi đè bản gốc cũ lên, mất dòng tài liệu vừa gộp; gộp xong tải lại trang thì cắt ngang bước nhận. Không được
 * gọi hàm này từ bên trong khoá đó (khoá không vào lại được: treo mãi). Trình duyệt không có Web Locks thì chạy thẳng.
 */
export async function nhanGoi(goi, tuyChon = {}) {
  const locks = globalThis.navigator?.locks;
  return locks?.request ? locks.request('bstr-drive-sync', () => nhanGoiTrongKhoa(goi, tuyChon)) : nhanGoiTrongKhoa(goi, tuyChon);
}

async function nhanGoiTrongKhoa(goi, { taiLai = true } = {}) {
  kiemTraGoi(goi);
  const Y = await napYjs();
  const wsId = await store.wsNhan(goi.doc.id);
  if (!wsId) throw new Error('Máy này chưa có workspace nào để nhận tài liệu — hãy mở ứng dụng trước');

  const rBins = await store.binsTaiLieu(wsId);
  if (!rBins.length) throw new Error(`Workspace ${wsId} không có tài liệu gốc — dừng, không ghi gì`);
  const { docId, meta, snapshotBin, rootBin, truoc, sau, gop } = await dungBanNhan(
    Y, gopBins(Y, rBins), goi, undefined, await store.binsTaiLieu(wsId, goi.doc.id));

  // BẮT BUỘC: sao lưu trước khi đụng vào tài liệu gốc. Hỏng thì dừng hẳn.
  try {
    await saoLuuTruocKhiGhiDe();
  } catch (e) {
    console.error('[drive-sync] sao lưu trước khi nhận tài liệu thất bại', e);
    setStatus('Không sao lưu được bản trên máy nên chưa nhận tài liệu. Dữ liệu trên máy chưa bị thay đổi.', { persist: true, level: 'error' });
    throw new Error(
      `Không sao lưu được trước khi ghi (${e?.message || e}) — đã huỷ, không ghi gì lên máy`
    );
  }

  setStatus('Đang ghi tài liệu nhận được...');
  const kq = await store.ghiTaiLieuNhan(wsId, {
    docId,
    snapshotBin,
    rootBin,
    gop,
    blobs: goi.blobs || [],
    blobData: goi.blobData || [],
  });
  console.log(
    `[drive-sync] đã ${kq.gop ? 'GỘP' : kq.daCoSan ? 'CẬP NHẬT' : 'THÊM'} tài liệu "${meta.title}" (${docId}) `
    + `vào workspace ${wsId}\n`
    + `meta.pages: ${truoc.ids.length} -> ${sau.ids.length} dòng; `
    + `ảnh kèm: ${(goi.blobs || []).length}; `
    + (kq.gop ? 'giữ mọi bản sửa trên máy' : `đã xoá ${kq.daXoaUpdates} bản sửa cũ của tài liệu này`)
  );
  setStatus(kq.gop ? `Đã gộp bản mới của "${meta.title}", giữ phần bạn đã sửa` : `Đã nhận tài liệu "${meta.title}"`);
  if (taiLai) {
    // Ứng dụng giữ trạng thái workspace trong bộ nhớ; ghi dưới chân nó là vô
    // hình cho tới khi tải lại trang.
    setTimeout(() => location.reload(), 600);
  }
  return { ...kq, docId, title: meta.title, wsId, soDong: sau.ids.length };
}

/**
 * Dán đường dẫn A gửi cho -> tải gói công khai -> ghi vào máy này. `tuyChon` chuyển cho nhanGoi(): liên kết
 * ?nhan= truyền { taiLai: false } rồi tự mở tài liệu vừa nhận.
 */
export async function nhanTaiLieu(link, tuyChon = {}) {
  const fileId = idTuLink(link);
  if (!CONFIG.shareUrl) {
    throw new Error(
      'Chưa cấu hình CONFIG.shareUrl (Worker tải gói chia sẻ) trong drive-sync/config.js '
      + '— chưa tải được gói chia sẻ công khai.'
    );
  }
  setStatus('Đang tải gói chia sẻ...');
  const goi = await taiJsonCongKhai(fileId, CONFIG.shareUrl);
  return nhanGoi(goi, tuyChon);
}

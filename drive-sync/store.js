import { CONFIG, LS } from './config.js';
import { migrateDatabase } from '../bstr-migrate.js';
import { prepareBackup, convertDocumentUpdate, encodeBackupValue as encode, decodeBackupValue as decode } from '../bstr-backup.js';

const req = (r) => new Promise((res, rej) => {
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

const txDone = (tx) => new Promise((res, rej) => {
  tx.oncomplete = () => res();
  tx.onerror = () => rej(tx.error);
  tx.onabort = () => rej(tx.error || new Error('giao dịch bị huỷ'));
});

export function workspaceIds() {
  try { return JSON.parse(localStorage.getItem(LS.workspaceList) || '[]'); }
  catch { return []; }
}

export function deviceId() {
  let id = localStorage.getItem(LS.deviceId);
  if (!id) {
    id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(LS.deviceId, id);
  }
  return id;
}

const u8ToBinaryString = (u8) => {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return s;
};

const dbName = (id) => `local:workspace:${id}`;

// Khoá ảnh của app: băm 32 byte viết base64 (44 ký tự, hết bằng '=').
const DANG_KHOA = /[A-Za-z0-9+/_-]{43}=/g;
const laDangKhoa = (k) => typeof k === 'string' && k.length === 44 && /^[A-Za-z0-9+/_-]{43}=$/.test(k);

/**
 * blobKey xuất hiện dạng chuỗi con trong bytes snapshot Yjs của tài liệu nào
 * thì coi tài liệu đó "sở hữu" blob ấy — khoá blob là chuỗi ngẫu nhiên dài nên
 * gần như không thể trùng tình cờ. Trả về Map<blobKey, Set<docId>>.
 * Khoá dạng của app: quét mỗi tài liệu một lượt tìm mọi chuỗi có dạng khoá rồi tra bảng (dò từng khoá qua từng tài liệu
 * là O(tài liệu × ảnh): máy mới 1000 tài liệu, 2000 ảnh mất 3 giây, khựng trang). Khoá khác dạng (gói chia sẻ mang
 * nguyên văn, tài liệu mẫu) thì dò như cũ.
 */
function blobOwners(snapshotRecords, blobKeys) {
  const owners = new Map(blobKeys.map((k) => [k, new Set()]));
  const khacDang = blobKeys.filter((k) => !laDangKhoa(k));
  for (const snap of snapshotRecords) {
    if (!snap.bin || !snap.bin.length) continue;
    const text = u8ToBinaryString(snap.bin);
    for (const [k] of text.matchAll(DANG_KHOA)) owners.get(k)?.add(snap.docId);
    for (const key of khacDang) {
      if (text.includes(key)) owners.get(key).add(snap.docId);
    }
  }
  return owners;
}

/** Trong owners, khoá nào chỉ được (các) tài liệu trong idSet tham chiếu. */
function blobKeysDocQuyen(owners, idSet) {
  const ket = new Set();
  for (const [key, ownerSet] of owners) {
    if (ownerSet.size && [...ownerSet].every((d) => idSet.has(d))) ket.add(key);
  }
  return ket;
}

function readSchema(db) {
  return [...db.objectStoreNames].map((n) => {
    const os = db.transaction(n, 'readonly').objectStore(n);
    return {
      name: n,
      keyPath: os.keyPath,
      autoIncrement: os.autoIncrement,
      indexes: [...os.indexNames].map((i) => {
        const ix = os.index(i);
        return { name: i, keyPath: ix.keyPath, unique: ix.unique, multiEntry: ix.multiEntry };
      }),
    };
  });
}

// kemAnh: chỉ bản sao lưu của máy chưa từng đồng bộ mang cả dữ liệu ảnh (blobData): đó là đường duy nhất restore xoá
// workspace trên máy (thayThe bỏ workspace mẫu), còn ảnh của máy đó chưa từng đẩy lên Drive. true: mọi workspace;
// danh sách id: chỉ các workspace đó (những workspace sắp bị bỏ).
// maHoa false: bản ghi để nguyên (Uint8Array, Date), cho lượt lưu lấy vân tay mà khỏi mã hoá cả máy (3/4 thời gian xuất);
// chỉ mã hoá (maHoa) khi thật sự tải lên.
export async function exportAll({ kemAnh = false, maHoa = true } = {}) {
  const workspaces = [];
  // Rỗng thì mọi điều kiện taiLieuMauSet.size bên dưới đều false — hành vi
  // giống hệt trước khi có tính năng này, không đọc thêm, không lọc thêm gì.
  const taiLieuMauSet = new Set(CONFIG.taiLieuMauIds);
  for (const id of workspaceIds()) {
    const name = dbName(id);
    if (!(await dbExists(name))) continue; // id mồ côi: bỏ qua, KHÔNG tạo DB rỗng
    const db = await req(indexedDB.open(name));
    try {
      const stores = {};
      let boQuaBlobKeys = null; // chỉ tính khi có tài liệu mẫu trong workspace này
      // Đọc mọi store trong MỘT transaction chỉ đọc để có một ảnh chụp nhất quán. Đọc từng store riêng
      // thì kho lưu trữ có thể gộp update vào snapshot giữa hai lần đọc: một tài liệu mới vắng mặt ở cả hai,
      // và lần lưu tưởng số tài liệu ít đi.
      const kem = Array.isArray(kemAnh) ? kemAnh.includes(id) : !!kemAnh;
      const names = (kem ? [...CONFIG.syncStores, 'blobData'] : CONFIG.syncStores).filter((n) => db.objectStoreNames.contains(n));
      const raw = {};
      if (names.length) {
        const tx = db.transaction(names, 'readonly');
        const all = await Promise.all(names.map((n) => req(tx.objectStore(n).getAll())));
        names.forEach((n, i) => { raw[n] = all[i]; });
      }
      for (const storeName of names) {
        let values = raw[storeName];
        if (taiLieuMauSet.size && storeName === 'snapshots') {
          // Phải tính owners TRƯỚC khi lọc: bytes của chính tài liệu mẫu là nơi
          // chứa khoá blob mà nó tham chiếu.
          if (db.objectStoreNames.contains('blobs')) {
            const allBlobs = raw.blobs; // 'blobs' nằm trong CONFIG.syncStores nên đã đọc cùng transaction
            const owners = blobOwners(values, allBlobs.map((b) => b.key));
            boQuaBlobKeys = blobKeysDocQuyen(owners, taiLieuMauSet);
          } else {
            boQuaBlobKeys = new Set();
          }
          values = values.filter((v) => !taiLieuMauSet.has(v.docId));
        } else if (boQuaBlobKeys && boQuaBlobKeys.size && (storeName === 'blobs' || storeName === 'blobData')) {
          values = values.filter((v) => !boQuaBlobKeys.has(v.key));
        }
        stores[storeName] = maHoa ? values.map(encode) : values;
      }
      const payload = {
        id,
        version: db.version,
        info: localStorage.getItem(LS.workspaceInfo(id)),
        schema: readSchema(db),
        stores,
      };
      workspaces.push(payload);
    } finally {
      db.close();
    }
  }
  return {
    format: 'bstr-drive-sync/1',
    savedAt: new Date().toISOString(),
    deviceId: deviceId(),
    workspaces,
  };
}

async function dbExists(name) {
  const list = await indexedDB.databases();
  return list.some((d) => d.name === name);
}

/**
 * Gói các tài liệu mẫu (ids) cùng những blob CHỈ chúng dùng thành dữ liệu có
 * thể ghi thẳng lại vào IndexedDB sau này (xem boSungTaiLieuMau). Quét TOÀN BỘ
 * snapshot của workspace (không chỉ ids) để biết blob nào còn bị tài liệu khác
 * tham chiếu — lấy nhầm chiều này sẽ âm thầm rút ảnh khỏi tài liệu thật.
 */
export async function taiLieuMauBundle(ids) {
  const idSet = new Set(ids);
  const banGhi = { snapshots: [], blobs: [], blobData: [] };
  const anhXa = []; // [{docId, size, blobKeys}]
  const giuLai = []; // [{blobKey, docIds}] — dùng chung nên KHÔNG gói

  for (const wsId of workspaceIds()) {
    const name = dbName(wsId);
    if (!(await dbExists(name))) continue;
    const db = await req(indexedDB.open(name));
    try {
      if (!db.objectStoreNames.contains('snapshots')) continue;
      const allSnaps = await req(db.transaction('snapshots', 'readonly').objectStore('snapshots').getAll());
      const wanted = allSnaps.filter((s) => idSet.has(s.docId));
      if (!wanted.length) continue;

      const allBlobs = db.objectStoreNames.contains('blobs')
        ? await req(db.transaction('blobs', 'readonly').objectStore('blobs').getAll()) : [];
      const allBlobData = db.objectStoreNames.contains('blobData')
        ? await req(db.transaction('blobData', 'readonly').objectStore('blobData').getAll()) : [];
      const owners = blobOwners(allSnaps, allBlobs.map((b) => b.key));
      const doiTuong = blobKeysDocQuyen(owners, idSet);
      for (const [key, ownerSet] of owners) {
        if (doiTuong.has(key) || !ownerSet.size) continue;
        if ([...ownerSet].some((d) => idSet.has(d))) {
          giuLai.push({ blobKey: key, docIds: [...ownerSet] });
        }
      }

      for (const s of wanted) {
        anhXa.push({
          docId: s.docId,
          size: s.bin ? s.bin.length : 0,
          blobKeys: [...doiTuong].filter((k) => owners.get(k).has(s.docId)),
        });
      }
      banGhi.snapshots.push(...wanted.map(encode));
      banGhi.blobs.push(...allBlobs.filter((b) => doiTuong.has(b.key)).map(encode));
      banGhi.blobData.push(...allBlobData.filter((b) => doiTuong.has(b.key)).map(encode));
    } finally {
      db.close();
    }
  }

  return { banGhi, anhXa, giuLai };
}

function createDb(name, version, schema) {
  return new Promise((res, rej) => {
    const q = indexedDB.open(name, version);
    q.onupgradeneeded = () => {
      const db = q.result;
      for (const s of schema) {
        if (db.objectStoreNames.contains(s.name)) continue;
        const os = db.createObjectStore(s.name, { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
        for (const ix of s.indexes) {
          os.createIndex(ix.name, ix.keyPath, { unique: ix.unique, multiEntry: ix.multiEntry });
        }
      }
    };
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}

/**
 * Kế hoạch ghi một workspace của restore: { tên kho: { xoaHet, xoa: [khoá], ghi: [bản ghi] } }. Không có thayDoi (ghi cả bản) hay
 * workspace mới: xoá sạch rồi ghi cả; ảnh (blobData) chỉ thêm: khoá ảnh là băm nội dung nên giữ ảnh đang có không bao giờ sai,
 * xoá là mất ảnh chưa kịp đẩy lên Drive. Sau khi gộp (thayDoi của gopPayload): chỉ snapshot + clock của tài liệu đổi, xoá ĐÚNG
 * các update đã gộp vào snapshot, thêm ảnh lấy từ bên kia. Không xoá sạch kho nào: kho của app có thể đang gộp update của một
 * tài liệu không đổi (đọc, ghi snapshot, rồi xoá các update đã đọc) và xoá mất update ta vừa ghi lại; update app ghi sau lúc
 * xuất cũng còn nguyên.
 */
export function keHoachGhi(ws, thayDoi) {
  const s = ws.stores;
  if (!thayDoi || thayDoi.moi) return Object.fromEntries(Object.keys(s).map((ten) => [ten, { xoaHet: ten !== 'blobData', xoa: [], ghi: s[ten] }]));
  const doi = new Set(thayDoi.taiLieu);
  const ke = {};
  for (const ten of ['snapshots', 'clocks']) if (s[ten]) ke[ten] = { xoaHet: false, xoa: [], ghi: s[ten].filter((r) => doi.has(r.docId)) };
  if (thayDoi.boCapNhat.length) ke.updates = { xoaHet: false, xoa: thayDoi.boCapNhat.map((u) => [u.docId, u.createdAt]), ghi: [] };
  for (const [ten, ds] of Object.entries(thayDoi.anh)) ke[ten] = { xoaHet: false, xoa: [], ghi: ds };
  return ke;
}

async function writeWorkspace(ws, thayDoi) {
  const name = dbName(ws.id);
  const ke = keHoachGhi(ws, thayDoi);
  const names = Object.keys(ke);
  if (!names.length) return;
  const db = await req(indexedDB.open(name));
  try {
    const missing = names.filter((n) => !db.objectStoreNames.contains(n));
    if (missing.length) {
      throw new Error(`Cơ sở dữ liệu ${name} thiếu store: ${missing.join(', ')}`);
    }
    const tx = db.transaction(names, 'readwrite');
    const finished = txDone(tx);
    try {
      for (const [storeName, { xoaHet, xoa, ghi }] of Object.entries(ke)) {
        const os = tx.objectStore(storeName);
        if (xoaHet) os.clear();
        for (const khoa of xoa) os.delete(decode(khoa));
        for (const rec of ghi) os.put(decode(rec));
      }
    } catch (error) {
      tx.abort();
      await finished.catch(()=>{});
      throw error;
    }
    await finished;
  } finally {
    db.close();
  }
}

/**
 * writeWorkspace vừa os.clear() rồi ghi lại đúng những gì có trong payload —
 * nếu payload này tới từ exportAll() đã lược bớt tài liệu mẫu thì chúng biến
 * mất khỏi IndexedDB. Bù lại từ gói tĩnh drive-sync/tai-lieu-mau.json. KHÔNG
 * BAO GIỜ được làm hỏng lần phục hồi vì việc này — tài liệu thật của người
 * dùng quan trọng hơn hai tài liệu mẫu, nên mọi lỗi ở đây chỉ log rồi bỏ qua.
 */
async function boSungTaiLieuMau(wsId) {
  const ids = CONFIG.taiLieuMauIds;
  if (!ids.length) return;
  const name = dbName(wsId);
  try {
    if (!(await dbExists(name))) return;
    const db = await req(indexedDB.open(name));
    try {
      if (!db.objectStoreNames.contains('snapshots')) return;
      const co = new Set(
        (await req(db.transaction('snapshots', 'readonly').objectStore('snapshots').getAll()))
          .map((s) => s.docId)
      );
      const thieu = ids.filter((id) => !co.has(id));
      if (!thieu.length) return;

      let bundle;
      try {
        const res = await fetch('/drive-sync/tai-lieu-mau.json');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        bundle = await res.json();
      } catch (e) {
        console.warn('[drive-sync] không đọc được drive-sync/tai-lieu-mau.json — bỏ qua bù tài liệu mẫu', e);
        return;
      }

      const names = ['snapshots', 'blobs', 'blobData'].filter(
        (n) => bundle[n]?.length && db.objectStoreNames.contains(n)
      );
      if (!names.length) return;
      const thieuSet = new Set(thieu);
      const prepared = Object.fromEntries(names.map(n=>[n,bundle[n].map(decode)]));
      if (prepared.snapshots) prepared.snapshots=prepared.snapshots.filter(r=>thieuSet.has(r.docId)).map(r=>({...r,bin:convertDocumentUpdate(r.bin).bytes}));
      const tx = db.transaction(names, 'readwrite');
      const finished = txDone(tx);
      try {
        if (names.includes('snapshots')) {
          const os = tx.objectStore('snapshots');
          for (const rec of prepared.snapshots) os.put(rec);
        }
        for (const storeName of ['blobs', 'blobData']) {
          if (!names.includes(storeName)) continue;
          const os = tx.objectStore(storeName);
          for (const rec of prepared[storeName]) os.put(rec);
        }
      } catch (error) { tx.abort(); await finished.catch(()=>{}); throw error; }
      await finished;
      console.info(`[drive-sync] đã bù ${thieu.length} tài liệu mẫu còn thiếu: ${thieu.join(', ')}`);
    } finally {
      db.close();
    }
  } catch (e) {
    console.warn('[drive-sync] bù tài liệu mẫu thất bại — bỏ qua, tài liệu thật không bị ảnh hưởng', e);
  }
}

/**
 * Kiểm tra toàn bộ đầu vào trước khi ghi. Mỗi workspace có một
 * giao dịch riêng; lỗi hệ thống khi ghi workspace sau vẫn có thể xảy ra sau
 * khi workspace trước đã hoàn tất. Báo rõ vị trí lỗi để có thể phục hồi lại.
 */
export async function prepareRestore(payload) {
  // Validate EVERY workspace before creating a DB or clearing data.
  try {
    payload = prepareBackup(payload, { maHoa: false }).payload; // đã giải mã: decode ở dưới để nguyên, không giải mã lại
    for (const ws of payload.workspaces) await validateRestoreTarget(ws);
  } catch (error) {
    if (error.code === 'BSTR_BACKUP_INVALID') throw error;
    const invalid = new Error(`Bản sao lưu không hợp lệ: ${error.message}`, { cause: error });
    invalid.code = 'BSTR_BACKUP_INVALID';
    throw invalid;
  }
  return payload;
}

/**
 * Danh sách workspace sau khi phục hồi: HỢP nhất (xem restore), trừ các workspace trong boDuoc. Mỗi trình duyệt
 * mới tự tạo một "Không gian làm việc mẫu" mã ngẫu nhiên; hợp nhất nó với bản Drive thì máy có hai không gian cùng
 * tên và lần lưu sau đẩy cả hai lên Drive (27/09). Workspace của bản Drive không bao giờ bị bỏ.
 */
export function danhSachSauKhoiPhuc(dangCo, tuDrive, boDuoc = []) {
  const bo = dangCo.filter((id) => boDuoc.includes(id) && !tuDrive.includes(id));
  return { giu: dangCo.filter((id) => !bo.includes(id)).concat(tuDrive.filter((id) => !dangCo.includes(id))), bo };
}

/** Tiêu đề các tài liệu mẫu app tự tạo trong "Không gian làm việc mẫu" (so sau khi bỏ khoảng trắng hai đầu). */
const TIEU_DE_MAU = new Set(['Bắt đầu sử dụng', 'Cách sử dụng Thư mục và Thẻ']);

/**
 * Chỉ có tài liệu mẫu: mọi dòng meta.pages mang tiêu đề mẫu. KHÔNG dùng updatedDate: app tự mở "Bắt đầu sử dụng"
 * ngay khi tạo workspace nên nó có updatedDate dù chưa ai sửa (đo 27/09).
 * ponytail: sửa nội dung một tài liệu mẫu mà giữ nguyên tiêu đề thì vẫn tính là mẫu; phần sửa đó chỉ còn trong
 * bản sao lưu chụp trước khi ghi đè. Muốn chặt hơn thì so nội dung với bản mẫu gốc.
 */
export const chiCoTaiLieuMau = (pages) =>
  Array.isArray(pages) && pages.every((p) => TIEU_DE_MAU.has(String(p?.title ?? '').trim()));

let napYjs = null;
/** Workspace trên máy chỉ chứa tài liệu mẫu? Đọc hỏng thì trả false: không chắc thì giữ lại. */
export async function laKhongGianMau(wsId) {
  try {
    if (!(await dbExists(dbName(wsId)))) return false; // indexedDB.open sẽ tạo DB rỗng cho id mồ côi
    const Y = await (napYjs ||= import('./vendor/yjs-gop.mjs'));
    const db = await req(indexedDB.open(dbName(wsId)));
    let bins;
    try { bins = await binsCuaDoc(db, wsId); } finally { db.close(); }
    if (!bins?.length) return false;
    const d = new Y.Doc();
    try {
      Y.applyUpdate(d, convertDocumentUpdate(bins.length === 1 ? bins[0] : Y.mergeUpdates(bins)).bytes);
      return chiCoTaiLieuMau(d.getMap('meta').get('pages')?.toJSON());
    } finally { d.destroy(); }
  } catch (e) {
    console.warn(`[drive-sync] không đọc được workspace ${wsId}, giữ lại`, e);
    return false;
  }
}

/**
 * thayThe: máy CHƯA TỪNG đồng bộ chọn "Lấy bản trên Drive". Workspace chỉ có trên máy mà chỉ chứa tài liệu mẫu thì
 * bỏ; workspace có tài liệu người dùng tự viết thì giữ và hợp nhất như thường. Workspace bị bỏ đã nằm trong bản sao
 * lưu chụp trước khi ghi đè (saoLuuTruocKhiGhiDe).
 */
/** thayDoi (sau khi gộp, của gopPayload): chỉ ghi phần đã đổi (keHoachGhi); workspace không có mặt trong đó thì không ghi gì. */
export async function restore(payload, { thayThe = false, thayDoi = null } = {}) {
  payload = await prepareRestore(payload);
  const tuDrive = payload.workspaces.map((w) => w.id);
  // Đọc TRƯỚC khi ghi: workspace chỉ có trên máy không bị restore đụng tới, nhưng đọc sớm cho chắc.
  const boDuoc = [];
  if (thayThe) {
    for (const id of workspaceIds()) if (!tuDrive.includes(id) && await laKhongGianMau(id)) boDuoc.push(id);
  }
  const tong = payload.workspaces.length;
  let xong = 0;
  for (const ws of payload.workspaces) {
    const name = dbName(ws.id);
    const doiWs = thayDoi ? thayDoi[ws.id] : null;
    if (thayDoi && !doiWs) { xong++; continue; } // gộp mà workspace này không đổi gì: không ghi
    try {
      const taoMoi = !(await dbExists(name));
      if (taoMoi) {
        if (!ws.schema || !ws.schema.length) {
          throw new Error('bản sao lưu không kèm schema — không dựng lại được trên máy trắng');
        }
        const fresh = await createDb(name, ws.version || 3, ws.schema);
        fresh.close();
      }
      await writeWorkspace(ws, taoMoi ? null : doiWs);
      if (!doiWs || taoMoi) await boSungTaiLieuMau(ws.id); // chỉ sau khi xoá sạch rồi ghi cả; tự bắt lỗi bên trong
      await migrateDatabase(name);
    } catch (e) {
      throw new Error(
        `Phục hồi hỏng ở workspace ${ws.id} (đã xong ${xong}/${tong}): ${e?.message || e}`
      );
    }
    xong++;
  }
  // Chỉ ghi localStorage SAU khi dữ liệu đã nằm an toàn trong IndexedDB,
  // để lỡ hỏng giữa chừng app không trỏ vào một workspace rỗng.
  // HỢP nhất chứ không thay thế: một workspace chỉ có trên máy này và chưa từng
  // được đồng bộ vẫn phải còn trong danh sách, nếu không nó biến mất khỏi thanh bên
  // và người dùng không kỹ thuật không còn đường nào mở lại.
  const { giu, bo } = danhSachSauKhoiPhuc(workspaceIds(), tuDrive, boDuoc);
  localStorage.setItem(LS.workspaceList, JSON.stringify(giu));
  for (const ws of payload.workspaces) {
    if (ws.info) localStorage.setItem(LS.workspaceInfo(ws.id), ws.info);
  }
  // Danh sách đã đúng trước khi xoá: lỡ xoá hỏng thì chỉ sót một DB mồ côi ngoài danh sách, không ai mở tới.
  // KHÔNG chờ: app đang mở chính DB này nên lệnh xoá bị chặn (onblocked) tới khi trang tải lại đóng kết nối.
  for (const id of bo) {
    localStorage.removeItem(LS.workspaceInfo(id));
    indexedDB.deleteDatabase(dbName(id)).onerror = (e) => console.warn(`[drive-sync] chưa xoá được workspace cũ ${id}`, e);
  }
  return { giu, bo };
}

async function validateRestoreTarget(ws) {
  let schema = ws.schema;
  if (await dbExists(dbName(ws.id))) {
    const opening=indexedDB.open(dbName(ws.id));
    opening.onupgradeneeded=()=>opening.transaction.abort();
    const db = await req(opening);
    try { schema = readSchema(db); } finally { db.close(); }
  }
  if (!Array.isArray(schema) || !schema.length) throw new Error('Bản sao lưu không có schema để khôi phục');
  const keyAt = (record,keyPath) => Array.isArray(keyPath) ? keyPath.map(k=>keyAt(record,k)) : keyPath.split('.').reduce((v,k)=>v && Object.hasOwn(v,k)?v[k]:undefined,record);
  const keyToken = key => JSON.stringify(encode(key));
  for (const [name,values] of Object.entries(ws.stores)) {
    const spec = schema.find(s=>s.name===name);
    if (!spec) throw new Error(`Cơ sở dữ liệu thiếu kho ${name}`);
    // Out-of-line keys cannot be reconstructed from getAll() exports.
    if (spec.keyPath===null) {
      if (values.length) throw new Error(`Kho ${name} không có khóa trong bản ghi`);
      continue;
    }
    const primary = new Set(), unique = new Map((spec.indexes||[]).filter(i=>i.unique).map(i=>[i.name,new Set()]));
    for (const value of values) {
      const record=decode(value),key=keyAt(record,spec.keyPath);
      if (key!==undefined || !spec.autoIncrement) {
        indexedDB.cmp(key,key);
        const token=keyToken(key);
        if (primary.has(token)) throw new Error(`Trùng khóa trong kho ${name}`);
        primary.add(token);
      }
      for (const index of spec.indexes||[]) {
        if (!index.unique) continue;
        const key=keyAt(record,index.keyPath),keys=index.multiEntry && Array.isArray(key)?key:[key];
        const local=new Set();
        for (const item of keys) {
          try { indexedDB.cmp(item,item); } catch { continue; }
          const token=keyToken(item);
          if (local.has(token)) continue;
          if (unique.get(index.name).has(token)) throw new Error(`Trùng chỉ mục ${index.name} trong kho ${name}`);
          local.add(token); unique.get(index.name).add(token);
        }
      }
    }
  }
}

// ─────────────────────────── Chia sẻ một tài liệu ───────────────────────────
// Các thao tác ghi bên dưới dùng dữ liệu đã kiểm tra tại lớp kiểm tra đầu
// vào; Yjs được dùng chung với bước kiểm tra dữ liệu khi khởi động.

/** Những khoá blob xuất hiện dạng chuỗi con trong bất kỳ mảng bytes nào đã cho. */
function blobKeysTrongBytes(bins, blobKeys) {
  const thay = new Set();
  for (const bin of bins) {
    if (!bin || !bin.length) continue;
    const text = u8ToBinaryString(bin);
    for (const key of blobKeys) if (text.includes(key)) thay.add(key);
  }
  return thay;
}

/**
 * MỌI bytes hiện có của một tài liệu: snapshot ĐÃ GỘP cộng các bản `updates`
 * chưa được gộp vào snapshot. Chỉ lấy snapshot là thiếu — sửa đổi vừa gõ xong
 * còn nằm nguyên trong `updates`, và với tài liệu gốc (root) thì bỏ sót chúng
 * đồng nghĩa xoá mất tài liệu người khác vừa tạo.
 */
async function binsCuaDoc(db, docId) {
  const bins = [];
  if (db.objectStoreNames.contains('snapshots')) {
    const s = await req(db.transaction('snapshots', 'readonly').objectStore('snapshots').get(docId));
    if (s?.bin?.length) bins.push(s.bin);
  }
  if (db.objectStoreNames.contains('updates')) {
    const os = db.transaction('updates', 'readonly').objectStore('updates');
    const ups = await req(os.index('docId').getAll(docId));
    for (const u of ups) if (u?.bin?.length) bins.push(u.bin);
  }
  return bins;
}

/** Workspace nào đang giữ tài liệu này (có bản ghi snapshots.docId). */
async function timWorkspace(docId) {
  for (const wsId of workspaceIds()) {
    const name = dbName(wsId);
    if (!(await dbExists(name))) continue;
    const db = await req(indexedDB.open(name));
    try {
      if (!db.objectStoreNames.contains('snapshots')) continue;
      if (await req(db.transaction('snapshots', 'readonly').objectStore('snapshots').get(docId))) {
        return wsId;
      }
    } finally {
      db.close();
    }
  }
  return null;
}

/**
 * Workspace đích để nhận tài liệu: workspace có snapshot của CHÍNH nó (tài liệu
 * gốc). Không có tài liệu gốc thì không có `meta.pages` để ghi vào, nên tuyệt
 * đối không được đoán bừa lấy workspace đầu danh sách.
 */
export async function wsNhan(docId = null) {
  const hopLe = [];
  for (const wsId of workspaceIds()) {
    if (await timWorkspace(wsId) === wsId) hopLe.push(wsId);
  }
  // Cập nhật lại một tài liệu đã nhận trước đó phải rơi đúng workspace đang giữ nó,
  // không phải workspace đầu danh sách — nếu không sẽ sinh ra bản thứ hai.
  if (docId) {
    const dangGiu = await timWorkspace(docId);
    if (dangGiu && hopLe.includes(dangGiu)) return dangGiu;
  }
  return hopLe[0] || null;
}

/** Bytes của một tài liệu trong workspace (mặc định tài liệu gốc) — snapshot + updates. */
export async function binsTaiLieu(wsId, docId = wsId) {
  const db = await req(indexedDB.open(dbName(wsId)));
  try { return await binsCuaDoc(db, docId); } finally { db.close(); }
}

/**
 * Nguyên liệu để đóng gói chia sẻ: bytes của tài liệu, bytes tài liệu gốc, và
 * các blob mà tài liệu này tham chiếu. Ở đây lấy MỌI blob tài liệu dùng (kể cả
 * blob dùng chung với tài liệu khác) — người nhận cần đủ ảnh để mở, còn máy
 * mình không mất gì vì đây chỉ là đọc.
 */
export async function nguonChiaSe(docId) {
  const wsId = await timWorkspace(docId);
  if (!wsId) throw new Error(`Không tìm thấy tài liệu ${docId} trên máy này`);
  const db = await req(indexedDB.open(dbName(wsId)));
  try {
    const bins = await binsCuaDoc(db, docId);
    if (!bins.length) throw new Error(`Tài liệu ${docId} không có dữ liệu để chia sẻ`);
    const rBins = await binsCuaDoc(db, wsId);
    if (!rBins.length) throw new Error(`Workspace ${wsId} không có tài liệu gốc — dừng`);

    const allBlobs = db.objectStoreNames.contains('blobs')
      ? await req(db.transaction('blobs', 'readonly').objectStore('blobs').getAll()) : [];
    const keys = blobKeysTrongBytes(bins, allBlobs.map((b) => b.key));
    const allBlobData = db.objectStoreNames.contains('blobData')
      ? await req(db.transaction('blobData', 'readonly').objectStore('blobData').getAll()) : [];

    return {
      wsId,
      bins,
      rootBins: rBins,
      blobKeys: [...keys],
      blobs: allBlobs.filter((b) => keys.has(b.key)).map(encode),
      blobData: allBlobData.filter((b) => keys.has(b.key)).map(encode),
    };
  } finally {
    db.close();
  }
}

/**
 * Ghi tài liệu nhận được vào IndexedDB trong MỘT giao dịch: snapshot tài liệu,
 * snapshot tài liệu gốc đã sửa, các blob kèm theo.
 *
 * Tài liệu mới: ghi snapshot, `updates` sót lại của id này bị xoá.
 * Nhận lại bản đã nhận (`gop`): snapshotBin là bản trên máy đã gộp bản người gửi. Ghi nó thành MỘT update mới, không
 * đụng snapshot hay update đang có: phần gõ thêm trên máy giữa lúc đọc và lúc ghi vẫn còn, lần mở sau app gộp tất cả.
 * Tài liệu GỐC: rootBin (đã gộp snapshot + updates lúc đọc) thêm thành MỘT update, không ghi đè snapshot: giữa lúc đọc và lúc
 * ghi (có sao lưu lên Drive), kho của app có thể đã gộp update của bản gốc vào snapshot — dòng tài liệu vừa tạo — rồi xoá update
 * đó; ghi đè bằng bản đọc từ trước là mất dòng ấy. Gộp lại phần đã biết là vô hại trong Yjs.
 */
export async function ghiTaiLieuNhan(wsId, { docId, snapshotBin, rootBin, gop = false, blobs = [], blobData = [] }) {
  const decodedBlobs=blobs.map(decode),decodedBlobData=blobData.map(decode);
  const db = await req(indexedDB.open(dbName(wsId)));
  try {
    const can = ['snapshots', 'updates', 'clocks', 'blobs', 'blobData']
      .filter((n) => db.objectStoreNames.contains(n));
    if (!can.includes('snapshots')) throw new Error(`Cơ sở dữ liệu ${dbName(wsId)} thiếu store snapshots`);
    const now = new Date();

    const snapOs0 = db.transaction('snapshots', 'readonly').objectStore('snapshots');
    const cuTaiLieu = await req(snapOs0.get(docId));
    const cuRoot = await req(db.transaction('snapshots', 'readonly').objectStore('snapshots').get(wsId));

    // Kho không có `updates`: bản gộp (đã chứa snapshot trên máy) ghi đè snapshot như tài liệu mới.
    const themUpdate = gop && can.includes('updates');
    const cuUpdates = can.includes('updates') && !themUpdate
      ? await req(db.transaction('updates', 'readonly').objectStore('updates').index('docId').getAll(docId))
      : [];

    const tx = db.transaction(can, 'readwrite');
    const finished = txDone(tx);
    try {
    const snaps = tx.objectStore('snapshots');
    if (!themUpdate) snaps.put({ docId, bin: snapshotBin, createdAt: cuTaiLieu?.createdAt || now, updatedAt: now });
    if (can.includes('updates')) {
      const ups = tx.objectStore('updates');
      // add, không put: trùng khoá [docId, createdAt] với update của app thì huỷ cả giao dịch, không ghi đè update đó.
      if (themUpdate) ups.add({ docId, bin: snapshotBin, createdAt: now });
      for (const u of cuUpdates) ups.delete([u.docId, u.createdAt]);
      ups.add({ docId: wsId, bin: rootBin, createdAt: now });
    } else snaps.put({ docId: wsId, bin: rootBin, createdAt: cuRoot?.createdAt || now, updatedAt: now });
    if (can.includes('clocks')) {
      const cl = tx.objectStore('clocks');
      cl.put({ docId, timestamp: now });
      cl.put({ docId: wsId, timestamp: now });
    }
    if (can.includes('blobs')) {
      const os = tx.objectStore('blobs');
      for (const rec of decodedBlobs) os.put(rec);
    }
    if (can.includes('blobData')) {
      const os = tx.objectStore('blobData');
      for (const rec of decodedBlobData) os.put(rec);
    }
    } catch (error) { tx.abort(); await finished.catch(()=>{}); throw error; }
    await finished;
    return { wsId, docId, daXoaUpdates: cuUpdates.length, daCoSan: !!cuTaiLieu, gop: themUpdate };
  } finally {
    db.close();
  }
}

// ─────────────────────────── Ảnh (tự gộp đợt 2) ───────────────────────────
// Dữ liệu ảnh (blobData) không đi trong bản lưu: anh.js đẩy từng ảnh lên Drive thành tệp riêng và tải về ảnh còn thiếu.

/**
 * Đọc các kho trong MỘT giao dịch chỉ đọc (ảnh chụp nhất quán: ảnh ghi giữa hai lần đọc không bị báo thiếu hay mất mime).
 * can: { tên kho: 'getAll' | 'getAllKeys' }. Trả { tên kho: mọi bản ghi hay mọi khoá }; không có kho thì mảng rỗng.
 */
async function tatCa(db, can) {
  const co = Object.keys(can).filter((ten) => db.objectStoreNames.contains(ten));
  const tx = co.length ? db.transaction(co, 'readonly') : null;
  const ra = await Promise.all(Object.entries(can).map(([ten, cach]) => (co.includes(ten) ? req(tx.objectStore(ten)[cach]()) : [])));
  return Object.fromEntries(Object.keys(can).map((ten, i) => [ten, ra[i]]));
}

/** Ảnh máy này có dữ liệu: [{ wsId, key, mime }]. Chỉ đọc khoá của blobData, không đọc byte ảnh. */
export async function anhCoDuLieu() {
  const ra = [];
  for (const wsId of workspaceIds()) {
    if (!(await dbExists(dbName(wsId)))) continue;
    const db = await req(indexedDB.open(dbName(wsId)));
    try {
      const { blobs, blobData } = await tatCa(db, { blobs: 'getAll', blobData: 'getAllKeys' });
      const mime = new Map(blobs.map((b) => [b.key, b.mime || '']));
      for (const key of blobData) ra.push({ wsId, key, mime: mime.get(key) || '' });
    } finally {
      db.close();
    }
  }
  return ra;
}

/** Byte gốc của một ảnh trên máy; không có thì null. */
export async function docAnh(wsId, key) {
  if (!(await dbExists(dbName(wsId)))) return null; // indexedDB.open sẽ tạo DB rỗng cho id mồ côi
  const db = await req(indexedDB.open(dbName(wsId)));
  try {
    if (!db.objectStoreNames.contains('blobData')) return null;
    const r = await req(db.transaction('blobData', 'readonly').objectStore('blobData').get(key));
    return r?.data ? new Uint8Array(r.data) : null;
  } finally {
    db.close();
  }
}

/** Ghi byte một ảnh vừa tải về. Máy đã có ảnh này thì để nguyên (cùng khoá là cùng nội dung). Trả true nếu vừa ghi. */
export async function ghiAnh(wsId, key, bytes) {
  if (!(await dbExists(dbName(wsId)))) return false;
  const db = await req(indexedDB.open(dbName(wsId)));
  try {
    if (!db.objectStoreNames.contains('blobData')) return false;
    const tx = db.transaction('blobData', 'readwrite');
    const finished = txDone(tx);
    finished.catch(() => {}); // getKey hỏng thì lỗi đi ra từ getKey; giao dịch bị huỷ theo không thành lời hứa bị bỏ rơi
    const os = tx.objectStore('blobData');
    const daCo = (await req(os.getKey(key))) !== undefined;
    if (!daCo) os.put({ key, data: bytes });
    await finished;
    return !daCo;
  } finally {
    db.close();
  }
}

/**
 * Ảnh máy này cần mà chưa có dữ liệu: bản ghi blobs chưa đánh dấu xoá mà blobData không có. Kèm tài liệu nhắc tới ảnh
 * (quét snapshot như blobOwners) và lần sửa gần nhất của các tài liệu đó, để anh.js xếp thứ tự tải.
 * blobs và khoá blobData đọc chung một giao dịch (ảnh ghi giữa hai lần đọc không bị báo thiếu). snapshots chỉ đọc khi có
 * ảnh thiếu (mọi lần mở app đều gọi; đọc hết tài liệu tốn như một lượt lưu), giao dịch riêng: chỉ để biết tài liệu nào
 * nhắc tới ảnh và thứ tự tải, không đổi số ảnh thiếu. Quét O(số tài liệu × số ảnh thiếu) như blobOwners.
 */
export async function anhThieu() {
  const ra = [];
  for (const wsId of workspaceIds()) {
    if (!(await dbExists(dbName(wsId)))) continue;
    const db = await req(indexedDB.open(dbName(wsId)));
    try {
      const { blobs, blobData } = await tatCa(db, { blobs: 'getAll', blobData: 'getAllKeys' });
      const co = new Set(blobData);
      const thieu = blobs.filter((b) => !b.deletedAt && !co.has(b.key)).map((b) => b.key);
      if (!thieu.length) continue;
      const { snapshots: snaps } = await tatCa(db, { snapshots: 'getAll' });
      const owners = blobOwners(snaps, thieu);
      const luc = new Map(snaps.map((s) => [s.docId, +new Date(s.updatedAt || s.createdAt || 0)]));
      for (const key of thieu) {
        const docIds = [...owners.get(key)];
        ra.push({ wsId, key, docIds, moiNhat: docIds.length ? Math.max(...docIds.map((d) => luc.get(d) || 0)) : null });
      }
    } finally {
      db.close();
    }
  }
  return ra;
}

/** encode/decode nhị phân <-> JSON — share.js dùng chung, không viết lại. */
export { encode as maHoa, decode as giaiMa };

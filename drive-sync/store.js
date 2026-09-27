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

/**
 * blobKey xuất hiện dạng chuỗi con trong bytes snapshot Yjs của tài liệu nào
 * thì coi tài liệu đó "sở hữu" blob ấy — khoá blob là chuỗi ngẫu nhiên dài nên
 * gần như không thể trùng tình cờ. Trả về Map<blobKey, Set<docId>>.
 * ponytail: quét O(số tài liệu × số blob) bằng String#includes — ổn với vài
 * chục tài liệu mẫu; workspace phình to hàng nghìn tài liệu thì đổi sang
 * Aho-Corasick quét một lượt.
 */
function blobOwners(snapshotRecords, blobKeys) {
  const owners = new Map(blobKeys.map((k) => [k, new Set()]));
  for (const snap of snapshotRecords) {
    if (!snap.bin || !snap.bin.length) continue;
    const text = u8ToBinaryString(snap.bin);
    for (const key of blobKeys) {
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

export async function exportAll() {
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
      const names = CONFIG.syncStores.filter((n) => db.objectStoreNames.contains(n));
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
        stores[storeName] = values.map(encode);
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

async function writeWorkspace(ws) {
  const name = dbName(ws.id);
  const db = await req(indexedDB.open(name));
  try {
    const names = Object.keys(ws.stores);
    const missing = names.filter((n) => !db.objectStoreNames.contains(n));
    if (missing.length) {
      throw new Error(`Cơ sở dữ liệu ${name} thiếu store: ${missing.join(', ')}`);
    }
    const tx = db.transaction(names, 'readwrite');
    const finished = txDone(tx);
    try {
      for (const storeName of names) {
        const os = tx.objectStore(storeName);
        os.clear();
        for (const rec of ws.stores[storeName]) os.put(decode(rec));
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
    payload = prepareBackup(payload).payload;
    for (const ws of payload.workspaces) await validateRestoreTarget(ws);
  } catch (error) {
    if (error.code === 'BSTR_BACKUP_INVALID') throw error;
    const invalid = new Error(`Bản sao lưu không hợp lệ: ${error.message}`, { cause: error });
    invalid.code = 'BSTR_BACKUP_INVALID';
    throw invalid;
  }
  return payload;
}

export async function restore(payload) {
  payload = await prepareRestore(payload);
  const tong = payload.workspaces.length;
  let xong = 0;
  for (const ws of payload.workspaces) {
    const name = dbName(ws.id);
    try {
      if (!(await dbExists(name))) {
        if (!ws.schema || !ws.schema.length) {
          throw new Error('bản sao lưu không kèm schema — không dựng lại được trên máy trắng');
        }
        const fresh = await createDb(name, ws.version || 3, ws.schema);
        fresh.close();
      }
      await writeWorkspace(ws);
      await boSungTaiLieuMau(ws.id); // tự bắt lỗi bên trong, không bao giờ ném ra đây
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
  const dangCo = workspaceIds();
  const hopNhat = dangCo.concat(
    payload.workspaces.map((w) => w.id).filter((id) => !dangCo.includes(id))
  );
  localStorage.setItem(LS.workspaceList, JSON.stringify(hopNhat));
  for (const ws of payload.workspaces) {
    if (ws.info) localStorage.setItem(LS.workspaceInfo(ws.id), ws.info);
  }
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

/** Bytes của tài liệu gốc (root) của một workspace — snapshot + updates. */
export async function rootBins(wsId) {
  const db = await req(indexedDB.open(dbName(wsId)));
  try { return await binsCuaDoc(db, wsId); } finally { db.close(); }
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
 * `updates` của riêng tài liệu nhận bị xoá: bản của người gửi phải thắng, nếu
 * để lại thì lần mở sau Yjs gộp bản sửa cũ của máy này đè lên nội dung vừa
 * nhận. `updates` của tài liệu GỐC thì giữ nguyên — rootBin đã gộp sẵn chúng
 * rồi, và gộp lại một update đã biết là vô hại trong Yjs.
 */
export async function ghiTaiLieuNhan(wsId, { docId, snapshotBin, rootBin, blobs = [], blobData = [] }) {
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

    const cuUpdates = can.includes('updates')
      ? await req(db.transaction('updates', 'readonly').objectStore('updates').index('docId').getAll(docId))
      : [];

    const tx = db.transaction(can, 'readwrite');
    const finished = txDone(tx);
    try {
    const snaps = tx.objectStore('snapshots');
    snaps.put({ docId, bin: snapshotBin, createdAt: cuTaiLieu?.createdAt || now, updatedAt: now });
    snaps.put({ docId: wsId, bin: rootBin, createdAt: cuRoot?.createdAt || now, updatedAt: now });
    if (can.includes('updates')) {
      const ups = tx.objectStore('updates');
      for (const u of cuUpdates) ups.delete([u.docId, u.createdAt]);
    }
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
    return { wsId, docId, daXoaUpdates: cuUpdates.length, daCoSan: !!cuTaiLieu };
  } finally {
    db.close();
  }
}

/** encode/decode nhị phân <-> JSON — share.js dùng chung, không viết lại. */
export { encode as maHoa, decode as giaiMa };

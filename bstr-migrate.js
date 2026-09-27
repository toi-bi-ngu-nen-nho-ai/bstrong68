// Kiểm tài liệu trong IndexedDB lúc mở app, trước khi mở tài liệu (xem bstr-compat.js). Tài liệu hợp lệ chỉ được đọc.
import { migrateUpdate } from './bstr-data.js';
// Nạp tĩnh, trước bundle: nạp sau thì Yjs thấy cờ của bản trong bundle và báo nhầm "already imported".
import * as Y from './drive-sync/vendor/yjs-gop.mjs';
const request = r => new Promise((resolve,reject) => { r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); });
const complete = tx => new Promise((resolve,reject) => { tx.oncomplete=resolve; tx.onabort=()=>reject(tx.error || new Error('Migration transaction aborted')); tx.onerror=()=>reject(tx.error); });
const open = (name, version, upgrade) => new Promise((resolve,reject) => {
  const r = indexedDB.open(name,version);
  r.onupgradeneeded = () => { if (upgrade) upgrade(r.result); else { r.transaction.abort(); reject(new Error('Database disappeared during migration')); } };
  r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error);
  r.onblocked=()=>reject(new Error('Đóng các tab cũ của ứng dụng rồi tải lại.'));
});
const byteEqual = (a,b) => a.length === b.length && a.every((v,i)=>v===b[i]);

// F5 nhanh hơn (25/09 tối): dấu của tài liệu đã qua kiểm (độ dài + mốc giờ từng bản ghi) cất trong sessionStorage,
// nên F5 cùng tab chỉ giải mã tài liệu đã đổi. Tab mới kiểm lại hết.
// Bản ghi nào thiếu mốc giờ thì tài liệu đó luôn được kiểm. Dấu chỉ ghi cho tài liệu không cần đổi gì.
const DAU = 'bstr-migrate:da-kiem';
const docDau = () => { try { return JSON.parse(sessionStorage.getItem(DAU)) || {}; } catch { return {}; } };
const ghiDau = dau => { try { sessionStorage.setItem(DAU, JSON.stringify(dau)); } catch {} };
const moc = r => { const t = r.updatedAt ?? r.createdAt; return t instanceof Date ? t.getTime() : t; };
const dauTaiLieu = records => records.every(r => moc(r) != null) ? records.map(r => `${r.bin.byteLength}@${moc(r)}`).join() : null;

export async function migrateDatabase(name) {
  const db = await open(name);
  let backup;
  const report = {database:name, documents:0, changes:0};
  try {
    if (!['snapshots','updates','clocks'].every(n=>db.objectStoreNames.contains(n))) return report;
    const readTx = db.transaction(['snapshots','updates'],'readonly');
    const [snapshots, updates] = await Promise.all(['snapshots','updates'].map(n=>request(readTx.objectStore(n).getAll())));
    const groups = new Map();
    for (const record of [...snapshots,...updates]) {
      if (!record.bin) continue;
      if (typeof record.docId !== 'string') throw new Error('Invalid document ID');
      if (!groups.has(record.docId)) groups.set(record.docId,[]);
      groups.get(record.docId).push(record);
    }
    // Giải mã và kiểm hết cả kho trước khi ghi. Luôn xét tài liệu đã gộp snapshot + mọi update.
    const tatCa = docDau(), cu = tatCa[name] || {}, moi = {}, planned = [];
    for (const [docId,records] of groups) {
      const dau = dauTaiLieu(records);
      if (dau !== null && cu[docId] === dau) { moi[docId] = dau; continue; }
      let result;
      try { result = migrateUpdate(Y,records.map(r=>r.bin)); }
      catch (error) { throw new Error(`Tài liệu ${docId}: ${error.message}`, {cause:error}); }
      if (result.count) planned.push({docId,...result});
      else if (dau !== null) moi[docId] = dau;
    }
    if (planned.length) {
      // Cất bản gốc của tài liệu sắp đổi vào kho sao lưu riêng trước khi ghi.
      backup = await open('bstr-schema-backups',1,d=>d.createObjectStore('documents',{keyPath:['database','docId','savedAt']}));
      const backupTx = backup.transaction('documents','readwrite'), saved = complete(backupTx);
      for (const {docId} of planned) backupTx.objectStore('documents').put({
        database:name,docId,savedAt:new Date(),
        snapshots:snapshots.filter(r=>r.docId===docId),updates:updates.filter(r=>r.docId===docId),
      });
      await saved;
      // Thêm một delta CRDT; không xoá snapshot hay update nào. Mọi tài liệu trong kho và đồng hồ của chúng
      // cùng ghi, hoặc không ghi gì.
      const tx = db.transaction(['snapshots','updates','clocks'],'readwrite'), done = complete(tx);
      try {
        for (const plan of planned) {
          const snapshot = await request(tx.objectStore('snapshots').get(plan.docId));
          const current = await request(tx.objectStore('updates').index('docId').getAll(plan.docId));
          const expectedSnapshot = snapshots.find(r=>r.docId===plan.docId);
          const expectedUpdates = updates.filter(r=>r.docId===plan.docId);
          if (!!snapshot !== !!expectedSnapshot || (snapshot && !byteEqual(snapshot.bin,expectedSnapshot.bin)) ||
              current.length !== expectedUpdates.length || current.some((r,i)=>!byteEqual(r.bin,expectedUpdates[i].bin))) {
            throw new Error('Dữ liệu vừa thay đổi ở tab khác. Đóng các tab cũ rồi tải lại.');
          }
          const clock = await request(tx.objectStore('clocks').get(plan.docId));
          const latest = current.reduce((max,r)=>Math.max(max,+r.createdAt||0),Math.max(Date.now(),+(clock?.timestamp||0)));
          const createdAt = new Date(latest+1);
          tx.objectStore('updates').add({docId:plan.docId,createdAt,bin:plan.delta,editor:'bstr-schema-v2'});
          tx.objectStore('clocks').put({docId:plan.docId,timestamp:createdAt});
          report.documents++; report.changes+=plan.count;
        }
      } catch(e) { tx.abort(); await done.catch(()=>{}); throw e; }
      await done;
    }
    tatCa[name] = moi;
    ghiDau(tatCa);
    return report;
  } finally { db.close(); backup?.close(); }
}

export async function migrateLocalData() {
  if (typeof indexedDB.databases !== 'function') throw new Error('Trình duyệt chưa hỗ trợ kiểm kê dữ liệu. Hãy dùng Chrome hoặc Edge mới.');
  const run = async () => {
    const reports = [];
    for (const {name} of await indexedDB.databases()) {
      if (name && /^(local|bstr-cloud):(workspace|userspace):/.test(name)) reports.push(await migrateDatabase(name));
    }
    return reports;
  };
  return navigator.locks ? navigator.locks.request('bstr-schema-v2',run) : run();
}

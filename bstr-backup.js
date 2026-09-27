// Kiểm tra đầu vào (xem bstr-compat.js), thuần: không IndexedDB, storage hay mạng, không sửa đầu vào.
import * as Y from './drive-sync/vendor/yjs-gop.mjs';
import { migrateSnapshot, migrateUpdate } from './bstr-data.js';

const fail = message => { throw new Error(message); };
const plain = v => !!v && typeof v === 'object' && [Object.prototype,null].includes(Object.getPrototypeOf(v));
const assign = (out,key,value) => Object.defineProperty(out,key,{value,enumerable:true,writable:true,configurable:true});
const keyPathValid = value => typeof value==='string' || (Array.isArray(value) && value.length>0 && value.every(k=>typeof k==='string'));
export function encodeBackupValue(value) {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    let binary = '';
    for (let i=0;i<bytes.length;i+=0x8000) binary += String.fromCharCode(...bytes.subarray(i,i+0x8000));
    return {__u8:btoa(binary)};
  }
  if (value instanceof Date) {
    if (!Number.isFinite(+value)) fail('Ngày trong bản sao lưu không hợp lệ');
    return {__date:value.toISOString()};
  }
  if (Array.isArray(value)) return value.map(encodeBackupValue);
  if (plain(value)) {
    const out = {};
    for (const [key,item] of Object.entries(value)) assign(out,key,encodeBackupValue(item));
    return out;
  }
  return value;
}
export function decodeBackupValue(value) {
  if (Array.isArray(value)) return value.map(decodeBackupValue);
  if (plain(value)) {
    if (Object.hasOwn(value,'__u8')) {
      if (Object.keys(value).length!==1 || typeof value.__u8!=='string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.__u8)) fail('Dữ liệu nhị phân trong bản sao lưu không hợp lệ');
      return Uint8Array.from(atob(value.__u8),c=>c.charCodeAt(0));
    }
    if (Object.hasOwn(value,'__date')) {
      if (Object.keys(value).length!==1 || typeof value.__date!=='string') fail('Ngày trong bản sao lưu không hợp lệ');
      const date = new Date(value.__date);
      if (!Number.isFinite(+date)) fail('Ngày trong bản sao lưu không hợp lệ');
      return date;
    }
    const out = {};
    for (const [key,item] of Object.entries(value)) assign(out,key,decodeBackupValue(item));
    return out;
  }
  return value;
}

export function convertDocumentUpdate(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!input.length) fail('Tài liệu không có dữ liệu');
  const result = migrateUpdate(Y,[input]);
  return {bytes:result.bin ?? input.slice(),changes:result.count};
}

export function convertSnapshotInput(snapshot) {
  if (!plain(snapshot) || snapshot.type!=='page' || !plain(snapshot.meta) || typeof snapshot.meta.id!=='string' || !plain(snapshot.blocks)) fail('Không phải snapshot tài liệu được hỗ trợ');
  return migrateSnapshot(snapshot);
}

// Kiểm tra từng tài liệu trên trạng thái đã gộp snapshot + mọi update; giữ nguyên bản ghi gốc, tài liệu nào
// cần đổi thì thêm một delta CRDT. Every workspace is prepared successfully before the caller can write any DB.
export function prepareBackup(payload) {
  try {
    if (!plain(payload) || payload.format!=='bstr-drive-sync/1' || !Array.isArray(payload.workspaces)) fail('Định dạng bản sao lưu không được hỗ trợ');
    const converted = decodeBackupValue(payload);
    const workspaceIds = new Set();
    let documents = 0, changes = 0;
    for (const ws of converted.workspaces) {
      if (!plain(ws) || typeof ws.id!=='string' || !ws.id || workspaceIds.has(ws.id)) fail('Workspace bị thiếu hoặc trùng định danh');
      workspaceIds.add(ws.id);
      if (ws.version!==undefined && (!Number.isSafeInteger(ws.version) || ws.version<1)) fail('Phiên bản cơ sở dữ liệu không hợp lệ');
      if (!plain(ws.stores) || !Array.isArray(ws.stores.snapshots)) fail('Bản sao lưu thiếu kho snapshot');
      const schemaNames = new Set();
      if (ws.schema!==undefined) {
        if (!Array.isArray(ws.schema)) fail('Schema bản sao lưu không hợp lệ');
        for (const store of ws.schema) {
          if (!plain(store) || typeof store.name!=='string' || !store.name || schemaNames.has(store.name) || !Array.isArray(store.indexes)) fail('Schema có kho bị thiếu hoặc trùng');
          if ((store.keyPath!==null && !keyPathValid(store.keyPath)) || (store.autoIncrement!==undefined && typeof store.autoIncrement!=='boolean') || (store.autoIncrement && Array.isArray(store.keyPath))) fail(`Schema có khóa kho không hợp lệ: ${store.name}`);
          const indexNames=new Set();
          for (const index of store.indexes) {
            if (!plain(index) || typeof index.name!=='string' || indexNames.has(index.name) || !keyPathValid(index.keyPath) || (index.unique!==undefined && typeof index.unique!=='boolean') || (index.multiEntry!==undefined && typeof index.multiEntry!=='boolean') || (index.multiEntry && Array.isArray(index.keyPath))) fail('Schema có chỉ mục không hợp lệ');
            indexNames.add(index.name);
          }
          schemaNames.add(store.name);
        }
      }
      for (const [name,records] of Object.entries(ws.stores)) {
        if (!Array.isArray(records) || records.some(record=>!plain(record))) fail(`Kho ${name} chứa bản ghi không hợp lệ`);
        if (schemaNames.size && !schemaNames.has(name)) fail(`Schema thiếu kho ${name}`);
      }
      const snapshots = ws.stores.snapshots, updates = ws.stores.updates ?? [];
      const groups = new Map(), snapshotIds = new Set(), updateIds = new Set();
      for (const [records,isSnapshot] of [[snapshots,true],[updates,false]]) {
        for (const record of records) {
          if (typeof record.docId!=='string' || !record.docId || !(record.bin instanceof Uint8Array) || !record.bin.length) fail('Bản ghi tài liệu thiếu định danh hoặc dữ liệu');
          if (isSnapshot) {
            if (snapshotIds.has(record.docId)) fail('Snapshot bị trùng định danh');
            snapshotIds.add(record.docId);
          } else {
            if (!(record.createdAt instanceof Date)) fail('Update thiếu thời điểm hợp lệ');
            const key=JSON.stringify([record.docId,+record.createdAt]);
            if (updateIds.has(key)) fail('Update bị trùng khóa');
            updateIds.add(key);
          }
          if (!groups.has(record.docId)) groups.set(record.docId,[]);
          groups.get(record.docId).push(record.bin);
        }
      }
      const clocks = ws.stores.clocks ?? [], clockIds = new Set();
      for (const clock of clocks) {
        if (typeof clock.docId!=='string' || !(clock.timestamp instanceof Date) || clockIds.has(clock.docId)) fail('Đồng hồ tài liệu bị lỗi hoặc trùng');
        clockIds.add(clock.docId);
      }
      for (const [docId,bins] of groups) {
        const result = migrateUpdate(Y,bins);
        if (!result.count) continue;
        if (schemaNames.size && (!schemaNames.has('updates') || !schemaNames.has('clocks'))) fail('Schema thiếu kho để ghi bản chuyển đổi');
        let latest = 0;
        for (const snapshot of snapshots) if (snapshot.docId===docId) {
          for (const field of ['createdAt','updatedAt']) if (snapshot[field]!==undefined) {
            if (!(snapshot[field] instanceof Date)) fail('Snapshot có thời điểm không hợp lệ');
            latest=Math.max(latest,+snapshot[field]);
          }
        }
        for (const update of updates) if (update.docId===docId) latest=Math.max(latest,+update.createdAt);
        const clock=clocks.find(c=>c.docId===docId);
        if (clock) latest=Math.max(latest,+clock.timestamp);
        const timestamp = new Date(latest+1);
        if (!Number.isFinite(+timestamp)) fail('Đồng hồ tài liệu vượt giới hạn');
        updates.push({docId,createdAt:timestamp,bin:result.delta,editor:'bstr-input-v2'});
        if (clock) clock.timestamp=timestamp; else clocks.push({docId,timestamp});
        documents++; changes+=result.count;
      }
      if (updates.length) ws.stores.updates=updates;
      if (clocks.length) ws.stores.clocks=clocks;
    }
    return {payload:encodeBackupValue(converted),documents,changes};
  } catch (cause) {
    const error = new Error(`Bản sao lưu không hợp lệ: ${cause.message}`,{cause});
    error.code='BSTR_BACKUP_INVALID';
    throw error;
  }
}

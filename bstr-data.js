// Kiểm tra dữ liệu đầu vào (xem bstr-compat.js). Tài liệu hợp lệ đi qua nguyên vẹn.
import './bstr-compat.js';

/** Snapshot JSON: trả đúng đối tượng nhận vào nếu không có gì cần đổi. */
export function migrateSnapshot(value) {
  return globalThis.bstrCompat.snapshot(value);
}

// Duyệt khóa, giá trị và thuộc tính định dạng; không chạm nội dung chữ trong Y.Text.
// Mỗi thay đổi là một thao tác Yjs bình thường, giữ nguyên ID khối và lịch sử.
export function migrateDoc(Y, doc) {
  const C = globalThis.bstrCompat;
  let changed = 0;
  const visited = new Set();
  // Chỉ chặn nhãn khối ở chỗ bộ chặn chỉ đọc từng xét (đối tượng JSON thường nằm thẳng trong Y.Map);
  // mảng JSON, phần tử Y.Array và thuộc tính định dạng không bị chặn.
  const doiGiaTri = (key, item, kiem) => {
    if (C.GIU.has(key) || item instanceof Y.AbstractType) return item;
    if (typeof item === 'string' || Array.isArray(item) || C.plain(item)) return C.snapshot(item, C.doiTen, kiem && C.plain(item));
    return item;
  };
  const visit = value => {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (value instanceof Y.Map) {
      for (const [key, item] of [...value.entries()]) {
        const nextKey = C.doiTen(key), next = doiGiaTri(key, item, true);
        if (key === 'sys:flavour') C.flavour(next);
        if (nextKey !== key) {
          if (value.has(nextKey)) throw new Error(`Conflicting document key: ${nextKey}`);
          value.set(nextKey, item instanceof Y.AbstractType ? item.clone() : next);
          value.delete(key); changed++;
          visit(value.get(nextKey));
        } else if (next !== item) { value.set(key, next); changed++; }
        else visit(item);
      }
    } else if (value instanceof Y.Array) {
      value.toArray().forEach((item, i) => {
        const next = doiGiaTri('', item, false);
        if (next !== item) { value.delete(i, 1); value.insert(i, [next]); changed++; }
        else visit(item);
      });
    } else if (value instanceof Y.Text) {
      let offset = 0;
      for (const op of value.toDelta()) {
        const length = typeof op.insert === 'string' ? op.insert.length : 1;
        const attributes = {};
        for (const [key, item] of Object.entries(op.attributes || {})) {
          if (C.doiTen(key) !== key) throw new Error(`Unexpected text attribute: ${key}`);
          const next = doiGiaTri(key, item, false);
          if (next !== item) attributes[key] = next;
        }
        if (Object.keys(attributes).length) { value.format(offset, length, attributes); changed++; }
        if (op.insert instanceof Y.AbstractType) visit(op.insert);
        offset += length;
      }
    }
  };
  doc.transact(() => {
    // Yjs giải mã kiểu gốc một cách lười: dựng mọi kiểu gốc có khóa thành Y.Map (blocks, meta, spaces, bảng db$...).
    for (const [key, value] of [...doc.share.entries()]) if (value._map.size) doc.getMap(key);
    for (const value of [...doc.share.values()]) visit(value);
  }, 'bstr-schema-v2');
  return changed;
}

/** Gộp snapshot và mọi update của một tài liệu; trả bản cập nhật (delta) nếu có gì cần đổi. */
export function migrateUpdate(Y, bins) {
  const doc = new Y.Doc();
  try {
    for (const bin of bins) Y.applyUpdate(doc, bin instanceof Uint8Array ? bin : new Uint8Array(bin));
    if (doc.store.pendingStructs || doc.store.pendingDs) throw new Error('Incomplete document updates; migration stopped');
    const before = Y.encodeStateVector(doc);
    const count = migrateDoc(Y, doc);
    const delta = count ? Y.encodeStateAsUpdate(doc, before) : null;
    const bin = count ? Y.encodeStateAsUpdate(doc) : null;
    return {count, delta, bin};
  } finally { doc.destroy(); }
}

// Kiểm tra đầu vào: chỉ nhận khối mang nhãn bstr:. Dữ liệu mang nhãn khác bị từ chối.
// Tệp này là script thường (không import/export), vì worker nạp nó bằng importScripts; mọi tên
// nằm trong một hàm tự gọi để không rò ra phạm vi toàn cục của worker.
(() => {
  const PREFIX = 'bstr:';
  // Lược đồ hiện tại không đổi tên nào; bstr-data và bstr-migrate gọi qua đây nên lần đổi lược đồ sau chỉ sửa một chỗ.
  const doiTen = s => s;
  // Khóa chứa chữ người dùng: giá trị không bao giờ bị đổi.
  const GIU = new Set(['insert','title','name']);
  const plain = v => !!v && typeof v === 'object' && [Object.prototype,null].includes(Object.getPrototypeOf(v));
  const flavour = label => {
    if (typeof label === 'string' && !label.startsWith(PREFIX)) {
      throw new Error(`Dữ liệu dạng cũ: khối "${label.slice(0, 80)}" không còn được hỗ trợ.`);
    }
  };
  /** Snapshot JSON: kiểm nhãn khối, đổi tên theo doiTen; trả đúng đối tượng nhận vào nếu không có gì đổi.
   *  kiem=false: không chặn nhãn khối (chỗ bộ chặn chưa từng xét). */
  const snapshot = (value, doiChuoi = doiTen, kiem = true) => {
    const nhan = kiem ? flavour : () => {};
    const seen = new Set();
    const visit = node => {
      if (typeof node === 'string') return doiChuoi(node);
      if (!node || typeof node !== 'object' || seen.has(node)) return node;
      if (Array.isArray(node)) {
        seen.add(node);
        const next = node.map(visit);
        return next.some((v,i) => v !== node[i]) ? next : node;
      }
      if (!plain(node)) return node;
      seen.add(node);
      if (node.type === 'block') nhan(doiTen(node.flavour));
      let changed = false;
      const out = {};
      for (const [key, item] of Object.entries(node)) {
        const nextKey = doiTen(key);
        const next = GIU.has(key) ? item : visit(item);
        if (key === 'sys:flavour') nhan(next);
        if (Object.hasOwn(out, nextKey)) throw new Error(`Conflicting snapshot key: ${nextKey}`);
        if (nextKey !== key || next !== item) changed = true;
        Object.defineProperty(out, nextKey, {value:next, enumerable:true, writable:true, configurable:true});
      }
      return changed ? out : node;
    };
    return visit(value);
  };
  globalThis.bstrCompat = Object.freeze({snapshot, flavour, doiTen, plain, GIU});
})();

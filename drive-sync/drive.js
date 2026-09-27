import { CONFIG } from './config.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

async function call(token, url, opts = {}) {
  const res = await fetch(url.startsWith('http') ? url : API + url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  if (!res.ok) {
    throw new Error(`Drive lỗi ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

/**
 * Chuỗi trong câu truy vấn Drive đặt giữa dấu nháy đơn; dấu nháy đơn và dấu
 * gạch chéo ngược trong giá trị phải được thoát, nếu không câu truy vấn vỡ
 * (Drive trả 400) hoặc lọc sai tệp. Mọi giá trị nhét vào `q` phải đi qua đây.
 */
const qEsc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export async function ensureFolder(token) {
  const q = `name='${qEsc(CONFIG.folderName)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const found = await call(token, `/files?q=${encodeURIComponent(q)}&fields=files(id,name)`);
  if (found.files.length) return found.files[0].id;
  const created = await call(token, '/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: CONFIG.folderName, mimeType: 'application/vnd.google-apps.folder' }),
  });
  return created.id;
}

/** appProperties: nhãn Drive đọc được khi liệt kê mà không tải nội dung (bản lưu gắn thiết bị và số tài liệu). */
export async function uploadJson(token, folderId, filename, obj, appProperties) {
  const boundary = 'bstr' + Math.random().toString(36).slice(2);
  const meta = { name: filename, parents: [folderId], mimeType: 'application/json', ...(appProperties && { appProperties }) };
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(meta) + '\r\n' +
    `--${boundary}\r\n` +
    'Content-Type: application/json\r\n\r\n' +
    JSON.stringify(obj) + '\r\n' +
    `--${boundary}--`;
  return call(token, `${UPLOAD}/files?uploadType=multipart&fields=id,name,createdTime`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
}

/**
 * Drive không có toán tử "startsWith": `name contains 'bstr-workspace-'` cũng
 * khớp cả `chia-se-bstr-workspace-....json`. Một tệp chia sẻ lọt vào đây sẽ bị
 * coi là bản đồng bộ mới nhất (tải về, ghi đè) và bị prune xoá. Nên phải lọc
 * lại phía client theo đúng tiền tố, và luôn giới hạn trong đúng thư mục.
 */
async function listByPrefix(token, folderId, prefix, fields) {
  const q = `'${qEsc(folderId)}' in parents and name contains '${qEsc(prefix)}' and trashed=false`;
  const r = await call(
    token,
    `/files?q=${encodeURIComponent(q)}&orderBy=createdTime desc&fields=files(${fields})`
  );
  return (r.files || []).filter((f) => typeof f.name === 'string' && f.name.startsWith(prefix));
}

export function listVersions(token, folderId) {
  return listByPrefix(token, folderId, CONFIG.filePrefix, 'id,name,createdTime,size,appProperties');
}

/**
 * Bản lưu cần xoá: giữ CONFIG.maxDevices thiết bị lưu gần nhất, mỗi thiết bị CONFIG.keepVersions bản
 * mới nhất; thiết bị cũ hơn bị bỏ hết bản. Bản lưu từ trước khi có nhãn thiết bị (không có bstrThietBi)
 * gom thành một nhóm, chiếm một chỗ như một thiết bị cho tới khi tự hết. `files` mới nhất trước.
 * ponytail: "thiết bị" là một hồ sơ trình duyệt (mã trong localStorage); ẩn danh hay xoá dữ liệu trang
 * tạo thiết bị mới và đẩy thiết bị cũ nhất ra, đúng như chủ dự án chọn (27/09).
 */
export function banThua(files, maxDevices = CONFIG.maxDevices, keep = CONFIG.keepVersions) {
  const nhom = new Map(); // Map giữ thứ tự chèn = thiết bị lưu gần nhất trước
  for (const f of files) {
    const id = f.appProperties?.bstrThietBi || '';
    if (!nhom.has(id)) nhom.set(id, []);
    nhom.get(id).push(f);
  }
  return [...nhom.values()].flatMap((ds, i) => (i < maxDevices ? ds.slice(keep) : ds));
}

/** Dọn bản lưu theo banThua(). Chỉ gọi SAU khi tải lên thành công (bản vừa lưu luôn thuộc thiết bị mới nhất). */
export async function pruneVersions(token, files) {
  for (const f of banThua(files)) {
    await call(token, `/files/${f.id}`, { method: 'DELETE' });
  }
}

/** Các bản chụp trước khi ghi đè — cố ý KHÔNG nằm trong listVersions. */
export function listBackups(token, folderId) {
  return listByPrefix(token, folderId, CONFIG.backupPrefix, 'id,name,createdTime,size');
}

export async function downloadJson(token, fileId) {
  const res = await fetch(`${API}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive tải về lỗi ${res.status}`);
  return res.json();
}

/** Xoá các bản vượt quá số lượng cần giữ (bản sao lưu, gói chia sẻ). Chỉ gọi SAU khi tải lên thành công. */
export async function prune(token, files, keep = CONFIG.keepVersions) {
  for (const f of files.slice(keep)) {
    await call(token, `/files/${f.id}`, { method: 'DELETE' });
  }
}

/** Tệp dò của tuKiemTra() — cố ý KHÔNG nằm trong listVersions/listBackups. */
export function listSelfTest(token, folderId) {
  return listByPrefix(token, folderId, CONFIG.selfTestPrefix, 'id,name,createdTime,size');
}

/** Xoá đúng một tệp theo id. Dùng cho tuKiemTra() xoá tệp dò của chính nó. */
export async function deleteFile(token, fileId) {
  await call(token, `/files/${fileId}`, { method: 'DELETE' });
}

/** Dọn bản sao lưu. KHÔNG bao giờ gọi trong cùng lượt vừa tạo một bản sao lưu. */
export async function pruneBackups(token, files) {
  return prune(token, files, CONFIG.keepBackups);
}

/** Đưa một tệp bất kỳ (ví dụ snapshot xuất từ app) lên thư mục chia sẻ. */
export async function shareFile(token, folderId, file) {
  const boundary = 'bstr' + Math.random().toString(36).slice(2);
  const meta = { name: `chia-se-${file.name}`, parents: [folderId] };
  const head =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(meta) + '\r\n' +
    `--${boundary}\r\n` +
    `Content-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`;
  const body = new Blob([head, file, `\r\n--${boundary}--`]);
  return call(token, `${UPLOAD}/files?uploadType=multipart&fields=id,name,webViewLink`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
}

/** Danh sách tệp được chia sẻ trong thư mục (tên bắt đầu bằng "chia-se-"). */
export function listShared(token, folderId) {
  return listByPrefix(token, folderId, 'chia-se-', 'id,name,createdTime,webViewLink');
}

/**
 * Gói chia sẻ MỘT tài liệu. Tiền tố riêng nên listVersions/listBackups (lọc
 * chặt theo startsWith) không bao giờ nhìn thấy nó.
 */
export function listShares(token, folderId) {
  return listByPrefix(token, folderId, CONFIG.sharePrefix, 'id,name,createdTime,size');
}

/** Cho phép bất kỳ ai có đường dẫn ĐỌC tệp này (không cho sửa). */
export async function moChoMoiNguoiDoc(token, fileId) {
  return call(token, `/files/${fileId}/permissions?fields=id,role,type`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
}

/** Người nhận xem quyền hiện có của tệp — dùng để tự kiểm tra sau khi chia sẻ. */
export async function quyenCuaTep(token, fileId) {
  const r = await call(token, `/files/${fileId}/permissions?fields=permissions(id,role,type)`);
  return r.permissions || [];
}

/**
 * Tải gói chia sẻ KHÔNG cần OAuth — người nhận có thể chưa hề đăng nhập. Đi qua
 * Worker (CONFIG.shareUrl) giữ khoá API; tệp phải đã được moChoMoiNguoiDoc().
 */
export async function taiJsonCongKhai(fileId, shareUrl) {
  const res = await fetch(`${shareUrl}?id=${encodeURIComponent(fileId)}`);
  if (!res.ok) throw new Error(`Tải gói chia sẻ lỗi ${res.status}: ${await res.text()}`);
  return res.json();
}

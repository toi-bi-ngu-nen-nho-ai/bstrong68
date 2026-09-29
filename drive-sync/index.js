import { CONFIG } from './config.js';
import * as sync from './sync.js';
import * as store from './store.js';
import * as auth from './auth.js';
import { shareFile, listShared, ensureFolder, listShares, quyenCuaTep } from './drive.js';
import * as share from './share.js?bstr-login=6';
import { setStatus, showNhan } from './ui.js';
import { createLoginFlow } from './login.js?bstr-login=3';
import { linkNhan, createNhanFlow } from './nhan.js';

const login = createLoginFlow({
  start: sync.start,
  isSignedIn: auth.isSignedIn,
  storage: localStorage,
  onError: (e) => console.error('[drive-sync] khởi động lỗi', e),
});
window.bstrDriveSync = { CONFIG, ...sync, ...share, store, auth, ...login, ready: true };
sync.ngheTabKhacGop(); // tab khác gộp thì tab này chặn nhập và chờ, kể cả khi chưa đăng nhập (chưa chạy start())

/** Máy mở app lần đầu cần vài giây để tạo workspace; nhận tài liệu phải chờ có chỗ để ghi. */
async function choWorkspace(hanMs = 30000) {
  for (const het = Date.now() + hanMs; Date.now() < het; await new Promise((r) => setTimeout(r, 500))) {
    if (await store.wsNhan()) return;
  }
  throw new Error('Chưa có workspace để nhận tài liệu');
}

// Liên kết ?nhan=: chạy sau bước khởi động đồng bộ để hai hộp thoại không chồng lên nhau.
const nhanFlow = createNhanFlow({
  storage: sessionStorage,
  idTuLink: share.idTuLink,
  hoiNhan: showNhan,
  daDangNhap: auth.isSignedIn,
  dangNhap: login.requestSignIn,
  choWorkspace,
  nhan: (id) => share.nhanTaiLieu(id, { taiLai: false }),
  mo: ({ wsId, docId }) => location.assign(`/workspace/${encodeURIComponent(wsId)}/${encodeURIComponent(docId)}`),
  setStatus,
});

// Bootstrap may import this module after the window load event has fired.
let started = false;
const startSync = () => {
  if (started) return;
  started = true;
  const khoiDong = login.initialize();
  sync.baoChuaDongBo();
  nhanFlow.chay(() => khoiDong).catch((e) => console.error('[drive-sync] nhận tài liệu từ liên kết lỗi', e));
};
if (document.readyState === 'complete') startSync();
else window.addEventListener('load', startSync, { once: true });

/** Mở hộp chọn tệp, đưa tệp đã chọn lên Drive để người khác tải. */
window.bstrDriveSync.chiaSe = async () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      setStatus('Đang đưa tệp lên Drive...');
      const token = await sync.ensureToken();
      const r = await shareFile(token, await ensureFolder(token), file);
      setStatus('Đã đưa lên Drive');
      console.log('Đường dẫn chia sẻ:', r.webViewLink);
    } catch (e) {
      console.error('[drive-sync] đưa tệp lên Drive thất bại', e);
      setStatus('Chưa đưa được tệp lên Drive. Hãy kiểm tra kết nối rồi thử lại.', { persist: true, level: 'error' });
    }
  };
  input.click();
};

window.bstrDriveSync.dsChiaSe = async () => {
  const token = await sync.ensureToken();
  return listShared(token, await ensureFolder(token));
};

/**
 * Nút "Đăng xuất" trong menu Không gian làm việc. Tải lại trang sau khi xong: hẹn giờ lưu nền đang
 * chạy sẽ không còn, nếu không hai phút sau nó lại mở hộp đăng nhập. Tài liệu trên máy giữ nguyên.
 */
window.bstrDriveSync.dangXuat = async () => {
  try {
    await auth.dangXuat();
    location.reload();
  } catch (e) {
    console.error('[drive-sync] đăng xuất thất bại', e);
    setStatus('Chưa đăng xuất được. Hãy kiểm tra kết nối rồi thử lại.', { persist: true, level: 'error' });
  }
};

/** Danh sách gói chia sẻ một tài liệu (tiền tố sharePrefix) trong thư mục Drive. */
window.bstrDriveSync.dsChiaSeTaiLieu = async () => {
  const token = await sync.ensureToken();
  return listShares(token, await ensureFolder(token));
};

/** Quyền hiện có của một tệp trên Drive — dùng để xác nhận đã mở cho mọi người đọc. */
window.bstrDriveSync.quyenTep = async (fileId) => quyenCuaTep(await sync.ensureToken(), fileId);

/** Id tài liệu đang mở, đọc từ URL dạng /workspace/<wsId>/<docId>. */
const docIdHienTai = () => {
  const m = location.pathname.match(/^\/workspace\/[^/]+\/([^/?]+)/);
  return m ? decodeURIComponent(m[1]) : null;
};

let dangChiaSeNutBam = false;

/**
 * Nút "Sao chép liên kết" trong popover Chia sẻ (index.html gọi vào đây khi
 * bấm): chưa đăng nhập thì mở bảng đăng nhập; đăng nhập rồi thì chia sẻ tài
 * liệu đang mở qua Drive và sao chép liên kết <app>/?nhan=<id tệp> (nhan.js): web không có máy chủ
 * để mở trang chia sẻ công khai.
 */
window.bstrDriveSync.chiaSeTaiLieuHienTai = async () => {
  if (dangChiaSeNutBam) return;
  dangChiaSeNutBam = true;
  try {
    if (!auth.isSignedIn()) {
      const ok = await login.requestSignIn();
      if (ok !== true) return;
    }
    const docId = docIdHienTai();
    if (!docId) {
      setStatus('Không xác định được tài liệu đang mở');
      return;
    }
    // Safari (iPhone) chỉ cho ghi clipboard trong cú bấm, mà tải gói lên Drive mất vài giây: đưa Promise của liên kết vào
    // ClipboardItem ngay lúc bấm. Vẫn bị chặn (hoặc đã mất cú bấm vì phải đăng nhập trước) thì hiện nút "Sao chép liên
    // kết" — bấm nút là cú bấm mới nên ghi được. Thử 25/09 trên bstrong68.com: writeText sau khi tải báo NotAllowedError.
    const lienKet = share.chiaSeVaDonDep(docId).then(({ fileId }) => linkNhan(location.origin, fileId));
    let chep = null;
    try {
      if (window.ClipboardItem && navigator.clipboard?.write) {
        chep = navigator.clipboard.write([new ClipboardItem({ 'text/plain': lienKet.then(l => new Blob([l], { type: 'text/plain' })) })]);
        chep.catch(() => {});
      }
    } catch { chep = null; }
    const link = await lienKet;
    const daChep = await (chep ?? Promise.reject()).then(() => true, () => navigator.clipboard.writeText(link).then(() => true, () => false));
    if (daChep) setStatus('Đã sao chép liên kết. Người nhận bấm vào là mở app và nhận tài liệu.');
    else setStatus('Liên kết đã sẵn sàng. Bấm "Sao chép liên kết" để gửi cho người nhận.', {
      persist: true,
      action: { label: 'Sao chép liên kết', run: () => navigator.clipboard.writeText(link).then(
        () => setStatus('Đã sao chép liên kết. Người nhận bấm vào là mở app và nhận tài liệu.'),
        () => setStatus(`Không sao chép được. Liên kết: ${link}`, { persist: true })) },
    });
  } catch (e) {
    console.error('[drive-sync] chia sẻ tài liệu hiện tại thất bại', e);
    setStatus('Chưa chia sẻ được tài liệu. Hãy kiểm tra kết nối rồi thử lại.', { persist: true, level: 'error' });
  } finally {
    dangChiaSeNutBam = false;
  }
};

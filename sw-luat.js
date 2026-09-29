// Luật phục vụ của service worker sw.js (mở app không cần mạng). sw.js nạp tệp này bằng importScripts. Chỉ hằng số và
// hàm thuần. Đổi tệp này thì tăng cờ ?bstr-sw= ở dòng importScripts của sw.js.
const KHO_UNG_DUNG = 'bstr-ung-dung-1'; // đổi số khi đổi cách lưu trong bộ nhớ đệm; bản mới xoá kho số cũ lúc kích hoạt
const CHO_TRANG_MS = 3000; // mở trang: chờ mạng tối đa chừng này rồi dùng bản đã cất
const DA_DON = '/__bstr-da-don'; // mục trong kho ghi phiên bản danh sách cất sẵn đã dọn theo
const CAT_SONG_SONG = 2; // cất sẵn: số tệp tải một lúc

/** Trang của app: máy chủ trả index.html cho mọi đường dẫn không có đuôi tệp; /privacy là trang riêng. */
function laTrangApp(pathname) {
  return !/\.[A-Za-z0-9]+$/.test(pathname) && !/^\/privacy\/?$/.test(pathname);
}

/**
 * Cách phục vụ một yêu cầu:
 * 'bo-qua' để trình duyệt tự đi mạng như chưa có service worker (khác nguồn, không phải GET, Range, tệp của chính service
 * worker, trang không phải của app); 'trang' mạng trước, chờ tối đa CHO_TRANG_MS; 'co-dinh' URL có cờ chống đệm bstr-
 * (nội dung đổi thì URL đổi) nên bộ nhớ trước; 'lam-moi-nen' có trong bộ nhớ thì trả ngay và tải bản mới chạy nền.
 * Tên tệp có mã băm mà không cờ vẫn là 'lam-moi-nen': bundle có lúc đổi nội dung mà giữ tên (cờ bstr-f5).
 */
function phanLoai({ method, url, mode, range }, origin) {
  const u = new URL(url);
  if (method !== 'GET' || u.origin !== origin || range) return 'bo-qua';
  if (mode === 'navigate') return laTrangApp(u.pathname) ? 'trang' : 'bo-qua';
  if (['/sw.js', '/sw-luat.js', '/bstr-ngoai-tuyen.json', DA_DON].includes(u.pathname)) return 'bo-qua';
  return u.search.includes('bstr-') ? 'co-dinh' : 'lam-moi-nen';
}

/** Mục giữ lại khi dọn kho (URL đầy đủ): danh sách cất sẵn, trang '/', mốc đã dọn, tệp lần mở này đã dùng. */
function dsGiu(tep, dung, origin) {
  const giu = new Set([...tep, '/', DA_DON].map((u) => new URL(u, origin).href));
  for (const u of dung) {
    if (phanLoai({ method: 'GET', url: u, mode: 'no-cors', range: false }, origin) !== 'bo-qua') giu.add(new URL(u).href);
  }
  return giu;
}

/** Mã kiểm trong URL cất sẵn (?bstr-nt=<16 ký tự hex đầu SHA-256 nội dung tệp>); không có thì null. */
function bamTrongUrl(url) {
  return new URL(url).searchParams.get('bstr-nt');
}

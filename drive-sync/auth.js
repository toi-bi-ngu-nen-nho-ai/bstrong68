import { CONFIG, LS } from './config.js';

// Đăng nhập lấy MÃ qua popup, Worker dang-nhap (services/dang-nhap) đổi mã và giữ refresh token
// trong cookie HttpOnly. Trang chỉ cầm access token 1 giờ trong bộ nhớ; mở lại app thì xin token mới từ
// Worker, không popup, không phải bấm gì.
let codeClient = null;
let accessToken = null;
let expiresAt = 0;
let dangLay = null;

function loadGis() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Không tải được Google Identity Services'));
    document.head.appendChild(s);
  });
}

export function isSignedIn() {
  return localStorage.getItem(LS.signedIn) === '1';
}

/** Quên phiên trên trang này (cờ + token trong bộ nhớ). Cookie ở Worker giữ nguyên; đăng xuất thật là dangXuat(). */
export function signOut() {
  accessToken = null;
  expiresAt = 0;
  localStorage.removeItem(LS.signedIn);
}

async function goiWorker(duong, body) {
  const r = await fetch(CONFIG.loginUrl + duong, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (r.status === 204) return null;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(r.status === 401 ? 'Phiên Google đã hết hạn' : `Máy chủ đăng nhập trả lỗi ${r.status} (${data.error || 'không rõ'})`);
    e.hetPhien = r.status === 401; // chỉ lỗi này mới cần đăng nhập lại; lỗi mạng/tạm thời thì để lần sau thử lại
    throw e;
  }
  return data;
}

function nhanToken(data) {
  accessToken = data.access_token;
  expiresAt = Date.now() + (Number(data.expires_in) - 60) * 1000;
  localStorage.setItem(LS.signedIn, '1');
  return accessToken;
}

/** Đăng nhập có popup; phải gọi từ một thao tác của người dùng. */
export async function signIn() {
  await loadGis();
  if (!codeClient) {
    codeClient = google.accounts.oauth2.initCodeClient({
      client_id: CONFIG.clientId,
      scope: CONFIG.scope,
      ux_mode: 'popup',
      select_account: true,
      callback: () => {},
      error_callback: () => {},
    });
  }
  const code = await new Promise((resolve, reject) => {
    // Google báo "người dùng đóng cửa sổ" / "trình duyệt chặn popup" qua
    // error_callback chứ KHÔNG qua callback. Thiếu nó thì promise treo mãi mãi
    // và khoá `busy` trong sync.js không bao giờ được nhả — đồng bộ chết lặng.
    let done = false;
    const settle = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(
      () => settle(reject, new Error('Hết thời gian chờ đăng nhập Google')),
      CONFIG.signInTimeoutMs
    );

    codeClient.callback = (resp) => {
      if (!resp || resp.error || !resp.code) {
        settle(reject, new Error(resp?.error_description || resp?.error || 'Google không trả mã đăng nhập'));
        return;
      }
      settle(resolve, resp.code);
    };
    codeClient.error_callback = (err) => {
      const chiTiet = err?.message || err?.type || 'không rõ lý do';
      const e = new Error(`Đăng nhập Google không hoàn tất (${chiTiet})`);
      e.loai = err?.type; // 'popup_failed_to_open' (trình duyệt chặn) | 'popup_closed' | 'unknown'
      settle(reject, e);
    };

    try {
      codeClient.requestCode();
    } catch (e) {
      settle(reject, e instanceof Error ? e : new Error(String(e)));
    }
  });
  return nhanToken(await goiWorker('/ma', { code }));
}

/** Token còn hạn trong bộ nhớ, hoặc xin token mới từ Worker (không popup). Lỗi có `hetPhien` = phải đăng nhập lại. */
export async function getToken() {
  if (accessToken && Date.now() < expiresAt) return accessToken;
  // Lưu nền, chia sẻ và khởi động có thể cùng xin một lúc: chỉ gọi Worker một lần.
  dangLay ??= goiWorker('/token').then(nhanToken).finally(() => { dangLay = null; });
  return dangLay;
}

/** Nút "Đăng xuất": Worker thu hồi quyền ở Google và xoá cookie, rồi trang quên phiên. */
export async function dangXuat() {
  await goiWorker('/xuat');
  signOut();
}

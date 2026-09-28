// Giao diện của đồng bộ Drive: hộp thoại và băng rôn đầu trang tài liệu (trạng thái lẫn thông báo ngắn). Mọi màu
// lấy từ token của app (biến --bstr-*), giá trị sau dấu phẩy chỉ là dự phòng theo giao diện sáng.
const CSS = `
.bstr-gs-overlay{position:fixed;inset:0;background:var(--bstr-v2-layer-background-modal,#000000b2);display:flex;align-items:center;
  justify-content:center;z-index:2147483000;font-family:var(--bstr-font-family,inherit)}
.bstr-gs-modal{width:440px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow:auto;box-sizing:border-box;
  padding:24px;border-radius:12px;outline:none;
  background:var(--bstr-v2-layer-background-overlayPanel,#fff);color:var(--bstr-v2-text-primary,#141414);
  box-shadow:var(--bstr-overlay-shadow,0 0 12px rgba(66,65,73,.14),inset 0 0 0 .5px #e3e2e4)}
.bstr-gs-title{margin:0 0 8px;font-size:20px;font-weight:600;line-height:1.35;text-wrap:balance;
  color:var(--bstr-v2-text-primary,#141414)}
.bstr-gs-desc{margin:0 0 20px;font-size:15px;line-height:1.55;color:color-mix(in srgb,var(--bstr-v2-text-primary,#141414) 72%,var(--bstr-v2-layer-background-overlayPanel,#fff))}
.bstr-gs-desc b{color:var(--bstr-v2-text-primary,#141414);font-weight:600}
/* Chỉ hộp đăng nhập và màn chặn nhập căn giữa. Các hộp còn lại chữ dài, căn giữa sẽ khó đọc. */
.bstr-gs-mid{text-align:center}
.bstr-gs-facts{margin:0 0 20px;padding:4px 0;border-block:1px solid var(--bstr-v2-layer-insideBorder-border,#e6e6e6)}
.bstr-gs-facts div{display:flex;justify-content:space-between;gap:16px;padding:8px 0;font-size:15px;line-height:1.4}
.bstr-gs-facts dt{color:color-mix(in srgb,var(--bstr-v2-text-primary,#141414) 72%,var(--bstr-v2-layer-background-overlayPanel,#fff))}
.bstr-gs-facts dd{margin:0;text-align:right;font-variant-numeric:tabular-nums;color:var(--bstr-v2-text-primary,#141414)}
.bstr-gs-facts small{display:block;font-size:12px;color:color-mix(in srgb,var(--bstr-v2-text-primary,#141414) 72%,var(--bstr-v2-layer-background-overlayPanel,#fff))}
.bstr-gs-btn{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;width:100%;min-height:44px;
  box-sizing:border-box;padding:8px 12px;border-radius:8px;cursor:pointer;font:inherit;font-size:15px;font-weight:500;line-height:1.3;
  border:1px solid var(--bstr-v2-layer-insideBorder-border,#e6e6e6);background:transparent;
  color:var(--bstr-v2-text-primary,#141414)}
.bstr-gs-btn:hover{background:var(--bstr-v2-layer-background-hoverOverlay,#0000000d)}
.bstr-gs-btn small{font-size:12px;font-weight:400;color:color-mix(in srgb,var(--bstr-v2-text-primary,#141414) 72%,var(--bstr-v2-layer-background-overlayPanel,#fff))}
.bstr-gs-btn-row{flex-direction:row;gap:8px}
.bstr-gs-primary{border-color:transparent;background:var(--bstr-v2-button-primary,#1e96eb);
  color:var(--bstr-v2-button-pureWhiteText,#fff);box-shadow:var(--bstr-button-shadow,none)}
.bstr-gs-primary:hover{background:var(--bstr-v2-button-primary,#1e96eb);filter:brightness(.94)}
.bstr-gs-danger{border-color:var(--bstr-v2-button-error,#ed3f3f)}
.bstr-gs-row{display:flex;flex-wrap:wrap;gap:8px}
.bstr-gs-row .bstr-gs-btn{flex:1 1 150px;width:auto}
.bstr-gs-link{display:block;width:100%;min-height:44px;margin-top:8px;padding:8px;background:none;border:0;border-radius:8px;
  cursor:pointer;font:inherit;font-size:15px;color:color-mix(in srgb,var(--bstr-v2-text-primary,#141414) 72%,var(--bstr-v2-layer-background-overlayPanel,#fff))}
.bstr-gs-link:hover{color:var(--bstr-v2-text-primary,#141414)}
.bstr-gs-overlay :focus-visible,.bstr-drive-slot :focus-visible{outline:2px solid var(--bstr-v2-button-primary,#1e96eb);outline-offset:2px}
/* Băng rôn Drive: dải ngang đầu trang tài liệu, chữ đậm 14px, nút nền trắng và nút × bên phải; khổ <=520px thì
   nhóm nút xuống dòng, trừ khi không còn nút nào hiện (nút anKhiHep ẩn đi ở khổ này): khi đó chữ và × nằm chung
   một hàng. Màu theo mức: lỗi (nền và chữ lỗi), cảnh báo (nền và chữ cảnh báo), thông tin (nền và chữ "đang xử lý");
   "Chưa đồng bộ" (mức local) màu lỗi. Khung .bstr-drive-slot nằm ở đầu trang tài liệu; không mở tài liệu thì
   không có khung và băng rôn chờ. */
.bstr-drive-slot{position:absolute;top:0;left:0;right:0;z-index:1;display:flex;flex-direction:column}
.bstr-gs-banner{display:flex;justify-content:space-between;align-items:center;gap:16px;width:100%;box-sizing:border-box;
  padding:12px 16px;font-family:var(--bstr-font-family,inherit);font-size:var(--bstr-font-sm,14px);font-weight:700;
  container-type:inline-size;
  background:var(--bstr-background-processing-color,#e9f1ff);color:var(--bstr-processing-color,#2776ff)}
.bstr-gs-banner[data-level=warn]{background:var(--bstr-background-warning-color,#ffeddb);color:var(--bstr-warning-color,#eb4335)}
.bstr-gs-banner[data-level=error],.bstr-gs-banner[data-level=local]{background:var(--bstr-background-error-color,#fdeceb);color:var(--bstr-error-color,#eb4335)}
.bstr-gs-banner-msg{flex-grow:1;flex-shrink:1;margin:0}
.bstr-gs-banner-right{display:flex;flex-shrink:0;justify-content:space-between;align-items:center;gap:16px}
.bstr-gs-action{height:28px;padding:0 8px;border-radius:8px;cursor:pointer;font:inherit;font-weight:500;white-space:nowrap;
  border:1px solid var(--bstr-border-color,#e3e2e4);background:var(--bstr-white,#fff);color:var(--bstr-text-primary-color,#121212)}
.bstr-gs-action:hover{filter:brightness(.97)}
.bstr-gs-close{display:grid;place-items:center;width:24px;height:24px;padding:0;border:0;border-radius:4px;background:none;
  cursor:pointer;color:var(--bstr-icon-color,#77757d)}
.bstr-gs-close:hover{background:var(--bstr-hover-color,#0000000a)}
@media screen and (max-width:520px){
  .bstr-gs-action[data-an-khi-hep]{display:none}
  .bstr-gs-banner:has(.bstr-gs-action:not([data-an-khi-hep])){flex-wrap:wrap}
  .bstr-gs-banner:has(.bstr-gs-action:not([data-an-khi-hep])) .bstr-gs-banner-right{width:100%}
  /* Vùng bấm × đủ 44px cho ngón tay; lề âm giữ nguyên chỗ và chiều cao băng rôn. */
  .bstr-gs-close{width:44px;height:44px;margin:-10px -10px -10px 0}
}
`;

const GOOGLE_SVG = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
</svg>`;

// Dấu × của nút đóng, cỡ 20px như IconButton size="20" của băng rôn gốc.
const CLOSE_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
  stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>`;

function ensureCss() {
  if (document.getElementById('bstr-gs-css')) return;
  const el = document.createElement('style');
  el.id = 'bstr-gs-css';
  el.textContent = CSS;
  document.head.appendChild(el);
}

let dialogCount = 0;

/**
 * Mở một hộp thoại và chờ người dùng chọn. Mọi nút có `data-act` trả về đúng giá trị đó. Hộp giữ focus bên
 * trong (Tab vòng quanh các nút), Esc trả về `escape`, phím bấm không lọt xuống editor phía sau, và khi đóng
 * thì focus về lại chỗ cũ.
 */
function openDialog(innerHtml, { escape, focus }) {
  ensureCss();
  const previousFocus = document.activeElement;
  const titleId = `bstr-gs-title-${++dialogCount}`;
  const overlay = document.createElement('div');
  overlay.className = 'bstr-gs-overlay';
  overlay.innerHTML = `<div class="bstr-gs-modal" role="dialog" aria-modal="true" aria-labelledby="${titleId}">${innerHtml}</div>`;
  const panel = overlay.firstElementChild;
  panel.querySelector('.bstr-gs-title').id = titleId;
  document.body.appendChild(overlay);
  return new Promise((resolve) => {
    const finish = (choice) => {
      overlay.remove();
      if (previousFocus?.isConnected) previousFocus.focus();
      resolve(choice);
    };
    for (const button of panel.querySelectorAll('[data-act]')) {
      button.addEventListener('click', () => finish(button.dataset.act));
    }
    overlay.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); finish(escape); }
      if (event.key === 'Tab') {
        const buttons = [...panel.querySelectorAll('button')];
        const next = (buttons.indexOf(document.activeElement) + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
        event.preventDefault();
        buttons[next].focus();
      }
    });
    panel.querySelector(`[data-act="${focus}"]`).focus();
  });
}

export function showSignIn() {
  return openDialog(`
      <h2 class="bstr-gs-title bstr-gs-mid">Đăng nhập</h2>
      <p class="bstr-gs-desc bstr-gs-mid">Đăng nhập bằng Google để lưu và đồng bộ tài liệu của bạn
        trên Google Drive của chính bạn.</p>
      <button class="bstr-gs-btn bstr-gs-btn-row" data-act="google">${GOOGLE_SVG}<span>Tiếp tục với Google</span></button>
      <button class="bstr-gs-link" data-act="skip">Tiếp tục không đăng nhập</button>
    `, { escape: 'skip', focus: 'google' });
}

/**
 * Mọi giá trị nhét vào innerHTML đều phải qua đây. Chuỗi thời gian do trình
 * duyệt/locale sinh ra là dữ liệu, không phải HTML — cứ chèn thẳng thì một
 * ngày nào đó nó chèn được thẻ.
 */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const RELATIVE = [['day', 86400], ['hour', 3600], ['minute', 60]];

/** "16:42, 24/9/2026" kèm dòng nhỏ "2 giờ trước", để so hai mốc mà không phải tự trừ giờ. */
export function when(iso, now = Date.now()) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return 'không rõ';
  const time = date.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'numeric', year: 'numeric' });
  const seconds = (date.getTime() - now) / 1000;
  const [unit, size] = RELATIVE.find(([, s]) => Math.abs(seconds) >= s) || ['minute', 60];
  const ago = new Intl.RelativeTimeFormat('vi', { numeric: 'auto' }).format(Math.round(seconds / size), unit);
  return `${esc(time)}<small>${esc(ago)}</small>`;
}

/**
 * Màn chặn nhập trong lúc gộp hoặc lấy dữ liệu từ Drive (vài giây, xong thì trang tự tải lại): không bấm, không gõ được
 * vào tài liệu phía sau, để không có chữ nào gõ đúng lúc dữ liệu trên máy đang được thay. Trả về hàm đóng màn.
 */
export function moManChan(text) {
  ensureCss();
  const overlay = document.createElement('div');
  overlay.className = 'bstr-gs-overlay';
  overlay.innerHTML = `<div class="bstr-gs-modal bstr-gs-mid" role="status" aria-live="polite" tabindex="-1">
      <p class="bstr-gs-title">${esc(text)}</p>
      <p class="bstr-gs-desc">Đừng đóng trang. Việc này mất vài giây, xong trang sẽ tự tải lại.</p></div>`;
  const chan = (event) => { event.stopPropagation(); event.preventDefault(); };
  overlay.addEventListener('keydown', chan, true);
  document.body.appendChild(overlay);
  overlay.firstElementChild.focus();
  return () => overlay.remove();
}

/** Mở app từ liên kết ?nhan= (drive-sync/nhan.js). Trả 'nhan' hoặc 'cancel'. */
export function showNhan() {
  return openDialog(`
      <h2 class="bstr-gs-title">Nhận tài liệu được chia sẻ</h2>
      <p class="bstr-gs-desc">Có người gửi cho bạn một tài liệu. Tài liệu được thêm vào máy này với tiêu đề
        bắt đầu bằng "[Nhận]"; tài liệu của bạn không bị thay đổi.</p>
      <p class="bstr-gs-desc">Trước khi thêm, app sao lưu dữ liệu trên máy lên Google Drive của bạn, nên cần
        đăng nhập Google.</p>
      <button class="bstr-gs-btn bstr-gs-primary" data-act="nhan">Nhận tài liệu</button>
      <button class="bstr-gs-link" data-act="cancel">Để sau</button>
    `, { escape: 'cancel', focus: 'nhan' });
}

/** Hỏi trước khi ghi đè bằng một bản ÍT tài liệu hơn lần lưu trước. Lựa chọn an toàn là mặc định. */
export async function showShrinkWarning({ oldCount, newCount }) {
  const choice = await openDialog(`
      <h2 class="bstr-gs-title">Trên máy ít tài liệu hơn lần lưu trước</h2>
      <dl class="bstr-gs-facts">
        <div><dt>Lần lưu trước</dt><dd>${esc(oldCount)} tài liệu</dd></div>
        <div><dt>Trên máy bây giờ</dt><dd>${esc(newCount)} tài liệu</dd></div>
      </dl>
      <p class="bstr-gs-desc">Nếu bạn vừa xoá bớt tài liệu thì cứ lưu. Nếu không, dữ liệu trên máy có thể
        đã hỏng: chọn <b>Huỷ lưu</b> để giữ nguyên bản tốt đang có trên Drive.</p>
      <div class="bstr-gs-row">
        <button class="bstr-gs-btn bstr-gs-primary" data-act="cancel">Huỷ lưu</button>
        <button class="bstr-gs-btn bstr-gs-danger" data-act="save">Vẫn lưu đè</button>
      </div>
    `, { escape: 'cancel', focus: 'cancel' });
  return choice === 'save';
}

// Hai loại thông báo: `banner` (trạng thái, ở lại tới khi trạng thái đổi hoặc bấm ×) và `flash` (thông báo ngắn, tự ẩn
// sau FLASH_MS). Chưa mở tài liệu thì không có khung: cả hai chờ; thông báo ngắn quá hạn thì bỏ.
const FLASH_MS = 4000;
let banner = null;
let flash = null;
let flashTimer = null;
let slotWatch = null;
let shownIn = null;

function currentSlot() {
  return [...document.querySelectorAll('.bstr-drive-slot')].find((el) => el.isConnected) || null;
}

function bannerEl({ text, level = 'info', action = null }, onClose) {
  const el = document.createElement('div');
  el.className = 'bstr-gs-banner';
  el.dataset.level = level;
  el.setAttribute('role', level === 'error' ? 'alert' : 'status');
  const msg = document.createElement('p');
  msg.className = 'bstr-gs-banner-msg';
  msg.textContent = text;
  const right = document.createElement('div');
  right.className = 'bstr-gs-banner-right';
  if (action) {
    const button = document.createElement('button');
    button.className = 'bstr-gs-action';
    button.textContent = action.label;
    if (action.anKhiHep) button.dataset.anKhiHep = '';
    button.addEventListener('click', () => { onClose(); action.run(); });
    right.append(button);
  }
  const close = document.createElement('button');
  close.className = 'bstr-gs-close';
  close.setAttribute('aria-label', 'Ẩn thông báo');
  close.innerHTML = CLOSE_SVG;
  close.addEventListener('click', onClose);
  right.append(close);
  el.append(msg, right);
  return el;
}

function render() {
  ensureCss();
  if (flash && Date.now() - flash.at >= FLASH_MS) flash = null;
  const slot = currentSlot();
  if (shownIn && shownIn !== slot) shownIn.replaceChildren();
  shownIn = slot;
  if (slot) {
    const items = [];
    if (flash) items.push(bannerEl(flash, () => { flash = null; render(); }));
    if (banner) items.push(bannerEl(banner, clearStatus));
    slot.replaceChildren(...items);
  }
  // Chỉ theo dõi DOM khi còn thứ để hiện: khung đổi theo tài liệu (hoặc chưa có) thì vẽ lại.
  const waiting = !!(banner || flash);
  if (waiting && !slotWatch) {
    slotWatch = new MutationObserver(() => { if (currentSlot() !== shownIn) render(); });
    slotWatch.observe(document.body, { childList: true, subtree: true });
  } else if (!waiting && slotWatch) {
    slotWatch.disconnect();
    slotWatch = null;
  }
}

/**
 * Thông báo thường (không `persist`) là băng rôn ngắn, tự ẩn sau 4 giây.
 *
 * `persist: true` dành cho thông báo mô tả một TRẠNG THÁI (chưa đăng nhập, trình duyệt không hỗ trợ, có việc
 * cần người dùng xử lý): băng rôn ở lại tới khi trạng thái đổi hoặc người dùng bấm ×. `level`
 * ('info' | 'warn' | 'error' | 'local') quyết định màu, và lỗi thì được đọc lên ngay (role=alert). 'local' là băng rôn
 * "Chưa đồng bộ": màu lỗi (chủ dự án chọn 25/09) nhưng vẫn role=status.
 * `action` ({ label, run }) thêm một nút để xử lý luôn, thay vì bắt người dùng tự nhớ phải làm gì.
 * `action.anKhiHep` ẩn nút ở khổ <=520px để băng rôn gọn một hàng; chỉ dùng khi việc đó còn lối khác trong app.
 */
export function setStatus(text, { persist = false, level = 'info', action = null } = {}) {
  if (persist) {
    banner = { text, level, action };
  } else {
    flash = { text, level, action, at: Date.now() };
    clearTimeout(flashTimer);
    flashTimer = setTimeout(render, FLASH_MS);
  }
  render();
}

/** Xoá băng rôn trạng thái khi tình huống đã được giải quyết (hoặc người dùng bấm ×). */
export function clearStatus() {
  banner = null;
  render();
}

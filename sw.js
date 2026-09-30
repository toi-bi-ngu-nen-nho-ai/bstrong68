// Service worker của bstr: mở app không cần mạng. Luật phục vụ ở sw-luat.js; đổi tệp đó thì tăng cờ dưới đây (trình duyệt
// chỉ nhận service worker mới khi chính tệp này đổi). Không bao giờ chặn app: yêu cầu không phục vụ được thì trả lỗi mạng
// như khi không có service worker. Có bản sw.js "công tắc tắt" riêng để thay tệp này khi cần gỡ.
importScripts('/sw-luat.js?bstr-sw=1');

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const ten of await caches.keys()) if (ten.startsWith('bstr-ung-dung-') && ten !== KHO_UNG_DUNG) await caches.delete(ten);
  await self.clients.claim();
})()));

// Phản hồi đáng cất: cùng nguồn, thành công, không qua chuyển hướng (trình duyệt không nhận bản chuyển hướng khi mở trang).
// Tệp mà máy chủ trả HTML là tệp không có (máy chủ trả index.html cho đường dẫn lạ): trả cho trang nhưng không cất; chỉ
// trang của app (laTrang) mới là HTML.
const tot = (res, laTrang = false) =>
  res.ok && res.type === 'basic' && !res.redirected && (laTrang || !/^text\/html/i.test(res.headers.get('content-type') || ''));
// Mất mạng mà chưa cất đúng URL này: dùng bản cất sẵn cùng đường dẫn (khác cờ), ví dụ tệp tải trước khi service worker kịp
// điều khiển trang, hay tệp worker nạp với cờ riêng. Có mạng thì không bao giờ đi đường này. Nhiều bản (lên bản mới, kho chưa
// dọn bản cũ) thì lấy bản cất sau cùng.
const duPhong = async (kho, req, loi) => (await hanKho(kho.matchAll(req, { ignoreSearch: true, ignoreVary: true }))).pop() || Promise.reject(loi);

// Lệnh đọc bộ nhớ đệm treo (lỗi trình duyệt, đĩa bận: không trả lời, không báo lỗi) quá CHO_KHO_MS thì coi như bộ nhớ đệm hỏng: đi mạng
// như không có service worker, không để app đứng trắng mãi. Lệnh đọc thường chỉ mất vài mili giây.
const CHO_KHO_MS = 5000;
function hanKho(p) {
  let hen;
  const het = new Promise((_, loi) => { hen = setTimeout(() => loi(new Error('bộ nhớ đệm không trả lời')), CHO_KHO_MS); });
  return Promise.race([p, het]).finally(() => clearTimeout(hen));
}

async function trang(e) {
  const khoP = caches.open(KHO_UNG_DUNG);
  const mang = fetch(e.request).then((res) => {
    if (tot(res, true)) {
      const ban = res.clone();
      e.waitUntil(khoP.then((kho) => kho.put('/', ban)).catch(() => {}));
    }
    return res;
  });
  e.waitUntil(mang.catch(() => {}));
  // Bộ nhớ đệm lỗi hay treo: dùng luôn lượt mạng đã gọi (không tải trang hai lần).
  const cat = await hanKho(khoP.then((kho) => kho.match('/'))).catch(() => null);
  if (!cat) return mang;
  // Máy chủ lỗi (5xx) hay chặn/giới hạn (4xx: Cloudflare 403, 429): bản đã cất. Chuyển hướng (status 0) đi qua.
  return Promise.race([
    mang.then((res) => (res.status >= 400 ? cat : res), () => cat),
    new Promise((ok) => setTimeout(() => ok(cat), CHO_TRANG_MS)),
  ]);
}

// Nội dung đúng mã kiểm trong URL (?…&bstr-nt=<16 hex đầu SHA-256>, make-deploy gắn); URL không mang mã thì coi là đúng.
const dungMa = async (res, bam) => !bam || (await sha256Hex(await res.clone().arrayBuffer())).slice(0, 16) === bam;

async function coDinh(e) {
  const kho = await hanKho(caches.open(KHO_UNG_DUNG));
  const cat = await hanKho(kho.match(e.request));
  if (cat) return cat;
  try {
    const bam = bamTrongUrl(e.request.url);
    let res = await fetch(e.request);
    // Vài giây đầu sau khi đưa lên, máy chủ có thể trả bản cũ dưới URL mới: sai mã thì tải lại một lần bỏ bộ nhớ HTTP; vẫn sai
    // thì trả cho trang mà không cất (không ghim bản cũ dưới URL mới; lần mở sau tải lại).
    if (tot(res) && !(await dungMa(res, bam))) {
      res = await fetch(e.request, { cache: 'reload' });
      if (!(await dungMa(res, bam))) return res;
    }
    if (tot(res)) e.waitUntil(kho.put(e.request, res.clone()).catch(() => {}));
    return res;
  } catch (loi) {
    return duPhong(kho, e.request, loi);
  }
}

async function lamMoiNen(e) {
  const kho = await hanKho(caches.open(KHO_UNG_DUNG));
  const cat = await hanKho(kho.match(e.request));
  const mang = fetch(e.request).then((res) => {
    if (tot(res)) e.waitUntil(kho.put(e.request, res.clone()).catch(() => {}));
    return res;
  });
  if (cat) {
    e.waitUntil(mang.catch(() => {}));
    return cat;
  }
  try {
    return await mang;
  } catch (loi) {
    return duPhong(kho, e.request, loi);
  }
}

self.addEventListener('fetch', (e) => {
  const r = e.request;
  const loai = phanLoai({ method: r.method, url: r.url, mode: r.mode, range: r.headers.has('range') }, self.location.origin);
  const phucVu = { trang, 'co-dinh': coDinh, 'lam-moi-nen': lamMoiNen }[loai];
  // Bộ nhớ đệm lỗi (đầy, hỏng): đi mạng như không có service worker.
  if (phucVu) e.respondWith(phucVu(e).catch(() => fetch(r)));
});

async function sha256Hex(buf) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Cất sẵn (trang nhắn 20 giây sau khi mở, khi có mạng): mọi tệp trong bstr-ngoai-tuyen.json (kèm mã kiểm nội dung), trang
 * '/', và tệp lần mở này đã dùng; tệp đã có thì bỏ qua, CAT_SONG_SONG tệp một lúc. Tệp tải về khác mã kiểm (máy chủ đang
 * đổi bản) thì không cất. Cất đủ danh sách rồi mới dọn mục không còn cần, mỗi phiên bản danh sách một lần.
 */
async function catSan(dung) {
  const res = await fetch('/bstr-ngoai-tuyen.json', { cache: 'no-store' });
  if (!res.ok) return; // máy xem trước không có danh sách: chỉ cất khi dùng
  const { phien, tep } = await res.json();
  const origin = self.location.origin;
  const kho = await caches.open(KHO_UNG_DUNG);
  const giu = dsGiu(tep, dung, origin);
  const trongDs = new Set([...tep, '/'].map((u) => new URL(u, origin).href));
  const coSan = new Set((await kho.keys()).map((r) => r.url));
  const can = [...giu].filter((u) => !coSan.has(u) && u !== new URL(DA_DON, origin).href);
  let thieu = 0;
  let hetCho = false;
  let i = 0;
  const tho = async () => {
    while (i < can.length) {
      const u = can[i++];
      try {
        const r = await fetch(u);
        if (!tot(r, new URL(u).pathname === '/') || !(await dungMa(r, bamTrongUrl(u)))) throw new Error(`tệp không dùng được (${r.status})`);
        await kho.put(u, r);
      } catch (loi) {
        if (trongDs.has(u)) thieu++;
        if (loi?.name === 'QuotaExceededError') hetCho = true;
        console.warn('[bstr] chưa cất được', u, loi);
      }
    }
  };
  await Promise.all(Array.from({ length: CAT_SONG_SONG }, tho));
  // Lần mở sau cất tiếp phần thiếu, rồi mới dọn. Trừ khi hết chỗ: dọn ngay, bộ nhớ đệm dùng chung hạn mức với dữ liệu tài liệu.
  if (thieu && !hetCho) return;
  const daDon = await kho.match(DA_DON);
  if (!hetCho && daDon && (await daDon.text()) === phien) return;
  for (const r of await kho.keys()) if (!giu.has(r.url)) await kho.delete(r);
  await kho.put(DA_DON, new Response(phien));
}

let dangCat = null;
self.addEventListener('message', (e) => {
  if (e.data?.loai !== 'cat-san') return;
  dangCat ??= catSan(Array.isArray(e.data.dung) ? e.data.dung : [])
    .catch((loi) => console.warn('[bstr] cất sẵn chưa xong', loi))
    .finally(() => { dangCat = null; });
  e.waitUntil(dangCat);
});

// Service worker của bstr: mở app không cần mạng. Luật phục vụ ở sw-luat.js; đổi tệp đó thì tăng cờ dưới đây (trình duyệt
// chỉ nhận service worker mới khi chính tệp này đổi). Không bao giờ chặn app: yêu cầu không phục vụ được thì trả lỗi mạng
// như khi không có service worker. Có bản sw.js "công tắc tắt" riêng để thay tệp này khi cần gỡ.
importScripts('/sw-luat.js?bstr-sw=1');

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const ten of await caches.keys()) if (ten.startsWith('bstr-ung-dung-') && ten !== KHO_UNG_DUNG) await caches.delete(ten);
  await self.clients.claim();
})()));

const tot = (res) => res.ok && res.type === 'basic';
// Mất mạng mà chưa cất đúng URL này: dùng bản cất sẵn cùng đường dẫn (khác cờ), ví dụ tệp tải trước khi service worker kịp
// điều khiển trang, hay tệp worker nạp với cờ riêng. Có mạng thì không bao giờ đi đường này.
const duPhong = async (kho, req, loi) => (await kho.match(req, { ignoreSearch: true, ignoreVary: true })) || Promise.reject(loi);

async function trang(e) {
  const kho = await caches.open(KHO_UNG_DUNG);
  const mang = fetch(e.request).then(async (res) => {
    if (tot(res)) await kho.put('/', res.clone());
    return res;
  });
  e.waitUntil(mang.catch(() => {}));
  const cat = await kho.match('/');
  if (!cat) return mang;
  return Promise.race([
    mang.then((res) => (res.status >= 500 ? cat : res), () => cat),
    new Promise((ok) => setTimeout(() => ok(cat), CHO_TRANG_MS)),
  ]);
}

async function coDinh(e) {
  const kho = await caches.open(KHO_UNG_DUNG);
  const cat = await kho.match(e.request);
  if (cat) return cat;
  try {
    const res = await fetch(e.request);
    if (tot(res)) e.waitUntil(kho.put(e.request, res.clone()));
    return res;
  } catch (loi) {
    return duPhong(kho, e.request, loi);
  }
}

async function lamMoiNen(e) {
  const kho = await caches.open(KHO_UNG_DUNG);
  const cat = await kho.match(e.request);
  const mang = fetch(e.request).then(async (res) => {
    if (tot(res)) await kho.put(e.request, res.clone());
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
  if (loai === 'trang') e.respondWith(trang(e));
  else if (loai === 'co-dinh') e.respondWith(coDinh(e));
  else if (loai === 'lam-moi-nen') e.respondWith(lamMoiNen(e));
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
  let i = 0;
  const tho = async () => {
    while (i < can.length) {
      const u = can[i++];
      try {
        const r = await fetch(u);
        const bam = bamTrongUrl(u);
        if (!tot(r) || (bam && (await sha256Hex(await r.clone().arrayBuffer())).slice(0, 16) !== bam)) throw new Error(`tệp không dùng được (${r.status})`);
        await kho.put(u, r);
      } catch (loi) {
        if (trongDs.has(u)) thieu++;
        console.warn('[bstr] chưa cất được', u, loi);
      }
    }
  };
  await Promise.all(Array.from({ length: CAT_SONG_SONG }, tho));
  if (thieu) return; // lần mở sau cất tiếp phần thiếu, rồi mới dọn
  const daDon = await kho.match(DA_DON);
  if (daDon && (await daDon.text()) === phien) return;
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

// Mở app không cần mạng: đăng ký service worker /sw.js sau khi trang tải xong (không làm chậm lần mở), 20 giây sau nhờ nó
// cất sẵn mọi tệp của app kèm các tệp lần mở này đã dùng. Lỗi gì cũng chỉ ghi console: app chạy như không có service worker.
export function batNgoaiTuyen({ nav = globalThis.navigator, win = globalThis.window, perf = globalThis.performance, choMs = 20000 } = {}) {
  const sw = nav?.serviceWorker;
  if (!sw) return;
  // Mặc định trình duyệt chỉ ghi 250 tệp tải đầu tiên; lần mở app đã khoảng 100.
  try { perf.setResourceTimingBufferSize(1000); } catch {}
  const dangKy = () => {
    sw.register('/sw.js', { updateViaCache: 'none' }).catch((e) => console.warn('[bstr] chưa đăng ký được service worker', e));
    win.setTimeout(async () => {
      try {
        if (nav.onLine === false) return; // lần mở sau cất
        const reg = await sw.ready;
        const goc = win.location.origin + '/';
        const dung = perf.getEntriesByType('resource').map((e) => e.name).filter((u) => u.startsWith(goc));
        reg.active?.postMessage({ loai: 'cat-san', dung });
      } catch (e) {
        console.warn('[bstr] chưa nhờ cất sẵn được', e);
      }
    }, choMs);
  };
  if (win.document.readyState === 'complete') dangKy();
  else win.addEventListener('load', dangKy, { once: true });
}

import { migrateLocalData } from './bstr-migrate.js';
import './bstr-services.js?bstr-proxy=1';

try {
  globalThis.bstrMigrationReport = await migrateLocalData();
  // Khoá kho kẹt (Phần A2): dọn TRƯỚC khi nạp app, không thì worker kho chờ tới 30 giây rồi tài liệu mới hiện. Không chặn quá 2 giây;
  // hết giờ thì bật tín hiệu huỷ để việc dọn dừng hẳn (app và kho sắp chạy, không được xoá thêm bản ghi khoá nào nữa).
  await import('./bstr-khoa-ket.js?bstr-kk=2').then((m) => {
    const huy = new AbortController();
    const gio = new Promise((r) => setTimeout(() => { huy.abort(); r(); }, 2000));
    return Promise.race([m.giaiPhongKhoaKet({ signal: huy.signal }), gio]);
  }).catch((e) => console.warn('[bstr] chưa dọn được khoá kho kẹt', e));
  const bundles = JSON.parse(document.getElementById('bstr-bundles').textContent);
  for (const src of bundles) {
    await new Promise((resolve,reject) => {
      const script=document.createElement('script');
      script.src=src+'?bstr-schema=1&bstr-samples=1&bstr-web=1&bstr-proxy=1&bstr-login=2&bstr-f5=14'; script.async=false;
      script.onload=resolve; script.onerror=()=>reject(new Error(`Không tải được ${src}`));
      document.body.append(script);
    });
    if(src.includes('/runtime.')) {
      globalThis.rspackChunk_bstr_monorepo.push([['bstr-cache-v1'],{},runtime=>{
        const chunk=runtime.u,css=runtime.miniCssF;
        runtime.u=id=>chunk(id)+'?bstr-schema=1&bstr-samples=1&bstr-web=1&bstr-proxy=1&bstr-login=2&bstr-f5=14';
        if(css)runtime.miniCssF=id=>css(id)+'?bstr-schema=1&bstr-f5=14';
      }]);
    }
  }
  import('./bstr-ngoai-tuyen.js?bstr-sw=3').then((m) => m.batNgoaiTuyen()).catch((e) => console.warn('[bstr] chưa bật được mở không cần mạng', e));
  await import('./drive-sync/index.js?bstr-login=8');
} catch (error) {
  console.error('[bstr] Không thể khởi động an toàn',error);
  document.getElementById('bstrIntroOverlay')?.remove();
  // Màn này nối tiếp màn intro: cùng nền, cùng chữ ký "Bác sĩ Trọng" (token --c-intro-* của intro.css, theo
  // giao diện sáng/tối). Câu chính nói điều người dùng cần biết; lỗi kỹ thuật (thường là tiếng Anh) nằm trong
  // phần "Chi tiết kỹ thuật" cho ai cần báo lỗi.
  const style=document.createElement('style');
  style.textContent=`
.bstr-boot-error{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px;box-sizing:border-box;overflow:auto;
  background:var(--c-intro-bg,#fff);color:var(--c-intro-ink,#141414);font:15px/1.6 Inter,"Source Sans 3",system-ui,sans-serif}
.bstr-boot-card{width:min(440px,100%)}
.bstr-boot-error .bstr-boot-mark{margin:0 0 32px;font:600 30px/1 var(--font-baloo,system-ui);letter-spacing:-.01em}
.bstr-boot-mark span{color:var(--c-intro-blue,#1e96eb)}
.bstr-boot-error h1{margin:0 0 8px;font-size:20px;font-weight:600;line-height:1.35}
.bstr-boot-error .bstr-boot-msg{margin:0 0 24px;color:color-mix(in srgb,var(--c-intro-ink,#141414) 72%,transparent)}
.bstr-boot-error button{min-height:44px;padding:0 20px;border:0;border-radius:8px;cursor:pointer;font-family:inherit;font-size:15px;font-weight:500;line-height:1;
  background:var(--c-intro-blue,#1e96eb);color:#fff}
.bstr-boot-error button:focus-visible{outline:2px solid var(--c-intro-blue,#1e96eb);outline-offset:3px}
.bstr-boot-error details{margin-top:28px;font-size:14px;color:color-mix(in srgb,var(--c-intro-ink,#141414) 72%,transparent)}
.bstr-boot-error summary{cursor:pointer;width:max-content}
.bstr-boot-error pre{margin:8px 0 0;padding:12px;border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere;
  font:13px/1.5 "Source Code Pro",ui-monospace,monospace;background:color-mix(in srgb,var(--c-intro-ink,#141414) 6%,transparent)}`;
  const panel=document.createElement('div');
  panel.className='bstr-boot-error';
  panel.setAttribute('role','alert');
  panel.innerHTML=`<div class="bstr-boot-card">
    <p class="bstr-boot-mark" aria-hidden="true">Bác sĩ <span>T</span>rọng</p>
    <h1>Chưa mở được ứng dụng</h1>
    <p class="bstr-boot-msg"></p>
    <button type="button">Tải lại trang</button>
    <details><summary>Chi tiết kỹ thuật</summary><pre></pre></details></div>`;
  panel.querySelector('pre').textContent=String(error?.message||error);
  // Câu chính theo nguyên nhân. Lỗi tải script ("Không tải được …", ở trên) là chuyện mạng. bstr-migrate.js ném
  // sẵn câu tiếng Việt có việc người dùng tự làm được ("Đóng các tab cũ…", "Hãy dùng Chrome…"): đưa thẳng câu đó
  // lên. Lỗi khác không đoán nguyên nhân.
  const reason=String(error?.message||'');
  panel.querySelector('.bstr-boot-msg').textContent=reason.startsWith('Không tải được ')
    ?'Chưa tải được một phần của ứng dụng. Hãy kiểm tra kết nối mạng rồi tải lại trang.'
    :/^(Đóng các tab|Trình duyệt chưa hỗ trợ)/.test(reason)
      ?`Ứng dụng đã dừng lại trước khi mở tài liệu, để bảo vệ dữ liệu trên máy. ${reason}`
      :'Ứng dụng đã dừng lại trước khi mở tài liệu, để bảo vệ dữ liệu trên máy. Hãy tải lại trang; nếu vẫn gặp màn này, phần chi tiết bên dưới giúp tìm nguyên nhân.';
  panel.querySelector('button').onclick=()=>location.reload();
  document.head.append(style); document.body.append(panel);
  panel.querySelector('button').focus();
}

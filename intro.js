// Màn giới thiệu bằng JS thuần: đo đạc và timeline GSAP thao tác thẳng trên khối HTML tĩnh #bstrIntroOverlay
// có sẵn trong index.html. Các hằng số/công thức sửa lỗi hiển thị đã xác nhận bằng ảnh chụp thật (iOS Safari),
// không phải suy đoán.
(function () {
  "use strict";

  var SAFETY_TIMEOUT_MS = 90000;
  var FONT_READY_TIMEOUT_MS = 500;
  var T_CAO_MUC_TIEU = 0.42 * 0.8;
  var T_RONG_TOI_DA = 0.55 * 0.8;

  var overlay = document.getElementById("bstrIntroOverlay");
  if (!overlay) return;
  var cover = document.getElementById("bstrIntroCover");
  var logo = document.getElementById("introLogo");
  var letterT = document.getElementById("letterT");
  var bacSi = document.getElementById("textBacSi");
  var rong = document.getElementById("textRong");

  function doHopMucChuT(el) {
    var cs = getComputedStyle(el);
    var canvas = document.createElement("canvas");
    var ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.font = cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
    var o = ctx.measureText(el.textContent || "T");
    var baselineTuDinh = o.fontBoundingBoxAscent;
    return {
      left: -o.actualBoundingBoxLeft,
      right: o.actualBoundingBoxRight,
      top: baselineTuDinh - o.actualBoundingBoxAscent,
      bottom: baselineTuDinh + o.actualBoundingBoxDescent,
    };
  }

  var daXong = false;
  var safety, hanGioFont, daHuy = false, tl = null;

  // F5 nhanh hơn (chủ dự án chọn 25/09): khi F5, tài liệu sẵn sàng (~1 giây) trước khi timeline chạy hết (~1,9 giây),
  // nên người dùng chờ intro chứ không chờ app. Trình soạn thảo đã có khối thì phần intro còn lại chạy nhanh gấp
  // TANG_TOC: vẫn đủ các nhịp, chỉ không bắt chờ thêm. Lần đầu vào (app chậm hơn intro) không đổi. Kiểm mỗi khung
  // hình qua ticker của GSAP, chỉ trong lúc intro còn chạy.
  var TANG_TOC = 3;
  var appSanSang = false;
  function kiemTraSanSang() {
    if (!document.querySelector("bstr-page-root [data-block-id], bstr-bangve-root [data-block-id]")) return;
    appSanSang = true;
    gsap.ticker.remove(kiemTraSanSang);
    if (tl) tl.timeScale(TANG_TOC);
  }

  // Lần đầu vào (chủ dự án 25/09 tối: "hết intro là ra web mượt"): trước đây timeline ~2 giây xong là gỡ overlay dù app
  // chưa có gì (đo trên bstrong68.com: intro tắt 3,4 s, tài liệu hiện 10,7 s — 7 giây nhìn app tải dở, khựng 1,4 s).
  // Giờ timeline dừng ở màn logo (addPause) tới khi app sẵn sàng; chờ quá 1 giây thì hiện ba chấm (Web Animations,
  // chỉ opacity/transform nên chạy trên compositor, không khựng khi luồng chính bận). Đã phải chờ thì mở màn sau khi
  // phông xong và luồng chính rảnh. F5 (app sẵn trước điểm dừng) đi thẳng như cũ. Chờ tối đa CHO_TOI_DA_MS.
  var CHO_TOI_DA_MS = 60000; // mạng chậm đo được 25/09: tài liệu tới 30–35 s mới hiện
  var TRANG_WORKSPACE_KHAC = /^(all|collection|tag|trash|journals|settings|chat|home)$/;
  var doDaiCu = -1, onDinhTu = 0;
  function appDaSanSang() {
    if (document.querySelector("bstr-page-root [data-block-id], bstr-bangve-root [data-block-id]")) return true;
    var p = location.pathname;
    if (p === "/" || p === "") return false; // app còn đang tạo/mở workspace
    // Trang không có khối (danh sách, cài đặt, trang "không tìm thấy"): nội dung đứng yên một lúc là xong.
    // Trang tài liệu mà không ra khối (tài liệu đã xoá…) thì chờ lâu hơn, vì khối thường tới ngay sau tiêu đề.
    var m = p.match(/^\/workspace\/[^\/]+\/([^\/]+)/);
    var laTaiLieu = !!m && !TRANG_WORKSPACE_KHAC.test(m[1]);
    var el = document.querySelector('[data-testid="main-container"]') || document.getElementById("app");
    var doDai = el ? el.textContent.length : 0;
    if (doDai === 0) return false;
    if (doDai !== doDaiCu) { doDaiCu = doDai; onDinhTu = Date.now(); return false; }
    return Date.now() - onDinhTu >= (laTaiLieu ? 1500 : 300);
  }
  function hienCham() {
    var khung = document.createElement("div");
    var r = logo.getBoundingClientRect();
    khung.setAttribute("aria-hidden", "true");
    khung.style.cssText = "position:absolute;left:50%;top:" + Math.round(r.bottom + 28) + "px;display:flex;gap:10px;transform:translateX(-50%);opacity:0;pointer-events:none";
    for (var i = 0; i < 3; i++) {
      var cham = document.createElement("span");
      cham.style.cssText = "width:7px;height:7px;border-radius:50%;background:var(--c-intro-blue)";
      khung.appendChild(cham);
      if (cham.animate) cham.animate(
        [{ opacity: 0.25, transform: "scale(0.75)" }, { opacity: 1, transform: "scale(1)" }, { opacity: 0.25, transform: "scale(0.75)" }],
        { duration: 1100, delay: i * 180, iterations: Infinity, easing: "ease-in-out" }
      );
    }
    logo.parentNode.appendChild(khung);
    if (khung.animate) khung.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, fill: "forwards" });
    else khung.style.opacity = "1";
    return khung;
  }
  function anCham(khung) {
    if (!khung) return;
    var go = function () { if (khung.parentNode) khung.parentNode.removeChild(khung); };
    if (khung.animate) khung.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: "forwards" }).onfinish = go;
    else go();
  }
  function choApp() {
    if (appDaSanSang()) { window.setTimeout(function () { if (!daHuy) tl.resume(); }, 0); return; }
    var batDau = Date.now(), khung = null;
    (function kiem() {
      if (daHuy) return;
      if (appDaSanSang() || Date.now() - batDau > CHO_TOI_DA_MS) {
        anCham(khung);
        var phong = document.fonts ? Promise.race([document.fonts.ready, new Promise(function (xong) { window.setTimeout(xong, 800); })]) : Promise.resolve();
        phong.then(function () {
          requestAnimationFrame(function () {
            requestAnimationFrame(function () {
              var moMan = function () { if (!daHuy) tl.resume(); };
              if (window.requestIdleCallback) window.requestIdleCallback(moMan, { timeout: 600 });
              else window.setTimeout(moMan, 50);
            });
          });
        });
        return;
      }
      if (!khung && Date.now() - batDau > 1000) khung = hienCham();
      window.setTimeout(kiem, 100);
    })();
  }

  function finish() {
    if (daXong) return;
    daXong = true;
    window.clearTimeout(safety);
    window.clearTimeout(hanGioFont);
    if (typeof gsap !== "undefined") gsap.ticker.remove(kiemTraSanSang);
    daHuy = true;
    if (tl) tl.kill();
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    finish();
    return;
  }

  if (typeof gsap === "undefined") {
    // GSAP không tải được (CDN lỗi/chặn mạng) — không có gì để chạy animation, gỡ overlay ngay
    // thay vì treo màn hình trắng/nền chờ vĩnh viễn.
    finish();
    return;
  }

  // App thật (React mount + đọc IndexedDB workspace) chạy CÙNG lúc, cùng main thread, với timeline
  // này — đo bằng requestAnimationFrame trên bản build thật cho thấy có khoảng ~300-400ms nghẽn
  // main thread ngay giữa lúc chữ T đang bay vào (lặp lại y hệt ở cả lần tải nguội lẫn tải có cache,
  // nên không phải do mạng/asset — là do chính app khởi động). Mặc định GSAP chỉ "làm mượt" khi
  // nghẽn > 500ms; nghẽn 300-400ms đo được nằm DƯỚI ngưỡng đó nên GSAP coi như thời gian trôi qua
  // thật, khiến khung tiếp theo "nhảy cóc" bù lại phần đã trôi — đúng cảm giác "khựng rồi giật".
  // Hạ ngưỡng xuống 200ms: nghẽn cỡ đo được giờ được hoãn logic-thời-gian lại (chạy tiếp cứ như
  // chỉ 33ms trôi qua), nên animation dừng khựng rồi chạy tiếp êm thay vì giật bù — không thể "vẽ
  // lại" các khung hình đã mất (main thread bận thật thì trình duyệt không vẽ được), chỉ đổi cách
  // GSAP tính thời gian sau đó để cảm giác đỡ giật hơn.
  gsap.ticker.lagSmoothing(200, 33);

  safety = window.setTimeout(finish, SAFETY_TIMEOUT_MS);
  gsap.ticker.add(kiemTraSanSang);

  var fontsReady = document.fonts
    ? Promise.race([
        document.fonts.ready,
        new Promise(function (giaiQuyet) {
          hanGioFont = window.setTimeout(giaiQuyet, FONT_READY_TIMEOUT_MS);
        }),
      ])
    : Promise.resolve();

  fontsReady.then(function () {
    if (daHuy) return;

    var oT = letterT.getBoundingClientRect();
    var hopMuc = doHopMucChuT(letterT) || { left: 0, top: 0, right: oT.width, bottom: oT.height };
    var netMucRong = hopMuc.right - hopMuc.left;
    var netMucCao = hopMuc.bottom - hopMuc.top;
    var tamMucX = (hopMuc.left + hopMuc.right) / 2;
    var tamMucY = (hopMuc.top + hopMuc.bottom) / 2;

    var goiXPT = ((tamMucX / oT.width) * 100) + "% " + ((tamMucY / oT.height) * 100) + "%";

    var tamTX = oT.left + tamMucX;
    var tamTY = oT.top + tamMucY;
    var offsetX = window.innerWidth / 2 - tamTX;
    var offsetY = window.innerHeight / 2 - tamTY;
    var heSoTuChieuCao = (window.innerHeight * T_CAO_MUC_TIEU) / netMucCao;
    var heSoTuChieuRong = (window.innerWidth * T_RONG_TOI_DA) / netMucRong;
    var heSoPhong = Math.max(1, Math.min(heSoTuChieuCao, heSoTuChieuRong));

    var W = window.innerWidth;
    var tranDay = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tran-day")) || 0;
    var H = window.innerHeight + tranDay;

    var halfW = oT.width / 2;
    var halfH = oT.height / 2;
    var barH = oT.height * 0.26;
    var stemW = oT.width * 0.3;
    var boCuc = [
      [-halfW, -halfH],
      [halfW, -halfH],
      [halfW, -halfH + barH],
      [stemW / 2, -halfH + barH],
      [stemW / 2, halfH],
      [-stemW / 2, halfH],
      [-stemW / 2, -halfH + barH],
      [-halfW, -halfH + barH],
    ];

    function layDuongKhoet(heSo) {
      var T = boCuc
        .slice()
        .reverse()
        .map(function (p) {
          return (tamTX + p[0] * heSo).toFixed(1) + "px " + (tamTY + p[1] * heSo).toFixed(1) + "px";
        });
      return "polygon(0px 0px, " + W + "px 0px, " + W + "px " + H + "px, 0px " + H + "px, 0px 0px, " + T.join(", ") + ", " + T[0] + ", 0px 0px)";
    }

    var heSoDich =
      Math.max(
        (2 * Math.max(tamTX, W - tamTX)) / stemW,
        tamTY / Math.max(halfH - barH, 1),
        (H - tamTY) / halfH
      ) * 1.12;

    var heSoBatDau = 0.35;
    var tySoPhong = heSoDich / heSoBatDau;

    var oKhoet = { p: 0 };
    function capNhatKhoet() {
      var duong = layDuongKhoet(heSoBatDau * Math.pow(tySoPhong, oKhoet.p));
      cover.style.clipPath = duong;
      cover.style.setProperty("-webkit-clip-path", duong);
    }

    gsap.set(logo, { visibility: "visible" });
    gsap.set(letterT, { transformOrigin: goiXPT, x: offsetX, y: offsetY, scale: heSoPhong });
    gsap.set(bacSi, { opacity: 0, y: -25, scale: 0.95 });
    gsap.set(rong, { opacity: 0, x: 25, scale: 0.95 });

    tl = gsap.timeline({ onComplete: finish });
    if (appSanSang) tl.timeScale(TANG_TOC);

    tl.to(letterT, {
      x: 0,
      y: 0,
      scale: 1,
      duration: 1.05,
      ease: "power3.inOut",
      clearProps: "transform,transformOrigin",
    })
      .to(
        bacSi,
        { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: "back.out(1.2)", clearProps: "transform" },
        "-=0.5"
      )
      .to(
        rong,
        { opacity: 1, x: 0, scale: 1, duration: 0.5, ease: "power2.out", clearProps: "transform" },
        "-=0.5"
      )
      .to({}, { duration: 0.3 })
      .addPause("-=0.01", choApp)
      // Fade-out and hole-reveal used to leave a ~0.10s gap (0.15s fade, only 0.05s overlap)
      // where the screen just sits flat mid-transition before the reveal starts growing —
      // a visible seam. Faster fade (0.08s) + faster reveal (0.5s) + overlap widened to match
      // the fade exactly (zero gap, reveal starts the instant the fade finishes) closes it.
      .to([bacSi, letterT, rong], { opacity: 0, duration: 0.08, ease: "power1.in" })
      .to(
        oKhoet,
        {
          p: 1,
          duration: 0.5,
          ease: "none",
          onUpdate: capNhatKhoet,
          onComplete: function () {
            cover.style.clipPath = "polygon(0px 0px, 0px 0px, 0px 0px)";
            cover.style.setProperty("-webkit-clip-path", "polygon(0px 0px, 0px 0px, 0px 0px)");
          },
        },
        "-=0.08"
      );
  });
})();

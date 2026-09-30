export const CONFIG = {
  // Client ID OAuth của Google Cloud (loại Web application)
  clientId: '379778952109-38d1cm8b3jvruao1rplgftq99d9lccrk.apps.googleusercontent.com',
  scope: 'https://www.googleapis.com/auth/drive.file',
  // Worker giữ refresh token (services/dang-nhap). Phải CÙNG SITE với web để cookie SameSite=Strict đi kèm:
  // web thật dùng tên miền phụ; localhost:1000 dùng `wrangler dev` ở localhost:8787 (cổng khác vẫn cùng site).
  loginUrl: globalThis.location?.hostname === 'localhost' ? 'http://localhost:8787' : 'https://dang-nhap.bstrong68.com',
  folderName: 'Bác sĩ Trọng',
  filePrefix: 'bstr-workspace-',
  // Bản sao lưu chụp TRƯỚC khi ghi đè phải mang tiền tố riêng, nếu không nó
  // sẽ trở thành "bản mới nhất" và app lại mời khôi phục đúng dữ liệu vừa bỏ.
  backupPrefix: 'bstr-backup-',
  // Tệp dò của tuKiemTra() — không được trùng/bắt đầu bằng filePrefix hay
  // backupPrefix, nếu không nó sẽ lẫn vào danh sách phiên bản hoặc sao lưu thật.
  selfTestPrefix: 'bstr-selftest-',
  // Tệp gói chia sẻ MỘT tài liệu (chiaSeTaiLieu). Cũng phải là tiền tố riêng,
  // không bắt đầu bằng filePrefix/backupPrefix — nếu không nó lọt vào danh sách
  // phiên bản, bị tải về ghi đè cả workspace hoặc bị prune xoá mất.
  sharePrefix: 'bstr-chia-se-',
  // Người NHẬN tải gói chia sẻ công khai mà không cần đăng nhập Google, qua Worker
  // services/proxy: Worker giữ khoá API Google (Secret GOOGLE_API_KEY), mã web không
  // có khoá. localhost:1000 cũng nằm trong ALLOWED_ORIGINS của Worker nên dùng chung.
  shareUrl: 'https://proxy.bstrong68.com/api/worker/drive-share',
  // Bản lưu trên Drive: tối đa maxDevices thiết bị (hồ sơ trình duyệt), mỗi thiết bị keepVersions
  // bản mới nhất; thêm thiết bị mới thì thiết bị lâu không lưu nhất bị bỏ (drive.js banThua).
  maxDevices: 3,
  keepVersions: 5,
  keepBackups: 3,
  // Ảnh là tệp riêng trên Drive (tự gộp đợt 2, 28/09): mỗi ảnh một tệp anhPrefix + khoá ảnh, đẩy một lần; đẩy và tải
  // tối đa anhSongSong tệp một lúc. Tiền tố riêng: không trùng filePrefix, backupPrefix, sharePrefix, selfTestPrefix.
  anhPrefix: 'bstr-anh-',
  // Lỗi tạm của Drive (quá tải, quá hạn mức gọi) khi liệt kê/đẩy/tải ảnh: thử lại sau lần lượt các khoảng chờ này (ms).
  anhChoThuLai: [1000, 2000, 4000],
  // Ảnh lớn hơn mức này đẩy lên kiểu resumable (Drive khuyên dùng cho tệp trên 5 MB), nhỏ hơn thì multipart một lệnh.
  anhMultipartToiDa: 5 * 1024 * 1024,
  anhSongSong: 6,
  autoSaveMs: 2 * 60 * 1000,
  // Phần B (30/09): mở app mà máy khác có bản chưa gộp thì chờ bản mới nhất: sau choNutMs hiện nút "Xem bản trên máy ngay",
  // tới choToiDaMs mà chưa tải xong thì tự thôi chờ (không ghi gì). Đã bắt đầu ghi thì không thôi (sync.js henCho).
  choNutMs: 10 * 1000,
  choToiDaMs: 30 * 1000,
  signInTimeoutMs: 120 * 1000,
  syncStores: ['snapshots', 'updates', 'blobs', 'clocks', 'peerClocks'],
  // Id tài liệu mẫu ("Bắt đầu sử dụng", "Cách sử dụng Thư mục và Thẻ") — giữ
  // trên máy, KHÔNG BAO GIỜ đồng bộ lên Drive. Rỗng cho tới khi chủ sở hữu
  // chạy dongGoiTaiLieuMau(ids) rồi dán ids vào đây.
  taiLieuMauIds: [],
};

export const LS = {
  workspaceList: 'bstr-local-workspace',
  workspaceInfo: (id) => `global-cache:workspace-information:${id}`,
  signedIn: 'bstr-drive-sync:signed-in',
  state: 'bstr-drive-sync:state',
  deviceId: 'bstr-drive-sync:device-id',
};

// Liên kết nhận tài liệu (25/09): nút "Sao chép liên kết" chép <app>/?nhan=<id tệp Drive>.
// Người nhận bấm vào là mở app. Router của app bỏ query ngay khi chuyển sang /workspace/…, nên một đoạn
// script thường trong index.html cất id vào sessionStorage (khoá NHAN_KEY) trước khi bundle chạy; luồng dưới
// đây đọc tiếp khoá đó sau khi app khởi động.
export const NHAN_KEY = 'bstr-drive-sync:nhan';

export const linkNhan = (origin, fileId) => `${origin}/?nhan=${encodeURIComponent(fileId)}`;

/**
 * Hỏi người dùng, đăng nhập nếu cần (bước nhận sao lưu máy lên Drive trước khi ghi), chờ app tạo xong
 * workspace, nhận rồi mở tài liệu. Khoá chỉ bị xoá khi đã có kết quả: nếu trang tải lại giữa chừng (đăng
 * nhập xong mà lấy dữ liệu từ Drive về), lần mở sau nhận tiếp. Mỗi lần tải trang chỉ chạy một lần.
 */
export function createNhanFlow({ storage, idTuLink, hoiNhan, daDangNhap, dangNhap, choWorkspace, nhan, mo, setStatus }) {
  const doc = () => { try { return storage.getItem(NHAN_KEY); } catch { return null; } };
  const xoa = () => { try { storage.removeItem(NHAN_KEY); } catch {} };
  let dangChay = null;

  async function chayMotLan(truoc) {
    const raw = doc();
    if (!raw) return 'khong-co';
    let id;
    try { id = idTuLink(raw); } catch {
      xoa();
      setStatus('Liên kết nhận tài liệu không đúng. Hãy nhờ người gửi chép lại liên kết.', { persist: true, level: 'error' });
      return 'link-hong';
    }
    await truoc?.();
    if (await hoiNhan() !== 'nhan') {
      xoa();
      setStatus('Chưa nhận tài liệu. Mở lại liên kết khi bạn muốn nhận.');
      return 'de-sau';
    }
    if (!daDangNhap() && await dangNhap() !== true) {
      xoa();
      setStatus('Chưa nhận tài liệu: cần đăng nhập Google để sao lưu dữ liệu trên máy trước khi thêm. Mở lại liên kết để thử lại.', { persist: true, level: 'warn' });
      return 'chua-dang-nhap';
    }
    try {
      await choWorkspace();
      xoa();
      mo(await nhan(id));
      return 'da-nhan';
    } catch (e) {
      xoa();
      console.error('[drive-sync] nhận tài liệu từ liên kết thất bại', e);
      // Sao lưu hỏng thì nhanGoi() đã báo đúng lý do; không ghi đè câu đó.
      if (!String(e?.message || '').startsWith('Không sao lưu được')) {
        setStatus('Chưa nhận được tài liệu. Liên kết có thể đã hết hạn, hoặc người gửi đã xoá tệp trên Drive.', { persist: true, level: 'error' });
      }
      return 'loi';
    }
  }

  return { chay: (truoc) => (dangChay ??= chayMotLan(truoc)) };
}

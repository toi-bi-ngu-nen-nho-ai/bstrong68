import { CONFIG, LS } from './config.js';
import { exportAll, restore, deviceId, taiLieuMauBundle } from './store.js';
import { getToken, isSignedIn, signIn, signOut } from './auth.js';
import {
  ensureFolder, uploadJson, listVersions, listBackups, downloadJson, pruneVersions, pruneBackups,
  listSelfTest, deleteFile,
} from './drive.js';
import {
  showSignIn, showConflict, showFirstRun, showShrinkWarning, setStatus, clearStatus,
} from './ui.js';

const readState = () => {
  try { return JSON.parse(localStorage.getItem(LS.state) || 'null'); }
  catch { return null; }
};
const writeState = (s) => localStorage.setItem(LS.state, JSON.stringify(s));

/**
 * Dòng lặng trong menu Không gian làm việc: lần gần nhất bản trên Drive khớp máy này. Lần lưu nền
 * không bật toast, nên đây là chỗ người dùng xem được lần lưu cuối.
 */
export function moTaLanLuu(now = new Date()) {
  const savedAt = readState()?.savedAt;
  const d = savedAt ? new Date(savedAt) : null;
  if (!d || Number.isNaN(d.getTime())) return 'Chưa lưu lên Drive lần nào';
  const gio = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? `Đã lưu Drive lúc ${gio}` : `Đã lưu Drive lúc ${gio} ${d.toLocaleDateString('vi-VN')}`;
}

/** Tên thiết bị hiện cho người dùng, tự đặt từ trình duyệt: "Chrome · Windows", "Safari · iPhone". */
export function tenThietBi(ua = globalThis.navigator?.userAgent || '') {
  const trinhDuyet = [[/Edg\//, 'Edge'], [/coc_coc_browser/, 'Cốc Cốc'], [/OPR\//, 'Opera'], [/Firefox\//, 'Firefox'],
    [/Chrome\/|CriOS\//, 'Chrome'], [/Safari\//, 'Safari']].find(([re]) => re.test(ua))?.[1] || 'Trình duyệt';
  const heDieuHanh = [[/iPhone/, 'iPhone'], [/iPad/, 'iPad'], [/Android/, 'Android'], [/Windows/, 'Windows'],
    [/Mac OS X|Macintosh/, 'macOS'], [/CrOS/, 'ChromeOS'], [/Linux/, 'Linux']].find(([re]) => re.test(ua))?.[1] || 'máy khác';
  return `${trinhDuyet} · ${heDieuHanh}`;
}

let folderId = null;
let busy = false;
let dangHoiDangNhap = false;

/**
 * Chữ ký của một store. ĐẾM BẢN GHI THÔI LÀ KHÔNG ĐỦ: sửa nội dung một tài
 * liệu đã có chỉ ghi đè bản ghi `snapshots` cũ, số lượng không đổi — vân tay
 * trùng, lần lưu bị bỏ qua, và người dùng đọc "Không có thay đổi mới" trong
 * khi bản sửa của họ không bao giờ rời khỏi máy. Nên gộp thêm tổng độ dài
 * phần nhị phân đã mã hoá và mốc thời gian mới nhất nhìn thấy được.
 */
function storeSig(records) {
  let soByte = 0;
  let moiNhat = '';
  for (const r of records) {
    const bin = r && (r.bin || r.data);
    if (bin && typeof bin.__u8 === 'string') soByte += bin.__u8.length;
    const at = r && (r.updatedAt || r.createdAt || r.timestamp);
    const iso = at && typeof at.__date === 'string' ? at.__date : '';
    if (iso > moiNhat) moiNhat = iso;
  }
  return `${records.length}:${soByte}:${moiNhat}`;
}

/**
 * Dấu vân tay rẻ tiền và tất định của toàn bộ dữ liệu cục bộ. Dùng để bỏ qua
 * lần lưu không có thay đổi — nếu không, năm lần lưu y hệt nhau sẽ ăn sạch
 * 5 ô phiên bản trên Drive.
 */
export function fingerprint(payload) {
  const parts = [];
  for (const ws of payload.workspaces) {
    const sigs = Object.keys(ws.stores).sort().map((k) => `${k}=${storeSig(ws.stores[k])}`).join(',');
    parts.push(`${ws.id}{${sigs}}`);
  }
  return parts.sort().join('|');
}

/**
 * Số tài liệu = số docId khác nhau trong `snapshots` và `updates` (tài liệu vừa tạo còn nằm
 * trong `updates` cho tới khi được gộp vào `snapshots`). KHÔNG đếm bản ghi: kho lưu trữ gộp các
 * update vào snapshot rồi xoá chúng, số bản ghi giảm dù không mất tài liệu nào, và lần lưu
 * nền sẽ từ chối mãi vì tưởng tài liệu ít đi.
 */
export function docCount(payload) {
  return payload.workspaces.reduce((n, ws) => {
    const ids = new Set();
    for (const r of [...(ws.stores.snapshots || []), ...(ws.stores.updates || [])]) {
      if (r && r.docId) ids.add(r.docId);
    }
    return n + ids.size;
  }, 0);
}

/** Lấy token; nếu phiên ở máy chủ đăng nhập đã hết thì mời đăng nhập lại đúng một lần. */
export async function ensureToken() {
  try {
    return await getToken();
  } catch (e) {
    // Lỗi mạng hay máy chủ đăng nhập lỗi tạm: phiên vẫn còn, không bắt đăng nhập lại; lượt lưu sau thử lại.
    if (!e?.hetPhien || dangHoiDangNhap) throw e;
    dangHoiDangNhap = true;
    try {
      signOut(); // xoá cờ cũ, nếu không lần tải trang sau vẫn không hỏi lại
      setStatus('Phiên Google đã hết hạn, hãy đăng nhập lại');
      const choice = await showSignIn();
      if (choice !== 'google') {
        baoChuaDongBo();
        throw e;
      }
      return await signIn();
    } finally {
      dangHoiDangNhap = false;
    }
  }
}

export async function folder() {
  if (!folderId) folderId = await ensureFolder(await ensureToken());
  return folderId;
}

/**
 * Tệp phiên bản mới nhất trên Drive — CHỈ liệt kê, không tải nội dung.
 * Câu hỏi thật sự luôn là "tệp mới nhất trên Drive có phải tệp máy này vừa ghi
 * không", và danh sách đã trả về `id` + `createdTime` rồi. Tải cả tệp 1,4 MB
 * mỗi 2 phút chỉ để đọc `savedAt` là tốn băng thông và thêm một chỗ để hỏng.
 */
async function newestOnDrive(token) {
  const files = await listVersions(token, await folder());
  return files[0] || null;
}

/** Drive đã đổi so với lần máy này ghi thành công? So theo id tệp. */
const daDoiTrenDrive = (latest, state) => !!latest && latest.id !== (state?.fileId || null);

export async function saveNow({ force = false, background = false } = {}) {
  if (busy) return;
  busy = true;
  let dangTaiVe = false;
  // Người dùng cố ý ghi đè (force, hoặc vừa chọn "Giữ bản máy này" trong hộp
  // thoại xung đột) thì KHÔNG được bỏ qua vì vân tay trùng: bản trên Drive là
  // một bản khác, bỏ qua tức là làm ngược lại điều họ vừa yêu cầu.
  let ghiDeTheoYNguoiDung = force;
  try {
    if (!background) setStatus('Đang lưu lên Drive...');
    const token = await ensureToken();
    const latest = await newestOnDrive(token);
    const state = readState();

    // KHÔNG lọc theo deviceId: tệp mới nhất trên Drive khác tệp máy này ghi nhận
    // là phải hỏi, kể cả khi chính máy này đã ghi nó — máy này cũng có thể hỏng.
    if (!force && daDoiTrenDrive(latest, state)) {
      // Lần lưu nền KHÔNG bao giờ được mở hộp thoại: nó giữ khoá `busy` cho tới
      // khi người dùng trả lời, làm mọi lần lưu sau đó im lặng không chạy, và
      // nó nhảy ra giữa lúc người ta đang gõ. Bỏ qua lượt này và báo trạng thái.
      if (background) {
        setStatus('Trên Drive có bản mới hơn, có thể từ máy khác. Lượt lưu này đã tạm dừng.', {
          persist: true, level: 'warn', action: { label: 'Chọn bản giữ lại', run: () => saveNow() },
        });
        return;
      }
      const choice = await showConflict({ localAt: state?.savedAt, driveAt: latest.createdTime });
      if (choice === 'take-drive') {
        dangTaiVe = true;
        return await pullFromDrive({ confirmed: true }); // giữ nguyên khoá
      }
      // Mọi câu trả lời đều phải xử lý tường minh. Trước đây chỉ 'cancel' được
      // bắt, nên bất kỳ đáp án lạ nào cũng rơi thẳng xuống nhánh ghi đè.
      if (choice !== 'keep-local') { setStatus('Đã bỏ qua lần lưu này'); return; }
      ghiDeTheoYNguoiDung = true;
    }

    // Tới đây là biết chắc: không còn xung đột nào đang treo (dù vì không có,
    // dù vì force ghi đè có chủ ý). Hai banner thường trực saveNow có thể bật
    // ("Drive có bản mới", "số tài liệu ít đi") đều là điều kiện tính lại từ
    // đầu mỗi lần chạy — nên banner cũ, nếu còn, chắc chắn đã lỗi thời. Xoá
    // một lần ở đây thay vì rải clearStatus() vào từng nhánh return phía sau.
    clearStatus();

    const payload = await exportAll();

    // Máy này tự bảo vệ mình: không còn gì trong máy thì tuyệt đối không ghi đè.
    if (payload.workspaces.length === 0) {
      setStatus('Không thấy dữ liệu trên máy nên chưa lưu, để không ghi đè bản tốt trên Drive', { persist: true, level: 'warn' });
      return;
    }

    const vanTay = fingerprint(payload);
    const soTaiLieu = docCount(payload);

    if (!ghiDeTheoYNguoiDung && state && state.fingerprint === vanTay) {
      if (!background) setStatus('Không có thay đổi mới');
      return;
    }

    // Trạng thái do phiên bản cũ ghi có `docCount` đếm bản ghi, không so được với số tài
    // liệu: bỏ qua nó; lần lưu này ghi `soTaiLieu`.
    if (state && typeof state.soTaiLieu === 'number' && soTaiLieu < state.soTaiLieu) {
      if (background) {
        setStatus('Số tài liệu trên máy ít đi so với lần lưu trước, nên chưa lưu lên Drive.', {
          persist: true, level: 'warn', action: { label: 'Xem và xác nhận', run: () => saveNow() },
        });
        return;
      }
      const dongY = await showShrinkWarning({ oldCount: state.soTaiLieu, newCount: soTaiLieu });
      if (!dongY) { setStatus('Đã huỷ lưu'); return; }
    }

    const name = `${CONFIG.filePrefix}${payload.savedAt.replace(/[:.]/g, '-')}.json`;
    const up = await uploadJson(token, await folder(), name, payload, {
      bstrThietBi: deviceId(), bstrTen: tenThietBi(), bstrSoTaiLieu: String(soTaiLieu),
    });
    writeState({
      fileId: up.id,
      savedAt: payload.savedAt,
      deviceId: deviceId(),
      fingerprint: vanTay,
      soTaiLieu,
    });

    // Tối đa CONFIG.maxDevices thiết bị, mỗi thiết bị CONFIG.keepVersions bản; thiết bị lâu không lưu nhất bị bỏ.
    await pruneVersions(token, await listVersions(token, await folder()));
    // Lượt này không tạo bản sao lưu nào, nên dọn bản sao lưu cũ ở đây là an toàn.
    await pruneBackups(token, await listBackups(token, await folder()));
    clearStatus(); // lưu được rồi thì cảnh báo "cần chú ý" không còn đúng nữa
    if (!background) setStatus('Đã lưu lên Drive');
  } catch (e) {
    if (dangTaiVe) {
      console.error('[drive-sync] tải dữ liệu từ Drive thất bại', e);
      setStatus('Chưa tải được dữ liệu từ Drive. Hãy kiểm tra kết nối rồi thử lại.', { persist: true, level: 'error' });
    } else {
      console.error('[drive-sync] lưu thất bại', e);
      setStatus('Chưa lưu được lên Drive. Tài liệu vẫn nằm trên máy; ứng dụng sẽ tự thử lại.', {
        persist: true, level: 'error', action: { label: 'Thử lại ngay', run: () => saveNow() },
      });
    }
  } finally {
    busy = false;
  }
}

/**
 * Chụp toàn bộ dữ liệu trên máy lên Drive TRƯỚC khi ghi đè nó. Ném lỗi nếu
 * không chụp được — người gọi PHẢI dừng hẳn, thà không ghi còn hơn mất dữ liệu.
 * Dùng backupPrefix: bản sao lưu KHÔNG được len vào dòng phiên bản, nếu không
 * lần khởi động sau app lại mời khôi phục đúng dữ liệu người dùng vừa bỏ.
 */
export async function saoLuuTruocKhiGhiDe() {
  setStatus('Đang sao lưu bản trên máy trước khi ghi đè...');
  const token = await ensureToken();
  const backup = await exportAll();
  const name = `${CONFIG.backupPrefix}${backup.savedAt.replace(/[:.]/g, '-')}.json`;
  return uploadJson(token, await folder(), name, backup);
}

/** Giả định KHOÁ đã được người gọi giữ. */
async function pullFromDrive({ confirmed = false } = {}) {
  const token0 = await ensureToken();
  const latest = await newestOnDrive(token0);
  if (!latest) { setStatus('Trên Drive chưa có bản nào'); return; }
  // Đã đồng bộ rồi thì khỏi tải: chính tệp này là tệp máy này ghi lần trước.
  if (!confirmed && readState()?.fileId === latest.id) return;
  // Đây mới là chỗ thật sự cần nội dung tệp.
  const payload = await downloadJson(token0, latest.id);
  // Máy chưa từng đồng bộ: bản Drive THAY hẳn dữ liệu máy (không hợp nhất), nếu không "Không gian làm việc mẫu"
  // máy tự tạo nằm cạnh bản Drive và lần lưu sau đẩy cả hai lên (27/09). Đã sao lưu máy này ngay bên dưới.
  const thayThe = !readState()?.fileId;

  // BẮT BUỘC: sao lưu bản đang có trên máy lên Drive TRƯỚC khi ghi đè nó.
  // Nếu sao lưu thất bại thì dừng hẳn, thà không đồng bộ còn hơn mất dữ liệu.
  // Dùng backupPrefix: bản sao lưu KHÔNG được len vào dòng phiên bản, nếu không
  // lần khởi động sau app lại mời khôi phục đúng dữ liệu người dùng vừa bỏ.
  try {
    await saoLuuTruocKhiGhiDe();
  } catch (e) {
    console.error('[drive-sync] sao lưu trước khi ghi đè thất bại', e);
    setStatus('Không sao lưu được bản trên máy nên chưa tải về. Dữ liệu trên máy chưa bị thay đổi.', { persist: true, level: 'error' });
    return;
  }

  setStatus('Đang tải dữ liệu từ Drive...');
  let boDi = [];
  try {
    boDi = (await restore(payload, { thayThe }))?.bo || [];
  } catch (e) {
    if (e?.code === 'BSTR_BACKUP_INVALID') {
      console.error('[drive-sync] bản sao lưu không qua kiểm tra đầu vào', e);
      setStatus('Bản sao lưu trên Drive không hợp lệ. Dữ liệu trên máy chưa bị ghi đè.', { persist: true, level: 'warn' });
      return;
    }
    // writeWorkspace đã xoá và ghi lại một phần các store rồi. Đây đúng là lúc
    // người dùng phải hành động — tuyệt đối không được báo "dữ liệu vẫn an toàn".
    console.error('[drive-sync] phục hồi dữ liệu thất bại', e);
    setStatus(
      'Phục hồi chưa xong, dữ liệu trên máy có thể còn thiếu. Tải lại trang rồi chọn '
      + '"Lấy bản trên Drive" một lần nữa.',
      { persist: true, level: 'error', action: { label: 'Tải lại trang', run: () => location.reload() } }
    );
    return;
  }
  writeState({
    fileId: latest.id,
    savedAt: payload.savedAt,
    deviceId: deviceId(),
    fingerprint: fingerprint(payload),
    soTaiLieu: docCount(payload),
  });
  // Sau khi tải lại, start() báo một lần "Đã lấy bản … về máy này: N tài liệu": người dùng vừa qua lúc căng nhất,
  // cần thấy dữ liệu đã về đủ.
  try { sessionStorage.setItem(DA_KHOI_PHUC, JSON.stringify({ savedAt: payload.savedAt, soTaiLieu: docCount(payload) })); } catch {}
  // Địa chỉ đang mở có thể trỏ vào workspace vừa bỏ: về trang gốc, app tự mở workspace còn trong danh sách.
  if (boDi.length) location.replace('/');
  else location.reload();
}

const DA_KHOI_PHUC = 'bstr-drive-da-khoi-phuc';

/** Báo (một lần) bản vừa khôi phục ở lần mở app ngay sau đó. Không có cờ thì không làm gì. */
function baoDaKhoiPhuc() {
  let info = null;
  try {
    info = JSON.parse(globalThis.sessionStorage?.getItem(DA_KHOI_PHUC) || 'null');
    globalThis.sessionStorage?.removeItem(DA_KHOI_PHUC);
  } catch {}
  const d = info?.savedAt ? new Date(info.savedAt) : null;
  if (!d || Number.isNaN(d.getTime())) return;
  const luc = d.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'numeric', year: 'numeric' });
  setStatus(`Đã lấy bản lưu lúc ${luc} từ Drive về máy này: ${info.soTaiLieu} tài liệu.`, { persist: true });
}

export async function loadFromDrive(opts = {}) {
  if (busy) { setStatus('Đang đồng bộ, thử lại sau ít giây'); return; }
  busy = true;
  try {
    await pullFromDrive(opts);
  } finally {
    busy = false;
  }
}

/** Client ID thật luôn có dạng <số>-<chuỗi>.apps.googleusercontent.com. */
/**
 * Băng rôn khách: chưa đăng nhập Drive thì tài liệu chỉ nằm trên máy này. Giọng nhẹ, theo chủ dự án
 * (25/09). Hiện lúc mở app và sau khi chọn không đăng nhập;
 * đăng nhập được thì lượt lưu đầu tiên xoá nó. Chưa cấu hình Client ID thì đồng bộ tắt hẳn: không hiện.
 */
export function baoChuaDongBo() {
  if (!clientIdDaCauHinh(CONFIG.clientId) || isSignedIn()) return;
  setStatus('Chưa đồng bộ: tài liệu chỉ đang nằm trên máy này.', {
    // Màn hẹp ẩn nút (chủ dự án 25/09) để băng rôn không tràn hàng: vẫn đăng nhập được ở menu Không gian làm việc.
    persist: true, level: 'local', action: { label: 'Đăng nhập', run: () => globalThis.bstrDriveSync?.requestSignIn?.(), anKhiHep: true },
  });
}

const clientIdDaCauHinh = (id) =>
  typeof id === 'string'
  && id.endsWith('.apps.googleusercontent.com')
  && !id.includes('THAY-BANG-CLIENT-ID');

/**
 * Tự kiểm tra toàn bộ đường đi tới Google Drive bằng một tệp dò riêng, không
 * đụng tới bản đồng bộ thật. Gọi tay từ console sau khi dán Client ID thật:
 *   await window.bstrDriveSync.tuKiemTra()
 *
 * AN TOÀN: không bao giờ ghi/sửa/xoá tệp có tên bắt đầu bằng filePrefix hay
 * backupPrefix; chỉ xoá đúng một tệp — id của chính tệp dò vừa tạo trong lượt
 * chạy này; không gọi restore(), không đụng IndexedDB, không ghi localStorage
 * của trạng thái đồng bộ. Hỏng bước nào thì dừng ngay ở đó, không dọn thêm gì
 * ngoài tệp dò (nếu đã chắc chắn tạo ra nó).
 */
export async function tuKiemTra() {
  const buoc = [];
  const ghi = (ok, msg) => { buoc.push({ ok, msg }); return ok; };
  const ketQua = () => {
    const dat = buoc.every((b) => b.ok);
    const dong = buoc.map((b) => `${b.ok ? '✓' : '✗'} ${b.msg}`).join('\n');
    console.log(`[drive-sync] tự kiểm tra:\n${dong}\nKẾT LUẬN: ${dat ? 'ĐẠT — mọi bước đều ổn' : 'THẤT BẠI — dừng ở bước lỗi trên'}`);
    return { pass: dat, steps: buoc };
  };

  if (!clientIdDaCauHinh(CONFIG.clientId)) {
    ghi(false, 'Chưa dán Client ID thật vào drive-sync/config.js (còn giữ giá trị mẫu THAY-BANG-CLIENT-ID) — không chạy, không gọi mạng.');
    return ketQua();
  }

  let token;
  try {
    token = await ensureToken(); // đúng đường đăng nhập sync.js đang dùng, không viết lại
    ghi(true, 'Đăng nhập Google thành công');
  } catch (e) {
    ghi(false, `Đăng nhập thất bại: ${e?.message || e}. Kiểm tra 3 chỗ hay hỏng: `
      + '(1) "Authorized JavaScript origins" của Client ID có đúng domain đang chạy app không; '
      + '(2) tài khoản Google đang dùng có nằm trong danh sách "Test users" của màn hình xin quyền OAuth không; '
      + '(3) Google Drive API đã bật (Enable) cho đúng project chưa.');
    return ketQua();
  }

  let fid;
  try {
    fid = await ensureFolder(token);
    ghi(true, `Tìm/tạo thư mục "${CONFIG.folderName}" thành công`);
  } catch (e) {
    ghi(false, `Tìm/tạo thư mục thất bại: ${e?.message || e}`);
    return ketQua();
  }

  const noiDung = { probe: true, at: new Date().toISOString(), nonce: Math.random().toString(36).slice(2) };
  const name = `${CONFIG.selfTestPrefix}${noiDung.at.replace(/[:.]/g, '-')}.json`;
  let up;
  try {
    up = await uploadJson(token, fid, name, noiDung);
    if (!up?.id || !up.name?.startsWith(CONFIG.selfTestPrefix)) {
      throw new Error('tệp tải lên không mang đúng tiền tố dò — dừng để khỏi xoá nhầm');
    }
    ghi(true, `Tải lên tệp dò "${name}" thành công`);
  } catch (e) {
    ghi(false, `Tải lên thất bại: ${e?.message || e}`);
    return ketQua();
  }

  try {
    const [phienBan, saoLuu] = await Promise.all([listVersions(token, fid), listBackups(token, fid)]);
    if (phienBan.some((f) => f.id === up.id) || saoLuu.some((f) => f.id === up.id)) {
      ghi(false, 'LỖI NGHIÊM TRỌNG: tệp dò lọt vào danh sách phiên bản hoặc sao lưu thật — dừng ngay, không xoá gì cả, hãy vào Drive kiểm tra tay.');
      return ketQua();
    }
    ghi(true, 'Tệp dò không lẫn vào danh sách phiên bản/sao lưu thật (lọc theo tiền tố đúng)');
  } catch (e) {
    ghi(false, `Kiểm tra danh sách phiên bản/sao lưu thất bại: ${e?.message || e}`);
    return ketQua();
  }

  try {
    const dsDo = await listSelfTest(token, fid);
    if (!dsDo.some((f) => f.id === up.id)) throw new Error('không thấy tệp dò vừa tạo khi liệt kê lại');
    ghi(true, 'Liệt kê lại thấy đúng tệp dò vừa tạo');
  } catch (e) {
    ghi(false, `Liệt kê tệp dò thất bại: ${e?.message || e}`);
    return ketQua();
  }

  try {
    const ve = await downloadJson(token, up.id);
    if (JSON.stringify(ve) !== JSON.stringify(noiDung)) throw new Error('nội dung tải về không khớp nội dung đã gửi lên');
    ghi(true, 'Tải về đúng nội dung đã gửi lên (round-trip khớp)');
  } catch (e) {
    ghi(false, `Tải về thất bại: ${e?.message || e}`);
    return ketQua();
  }

  try {
    await deleteFile(token, up.id);
    ghi(true, 'Đã xoá tệp dò');
  } catch (e) {
    ghi(false, `Xoá tệp dò thất bại — vào Google Drive xoá tay tệp "${name}": ${e?.message || e}`);
    return ketQua();
  }

  return ketQua();
}

/**
 * Đóng gói các tài liệu mẫu (ids) — snapshot của chúng và những blob CHỈ
 * chúng dùng — thành drive-sync/tai-lieu-mau.json rồi tải file này xuống máy.
 * Gọi tay từ console: await window.bstrDriveSync.dongGoiTaiLieuMau(['id1','id2'])
 * Sau đó: đặt file tải về vào thư mục drive-sync/ của repo, rồi dán đúng các
 * ids này vào CONFIG.taiLieuMauIds để exportAll() bắt đầu bỏ qua chúng.
 */
export async function dongGoiTaiLieuMau(ids) {
  const { banGhi, anhXa, giuLai } = await taiLieuMauBundle(ids);

  const url = URL.createObjectURL(new Blob([JSON.stringify(banGhi)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tai-lieu-mau.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  const dongTaiLieu = anhXa.map((d) => `  ${d.docId}: ${kb(d.size)} — ${d.blobKeys.length} blob`
    + (d.blobKeys.length ? ` (${d.blobKeys.join(', ')})` : '')).join('\n') || '  (không tìm thấy tài liệu nào trong ids đã cho)';
  const dongGiuLai = giuLai.length
    ? giuLai.map((g) => `  ${g.blobKey}: còn dùng bởi ${g.docIds.filter((d) => !ids.includes(d)).join(', ')} — GIỮ đồng bộ, không gói`).join('\n')
    : '  (không có blob nào bị dùng chung)';
  console.log(
    `[drive-sync] đã tải tai-lieu-mau.json\n`
    + `Tài liệu đã gói:\n${dongTaiLieu}\n`
    + `Blob dùng chung nên giữ lại (không gói):\n${dongGiuLai}`
  );
  return { anhXa, giuLai };
}

export async function start({ onSkip } = {}) {
  // Chưa có Client ID thì đồng bộ KHÔNG THỂ chạy: mọi lần đăng nhập đều hỏng.
  // Nằm im tuyệt đối — không modal, không trạng thái, không hẹn giờ, không
  // lắng nghe sự kiện — để ứng dụng chạy y như trước khi có nhánh này.
  if (!clientIdDaCauHinh(CONFIG.clientId)) {
    console.info('[drive-sync] chưa cấu hình Client ID — đồng bộ Google Drive đang tắt');
    return;
  }

  // Firefox chưa có indexedDB.databases(): exportAll sẽ hỏng ở mọi lần lưu và
  // người dùng chỉ thấy "Lưu lên Drive thất bại" mãi mãi. Nói thẳng rồi dừng.
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
    console.warn('[drive-sync] trình duyệt không có indexedDB.databases() — bỏ qua đồng bộ');
    setStatus('Trình duyệt này chưa hỗ trợ đồng bộ Drive. Hãy mở bằng Google Chrome.', { persist: true, level: 'warn' });
    return;
  }

  try {
    if (!isSignedIn()) {
      const choice = await showSignIn();
      if (choice !== 'google') {
        onSkip?.();
        // Không được để họ tưởng đang đồng bộ trong khi không hề.
        baoChuaDongBo();
        return;
      }
      await signIn();
    } else {
      await ensureToken();
    }
    // Đã đăng nhập: băng rôn "Chưa đồng bộ… Đăng nhập" hay lỗi đăng nhập trước đó không còn đúng. Trước đây chỉ lượt
    // lưu thành công mới xoá, nên chọn "Để sau" ở hộp xung đột thì băng rôn cũ ở lại (thử 25/09 trên bstrong68.com).
    clearStatus();

    const state = readState();
    const token = await ensureToken();
    const latest = await newestOnDrive(token);
    if (daDoiTrenDrive(latest, state)) {
      const local = await exportAll();
      const mayTrang = local.workspaces.length === 0 || docCount(local) === 0;
      if (mayTrang) {
        // Không có gì để giữ nên không được mời "Giữ bản máy này".
        const choice = await showFirstRun({ driveAt: latest.createdTime });
        if (choice === 'take-drive') return await loadFromDrive({ confirmed: true });
        // Từ chối thì DỪNG HẲN: nếu vẫn cài hẹn giờ, hai phút sau saveNow lại
        // chạy với state rỗng và hiện đúng hộp thoại xung đột mà máy trắng
        // không được phép thấy — kèm nút "Giữ bản máy này".
        setStatus('Chưa đồng bộ. Mở lại ứng dụng khi bạn muốn lấy dữ liệu từ Drive.', { persist: true });
        return;
      } else {
        const choice = await showConflict({ localAt: state?.savedAt, driveAt: latest.createdTime });
        if (choice === 'take-drive') return await loadFromDrive({ confirmed: true });
        if (choice === 'keep-local') await saveNow({ force: true });
      }
    } else {
      // Drive chưa đổi, hoặc chưa có bản nào: lưu ngay một lần ở tiền cảnh. Lần lưu nền không
      // được mở hộp thoại, nên khi số tài liệu ít đi thì chỉ lần lưu này hỏi được người dùng
      // (lời nhắc nền bảo "hãy tải lại trang để xác nhận").
      await saveNow({ force: !latest });
    }

    // Sau lượt lưu lúc mở app: lượt đó gọi clearStatus(), báo trước thì câu xác nhận bị xoá ngay.
    baoDaKhoiPhuc();
    setInterval(() => saveNow({ background: true }), CONFIG.autoSaveMs);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveNow({ background: true });
    });
    return true;
  } catch (e) {
    console.error('[drive-sync] khởi động lỗi', e);
    if (e?.loai === 'popup_failed_to_open') {
      // Bấm nút trên băng rôn là thao tác của người dùng, trình duyệt thường cho mở cửa sổ.
      setStatus('Trình duyệt đã chặn cửa sổ đăng nhập Google. Hãy cho phép cửa sổ bật lên rồi bấm Đăng nhập.', {
        persist: true, level: 'warn', action: { label: 'Đăng nhập', run: () => globalThis.bstrDriveSync?.requestSignIn?.() },
      });
      return;
    }
    if (e?.loai === 'popup_closed') return baoChuaDongBo(); // tự đóng cửa sổ Google = chưa đăng nhập, không phải lỗi mạng
    setStatus('Không kết nối được Google Drive. Tài liệu vẫn được lưu trên máy.', {
      persist: true, level: 'warn', action: { label: 'Tải lại trang', run: () => location.reload() },
    });
  }
}

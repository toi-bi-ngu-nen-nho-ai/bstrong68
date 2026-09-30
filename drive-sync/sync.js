import { CONFIG, LS } from './config.js';
import { exportAll, restore, deviceId, taiLieuMauBundle, laKhongGianMau, maHoa } from './store.js';
import { getToken, isSignedIn, signIn, signOut } from './auth.js';
import {
  ensureFolder, uploadJson, listVersions, listBackups, downloadJson, pruneVersions, pruneBackups,
  listSelfTest, deleteFile,
} from './drive.js';
import {
  showSignIn, showShrinkWarning, setStatus, clearStatus, moManChan, setCanhBaoAnh,
} from './ui.js';
import { gopPayload, banCanGop } from './gop.js';
import { dayAnh, taiAnhThieu } from './anh.js';

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

/** Băng rôn khi mở app lúc mất mạng: đang xem bản trên máy, kèm lần lưu Drive gần nhất. */
export function cauKhongMang(now = new Date()) {
  const lan = moTaLanLuu(now).replace(/^Đã lưu/, 'lưu').replace(/^Chưa/, 'chưa');
  return `Không có mạng: đang xem bản trên máy (${lan}). Có mạng lại sẽ tự lưu lên Drive.`;
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
    // Bản chưa mã hoá (exportAll({ maHoa: false })): cùng số như sau khi mã hoá (base64 dài 4 * ceil(n / 3), ngày ISO).
    else if (bin instanceof Uint8Array || bin instanceof ArrayBuffer) soByte += 4 * Math.ceil(bin.byteLength / 3);
    const at = r && (r.updatedAt || r.createdAt || r.timestamp);
    const iso = at && typeof at.__date === 'string' ? at.__date : at instanceof Date && Number.isFinite(+at) ? at.toISOString() : '';
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

/** Một nơi đồng bộ một lúc, kể cả giữa các tab cùng trình duyệt; tab khác đang giữ khoá thì bỏ lượt (trả undefined). */
function khoaDongBo(viec) {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return viec();
  return locks.request('bstr-drive-sync', { ifAvailable: true }, (lock) => (lock ? viec() : undefined));
}

let kenh = null;

/**
 * Tab khác sắp ghi dữ liệu đã gộp vào máy (gopNgay phát 'dang-gop' khi đang giữ khoá): tab này chặn nhập và chờ khoá,
 * vì chữ gõ ở đây lúc đó sẽ bị lượt ghi kia xoá. Khoá được nhả khi tab kia xong, hỏng hay bị đóng. Tab kia đã báo
 * 'da-ghi' (không kèm 'khong-ghi' sau đó) thì tải lại để đọc dữ liệu mới; không thì mở lại và chờ lượt sau. Tải lại cả khi
 * tab kia không ghi gì thì hai tab gộp hỏng rồi tải lại lẫn nhau mãi (tab vừa tải lại tự gộp).
 * index.js gọi lúc tải trang, không đợi start(): tab chưa đăng nhập cũng ghi vào máy.
 */
export function ngheTabKhacGop() {
  if (kenh || !clientIdDaCauHinh(CONFIG.clientId) || typeof BroadcastChannel !== 'function' || !globalThis.navigator?.locks?.request) return;
  kenh = new BroadcastChannel('bstr-drive-sync');
  let cho = null; // đang chờ tab khác: { dong, daGhi }
  kenh.onmessage = ({ data }) => {
    if (cho && (data === 'da-ghi' || data === 'khong-ghi')) cho.daGhi = data === 'da-ghi';
    if (data !== 'dang-gop' || cho) return;
    cho = { dong: moManChan('Đang gộp…'), daGhi: false };
    navigator.locks.request('bstr-drive-sync', () => {
      const { dong, daGhi } = cho;
      cho = null;
      if (daGhi) location.reload();
      else dong();
    });
  };
}

/** Tải payload lên Drive thành bản mới nhất của máy này (nhãn thiết bị và số tài liệu). */
async function taiLenBanMayNay(token, payload) {
  const name = `${CONFIG.filePrefix}${payload.savedAt.replace(/[:.]/g, '-')}.json`;
  return uploadJson(token, await folder(), name, payload, {
    bstrThietBi: deviceId(), bstrTen: tenThietBi(), bstrSoTaiLieu: String(docCount(payload)),
  });
}

/** Máy khác có bản chưa gộp: băng rôn chờ người dùng bấm (không tự tải lại khi đang gõ). Trả true nếu đã báo. */
function baoCanGop(canGop) {
  if (!canGop.length) return false;
  setStatus('Máy khác vừa có thay đổi.', {
    persist: true, level: 'info', action: { label: 'Tải lại để gộp', run: () => gopVoiDrive() },
  });
  return true;
}

/** dsBan: danh sách bản lưu start() vừa đọc, khỏi hỏi Drive lần nữa. */
export async function saveNow({ force = false, background = false, dsBan = null } = {}) {
  if (busy) return;
  busy = true;
  try {
    await khoaDongBo(() => luu({ force, background, dsBan }));
  } finally {
    busy = false;
  }
}

/**
 * Drive đầy: câu báo riêng, không nút thử lại (thử lại vô ích tới khi có chỗ). Trả true nếu đã báo. Drive trả 403 kèm lý do
 * storageQuotaExceeded trong nội dung lỗi (drive.js call() đưa nguyên văn vào message).
 */
function baoDriveDay(e) {
  if (!/storageQuotaExceeded/.test(e?.message || '')) return false;
  setStatus('Google Drive đã đầy, chưa lưu được. Tài liệu vẫn nằm trên máy.', { persist: true, level: 'error' });
  return true;
}

async function luu({ force, background, dsBan }) {
  try {
    if (!background) setStatus('Đang lưu lên Drive...');
    const token = await ensureToken();
    const state = readState();
    // Tự gộp (28/09): Drive có bản mới hơn của máy khác thì VẪN lưu phần máy này (gộp về sau lấy đủ cả hai bên),
    // rồi báo băng rôn. Không mở hộp thoại nào ở đây.
    const canGop = banCanGop(dsBan || await listVersions(token, await folder()), state, deviceId());
    clearStatus();
    baoCanGop(canGop); // tải lên có khi hàng chục giây (mạng yếu): trong lúc đó vẫn báo máy này đang xem bản chưa gộp

    // Chưa mã hoá: đủ lấy vân tay và đếm tài liệu. Phần lớn lượt lưu nền không đổi gì; mã hoá cả máy chỉ khi tải lên.
    const payload = await exportAll({ maHoa: false });

    // Máy này tự bảo vệ mình: không còn gì trong máy thì tuyệt đối không ghi đè.
    if (payload.workspaces.length === 0) {
      setStatus('Không thấy dữ liệu trên máy nên chưa lưu, để không ghi đè bản tốt trên Drive', { persist: true, level: 'warn' });
      return;
    }

    const vanTay = fingerprint(payload);
    const soTaiLieu = docCount(payload);

    if (!force && state && state.fingerprint === vanTay) {
      // Chữ không đổi: lượt lưu tiền cảnh (mở app, bấm lưu) vẫn đẩy ảnh Drive còn thiếu (tệp ảnh bị xoá tay trên Drive:
      // cảnh báo "Thiếu k ảnh" bảo mở app trên máy có ảnh). Lượt lưu nền thì thôi, khỏi tốn lệnh Drive mỗi 2 phút.
      if (!background) await dayAnh(token, await folder(), { baoTienDo: (n, tong) => setStatus(`Đang tải ảnh lên ${n}/${tong}`) });
      if (!baoCanGop(canGop) && !background) setStatus('Không có thay đổi mới');
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

    // Ảnh là tệp riêng (tự gộp đợt 2): đẩy hết ảnh Drive chưa có rồi mới lưu bản chữ, không thì máy khác gộp được chữ mà
    // thiếu ảnh. Đứt giữa chừng thì ném lỗi (báo "Chưa lưu được…", tự thử lại), lần sau chỉ đẩy phần còn thiếu. Lần đầu có
    // thể lâu: báo tiến độ.
    await dayAnh(token, await folder(), { baoTienDo: (n, tong) => setStatus(`Đang tải ảnh lên ${n}/${tong}`) });
    const up = await taiLenBanMayNay(token, { ...payload, workspaces: payload.workspaces.map((ws) => ({ ...ws, stores: maHoa(ws.stores) })) });
    writeState({ fileId: up.id, savedAt: payload.savedAt, deviceId: deviceId(), fingerprint: vanTay, soTaiLieu, daGop: state?.daGop || [] });

    // Tối đa CONFIG.maxDevices thiết bị, mỗi thiết bị CONFIG.keepVersions bản; thiết bị lâu không lưu nhất bị bỏ.
    // Trừ thiết bị còn bản chưa gộp: máy đó có thể không mở lại nữa (máy mượn, cửa sổ ẩn danh), dọn là mất hẳn phần
    // của nó. gopNgay không dọn: nó nhớ bản đã gộp (daGop), lượt lưu sau khi tải lại trang dọn cả thiết bị đó.
    const chuaGop = new Set(canGop.map((f) => f.appProperties?.bstrThietBi || ''));
    const files = await listVersions(token, await folder());
    await pruneVersions(token, files.filter((f) => !chuaGop.has(f.appProperties?.bstrThietBi || '')));
    // Lượt này không tạo bản sao lưu nào, nên dọn bản sao lưu cũ ở đây là an toàn.
    await pruneBackups(token, await listBackups(token, await folder()));
    clearStatus(); // lưu được rồi thì cảnh báo "cần chú ý" không còn đúng nữa
    if (!baoCanGop(canGop) && !background) setStatus('Đã lưu lên Drive');
  } catch (e) {
    console.error('[drive-sync] lưu thất bại', e);
    if (baoDriveDay(e)) return;
    setStatus('Chưa lưu được lên Drive. Tài liệu vẫn nằm trên máy; ứng dụng sẽ tự thử lại.', {
      persist: true, level: 'error', action: { label: 'Thử lại ngay', run: () => saveNow() },
    });
  }
}

/**
 * Chụp toàn bộ dữ liệu trên máy lên Drive TRƯỚC khi ghi đè nó. Ném lỗi nếu
 * không chụp được — người gọi PHẢI dừng hẳn, thà không ghi còn hơn mất dữ liệu.
 * Dùng backupPrefix: bản sao lưu KHÔNG được len vào dòng phiên bản, nếu không
 * lần khởi động sau app lại mời khôi phục đúng dữ liệu người dùng vừa bỏ.
 */
export async function saoLuuTruocKhiGhiDe({ kemAnh = false } = {}) {
  setStatus('Đang sao lưu bản trên máy trước khi ghi đè...');
  const token = await ensureToken();
  const backup = await exportAll({ kemAnh });
  const name = `${CONFIG.backupPrefix}${backup.savedAt.replace(/[:.]/g, '-')}.json`;
  return uploadJson(token, await folder(), name, backup);
}

async function boKhongGianMau(payload) {
  const workspaces = [];
  for (const ws of payload.workspaces) if (!(await laKhongGianMau(ws.id))) workspaces.push(ws);
  return { ...payload, workspaces };
}

/**
 * Tự gộp (28/09): gộp dữ liệu máy này với bản mới nhất của từng máy khác chưa gộp, ghi vào máy, tải lại trang. Không
 * tải bản đã gộp lên ở đây (đợt 2): lượt lưu tiền cảnh của start() sau khi tải lại đẩy ảnh rồi lưu nó. Máy chưa từng
 * đồng bộ: bỏ "Không gian làm việc mẫu" tự tạo trước khi gộp (restore thayThe).
 * An toàn: sao lưu máy TRƯỚC khi ghi (trừ khi máy chưa đổi từ lần đồng bộ trước: dữ liệu đó đã nằm trên Drive); tải
 * hỏng, bản hỏng hay gộp hỏng thì không ghi gì. Bản kia không có gì mới với máy này: chỉ nhớ đã gộp, trả 'khong-doi'.
 */
export async function gopVoiDrive() {
  if (busy) { setStatus('Đang đồng bộ, thử lại sau ít giây'); return; }
  busy = true;
  try {
    const kq = await khoaDongBo(gopNgay);
    // Khoá đang bị giữ (tab khác lưu hay gộp; bước nhận tài liệu ở tab này hay tab khác): lượt này không chạy. Băng rôn của nút vừa bấm đã bị gỡ, và start()
    // đã clearStatus(): báo lại bản chưa gộp, không im lặng.
    if (kq === undefined) baoCanGop([kq]);
    return kq;
  } finally {
    busy = false;
  }
}

const NUT_XEM_NGAY = 'Xem bản trên máy ngay';
const LOI_THOI_CHO = 'BSTR_THOI_CHO';

/**
 * Phần B (30/09; chủ dự án: có mạng thì chờ vài giây lấy bản mới nhất, nhưng có giới hạn). Sau CONFIG.choNutMs màn chặn nhập
 * hiện nút "Xem bản trên máy ngay"; bấm nút hay tới CONFIG.choToiDaMs thì:
 * - còn đang tải (trước khi ghi): thôi chờ; lời chờ bọc bằng cho() đang dở ném lỗi LOI_THOI_CHO, không ghi gì. BẤT BIẾN: mọi await
 *   trước hen.ghi() phải bọc bằng hen.cho() (lúc thôi chờ — hẹn giờ hay cú bấm, đều là macrotask — luôn có một lời chờ đã bọc đang
 *   dở); ghi() là chốt cuối (đã thôi thì ném, không ghi);
 * - đang ghi (sau ghi()): không làm gì, nút ẩn (ghi dở nguy hiểm hơn chờ);
 * - đang tải trước ảnh tài liệu đang mở (anh()): bỏ phần ảnh, lời hứa anh() xong ngay (đã hết giờ lúc đang ghi: xong ngay khi vào).
 * coHan false (máy chưa đồng bộ lần nào): không nút, không hạn. Thôi chờ rồi lượt lưu nền sẽ đẩy cả "Không gian làm việc mẫu" (chỉ
 * gopNgay mới bỏ nó) lên Drive, lẫn vào dữ liệu thật của các máy khác; nên chờ tới khi lấy xong.
 * Lệnh mạng đang chạy không bị huỷ (drive.js không nhận AbortSignal): kết quả về muộn bị bỏ qua.
 */
function henCho(man, coHan) {
  let giaiDoan = 'tai', denGioNut = false, hetGio = false, daThoi = false, nemThoi, boAnh;
  const loiThoi = () => Object.assign(new Error('Thôi chờ bản mới nhất'), { code: LOI_THOI_CHO });
  const thoiCho = new Promise((_, nem) => { nemThoi = nem; });
  thoiCho.catch(() => {}); // thôi lúc không có lời chờ nào: không thành lỗi chưa bắt
  const xongAnh = new Promise((r) => { boAnh = r; });
  const bam = () => {
    if (giaiDoan === 'tai' && !daThoi) { daThoi = true; nemThoi(loiThoi()); }
    else if (giaiDoan === 'anh') boAnh();
  };
  const hen = coHan ? [
    setTimeout(() => { denGioNut = true; if (giaiDoan !== 'ghi') man.hienNut(NUT_XEM_NGAY, bam); }, CONFIG.choNutMs),
    setTimeout(() => { hetGio = true; bam(); }, CONFIG.choToiDaMs),
  ] : [];
  return {
    cho: (p) => Promise.race([p, thoiCho]),
    /** Sắp ghi vào máy: từ đây không thôi chờ được nữa, nút ẩn. Đã thôi (không có lời chờ nào xen giữa) thì ném, không ghi. */
    ghi() {
      if (daThoi) throw loiThoi();
      giaiDoan = 'ghi';
      man.anNut();
    },
    /** Bắt đầu tải trước ảnh: trả lời hứa xong khi bấm nút hay hết giờ. */
    anh() {
      giaiDoan = 'anh';
      if (hetGio) boAnh();
      else if (denGioNut) man.hienNut(NUT_XEM_NGAY, bam);
      return xongAnh;
    },
    xong() { hen.forEach(clearTimeout); },
  };
}

async function gopNgay() {
  const state = readState();
  const thayThe = !state?.fileId;
  // Phần B (30/09): máy đã từng đồng bộ chờ bản mới nhất có giới hạn (henCho); mọi lời chờ trước khi ghi đi qua hen.cho().
  const dong = moManChan(thayThe ? 'Đang lấy dữ liệu từ Drive…' : 'Đang lấy bản mới nhất từ máy khác…', { demGiay: true });
  const hen = henCho(dong, !thayThe);
  let daGhi = false;
  try {
    const token = await hen.cho(ensureToken());
    const files = banCanGop(await hen.cho(listVersions(token, await hen.cho(folder()))), state, deviceId());
    if (!files.length) { dong(); return 'khong-can'; }
    const cacBan = await hen.cho(Promise.all(files.map((f) => downloadJson(token, f.id))));
    const daGop = [...files.map((f) => f.id), ...(state?.daGop || [])].slice(0, 20);
    // Quyết định trước khi ghi gì: bản kia chỉ có những gì máy này đã có thì chỉ nhớ đã gộp. Không sao lưu, không ghi,
    // không tải lên, không tải lại: hai máy không ai sửa gì thì không gộp qua lại mãi.
    const mayNay = await hen.cho(exportAll());
    const vao = thayThe ? await hen.cho(boKhongGianMau(mayNay)) : mayNay;
    const dau = gopPayload(vao, cacBan);
    const { taiLieuGop, wsMoi, anhGop } = dau.thongKe;
    if (!taiLieuGop && !wsMoi && !anhGop && vao.workspaces.length === mayNay.workspaces.length) {
      writeState({ ...(state || {}), deviceId: deviceId(), daGop });
      dong();
      setStatus('Không có thay đổi mới');
      return 'khong-doi';
    }
    // Sắp ghi: tab khác của app chặn nhập và chờ lượt này xong rồi tải lại (ngheTabKhacGop), để không có chữ nào ghi vào
    // máy sau lúc xuất rồi bị restore xoá.
    kenh?.postMessage('dang-gop');
    if (mayNay.workspaces.length && state?.fingerprint !== fingerprint(mayNay)) {
      // Bản sao lưu mang ảnh chỉ của workspace sắp bị bỏ (workspace mẫu, boKhongGianMau): ảnh của chúng chưa từng lên Drive.
      const seBo = mayNay.workspaces.map((w) => w.id).filter((id) => !vao.workspaces.some((w) => w.id === id));
      try {
        await hen.cho(saoLuuTruocKhiGhiDe({ kemAnh: seBo.length ? seBo : false }));
      } catch (e) {
        if (e?.code === LOI_THOI_CHO) throw e; // thôi chờ lúc đang sao lưu: báo như thôi chờ (catch ngoài), không phải lỗi sao lưu
        console.error('[drive-sync] sao lưu trước khi gộp thất bại', e);
        dong();
        if (!baoDriveDay(e)) {
          setStatus('Không sao lưu được bản trên máy nên chưa gộp. Dữ liệu trên máy chưa bị thay đổi.', { persist: true, level: 'error' });
        }
        return 'loi';
      }
    }
    // Xuất lại ngay trước khi ghi, không gọi mạng ở giữa: những gì ghi vào máy trong lúc tải bản sao lưu lên cũng được
    // gộp. Gộp trên bản xuất đầu thì restore (xoá rồi ghi lại cả kho) xoá mất chúng, và Yjs giấu luôn mọi sửa đổi sau đó.
    // Vân tay không đổi (không ai ghi gì từ lúc quyết định) thì dùng lại kết quả gộp lần đầu: gộp lại tốn cả giây khi
    // nhiều tài liệu, sau màn chặn nhập.
    let ketQua = dau;
    if (fingerprint(await hen.cho(exportAll({ maHoa: false }))) !== fingerprint(mayNay)) {
      let moi = await hen.cho(exportAll());
      if (thayThe) moi = await hen.cho(boKhongGianMau(moi));
      ketQua = gopPayload(moi, cacBan);
    }
    const { payload, thongKe, thayDoi } = ketQua;
    hen.ghi(); // từ đây không thôi chờ được nữa (nút ẩn): ghi dở nguy hiểm hơn chờ
    daGhi = true;
    kenh?.postMessage('da-ghi'); // tab đang chờ: dữ liệu trên máy sắp đổi, khoá nhả thì tải lại
    // Chỉ ghi phần đã đổi (thayDoi), không xoá sạch kho: kho của app có thể đang gộp update của tài liệu không đổi.
    const { bo } = await restore(payload, { thayThe, thayDoi });
    // Không tải bản đã gộp lên ở đây (tự gộp đợt 2): phải đẩy ảnh trước (lần đầu có thể lâu) mà màn chặn nhập đang mở.
    // Trang tải lại, lượt lưu tiền cảnh của start() đẩy ảnh rồi lưu bản này (vân tay còn là của lần trước nên chắc chắn
    // lưu) và dọn bản cũ.
    writeState({ ...(state || {}), deviceId: deviceId(), daGop });
    const tu = thayThe ? null : [...new Set(files.map((f) => f.appProperties?.bstrTen || 'bản lưu cũ'))].join(', ');
    const soTaiLieu = thayThe ? docCount(payload) : thongKe.taiLieuGop; // gộp: số tài liệu đổi hoặc thêm, không phải tổng
    try { sessionStorage.setItem(DA_KHOI_PHUC, JSON.stringify({ savedAt: payload.savedAt, soTaiLieu, tu })); } catch {}
    // Task 1 (thử 28/09): app không tự hiện ảnh về muộn trong tài liệu đang mở. Tải trước ảnh của tài liệu đó (tối đa
    // 20 giây) rồi mới tải lại trang; ảnh khác tải nền sau khi tải lại (taiAnhNen).
    const mo = docDangMo();
    if (mo) {
      let henAnh;
      await Promise.race([
        taiAnhThieu(token, await folder(), { chiTaiLieu: mo }),
        new Promise((r) => { henAnh = setTimeout(r, 20000); }),
        hen.anh(), // Phần B: bấm "Xem bản trên máy ngay" hay hết giờ thì bỏ phần ảnh, tải lại với chữ đã gộp
      ]).catch((e) => console.error('[drive-sync] tải trước ảnh tài liệu đang mở thất bại, sẽ tải nền', e))
        .finally(() => clearTimeout(henAnh));
    }
    // Địa chỉ đang mở có thể trỏ vào workspace vừa bỏ: về trang gốc, app tự mở workspace còn trong danh sách.
    if (bo.length) location.replace('/');
    else location.reload();
    return 'xong';
  } catch (e) {
    dong();
    if (e?.code === LOI_THOI_CHO) {
      // Thôi chờ trước khi ghi (bấm nút hay hết giờ): máy chưa bị đổi, không nhớ đã gộp (lần sau gộp lại). Tab khác đang chờ khoá
      // không nhận 'da-ghi' nên mở lại, không tải lại. Mở app chạy tiếp như gộp lỗi: tải nền ảnh, cài lượt lưu nền.
      setStatus('Chưa lấy được bản mới nhất (mạng yếu). Đang xem bản trên máy.', {
        persist: true, level: 'warn', action: { label: 'Thử lại', run: () => gopVoiDrive() },
      });
      return 'huy';
    }
    if (e?.code === 'BSTR_BACKUP_INVALID') {
      kenh?.postMessage('khong-ghi'); // restore kiểm tra đầu vào trước khi ghi: máy chưa bị đổi, tab đang chờ khỏi tải lại
      console.error('[drive-sync] bản lưu không qua kiểm tra đầu vào', e);
      setStatus('Bản lưu trên Drive không hợp lệ. Dữ liệu trên máy chưa bị ghi đè.', { persist: true, level: 'warn' });
      return 'loi';
    }
    if (daGhi) {
      console.error('[drive-sync] ghi dữ liệu đã gộp thất bại', e);
      setStatus('Gộp chưa xong, dữ liệu trên máy có thể còn thiếu. Tải lại trang để gộp lại.', {
        persist: true, level: 'error', action: { label: 'Tải lại trang', run: () => location.reload() },
      });
      return 'loi-ghi';
    }
    console.error('[drive-sync] gộp thất bại', e);
    setStatus('Chưa gộp được với dữ liệu trên Drive. Tài liệu vẫn nằm trên máy.', {
      persist: true, level: 'error', action: { label: 'Thử lại', run: () => gopVoiDrive() },
    });
    return 'loi';
  } finally {
    hen.xong();
  }
}

/** Tài liệu đang mở (địa chỉ /workspace/<không gian>/<tài liệu>), để tải ảnh của nó trước. */
const docDangMo = () => globalThis.location?.pathname?.match(/^\/workspace\/[^/]+\/([^/?#]+)/)?.[1] || null;

let conAnhCanTai = false; // lần tải nền gần nhất còn ảnh thiếu trên Drive, ảnh tải hỏng hay hỏng hẳn: lượt lưu nền tải lại

/**
 * Tải nền ảnh máy này còn thiếu (sau khi gộp hay lấy dữ liệu từ Drive), báo "Đang tải ảnh n/N". Một tab làm một lúc
 * (khoá riêng 'bstr-drive-anh', không giữ khoá đồng bộ: lượt lưu vẫn chạy). Còn thiếu hay hỏng thì lượt lưu nền sau
 * (2 phút) tải lại: máy khác có thể đã đẩy ảnh lên, Drive hết bận. Cảnh báo "Thiếu k ảnh" theo lần tải gần nhất.
 */
function taiAnhNen() {
  const viec = async () => {
    try {
      const { daTai, thieuTrenDrive, loi } = await taiAnhThieu(await ensureToken(), await folder(), {
        docDangMo: docDangMo(),
        baoTienDo: (n, tong) => setStatus(`Đang tải ảnh ${n}/${tong}`),
      });
      // App không tự hiện ảnh về muộn trong tài liệu đang mở (Task 1): người dùng tưởng ảnh hỏng mà xoá ô ảnh thì xoá cả
      // trên mọi máy. Thông báo ngắn nằm ô riêng, không đè cảnh báo "Thiếu k ảnh" (ui.js).
      if (daTai) setStatus('Đã tải xong ảnh. Mở lại tài liệu nếu còn ô ảnh trống.');
      setCanhBaoAnh(thieuTrenDrive ? `Thiếu ${thieuTrenDrive} ảnh trên Drive: mở app trên máy đã thêm ảnh để tải lên.` : null);
      conAnhCanTai = thieuTrenDrive + loi > 0;
    } catch (e) {
      console.error('[drive-sync] tải ảnh thất bại, lượt lưu nền sau tải tiếp', e);
      conAnhCanTai = true;
    }
  };
  const locks = globalThis.navigator?.locks;
  return locks?.request ? locks.request('bstr-drive-anh', { ifAvailable: true }, (lock) => (lock ? viec() : undefined)) : viec();
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
  setStatus(info.tu
    ? `Đã gộp thay đổi từ ${info.tu}: ${info.soTaiLieu} tài liệu.`
    : `Đã lấy bản lưu lúc ${luc} từ Drive về máy này: ${info.soTaiLieu} tài liệu.`, { persist: true });
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

/** Lỗi mạng của fetch (Chrome "Failed to fetch", Safari "Load failed", Firefox "NetworkError…"), không phải lỗi mã. */
const laLoiMang = (e) => e?.name === 'TypeError' && /Failed to fetch|Load failed|NetworkError/i.test(e?.message || '');

let choCoMang = null; // đang chờ có mạng lại để chạy lại start()

/**
 * Mở app lúc mất mạng: báo đang xem bản trên máy; có mạng lại (sự kiện online, hoặc lần kiểm 60 giây một lần) thì chạy lại
 * start() đúng một lần: gộp nếu cần, cài lượt lưu nền, tải nền ảnh. Trước đây mở app lúc mất mạng thì cả buổi không tự lưu.
 */
function baoKhongMang() {
  setStatus(cauKhongMang(), { persist: true, level: 'warn' });
  if (choCoMang) return;
  const chay = () => {
    if (globalThis.navigator?.onLine === false) return;
    clearInterval(choCoMang.hen);
    globalThis.removeEventListener?.('online', chay);
    choCoMang = null;
    start({ giuaPhien: true });
  };
  choCoMang = { hen: setInterval(chay, 60000) };
  globalThis.addEventListener?.('online', chay);
}

/** giuaPhien: chạy lại khi có mạng lại (baoKhongMang), người dùng có thể đang đọc hay gõ. */
export async function start({ onSkip, giuaPhien = false } = {}) {
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
      // Mất mạng: mở bằng bản trên máy, không chờ Drive; có mạng lại thì tự chạy lại (baoKhongMang).
      if (globalThis.navigator?.onLine === false) { baoKhongMang(); return; }
      await ensureToken();
    }
    // Đã đăng nhập: băng rôn "Chưa đồng bộ… Đăng nhập" hay lỗi đăng nhập trước đó không còn đúng. Trước đây chỉ lượt
    // lưu thành công mới xoá, nên chọn "Để sau" ở hộp xung đột thì băng rôn cũ ở lại (thử 25/09 trên bstrong68.com).
    clearStatus();
    // Xin trình duyệt giữ dữ liệu trang lâu dài (không tự xoá khi máy thiếu chỗ); không được thì thôi.
    Promise.resolve(globalThis.navigator?.storage?.persist?.()).catch(() => {});

    const token = await ensureToken();
    const files = await listVersions(token, await folder());
    // Tự gộp: thành công thì trang tải lại. Lỗi hay thôi chờ (Phần B) thì giữ lời báo, lượt lưu nền 2 phút sau lưu phần máy này. Có mạng lại giữa
    // phiên thì máy đã đồng bộ không tự gộp (không chặn màn hình, không tải lại trang khi đang đọc/gõ; chủ dự án chọn 29/09):
    // lượt lưu dưới đây báo băng rôn "Tải lại để gộp". Máy chưa đồng bộ lần nào vẫn gộp: lưu trước thì không gian mẫu lên Drive.
    const state = readState();
    const tuGop = banCanGop(files, state, deviceId()).length && !(giuaPhien && state?.fileId);
    const gop = tuGop ? await gopVoiDrive() : 'khong-doi';
    // Gộp xong thì trang đang tải lại (gopNgay đã gọi location.reload/replace): không trả về. Trả true thì người gọi (luồng nhận
    // ?nhan=, nút chia sẻ) tưởng đã đăng nhập xong, chạy tiếp rồi bị tải lại cắt ngang giữa chừng (thử thật 30/09: máy chưa đồng
    // bộ lần nào đăng nhập từ hộp nhận tài liệu thì tài liệu không được nhận, không lời báo).
    if (gop === 'xong') return new Promise(() => {});
    // Không chờ: ảnh về dần sau khi chữ đã đọc và gõ được, không chờ lượt lưu dưới đây (có khi cả chục lệnh Drive nối
    // tiếp). Thông báo của nó là thông báo ngắn và ô cảnh báo riêng, clearStatus của lượt lưu không xoá.
    taiAnhNen();
    if (gop === 'khong-doi') {
      // Không có gì cần gộp (hay gộp mà máy này không đổi gì): lưu ngay một lần ở tiền cảnh. Lần lưu nền không được mở
      // hộp thoại, nên khi số tài liệu ít đi thì chỉ lần lưu này hỏi được người dùng.
      await saveNow({ force: !files.length, dsBan: files });
    }

    // Sau lượt lưu lúc mở app: lượt đó gọi clearStatus(), báo trước thì câu xác nhận bị xoá ngay. Chỉ khi lần mở này không còn gì
    // cần gộp: thôi chờ, gộp lỗi hay khoá bận thì câu "Đã gộp…" của lần trước đè mất lời báo đang xem bản chưa gộp; bỏ cờ.
    if (gop === 'khong-doi') baoDaKhoiPhuc();
    else try { globalThis.sessionStorage?.removeItem(DA_KHOI_PHUC); } catch {}
    setInterval(() => {
      saveNow({ background: true });
      if (conAnhCanTai) taiAnhNen();
    }, CONFIG.autoSaveMs);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveNow({ background: true });
    });
    return true;
  } catch (e) {
    if (laLoiMang(e) && isSignedIn()) {
      console.warn('[drive-sync] mất mạng lúc khởi động, chờ có mạng lại', e);
      baoKhongMang();
      return;
    }
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

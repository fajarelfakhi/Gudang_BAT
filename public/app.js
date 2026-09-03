/* ==========================================================================
   GUDANG BAT - Master Frontend Logic (Multi-User, Role-Based WMS Engine)
   100% Bahasa Indonesia Interface
   ========================================================================== */

// Gunakan endpoint relatif agar aplikasi otomatis mengikuti port server (8080/8081/dll)
const API_BASE = '/api';

// Global Application State
let appState = {
  settings: {
    appName: "GUDANG BAT",
    warehouseName: "Gudang Utama BAT Logistics - Jakarta",
    bookingExpiryDays: 3,
    minStockDefault: 10
  },
  users: [],
  categories: [],
  products: [],
  inventory: [],
  stockMutations: [],
  stockIns: [],
  stockOuts: [],
  workTypes: [],
  workRates: [],
  workTargets: [],
  workReports: [],
  payoutRequests: [],
  sellerBookings: [],
  shippingResi: [],
  salesClosings: [],
  damagedGoods: [],
  returnedGoods: [],
  activityLogs: []
};

let currentUser = null;
let currentChartActivity = null;
let currentChartStatus = null;
let currentChartProductivity = null;
let activePeriodFilter = 'today';
let gudangPeriodFilter = 'today';
let gudangCustomRange = { start: '', end: '' };
function localDateKey(d=new Date()){ const x=new Date(d); const y=x.getFullYear(); const m=String(x.getMonth()+1).padStart(2,'0'); const day=String(x.getDate()).padStart(2,'0'); return `${y}-${m}-${day}`; }
function getGudangRange(){
  const now=new Date(); const today=localDateKey(now);
  if(gudangPeriodFilter==='today') return {start:today,end:today,label:'Hari Ini'};
  if(gudangPeriodFilter==='week'){ const d=new Date(now); d.setHours(0,0,0,0); d.setDate(d.getDate()-((d.getDay()+6)%7)); return {start:localDateKey(d),end:today,label:'Pekan Ini'}; }
  if(gudangPeriodFilter==='month'){ return {start:`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`,end:today,label:'Bulan Ini'}; }
  const start=gudangCustomRange.start||today, end=gudangCustomRange.end||today; return {start:start<=end?start:end,end:start<=end?end:start,label:`${start<=end?start:end} s/d ${start<=end?end:start}`};
}
function inDateRange(value, range){ const key=String(value||'').slice(0,10); return !!key && key>=range.start && key<=range.end; }
let pendingConfirmAction = null;

let saveQueue = Promise.resolve();
let saveInProgress = false;
let isStateInitialized = false;
let stateVersion = Number(localStorage.getItem('gudangbat_state_version') || 0);

function getAuthHeaders(extra = {}) {
  const token = localStorage.getItem('gudangbat_token');
  return { ...extra, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

async function apiRequest(url, options = {}) {
  const res = await fetch(url, { ...options, headers: getAuthHeaders(options.headers || {}) });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok || data?.success === false) throw new Error(data?.message || `Permintaan gagal (${res.status}).`);
  return data;
}

const ALL_PERMISSIONS = [
  { id: 'dashboard.view', label: 'Akses Dashboard & Ringkasan Statistik' },
  { id: 'products.manage', label: 'Kelola Katalog Produk & Varian (Tambah/Edit/Hapus)' },
  { id: 'stocks.view', label: 'Melihat Data Stok & Riwayat Mutasi' },
  { id: 'inventory.in_out', label: 'Input Barang Masuk & Barang Keluar' },
  { id: 'inventory.qc', label: 'Pemeriksaan Quality Control (QC) & Lapor Cacat/Retur' },
  { id: 'sales.closing', label: 'Closing Resi Penjualan & Scan Barcode Resi' },
  { id: 'seller.booking', label: 'Buat & Kelola Booking Stok Seller' },
  { id: 'work.reports', label: 'Input & Lihat Laporan Pekerjaan Worker Gudang' },
  { id: 'wages.manage', label: 'Manajemen Tarif Pekerjaan, Upah & Pencairan Dana' },
  { id: 'system.settings', label: 'Pengaturan Sistem, Logo Perusahaan & Kelola User' },
  { id: 'rbac.manage', label: 'Manajemen Hak Akses & Matriks Peran (RBAC)' }
];

const VIEW_PERMISSIONS = {
  'admin-dashboard':'dashboard.view','gudang-dashboard':'dashboard.view','seller-dashboard':'dashboard.view',
  'admin-products':'products.manage','admin-stocks':'stocks.view','admin-stock-ins':'inventory.in_out','admin-stock-outs':'inventory.in_out',
  'admin-work-management':'wages.manage','admin-seller-bookings':'seller.booking','admin-sales-closing':'sales.closing','admin-damaged-goods':'inventory.qc','admin-returned-goods':'inventory.qc',
  'admin-wages':'wages.manage','admin-payouts':'wages.manage','admin-reports':'dashboard.view','admin-pending-users':'system.settings','admin-roles':'rbac.manage','admin-users':'system.settings','admin-activity-logs':'system.settings','admin-settings':'system.settings','admin-profile':'dashboard.view',
  'gudang-targets':'dashboard.view','gudang-work-report':'work.reports','gudang-work-history':'work.reports','gudang-earnings':'wages.manage','gudang-payout-request':'wages.manage','gudang-profile':'dashboard.view',
  'seller-stock-view':'stocks.view','seller-booking-form':'seller.booking','seller-booking-history':'seller.booking','seller-sales-status':'sales.closing','seller-profile':'dashboard.view'
};
function normalizeRole(role){const r=String(role||'').trim().toLowerCase();if(['admin','administrator','admin utama','administrator utama'].includes(r))return 'admin';if(['gudang','pekerja gudang','worker','warehouse','warehouse worker','staff gudang'].includes(r))return 'gudang';if(['seller','seller / penjual','penjual','sales'].includes(r))return 'seller';return r||'seller';}
function getCurrentPermissions(){if(!currentUser)return [];const individual=Array.isArray(currentUser.permissions)?currentUser.permissions:[];return individual.length?individual:(appState.rbac?.rolePermissions?.[normalizeRole(currentUser.role)]||[]);}
function hasPermission(permission){const p=getCurrentPermissions();return normalizeRole(currentUser?.role)==='admin'||p.includes('*')||p.includes(permission);}
function applyRolePermissionsToUI(){
  document.querySelectorAll('.nav-link[data-view]').forEach(btn=>{ const perm=VIEW_PERMISSIONS[btn.dataset.view]; btn.classList.toggle('hidden-by-permission', !!perm && !hasPermission(perm)); });
  const first=[...document.querySelectorAll('.sidebar-nav:not(.hidden) .nav-link:not(.hidden-by-permission)')][0];
  if(first && !document.querySelector('.sidebar-nav:not(.hidden) .nav-link.active:not(.hidden-by-permission)')) first.classList.add('active');
}

function ensureStateShape() {
  const defaults = {
    settings: {
      appName: 'GUDANG BAT',
      warehouseName: 'Gudang Utama BAT Logistics',
      bookingExpiryDays: 3,
      minStockDefault: 10,
      companyLogo: ''
    },
    users: [], categories: [], products: [], inventory: [], stockMutations: [], stockIns: [], stockOuts: [],
    workTypes: [], workRates: [], workTargets: [], workReports: [], payoutRequests: [], sellerBookings: [],
    shippingResi: [], scannedResi: [], userProfiles: {}, salesClosings: [], damagedGoods: [], returnedGoods: [], activityLogs: [],
    pendingRegistrations: [], customRoles: [],
    rbac: {
      rolePermissions: {
        admin: ALL_PERMISSIONS.map(p => p.id),
        gudang: ['dashboard.view', 'stocks.view', 'inventory.qc', 'work.reports', 'wages.manage'],
        seller: ['dashboard.view', 'stocks.view', 'seller.booking', 'sales.closing']
      }
    }
  };

  Object.keys(defaults).forEach(k => {
    if (appState[k] === undefined || appState[k] === null) appState[k] = defaults[k];
  });
  appState.settings = { ...defaults.settings, ...(appState.settings || {}) };
  appState.rbac = { ...defaults.rbac, ...(appState.rbac || {}) };
  if (!appState.rbac.rolePermissions) appState.rbac.rolePermissions = defaults.rbac.rolePermissions;
  if (!appState.userProfiles || typeof appState.userProfiles !== 'object') appState.userProfiles = {};
  if (!Array.isArray(appState.customRoles)) appState.customRoles = [];
  if (!Array.isArray(appState.pendingRegistrations)) appState.pendingRegistrations = [];

  (appState.inventory || []).forEach(i => {
    ['physicalStock','bookedStock','processStock','soldStock','damagedStock'].forEach(k => i[k] = Number(i[k] || 0));
  });
}

function getInventory(productId, variantId) {
  return (appState.inventory || []).find(i => i.productId === productId && i.variantId === variantId);
}

function getAvailableStock(inv) {
  if (!inv) return 0;
  return Math.max(0, Number(inv.physicalStock || 0) - Number(inv.bookedStock || 0));
}

function getWorkerReservedPayout(workerId) {
  return (appState.payoutRequests || [])
    .filter(p => p.workerId === workerId && ['Menunggu Persetujuan','Disetujui','Sudah Dibayar'].includes(p.status))
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);
}

function getWorkerTotalWage(workerId) {
  return (appState.workReports || [])
    .filter(r => r.workerId === workerId)
    .reduce((sum, r) => sum + Number(r.totalWage || 0), 0);
}

function getWorkerAvailableWage(workerId) {
  return Math.max(0, getWorkerTotalWage(workerId) - getWorkerReservedPayout(workerId));
}

function expireSellerBookings() {
  let changed = false;
  const now = Date.now();
  (appState.sellerBookings || []).forEach(b => {
    if (['Menunggu Persetujuan','Aktif'].includes(b.status) && b.expiresAt && new Date(b.expiresAt).getTime() <= now) {
      b.status = 'Kedaluwarsa';
      const inv = getInventory(b.productId, b.variantId);
      if (inv) inv.bookedStock = Math.max(0, Number(inv.bookedStock || 0) - Number(b.qty || 0));
      changed = true;
    }
  });
  return changed;
}

function initThemeMode() {
  const savedTheme = localStorage.getItem('gudangbat_theme') || 'light';
  if (savedTheme === 'dark') {
    document.body.classList.add('dark-theme');
  } else {
    document.body.classList.remove('dark-theme');
  }
  const themeIcon = document.getElementById('theme-icon');
  if (themeIcon) themeIcon.className = savedTheme === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
}

async function loadPublicBranding() {
  try {
    const res=await fetch(`${API_BASE}/public/settings`,{cache:'no-store'});
    const json=await res.json();
    if(json?.success && json.data){
      appState.settings={...appState.settings,...json.data};
      const appName=document.getElementById('login-simple-app-name'); if(appName) appName.textContent=json.data.appName||'GUDANG BAT';
      const sub=document.getElementById('login-simple-subtitle'); if(sub) sub.textContent=json.data.warehouseName||'Masuk ke sistem manajemen gudang';
      renderCompanyLogo();
    }
  } catch { renderCompanyLogo(); }
}

function renderCompanyLogo() {
  const logoUrl = appState.settings?.companyLogo || '';
  const appName = appState.settings?.appName || 'GUDANG BAT';
  const whName = appState.settings?.warehouseName || 'SISTEM MANAJEMEN GUDANG MULTI-USER';

  const logoImg = document.getElementById('login-company-logo-img');
  // Fallback logo pada tampilan login sederhana. ID ini harus unik agar
  // logo perusahaan benar-benar MENGGANTIKAN ikon 3 kotak, bukan tampil di atasnya.
  const loginFallback = document.getElementById('login-company-fallback');
  const bannerIcon = document.getElementById('login-banner-company-icon');
  const appNameEl = document.getElementById('login-app-name');
  const whNameEl = document.getElementById('login-warehouse-name');

  if (appNameEl) appNameEl.innerHTML = appName.includes(' ') ? appName.replace(' ', '<span>') + '</span>' : `${appName}<span>BAT</span>`;
  if (whNameEl) whNameEl.textContent = whName;

  if (logoImg) {
    if (logoUrl) {
      // Logo custom menggantikan ikon bawaan (3 kotak) di posisi yang sama.
      logoImg.src = logoUrl;
      logoImg.classList.remove('hidden');
      if (loginFallback) loginFallback.classList.add('hidden');
      if (bannerIcon) bannerIcon.classList.add('hidden');
      logoImg.onerror = () => {
        logoImg.classList.add('hidden');
        if (loginFallback) loginFallback.classList.remove('hidden');
      };
    } else {
      logoImg.removeAttribute('src');
      logoImg.classList.add('hidden');
      if (loginFallback) loginFallback.classList.remove('hidden');
      if (bannerIcon) bannerIcon.classList.remove('hidden');
    }
  }

  const sbAppName = document.getElementById('sidebar-app-name');
  const sbAppSub = document.getElementById('sidebar-app-sub');
  if (sbAppName) sbAppName.innerHTML = appName.includes(' ') ? appName.replace(' ', '<span>') + '</span>' : `${appName}<span>BAT</span>`;
  if (sbAppSub) sbAppSub.textContent = whName;

  const prevImg = document.getElementById('setting-logo-preview');
  const prevPlaceholder = document.getElementById('setting-logo-placeholder');
  const settingInput = document.getElementById('setting-company-logo');
  if (settingInput && !settingInput.value) settingInput.value = logoUrl;
  if (prevImg) {
    if (logoUrl) {
      prevImg.src = logoUrl;
      prevImg.classList.remove('hidden');
      if (prevPlaceholder) prevPlaceholder.classList.add('hidden');
    } else {
      prevImg.classList.add('hidden');
      if (prevPlaceholder) prevPlaceholder.classList.remove('hidden');
    }
  }
}

// ==========================================================================
// 1. SYSTEM INITIALIZATION & API SYNC ENGINE
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
  initThemeMode();
  initEventListeners();
  loadPublicBranding();
  // Jangan memuat atau menyimpan state sebelum sesi pengguna tervalidasi.
  // Ini mencegah perangkat baru dengan state lokal kosong menimpa data server.
  checkSavedSession();

  // Sinkronisasi multi-device berkala: polling versi ringan
  setInterval(async () => {
    if (currentUser && !saveInProgress && navigator.onLine) {
      try {
        const r = await fetch(`${API_BASE}/sync/version`, { headers: getAuthHeaders() });
        if (r.ok) {
          const v = await r.json();
          if (Number(v.version || 0) !== Number(stateVersion || 0)) await syncFetchState(true);
        }
      } catch (_) { /* polling error silent fallback */ }
    }
  }, 8000);

  window.addEventListener('online', () => { if (currentUser && !saveInProgress) syncFetchState(true); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && currentUser && !saveInProgress) syncFetchState(true); });
});

async function loadAppState() {
  try {
    const res = await fetch(`${API_BASE}/state`, { headers: getAuthHeaders() });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === 'object' && !Array.isArray(data) && data.success !== false) {
        stateVersion = Number(res.headers.get('X-State-Version') || data._version || stateVersion || 0);
        localStorage.setItem('gudangbat_state_version', String(stateVersion));
        delete data._version;
        appState = data;
        isStateInitialized = true;
        ensureStateShape();
        renderCompanyLogo();
        return;
      }
    }
  } catch (err) {
    console.warn("Backend REST API offline atau belum diautentikasi.");
  }
}

async function syncFetchState(silent = false) {
  try {
    const res = await fetch(`${API_BASE}/state`, { headers: getAuthHeaders() });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === 'object' && !Array.isArray(data) && data.success !== false) {
        stateVersion = Number(res.headers.get('X-State-Version') || data._version || stateVersion || 0);
        localStorage.setItem('gudangbat_state_version', String(stateVersion));
        delete data._version;
        appState = data;
        isStateInitialized = true;
        ensureStateShape();
        renderCompanyLogo();
        if (!silent) showToast("Data berhasil disinkronisasi dengan server.", "success");
        refreshCurrentView();
      }
    }
  } catch (err) {
    // Silent fail on polling error
  }
}

async function persistAppState(logAction = null, logDetails = "") {
  if (!isStateInitialized) {
    console.warn("Penyimpanan dibatalkan karena state lokal belum diawali dari database.");
    return false;
  }

  if (logAction && currentUser) {
    const newLog = {
      id: 'LOG-' + Date.now(), userId: currentUser.id, userName: currentUser.name,
      userRole: currentUser.role, action: logAction, details: logDetails,
      ipAddress: '127.0.0.1', createdAt: new Date().toISOString()
    };
    appState.activityLogs = appState.activityLogs || [];
    appState.activityLogs.unshift(newLog);
  }

  ensureStateShape();
  const snapshot = JSON.stringify(appState);
  saveQueue = saveQueue.then(async () => {
    saveInProgress = true;
    const res = await fetch(`${API_BASE}/state`, {
      method: 'POST', headers: getAuthHeaders({ 'Content-Type': 'application/json', 'X-State-Version': String(stateVersion || 0) }), body: snapshot
    });
    if (res.status === 409) {
      await syncFetchState(true);
      throw new Error('Data telah diubah oleh perangkat lain. Data terbaru dari server sudah dimuat. Silakan ulangi perubahan Anda.');
    }
    const result = await res.json().catch(() => null);
    if (!res.ok) throw new Error(result?.message || 'Server menolak penyimpanan data.');
    if (!result) throw new Error('Server tidak mengirim konfirmasi penyimpanan.');
    if (result && result.version !== undefined) { stateVersion = Number(result.version); localStorage.setItem('gudangbat_state_version', String(stateVersion)); }
    if (result && result.success === false) throw new Error(result.message || 'Penyimpanan gagal.');
  }).catch(err => {
    console.error('Gagal menyimpan ke database server:', err);
    const message = err?.message || 'Data belum tersimpan ke server. Periksa koneksi backend.';
    showToast(message, 'danger');
    return false;
  }).finally(() => { saveInProgress = false; });

  const saved = await saveQueue;
  if (saved === false) return false;
  refreshCurrentView();
  return true;
}

// ==========================================================================
// 2. AUTHENTICATION, REGISTRATION & LOGIN ENGINE
// ==========================================================================
function switchAuthTab(tab) {
  const btnLogin = document.getElementById('tab-btn-login');
  const btnReg = document.getElementById('tab-btn-register');
  const formLogin = document.getElementById('form-login');
  const formReg = document.getElementById('form-register');
  const loginAlert = document.getElementById('login-alert');
  const regAlert = document.getElementById('register-success-alert');

  if (loginAlert) loginAlert.classList.add('hidden');
  if (regAlert) regAlert.classList.add('hidden');

  if (tab === 'login') {
    if (btnLogin) btnLogin.classList.add('active');
    if (btnReg) btnReg.classList.remove('active');
    if (formLogin) formLogin.classList.remove('hidden');
    if (formReg) formReg.classList.add('hidden');
  } else {
    if (btnReg) btnReg.classList.add('active');
    if (btnLogin) btnLogin.classList.remove('active');
    if (formReg) formReg.classList.remove('hidden');
    if (formLogin) formLogin.classList.add('hidden');
  }
}

async function performLoginProcess() {
  const usernameInput = document.getElementById('login-username');
  const passwordInput = document.getElementById('login-password');
  const submitBtn = document.getElementById('btn-login-submit');
  const alertBox = document.getElementById('login-alert');
  const alertText = document.getElementById('login-alert-text');

  if (!usernameInput || !passwordInput) return;

  const username = usernameInput.value.trim();
  const password = passwordInput.value.trim();

  if (alertBox) alertBox.classList.add('hidden');

  if (!username || !password) {
    if (alertText) alertText.innerText = 'Harap isi username dan password Anda!';
    if (alertBox) alertBox.classList.remove('hidden');
    return;
  }

  let originalBtnHtml = '';
  if (submitBtn) {
    originalBtnHtml = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Memproses...';
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(`${API_BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: controller.signal,
      cache: 'no-store'
    });

    clearTimeout(timeoutId);

    let result = null;
    try {
      result = await res.json();
    } catch (jsonError) {
      throw new Error('Respons server tidak valid.');
    }

    if (res.ok && result && result.success && result.user) {
      if (result.token) localStorage.setItem('gudangbat_token', result.token);
      await loginSuccess(result.user, result.token);
      return;
    }

    const message = result?.message || 'Username atau password salah, atau akun Anda nonaktif.';
    if (alertText) alertText.innerText = message;
    if (alertBox) alertBox.classList.remove('hidden');
    return;

  } catch (err) {
    console.error('Gagal menghubungi backend:', err);
    const isTimeout = err?.name === 'AbortError';
    const message = isTimeout
      ? 'Server terlalu lama merespons. Pastikan backend GUDANG BAT sedang berjalan.'
      : (err.message || 'Tidak dapat terhubung ke server. Periksa koneksi backend Anda.');

    if (alertText) alertText.innerText = message;
    if (alertBox) alertBox.classList.remove('hidden');
  } finally {
    resetLoginBtn(submitBtn, originalBtnHtml);
  }
}

async function performRegistrationProcess() {
  const username = document.getElementById('reg-username')?.value.trim();
  const name = document.getElementById('reg-fullname')?.value.trim();
  const email = document.getElementById('reg-email')?.value.trim();
  const phone = document.getElementById('reg-phone')?.value.trim();
  const requestedRole = document.getElementById('reg-role-requested')?.value;
  const password = document.getElementById('reg-password')?.value;
  const passwordConfirm = document.getElementById('reg-password-confirm')?.value;
  const note = document.getElementById('reg-note')?.value.trim();
  const btnSubmit = document.getElementById('btn-register-submit');
  const alertSuccess = document.getElementById('register-success-alert');
  const alertSuccessText = document.getElementById('register-success-text');

  if (!username || !name || !password) return showToast('Lengkapi username, nama lengkap, dan password.', 'warning');
  if (password !== passwordConfirm) return showToast('Password dan Konfirmasi Password tidak cocok!', 'danger');
  if (password.length < 6) return showToast('Password minimal 6 karakter.', 'warning');

  let origHtml = '';
  if (btnSubmit) { origHtml = btnSubmit.innerHTML; btnSubmit.disabled = true; btnSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Mengirim Pendaftaran...'; }

  try {
    const res = await apiRequest(`${API_BASE}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, name, email, phone, requestedRole, note })
    });

    if (alertSuccess && alertSuccessText) {
      alertSuccessText.innerText = res.message || 'Registrasi berhasil! Menunggu persetujuan Admin.';
      alertSuccess.classList.remove('hidden');
    }
    showToast('Registrasi berhasil! Akun Anda kini menunggu persetujuan Admin.', 'success');
    document.getElementById('form-register')?.reset();
    setTimeout(() => {
      switchAuthTab('login');
      const loginUserInput = document.getElementById('login-username');
      if (loginUserInput) loginUserInput.value = username;
    }, 2000);
  } catch (err) {
    showToast(err.message || 'Gagal mendaftar. Silakan coba lagi.', 'danger');
  } finally {
    if (btnSubmit) { btnSubmit.disabled = false; btnSubmit.innerHTML = origHtml; }
  }
}

function resetLoginBtn(submitBtn, originalHtml) {
  if (submitBtn) {
    submitBtn.disabled = false;
    if (originalHtml) submitBtn.innerHTML = originalHtml;
  }
}

async function loginSuccess(user, token = null) {
  currentUser = user || null;
  if (token) localStorage.setItem('gudangbat_token', token);
  try { const me=await apiRequest(`${API_BASE}/me`); if(me?.user) user={...user,...me.user}; } catch(e) { console.warn('Gagal memuat identitas terbaru:',e?.message||e); }
  user={...user,role:normalizeRole(user?.role)}; currentUser=user;
  localStorage.setItem('gudangbat_user', JSON.stringify(user));
  
  // Wajib muat state dari server terlebih dahulu sebelum menampilkan UI!
  await syncFetchState(true);

  const loginScreen = document.getElementById('login-screen');
  const appLayout = document.getElementById('app-layout');

  if (loginScreen) loginScreen.classList.add('hidden');
  if (appLayout) appLayout.classList.remove('hidden');

  const avatarEl = document.getElementById('user-avatar');
  const nameEl = document.getElementById('user-display-name');
  const roleEl = document.getElementById('user-display-role');

  if (avatarEl) avatarEl.innerText = user.name.charAt(0).toUpperCase();
  if (nameEl) nameEl.innerText = user.name;
  if (roleEl) {
    roleEl.innerText = user.role.toUpperCase();
    roleEl.className = `user-role-badge badge-role-${user.role}`;
  }

  const navAdmin = document.getElementById('nav-admin');
  const navGudang = document.getElementById('nav-gudang');
  const navSeller = document.getElementById('nav-seller');

  if (navAdmin) navAdmin.classList.add('hidden');
  if (navGudang) navGudang.classList.add('hidden');
  if (navSeller) navSeller.classList.add('hidden');

  const normalizedRole=normalizeRole(user.role);
  if (normalizedRole === 'admin') { if (navAdmin) navAdmin.classList.remove('hidden'); switchView('admin-dashboard'); }
  else if (normalizedRole === 'gudang') { if (navGudang) navGudang.classList.remove('hidden'); switchView('gudang-dashboard'); }
  else if (normalizedRole === 'seller') { if (navSeller) navSeller.classList.remove('hidden'); switchView('seller-dashboard'); }
  else { const perms=getCurrentPermissions(); if(perms.includes('seller.booking')&&!perms.includes('work.reports')){if(navSeller)navSeller.classList.remove('hidden');switchView('seller-dashboard');}else if(perms.includes('work.reports')){if(navGudang)navGudang.classList.remove('hidden');switchView('gudang-dashboard');}else{if(navAdmin)navAdmin.classList.remove('hidden');switchView('admin-dashboard');} }

  applyRolePermissionsToUI();
  await loadMyProfile();
  setProfilePhotoUI(getProfileRecord().avatarData || '');
  renderCompanyLogo();
  updateNotificationBadges();
  showToast(`Login berhasil. Selamat datang, ${user.name}!`, "success");
}

async function checkSavedSession() {
  const saved = localStorage.getItem('gudangbat_user');
  const token = localStorage.getItem('gudangbat_token');
  if (saved && token) {
    try {
      const user = JSON.parse(saved);
      if (user && user.id) {
        await loginSuccess(user, token);
      }
    } catch (e) {}
  }
}

// ==========================================================================
// HELPERS: UPAH PEKERJA
// ==========================================================================
function formatRupiah(value) {
  return `Rp ${Number(value || 0).toLocaleString('id-ID')}`;
}

function getWorkTypeById(id) {
  return (appState.workTypes || []).find(w => w.id === id);
}

function getWorkRate(workTypeId) {
  const workType = getWorkTypeById(workTypeId);
  if (!workType) return 0;
  return Number(workType.defaultRate || workType.ratePerUnit || 0);
}

function updateWorkWagePreview() {
  const workTypeId = document.getElementById('wrk-work-type-id')?.value;
  const qty = Number(document.getElementById('wrk-qty')?.value || 0);
  const rate = getWorkRate(workTypeId);
  const rateEl = document.getElementById('wrk-rate-preview');
  const totalEl = document.getElementById('wrk-total-wage-preview');
  if (rateEl) rateEl.textContent = formatRupiah(rate);
  if (totalEl) totalEl.textContent = formatRupiah(rate * qty);
}

function populateWorkReportForm() {
  const wtSelect = document.getElementById('wrk-work-type-id');
  const pSelect = document.getElementById('wrk-product-id');
  if (wtSelect) {
    const selected = wtSelect.value;
    wtSelect.innerHTML = '<option value="">-- Pilih Jenis Pekerjaan --</option>';
    (appState.workTypes || []).forEach(wt => {
      wtSelect.innerHTML += `<option value="${wt.id}">${wt.name} — ${formatRupiah(getWorkRate(wt.id))}/unit</option>`;
    });
    if (selected) wtSelect.value = selected;
  }
  if (pSelect) {
    const selected = pSelect.value;
    pSelect.innerHTML = '<option value="">-- Pilih Produk --</option>';
    (appState.products || []).forEach(prod => {
      pSelect.innerHTML += `<option value="${prod.id}">${prod.name}</option>`;
    });
    if (selected) pSelect.value = selected;
  }
  updateWorkVariantOptions();
  updateWorkWagePreview();
}

function updateWorkVariantOptions() {
  const productId = document.getElementById('wrk-product-id')?.value;
  const vSelect = document.getElementById('wrk-variant-id');
  if (!vSelect) return;
  const selected = vSelect.value;
  vSelect.innerHTML = '<option value="">-- Pilih Varian --</option>';
  const product = (appState.products || []).find(p => p.id === productId);
  (product?.variants || []).forEach(v => {
    vSelect.innerHTML += `<option value="${v.id}">${v.name}</option>`;
  });
  if (selected) vSelect.value = selected;
}

async function submitGudangWorkReport(event) {
  event.preventDefault();
  if (!currentUser || !hasPermission('work.reports')) return showToast('Anda tidak memiliki hak akses untuk mengirim laporan pekerjaan.', 'danger');
  const workTypeId=document.getElementById('wrk-work-type-id')?.value, productId=document.getElementById('wrk-product-id')?.value, variantId=document.getElementById('wrk-variant-id')?.value;
  const qty=Number(document.getElementById('wrk-qty')?.value||0), condition=document.getElementById('wrk-condition')?.value||'Lolos', note=document.getElementById('wrk-note')?.value.trim()||'';
  if(!workTypeId||!productId||!variantId||qty<=0) return showToast('Lengkapi jenis pekerjaan, produk, varian, dan jumlah pekerjaan.','warning');
  try {
    const res=await apiRequest('/api/work-reports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workTypeId,productId,variantId,qty,condition,note,workerName:currentUser.name})});
    await syncFetchState(true); document.getElementById('form-gudang-work-report')?.reset(); updateWorkWagePreview(); refreshCurrentView();
    showToast(res.message||'Laporan pekerjaan berhasil disimpan.','success');
  } catch(err){showToast(err.message||'Laporan pekerjaan gagal disimpan.','danger');}
}

function populateBookingForm() {
  const pSelect = document.getElementById('bkg-product-id');
  if (!pSelect) return;
  const selected = pSelect.value;
  pSelect.innerHTML = '<option value="">-- Pilih Produk --</option>';
  (appState.products || []).forEach(p => {
    const hasStock = (p.variants || []).some(v => getAvailableStock(getInventory(p.id, v.id)) > 0);
    if (hasStock) pSelect.innerHTML += `<option value="${p.id}">${p.name}</option>`;
  });
  if (selected) pSelect.value = selected;
  populateBookingVariants();
}

function populateBookingVariants() {
  const pId = document.getElementById('bkg-product-id')?.value;
  const vSelect = document.getElementById('bkg-variant-id');
  if (!vSelect) return;
  const selected = vSelect.value;
  vSelect.innerHTML = '<option value="">-- Pilih Varian --</option>';
  const product = (appState.products || []).find(p => p.id === pId);
  (product?.variants || []).forEach(v => {
    const avail = getAvailableStock(getInventory(pId, v.id));
    vSelect.innerHTML += `<option value="${v.id}" ${avail <= 0 ? 'disabled' : ''}>${v.name} — tersedia ${avail} ${product.unit || 'Unit'}</option>`;
  });
  if (selected) vSelect.value = selected;
  updateBookingAvailability();
}

function updateBookingAvailability() {
  const pId = document.getElementById('bkg-product-id')?.value;
  const vId = document.getElementById('bkg-variant-id')?.value;
  const qty = Number(document.getElementById('bkg-qty')?.value || 0);
  const warning = document.getElementById('bkg-stock-warning');
  const submit = document.getElementById('btn-submit-booking');
  const available = getAvailableStock(getInventory(pId, vId));
  const invalid = qty > 0 && qty > available;
  if (warning) warning.classList.toggle('hidden', !invalid);
  if (submit) submit.disabled = invalid;
}

async function submitSellerBooking(event) {
  event.preventDefault();
  if (!currentUser || !hasPermission('seller.booking')) return showToast('Anda tidak memiliki hak akses untuk membuat booking.', 'danger');
  const pId = document.getElementById('bkg-product-id')?.value;
  const vId = document.getElementById('bkg-variant-id')?.value;
  const qty = Number(document.getElementById('bkg-qty')?.value || 0);
  const note = document.getElementById('bkg-note')?.value.trim() || '';
  if (!pId || !vId || qty <= 0) return showToast('Pilih produk, varian, dan jumlah booking.', 'warning');
  const btn=document.getElementById('btn-submit-booking'); if(btn) btn.disabled=true;
  try {
    const res=await apiRequest('/api/bookings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({productId:pId,variantId:vId,qty,note})});
    await syncFetchState(true);
    document.getElementById('form-seller-booking')?.reset();
    showToast(res.message||'Booking berhasil dibuat dan stok direservasi.','success');
    switchView('seller-booking-history');
  } catch(err) { showToast(err.message||'Booking gagal disimpan.','danger'); } finally { if(btn) btn.disabled=false; }
}

async function submitPayoutRequest(event) {
  event.preventDefault();
  if (!currentUser || !(hasPermission('work.reports') || hasPermission('wages.manage'))) return showToast('Anda tidak memiliki hak akses untuk mengajukan pencairan.', 'danger');
  const amount=Number(document.getElementById('payout-amount')?.value||0), paymentMethod=document.getElementById('payout-method')?.value||'', accountNo=document.getElementById('payout-account')?.value.trim()||'', note=document.getElementById('payout-note')?.value.trim()||'';
  try {const res=await apiRequest('/api/wage-withdrawals',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount,paymentMethod,accountNo,note,workerName:currentUser.name})});await syncFetchState(true);document.getElementById('form-payout-request')?.reset();renderGudangPayoutRequest();showToast(res.message||'Pengajuan pencairan berhasil dikirim.','success');}
  catch(err){showToast(err.message||'Pengajuan pencairan gagal disimpan.','danger');}
}

// ==========================================================================
// 3. NAVIGATION & VIEW ROUTING
// ==========================================================================
function initEventListeners() {
  const formLogin = document.getElementById('form-login');
  if (formLogin) {
    formLogin.addEventListener('submit', (e) => {
      e.preventDefault();
      performLoginProcess();
    });
  }

  const btnLoginSubmit = document.getElementById('btn-login-submit');
  if (btnLoginSubmit) {
    btnLoginSubmit.addEventListener('click', (e) => {
      e.preventDefault();
      performLoginProcess();
    });
  }

  const togglePass = document.getElementById('toggle-password');
  if (togglePass) {
    togglePass.addEventListener('click', function() {
      const input = document.getElementById('login-password');
      if (input) {
        if (input.type === 'password') {
          input.type = 'text';
          this.classList.replace('fa-eye', 'fa-eye-slash');
        } else {
          input.type = 'password';
          this.classList.replace('fa-eye-slash', 'fa-eye');
        }
      }
    });
  }

  const btnLogout = document.getElementById('btn-logout');
  if (btnLogout) {
    btnLogout.addEventListener('click', () => {
      // Logout hanya mengakhiri sesi. Semua perubahan data harus sudah
      // disimpan saat aksi Tambah/Edit/Hapus/ACC/Tolak dilakukan.
      currentUser = null;
      sessionStorage.removeItem('gudangbat_user');
      sessionStorage.removeItem('gudangbat_token');
      sessionStorage.removeItem('gudangbat_state_version');
      localStorage.removeItem('gudangbat_user');
      localStorage.removeItem('gudangbat_token');
      localStorage.removeItem('gudangbat_state_version');
      isStateInitialized=false;
      const appLayout = document.getElementById('app-layout');
      const loginScreen = document.getElementById('login-screen');
      if (appLayout) appLayout.classList.add('hidden');
      if (loginScreen) loginScreen.classList.remove('hidden');
      showToast("Anda telah keluar dari aplikasi GUDANG BAT.", "secondary");
    });
  }

  document.querySelectorAll('.nav-link').forEach(btn => {
    btn.addEventListener('click', function() {
      const viewId = this.getAttribute('data-view');
      document.querySelectorAll('.nav-link').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      switchView(viewId);
      if (window.innerWidth <= 768) document.getElementById('sidebar')?.classList.remove('mobile-open');
      document.getElementById('sidebar-mobile-overlay')?.classList.remove('active');
    });
  });

  const sidebarToggle = document.getElementById('sidebar-toggle');
  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', () => { const sb=document.getElementById('sidebar'); if(!sb)return; if(window.innerWidth<=768){ sb.classList.toggle('mobile-open'); document.getElementById('sidebar-mobile-overlay')?.classList.toggle('active',sb.classList.contains('mobile-open')); } else { sb.classList.toggle('collapsed'); localStorage.setItem('gudangbat_sidebar_collapsed',sb.classList.contains('collapsed')?'1':'0'); } });
  }
  const sidebar=document.getElementById('sidebar'); if(sidebar && localStorage.getItem('gudangbat_sidebar_collapsed')==='1' && window.innerWidth>768) sidebar.classList.add('collapsed');
  window.addEventListener('resize',()=>{const sb=document.getElementById('sidebar');if(!sb)return;if(window.innerWidth>768){sb.classList.remove('mobile-open');document.getElementById('sidebar-mobile-overlay')?.classList.remove('active');if(localStorage.getItem('gudangbat_sidebar_collapsed')==='1')sb.classList.add('collapsed');}});
  document.getElementById('sidebar-mobile-overlay')?.addEventListener('click', () => { document.getElementById('sidebar')?.classList.remove('mobile-open'); document.getElementById('sidebar-mobile-overlay')?.classList.remove('active'); });

  document.querySelectorAll('.btn-period-gudang').forEach(btn=>btn.addEventListener('click',()=>{gudangPeriodFilter=btn.dataset.period||'today';document.querySelectorAll('.btn-period-gudang').forEach(b=>b.classList.toggle('active',b===btn));document.getElementById('gudang-custom-date-range')?.classList.toggle('hidden',gudangPeriodFilter!=='custom');if(gudangPeriodFilter!=='custom')renderGudangDashboard();}));
  document.getElementById('btn-gudang-apply-date')?.addEventListener('click',()=>{gudangCustomRange.start=document.getElementById('gudang-filter-start')?.value||'';gudangCustomRange.end=document.getElementById('gudang-filter-end')?.value||'';if(!gudangCustomRange.start||!gudangCustomRange.end)return showToast('Pilih tanggal mulai dan tanggal akhir.','warning');renderGudangDashboard();});
  document.querySelectorAll('[data-gudang-summary]').forEach(el=>el.addEventListener('click',()=>openGudangSummary(el.dataset.gudangSummary)));
  document.getElementById('seller-stock-search')?.addEventListener('input',renderSellerStockView);
  document.getElementById('seller-stock-category')?.addEventListener('change',renderSellerStockView);
  document.getElementById('btn-seller-refresh')?.addEventListener('click',async()=>{await syncFetchState();renderSellerDashboard();});

  const adminStockPhotoInput=document.getElementById('admin-stock-photo-input'); adminStockPhotoInput?.addEventListener('change',()=>{const f=adminStockPhotoInput.files?.[0],id=adminStockPhotoInput.dataset.productId;if(f&&id)saveAdminProductPhoto(f,id);});

  const themeToggle = document.getElementById('btn-theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      document.body.classList.toggle('dark-theme');
      const isDark = document.body.classList.contains('dark-theme');
      localStorage.setItem('gudangbat_theme', isDark ? 'dark' : 'light');
      const themeIcon = document.getElementById('theme-icon');
      if (themeIcon) themeIcon.className = isDark ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    });
  }

  const formRegister = document.getElementById('form-register');
  if (formRegister) {
    formRegister.addEventListener('submit', (e) => {
      e.preventDefault();
      performRegistrationProcess();
    });
  }

  const btnRefreshPending = document.getElementById('btn-refresh-pending-users');
  if (btnRefreshPending) {
    btnRefreshPending.addEventListener('click', () => loadPendingUsersData());
  }

  const btnSaveRbac = document.getElementById('btn-save-rbac-matrix');
  if (btnSaveRbac) {
    btnSaveRbac.addEventListener('click', () => saveRbacMatrix());
  }

  const btnAddRole = document.getElementById('btn-add-custom-role');
  if (btnAddRole) {
    btnAddRole.addEventListener('click', () => {
      document.getElementById('modal-custom-role')?.classList.add('active');
    });
  }

  const formCustomRole = document.getElementById('form-custom-role');
  if (formCustomRole) {
    formCustomRole.addEventListener('submit', (e) => {
      e.preventDefault();
      addCustomRole();
    });
  }

  const formSettings = document.getElementById('form-settings');
  if (formSettings) {
    formSettings.addEventListener('submit', async (e) => {
      e.preventDefault();
      appState.settings = appState.settings || {};
      appState.settings.appName = document.getElementById('setting-app-name')?.value.trim() || 'GUDANG BAT';
      appState.settings.warehouseName = document.getElementById('setting-warehouse-name')?.value.trim() || 'Gudang BAT';
      appState.settings.companyLogo = document.getElementById('setting-company-logo')?.value.trim() || '';
      appState.settings.bookingExpiryDays = Number(document.getElementById('setting-booking-expiry')?.value || 3);
      appState.settings.minStockDefault = Number(document.getElementById('setting-min-stock')?.value || 10);
      renderCompanyLogo();
      const saved = await persistAppState('UPDATE_SETTINGS', 'Admin memperbarui pengaturan aplikasi dan logo perusahaan.');
      if (saved !== false) showToast('Pengaturan aplikasi & logo perusahaan berhasil disimpan!', 'success');
    });
  }

  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', function() {
      const backdrop = this.closest('.modal-backdrop');
      if (backdrop) backdrop.classList.remove('active');
    });
  });

  document.querySelectorAll('.btn-period').forEach(btn => {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.btn-period').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      activePeriodFilter = this.getAttribute('data-period');
      
      const customBox = document.getElementById('custom-date-range');
      if (activePeriodFilter === 'custom') {
        if (customBox) customBox.classList.remove('hidden');
      } else {
        if (customBox) customBox.classList.add('hidden');
        renderAdminDashboard();
      }
    });
  });

  const btnApplyCustomDate = document.getElementById('btn-apply-custom-date');
  if (btnApplyCustomDate) {
    btnApplyCustomDate.addEventListener('click', () => {
      renderAdminDashboard();
    });
  }

  const workReportForm = document.getElementById('form-gudang-work-report');
  if (workReportForm) workReportForm.addEventListener('submit', submitGudangWorkReport);

  const payoutForm = document.getElementById('form-payout-request');
  if (payoutForm) payoutForm.addEventListener('submit', submitPayoutRequest);

  const sellerBookingForm = document.getElementById('form-seller-booking');
  if (sellerBookingForm) sellerBookingForm.addEventListener('submit', submitSellerBooking);

  const bookingProduct = document.getElementById('bkg-product-id');
  if (bookingProduct) bookingProduct.addEventListener('change', populateBookingVariants);
  const bookingVariant = document.getElementById('bkg-variant-id');
  if (bookingVariant) bookingVariant.addEventListener('change', updateBookingAvailability);
  const bookingQty = document.getElementById('bkg-qty');
  if (bookingQty) bookingQty.addEventListener('input', updateBookingAvailability);

  const workTypeSelect = document.getElementById('wrk-work-type-id');
  if (workTypeSelect) workTypeSelect.addEventListener('change', updateWorkWagePreview);
  const workQtyInput = document.getElementById('wrk-qty');
  if (workQtyInput) workQtyInput.addEventListener('input', updateWorkWagePreview);
  const workProductSelect = document.getElementById('wrk-product-id');
  if (workProductSelect) workProductSelect.addEventListener('change', updateWorkVariantOptions);

  document.querySelectorAll('.btn-period-gudang').forEach(btn=>btn.addEventListener('click',()=>{gudangPeriodFilter=btn.dataset.period||'today';document.querySelectorAll('.btn-period-gudang').forEach(b=>b.classList.toggle('active',b===btn));const box=document.getElementById('gudang-custom-date-range');if(box)box.classList.toggle('hidden',gudangPeriodFilter!=='custom');if(gudangPeriodFilter!=='custom')renderGudangDashboard();}));
  document.getElementById('btn-gudang-apply-date')?.addEventListener('click',()=>{gudangCustomRange.start=document.getElementById('gudang-filter-start')?.value||'';gudangCustomRange.end=document.getElementById('gudang-filter-end')?.value||'';if(!gudangCustomRange.start||!gudangCustomRange.end)return showToast('Pilih tanggal mulai dan tanggal akhir.','warning');renderGudangDashboard();});
  document.querySelectorAll('[data-gudang-summary]').forEach(el=>el.addEventListener('click',()=>openGudangSummary(el.dataset.gudangSummary)));
  document.getElementById('seller-refresh-data')?.addEventListener('click',()=>syncFetchState());
  document.getElementById('seller-dashboard-search')?.addEventListener('input',()=>renderSellerStockView());
  initModalActions();
}

function switchView(viewId) {
  const requiredPermission = VIEW_PERMISSIONS[viewId];
  if (requiredPermission && !hasPermission(requiredPermission)) { showToast('Anda tidak memiliki hak akses ke menu ini.', 'danger'); return; }
  document.querySelectorAll('.app-view').forEach(view => view.classList.add('hidden'));
  const targetView = document.getElementById(`view-${viewId}`);
  if (targetView) {
    targetView.classList.remove('hidden');
  }

  const titleMap = {
    'admin-dashboard': { title: 'Dashboard Admin', sub: 'Ringkasan real-time statistik gudang, produk, upah & pencairan' },
    'admin-products': { title: 'Manajemen Produk & Varian', sub: 'Kelola katalog produk, SKU, varian, dan lokasi penyimpanan' },
    'admin-stocks': { title: 'Manajemen Stok Barang', sub: 'Monitoring stok fisik, dibooking, tersedia, dan terjual' },
    'admin-stock-ins': { title: 'Barang Masuk', sub: 'Pencatatan penerimaan pasokan barang dari supplier' },
    'admin-stock-outs': { title: 'Barang Keluar', sub: 'Pencatatan pengeluaran barang selain transaksi closing sales' },
    'admin-work-management': { title: 'Pekerjaan Gudang & Upah', sub: 'Atur jenis pekerjaan, tarif per unit, dan target harian worker' },
    'admin-seller-bookings': { title: 'Booking Stok Seller', sub: 'Verifikasi dan kelola reservasi stok oleh seller' },
    'admin-sales-closing': { title: 'Scan Resi & Closing Penjualan', sub: 'Closing resi pengiriman untuk mengubah stok menjadi Terjual' },
    'admin-damaged-goods': { title: 'Barang Cacat Gudang', sub: 'Monitoring dan tindak lanjut barang rusak / cacat QC' },
    'admin-returned-goods': { title: 'Barang Retur Pembeli', sub: 'Pengelolaan barang retur yang dikembalikan pelanggan' },
    'admin-wages': { title: 'Upah Pekerja Gudang', sub: 'Ringkasan kalkulasi pendapatan dan klaim upah pekerja' },
    'admin-payouts': { title: 'Pengajuan Pencairan Upah', sub: 'Persetujuan dan pencairan dana upah hasil kerja gudang' },
    'admin-reports': { title: 'Laporan & Statistik', sub: 'Cetak dan ekspor laporan stok, mutasi, pekerjaan, dan upah' },
    'admin-pending-users': { title: 'Persetujuan Akun Pendaftaran', sub: 'Tinjau pendaftaran akun pengguna baru dan tentukan hak akses peran' },
    'admin-roles': { title: 'Hak Akses & Peran (RBAC)', sub: 'Konfigurasi izin matriks modul dan fitur aplikasi untuk setiap peran' },
    'admin-users': { title: 'Pengguna Sistem', sub: 'Kelola akun pengguna, role Admin, Gudang, dan Seller' },
    'admin-activity-logs': { title: 'Log Aktivitas', sub: 'Jejak audit trail seluruh aktivitas pengguna sistem' },
    'admin-settings': { title: 'Pengaturan Gudang & Logo', sub: 'Konfigurasi nama gudang, logo perusahaan, dan batasan sistem' },
    'admin-profile': { title: 'Profil Admin', sub: 'Kelola foto dan informasi akun administrator' },
    'gudang-dashboard': { title: 'Dashboard Gudang', sub: 'Progres target pekerjaan dan pendapatan upah harian Anda' },
    'gudang-targets': { title: 'Target Hari Ini', sub: 'Target pencapaian pekerjaan gudang yang ditugaskan admin' },
    'gudang-work-report': { title: 'Laporan Pekerjaan', sub: 'Input hasil kerja checking, packing, labeling, dan QC' },
    'gudang-work-history': { title: 'Riwayat Pekerjaan', sub: 'Catatan pekerjaan dan upah yang telah Anda selesaikan' },
    'gudang-earnings': { title: 'Pendapatan & Upah', sub: 'Detail pendapatan upah harian, mingguan, dan bulanan' },
    'gudang-payout-request': { title: 'Ajukan Pencairan Upah', sub: 'Form pengajuan klaim upah ke rekening / e-wallet' },
    'gudang-profile': { title: 'Profil Saya', sub: 'Informasi identitas akun pekerja gudang' },
    'seller-dashboard': { title: 'Dashboard Seller', sub: 'Ringkasan stok tersedia gudang dan status booking Anda' },
    'seller-stock-view': { title: 'Stok Gudang Available', sub: 'Katalog barang yang tersedia dan dapat dibooking' },
    'seller-booking-form': { title: 'Booking Stok Baru', sub: 'Form reservasi stok produk untuk persiapan penjualan' },
    'seller-booking-history': { title: 'Riwayat Booking', sub: 'Daftar status reservasi stok yang pernah Anda buat' },
    'seller-sales-status': { title: 'Status Penjualan', sub: 'Daftar resi dan transaksi yang sudah sukses di-closing' },
    'seller-profile': { title: 'Profil Seller', sub: 'Informasi identitas toko dan akun seller Anda' }
  };

  if (titleMap[viewId]) {
    const titleText = document.getElementById('page-title-text');
    const subText = document.getElementById('page-subtitle-text');
    if (titleText) titleText.innerText = titleMap[viewId].title;
    if (subText) subText.innerText = titleMap[viewId].sub;
  }

  refreshViewData(viewId);
}

function refreshCurrentView() {
  const activeLink = document.querySelector('.nav-link.active');
  if (activeLink) {
    const viewId = activeLink.getAttribute('data-view');
    refreshViewData(viewId);
  }
}

function refreshViewData(viewId) {
  updateNotificationBadges();
  switch (viewId) {
    case 'admin-dashboard': renderAdminDashboard(); break;
    case 'admin-products': renderAdminProducts(); break;
    case 'admin-stocks': renderAdminStocks(); break;
    case 'admin-stock-ins': renderAdminStockIns(); break;
    case 'admin-stock-outs': renderAdminStockOuts(); break;
    case 'admin-work-management': renderAdminWorkManagement(); renderAdminWorkTypesList(); break;
    case 'admin-seller-bookings': renderAdminSellerBookings(); break;
    case 'admin-sales-closing': renderAdminSalesClosing(); break;
    case 'admin-damaged-goods': renderAdminDamagedGoods(); break;
    case 'admin-returned-goods': renderAdminReturnedGoods(); break;
    case 'admin-wages': renderAdminWages(); break;
    case 'admin-payouts': renderAdminPayouts(); break;
    case 'admin-reports': renderAdminReports(); break;
    case 'admin-pending-users': loadPendingUsersData(); break;
    case 'admin-roles': renderRbacMatrix(); break;
    case 'admin-settings': renderCompanyLogo(); break;
    case 'admin-users': renderAdminUsers(); break;
    case 'admin-activity-logs': renderAdminActivityLogs(); break;
    case 'admin-profile': renderProfileView(); break;
    case 'gudang-profile': renderProfileView(); break;
    case 'seller-profile': renderProfileView(); break;
    case 'gudang-dashboard': renderGudangDashboard(); break;
    case 'gudang-targets': renderGudangTargets(); break;
    case 'gudang-work-report': populateWorkReportForm(); break;
    case 'gudang-work-history': renderGudangWorkHistory(); break;
    case 'gudang-earnings': renderGudangEarnings(); break;
    case 'gudang-payout-request': renderGudangPayoutRequest(); break;
    case 'seller-dashboard': renderSellerDashboard(); break;
    case 'seller-stock-view': renderSellerStockView(); break;
    case 'seller-booking-form': populateBookingForm(); break;
    case 'seller-booking-history': renderSellerBookingHistory(); break;
    case 'seller-sales-status': renderSellerSalesStatus(); break;
  }
}

async function loadPendingUsersData() {
  try {
    const res = await apiRequest(`${API_BASE}/users/pending`);
    const pendingUsers = res.data || [];
    renderPendingUsersList(pendingUsers);
    updatePendingBadge(pendingUsers.length);
  } catch (err) {
    console.warn("Gagal memuat pengguna pending:", err);
  }
}

function updateNotificationBadges() {
  if (!currentUser || currentUser.role !== 'admin') return;
  const pendingRegistrations = (appState.pendingRegistrations || []).length;
  updatePendingBadge(pendingRegistrations);

  const pendingBookings = (appState.sellerBookings || []).filter(b => b.status === 'Menunggu Persetujuan').length;
  const badgeBookings = document.getElementById('badge-admin-bookings');
  if (badgeBookings) {
    badgeBookings.textContent = pendingBookings;
    badgeBookings.classList.toggle('hidden', pendingBookings === 0);
  }

  const pendingPayouts = (appState.payoutRequests || []).filter(p => p.status === 'Menunggu Persetujuan').length;
  const badgePayouts = document.getElementById('badge-admin-payouts');
  if (badgePayouts) {
    badgePayouts.textContent = pendingPayouts;
    badgePayouts.classList.toggle('hidden', pendingPayouts === 0);
  }
}

function updatePendingBadge(count) {
  const badge = document.getElementById('badge-admin-pending');
  if (badge) {
    badge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
  }
}

function renderPendingUsersList(users) {
  const tbody = document.getElementById('tbody-pending-users-list');
  if (!tbody) return;
  if (!users || users.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted" style="padding: 24px;">Tidak ada pendaftaran pengguna baru yang menunggu persetujuan.</td></tr>`;
    return;
  }

  const customRoles = appState.customRoles || [];

  tbody.innerHTML = users.map(u => {
    const registeredDate = u.createdAt ? new Date(u.createdAt).toLocaleString('id-ID') : '-';
    return `
      <tr>
        <td><small class="text-muted">${registeredDate}</small></td>
        <td><strong>${u.name}</strong></td>
        <td><code>${u.username}</code></td>
        <td>${u.email || u.phone || '-'}</td>
        <td><span class="badge badge-secondary">${u.requestedRole || 'seller'}</span></td>
        <td>
          <select id="role-select-${u.id}" class="form-control form-control-sm" style="min-width: 140px;">
            <option value="seller" ${u.requestedRole === 'seller' ? 'selected' : ''}>Seller / Penjual</option>
            <option value="gudang" ${u.requestedRole === 'gudang' ? 'selected' : ''}>Pekerja Gudang</option>
            <option value="admin" ${u.requestedRole === 'admin' ? 'selected' : ''}>Admin Pusat</option>
            ${customRoles.map(r => `<option value="${r.id}" ${u.requestedRole === r.id ? 'selected' : ''}>${r.name}</option>`).join('')}
          </select>
        </td>
        <td class="text-right">
          <button type="button" class="btn btn-success btn-sm" onclick="approvePendingUser('${u.id}')">
            <i class="fa-solid fa-check"></i> Setujui & Aktifkan
          </button>
          <button type="button" class="btn btn-danger btn-sm" onclick="rejectPendingUser('${u.id}')">
            <i class="fa-solid fa-xmark"></i> Tolak
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

async function approvePendingUser(userId) {
  const select = document.getElementById(`role-select-${userId}`);
  const assignedRole = select ? select.value : 'seller';
  try {
    const res = await apiRequest(`${API_BASE}/users/${userId}/approve`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: assignedRole })
    });
    showToast(res.message || 'Akun berhasil disetujui.', 'success');
    await loadPendingUsersData();
    await syncFetchState(true);
  } catch (err) {
    showToast(err.message || 'Gagal menyetujui akun.', 'danger');
  }
}

async function rejectPendingUser(userId) {
  showConfirmDialog('Konfirmasi Penolakan', 'Apakah Anda yakin ingin menolak pendaftaran pengguna ini?', async () => {
    try {
      const res = await apiRequest(`${API_BASE}/users/${userId}/reject`, { method: 'PATCH' });
      showToast(res.message || 'Pendaftaran ditolak.', 'secondary');
      await loadPendingUsersData();
      await syncFetchState(true);
    } catch (err) {
      showToast(err.message || 'Gagal menolak akun.', 'danger');
    }
  });
}

function renderRbacMatrix() {
  const tbody = document.getElementById('tbody-rbac-matrix');
  const thead = document.querySelector('#table-rbac-matrix thead tr');
  if (!tbody) return;

  ensureStateShape();
  const customRoles = appState.customRoles || [];
  const rolesMap = appState.rbac?.rolePermissions || {};

  if (thead) {
    thead.innerHTML = `
      <th style="width: 320px;">Modul / Fitur Sistem</th>
      <th class="text-center">Admin Pusat</th>
      <th class="text-center">Pekerja Gudang</th>
      <th class="text-center">Seller / Penjual</th>
      ${customRoles.map(r => `<th class="text-center">${r.name} <button class="btn-icon text-danger" onclick="deleteCustomRole('${r.id}')" title="Hapus Peran"><i class="fa-solid fa-trash"></i></button></th>`).join('')}
    `;
  }

  const allRoleIds = ['admin', 'gudang', 'seller', ...customRoles.map(r => r.id)];

  tbody.innerHTML = ALL_PERMISSIONS.map(p => {
    return `
      <tr>
        <td><strong>${p.label}</strong><br><small class="text-muted"><code>${p.id}</code></small></td>
        ${allRoleIds.map(roleId => {
          const isChecked = (rolesMap[roleId] || []).includes(p.id) || roleId === 'admin';
          const isDisabled = roleId === 'admin';
          return `
            <td class="text-center">
              <input type="checkbox" class="rbac-checkbox" data-role="${roleId}" data-perm="${p.id}" ${isChecked ? 'checked' : ''} ${isDisabled ? 'disabled' : ''}>
            </td>
          `;
        }).join('')}
      </tr>
    `;
  }).join('');
}

async function saveRbacMatrix() {
  ensureStateShape();
  const checkboxes = document.querySelectorAll('.rbac-checkbox');
  const rolesMap = { admin: ALL_PERMISSIONS.map(p => p.id) };

  checkboxes.forEach(cb => {
    const roleId = cb.getAttribute('data-role');
    const permId = cb.getAttribute('data-perm');
    if (!rolesMap[roleId]) rolesMap[roleId] = [];
    if (cb.checked && !rolesMap[roleId].includes(permId)) {
      rolesMap[roleId].push(permId);
    }
  });

  appState.rbac.rolePermissions = rolesMap;
  const saved = await persistAppState('UPDATE_RBAC', 'Admin memperbarui matriks hak akses peran.');
  if (saved !== false) showToast('Matriks hak akses peran berhasil diperbarui!', 'success');
}

async function addCustomRole() {
  const name = document.getElementById('role-name-input')?.value.trim();
  const id = document.getElementById('role-id-input')?.value.trim().toLowerCase().replace(/\s+/g, '_');
  const desc = document.getElementById('role-desc-input')?.value.trim();

  if (!name || !id) return showToast('Nama dan ID peran wajib diisi.', 'warning');

  ensureStateShape();
  if (['admin', 'gudang', 'seller'].includes(id) || appState.customRoles.some(r => r.id === id)) {
    return showToast('ID Peran sudah digunakan. Pilih ID lain.', 'danger');
  }

  appState.customRoles.push({ id, name, desc });
  appState.rbac.rolePermissions[id] = ['dashboard.view', 'stocks.view'];

  const saved = await persistAppState('ADD_CUSTOM_ROLE', `Admin menambahkan peran kustom baru: ${name} (${id}).`);
  if (saved !== false) {
    showToast(`Peran kustom '${name}' berhasil ditambahkan!`, 'success');
    document.getElementById('modal-custom-role')?.classList.remove('active');
    document.getElementById('form-custom-role')?.reset();
    renderRbacMatrix();
  }
}

async function deleteCustomRole(roleId) {
  showConfirmDialog('Hapus Peran', 'Apakah Anda yakin ingin menghapus peran kustom ini?', async () => {
    ensureStateShape();
    appState.customRoles = (appState.customRoles || []).filter(r => r.id !== roleId);
    delete appState.rbac.rolePermissions[roleId];
    const saved = await persistAppState('DELETE_CUSTOM_ROLE', `Admin menghapus peran kustom '${roleId}'.`);
    if (saved !== false) {
      showToast('Peran kustom berhasil dihapus.', 'secondary');
      renderRbacMatrix();
    }
  });
}

function updateBadges() {
  const pendingBookings = (appState.sellerBookings || []).filter(b => b.status === 'Menunggu Persetujuan').length;
  const pendingPayouts = (appState.payoutRequests || []).filter(p => p.status === 'Menunggu Persetujuan').length;

  const bkgBadge = document.getElementById('badge-admin-bookings');
  if (bkgBadge) bkgBadge.innerText = pendingBookings;

  const payBadge = document.getElementById('badge-admin-payouts');
  if (payBadge) payBadge.innerText = pendingPayouts;
}

// ==========================================================================
// 4. ADMIN DASHBOARD & CHARTS
// ==========================================================================
function renderAdminDashboard() {
  const inv = appState.inventory || [];
  
  let totalProducts = (appState.products || []).length;
  let totalPhysical = inv.reduce((acc, i) => acc + (i.physicalStock || 0), 0);
  let totalBooked = inv.reduce((acc, i) => acc + (i.bookedStock || 0), 0);
  let totalAvailable = inv.reduce((acc, i) => acc + Math.max(0, (i.physicalStock || 0) - (i.bookedStock || 0)), 0);
  let totalProcess = inv.reduce((acc, i) => acc + (i.processStock || 0), 0);
  let totalSold = inv.reduce((acc, i) => acc + (i.soldStock || 0), 0);

  let totalDamaged = (appState.damagedGoods || []).reduce((acc, d) => acc + (d.qty || 0), 0);
  let totalReturned = (appState.returnedGoods || []).reduce((acc, r) => acc + (r.qty || 0), 0);

  let stockInQty = (appState.stockIns || []).reduce((acc, s) => acc + (s.qty || 0), 0);
  let stockOutQty = (appState.stockOuts || []).reduce((acc, s) => acc + (s.qty || 0), 0);

  let totalJobs = (appState.workReports || []).length;
  let unpaidWages = (appState.workReports || []).reduce((acc, w) => acc + (w.totalWage || 0), 0);

  const elProducts = document.getElementById('stat-total-products');
  if (elProducts) elProducts.innerText = totalProducts;

  const elPhysical = document.getElementById('stat-total-physical-stock');
  if (elPhysical) elPhysical.innerText = totalPhysical.toLocaleString('id-ID');

  const elAvail = document.getElementById('stat-available-stock');
  if (elAvail) elAvail.innerText = totalAvailable.toLocaleString('id-ID');

  const elBooked = document.getElementById('stat-booked-stock');
  if (elBooked) elBooked.innerText = totalBooked.toLocaleString('id-ID');

  const elProcess = document.getElementById('stat-process-stock');
  if (elProcess) elProcess.innerText = totalProcess.toLocaleString('id-ID');

  const elSold = document.getElementById('stat-sold-stock');
  if (elSold) elSold.innerText = totalSold.toLocaleString('id-ID');

  const elDamaged = document.getElementById('stat-damaged-stock');
  if (elDamaged) elDamaged.innerText = totalDamaged.toLocaleString('id-ID');

  const elReturned = document.getElementById('stat-returned-stock');
  if (elReturned) elReturned.innerText = totalReturned.toLocaleString('id-ID');

  const elStockIn = document.getElementById('stat-stock-in-qty');
  if (elStockIn) elStockIn.innerText = stockInQty.toLocaleString('id-ID');

  const elStockOut = document.getElementById('stat-stock-out-qty');
  if (elStockOut) elStockOut.innerText = stockOutQty.toLocaleString('id-ID');

  const elJobs = document.getElementById('stat-total-jobs');
  if (elJobs) elJobs.innerText = totalJobs;

  const elWages = document.getElementById('stat-unpaid-wages');
  if (elWages) elWages.innerText = `Rp ${unpaidWages.toLocaleString('id-ID')}`;

  renderAdminCharts(stockInQty, stockOutQty, totalSold, totalAvailable, totalBooked, totalDamaged, totalReturned);

  const tbody = document.getElementById('tbody-admin-recent-activities');
  if (!tbody) return;
  tbody.innerHTML = '';

  const logs = (appState.activityLogs || []).slice(0, 10);
  if (logs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center">Belum ada aktivitas tercatat.</td></tr>`;
    return;
  }

  logs.forEach(log => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatDateTime(log.createdAt)}</td>
      <td><strong>${log.userName}</strong></td>
      <td><span class="badge badge-primary">${(log.userRole || '').toUpperCase()}</span></td>
      <td><span class="badge badge-success">${log.action}</span></td>
      <td>${log.details}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderAdminCharts(stockIn, stockOut, sold, available, booked, damaged, returned) {
  if (typeof Chart === 'undefined') return;

  const ctx1 = document.getElementById('chart-stock-activity');
  if (ctx1) {
    if (currentChartActivity) currentChartActivity.destroy();
    currentChartActivity = new Chart(ctx1, {
      type: 'bar',
      data: {
        labels: ['Barang Masuk', 'Barang Keluar', 'Barang Terjual (Closing)'],
        datasets: [{
          label: 'Jumlah Unit',
          data: [stockIn, stockOut, sold],
          backgroundColor: ['#2563eb', '#f59e0b', '#10b981'],
          borderRadius: 6
        }]
      },
      options: { responsive: true, maintainAspectRatio: false }
    });
  }

  const ctx2 = document.getElementById('chart-goods-status');
  if (ctx2) {
    if (currentChartStatus) currentChartStatus.destroy();
    currentChartStatus = new Chart(ctx2, {
      type: 'doughnut',
      data: {
        labels: ['Tersedia', 'Dibooking', 'Terjual', 'Cacat', 'Retur'],
        datasets: [{
          data: [available, booked, sold, damaged, returned],
          backgroundColor: ['#10b981', '#8b5cf6', '#3b82f6', '#ef4444', '#f59e0b']
        }]
      },
      options: { responsive: true, maintainAspectRatio: false }
    });
  }

  const ctx3 = document.getElementById('chart-worker-productivity');
  if (ctx3) {
    if (currentChartProductivity) currentChartProductivity.destroy();
    
    const workerMap = {};
    (appState.workReports || []).forEach(r => {
      workerMap[r.workerName] = (workerMap[r.workerName] || 0) + r.qty;
    });

    const labels = Object.keys(workerMap);
    const dataVals = Object.values(workerMap);

    currentChartProductivity = new Chart(ctx3, {
      type: 'bar',
      data: {
        labels: labels.length ? labels : ['Agus Hermawan'],
        datasets: [{
          label: 'Unit Selesai QC/Packing',
          data: dataVals.length ? dataVals : [85],
          backgroundColor: '#8b5cf6',
          borderRadius: 6
        }]
      },
      options: { responsive: true, maintainAspectRatio: false }
    });
  }
}

// ==========================================================================
// 5. MANAJEMEN PRODUK & STOK (ADMIN)
// ==========================================================================
function renderAdminProducts() {
  const tbody = document.getElementById('tbody-products-list');
  if (!tbody) return;
  tbody.innerHTML = '';

  const products = appState.products || [];
  if (products.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="text-center">Belum ada data produk. Klik 'Tambah Produk Baru'</td></tr>`;
    return;
  }

  products.forEach(p => {
    const cat = (appState.categories || []).find(c => c.id === p.categoryId);
    const variantsText = (p.variants || []).map(v => `<span class="badge badge-secondary" style="margin:2px;">${v.name}</span>`).join(' ');

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><img src="${p.imageUrl || 'https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=100'}" style="width:40px; height:40px; border-radius:6px; object-fit:cover;"></td>
      <td><strong>${p.name}</strong><br><small class="text-muted">${p.description || ''}</small></td>
      <td><code>${p.sku}</code></td>
      <td><span class="badge badge-primary">${cat ? cat.name : '-'}</span></td>
      <td>${variantsText}</td>
      <td>${p.warehouseLocation || '-'}</td>
      <td>${p.minStock} ${p.unit}</td>
      <td><span class="badge ${p.status === 'active' ? 'badge-success' : 'badge-danger'}">${p.status === 'active' ? 'Aktif' : 'Nonaktif'}</span></td>
      <td class="text-right">
        <button class="btn btn-secondary btn-sm" onclick="editProduct('${p.id}')"><i class="fa-solid fa-pen"></i></button>
        <button class="btn btn-danger btn-sm" onclick="confirmDeleteProduct('${p.id}')"><i class="fa-solid fa-trash"></i></button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function openAdminProductPhoto(productId){if(normalizeRole(currentUser?.role)!=='admin')return showToast('Hanya Admin yang dapat mengubah foto produk.','danger');const input=document.getElementById('admin-stock-photo-input');if(!input)return showToast('Form foto produk tidak tersedia.','danger');input.dataset.productId=productId;input.value='';input.click();}
function compressImageForStorage(file,maxSize=1200,quality=.82){return new Promise((resolve,reject)=>{const rd=new FileReader();rd.onload=()=>{const img=new Image();img.onload=()=>{const scale=Math.min(1,maxSize/Math.max(img.width,img.height));const c=document.createElement('canvas');c.width=Math.max(1,Math.round(img.width*scale));c.height=Math.max(1,Math.round(img.height*scale));c.getContext('2d').drawImage(img,0,0,c.width,c.height);resolve(c.toDataURL('image/jpeg',quality));};img.onerror=()=>reject(new Error('Foto tidak dapat diproses.'));img.src=rd.result;};rd.onerror=()=>reject(new Error('Foto gagal dibaca.'));rd.readAsDataURL(file);});}
async function saveAdminProductPhoto(file,productId){if(!file||!productId)return;if(!file.type.startsWith('image/'))return showToast('File harus berupa gambar.','warning');if(file.size>3*1024*1024)return showToast('Ukuran foto maksimal 3 MB.','warning');try{const data=await compressImageForStorage(file);const p=(appState.products||[]).find(x=>x.id===productId);if(!p)throw new Error('Produk tidak ditemukan.');const payload={name:p.name,categoryId:p.categoryId,sku:p.sku,description:p.description||'',unit:p.unit||'Unit',warehouseLocation:p.warehouseLocation||'',minStock:Number(p.minStock||10),imageUrl:data,variants:p.variants||[]};await apiRequest(`/api/products/${encodeURIComponent(productId)}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});await syncFetchState(true);renderAdminStocks();renderAdminProducts();renderAdminDashboard();showToast('Foto produk berhasil diperbarui dan tersimpan di server.','success');}catch(e){showToast(e.message||'Gagal menyimpan foto produk.','danger');}}

function renderAdminStocks() {
  const tbody = document.getElementById('tbody-stocks-list');
  if (!tbody) return;
  tbody.innerHTML = '';

  const products = appState.products || [];
  const inventory = appState.inventory || [];

  if (products.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="text-center">Belum ada stok produk terdaftar.</td></tr>`;
    return;
  }

  products.forEach(p => {
    (p.variants || []).forEach(v => {
      const inv = inventory.find(i => i.productId === p.id && i.variantId === v.id) || { physicalStock: 0, bookedStock: 0, processStock: 0, soldStock: 0 };
      const available = Math.max(0, inv.physicalStock - inv.bookedStock);

      let statusBadge = `<span class="badge badge-success">Stok Aman</span>`;
      if (inv.physicalStock <= 0) statusBadge = `<span class="badge badge-danger">Habis</span>`;
      else if (available < p.minStock) statusBadge = `<span class="badge badge-warning">Hampir Habis</span>`;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><div class="stock-product-photo-cell"><img src="${p.imageUrl || ''}" onerror="this.style.display='none'" style="width:44px;height:44px;border-radius:10px;object-fit:cover;background:var(--bg-primary);"><button type="button" class="btn btn-secondary btn-xs" onclick="openAdminProductPhoto('${p.id}')" title="Ubah foto produk"><i class="fa-solid fa-camera"></i></button></div></td>
        <td><strong>${p.name}</strong><br><small class="text-primary">${v.name}</small></td>
        <td><code>${v.sku || p.sku}</code></td>
        <td><strong style="font-size:15px;">${inv.physicalStock}</strong> ${p.unit}</td>
        <td><span class="badge badge-purple">${inv.bookedStock} ${p.unit}</span></td>
        <td><strong class="text-success" style="font-size:15px;">${available}</strong> ${p.unit}</td>
        <td><span class="badge badge-warning">${inv.processStock} ${p.unit}</span></td>
        <td><span class="badge badge-primary">${inv.soldStock} ${p.unit}</span></td>
        <td>${p.warehouseLocation}</td>
        <td>${statusBadge}</td>
      `;
      tbody.appendChild(tr);
    });
  });
}

function renderAdminStockIns() {
  const tbody = document.getElementById('tbody-stock-ins-list');
  if (!tbody) return;
  tbody.innerHTML = '';

  const list = appState.stockIns || [];
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center">Belum ada catatan barang masuk.</td></tr>`;
    return;
  }

  list.forEach(item => {
    const p = (appState.products || []).find(x => x.id === item.productId);
    const v = (p ? p.variants : []).find(x => x.id === item.variantId);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${item.date}</td>
      <td><code>${item.docNo}</code></td>
      <td>${item.supplier}</td>
      <td><strong>${p ? p.name : '-'}</strong> (${v ? v.name : '-'})</td>
      <td><span class="badge badge-success">+${item.qty} ${p ? p.unit : ''}</span></td>
      <td>${item.note || '-'}</td>
      <td>Admin</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderAdminStockOuts() {
  const tbody = document.getElementById('tbody-stock-outs-list');
  if (!tbody) return;
  tbody.innerHTML = '';

  const list = appState.stockOuts || [];
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center">Belum ada pengeluaran barang non-penjualan.</td></tr>`;
    return;
  }

  list.forEach(item => {
    const p = (appState.products || []).find(x => x.id === item.productId);
    const v = (p ? p.variants : []).find(x => x.id === item.variantId);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${item.date}</td>
      <td><code>${item.docNo}</code></td>
      <td>${item.destination}</td>
      <td>${item.reason}</td>
      <td><strong>${p ? p.name : '-'}</strong> (${v ? v.name : '-'})</td>
      <td><span class="badge badge-danger">-${item.qty}</span></td>
      <td>${item.note || '-'}</td>
      <td>Admin</td>
    `;
    tbody.appendChild(tr);
  });
}

// ==========================================================================
// 6. WORKER & WAGES MANAGEMENT
// ==========================================================================
function renderAdminWorkTypesList() {
  const tbody = document.getElementById('tbody-admin-work-types');
  if (!tbody) return;
  tbody.innerHTML = '';
  const list = appState.workTypes || [];
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center">Belum ada jenis pekerjaan. Tambahkan jenis pekerjaan beserta nominal upahnya.</td></tr>';
    return;
  }
  list.forEach(wt => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><strong>${wt.name}</strong><br><small class="text-muted">${wt.description || '-'}</small></td>
      <td><strong class="text-success">${formatRupiah(getWorkRate(wt.id))}</strong>/unit</td>
      <td>${wt.updatedAt ? formatDateTime(wt.updatedAt) : '-'}</td>
      <td class="text-right"><button class="btn btn-secondary btn-sm" onclick="editWorkType('${wt.id}')"><i class="fa-solid fa-pen"></i> Edit Upah</button> <button class="btn btn-danger btn-sm" onclick="deleteWorkType('${wt.id}')"><i class="fa-solid fa-trash"></i></button></td>`;
    tbody.appendChild(tr);
  });
}

function editWorkType(id) {
  const wt = getWorkTypeById(id);
  if (!wt) return;
  document.getElementById('wt-id').value = wt.id;
  document.getElementById('wt-name').value = wt.name || '';
  document.getElementById('wt-rate').value = getWorkRate(wt.id);
  document.getElementById('wt-desc').value = wt.description || '';
  const modal = document.getElementById('modal-work-type');
  if (modal) modal.classList.add('active');
}

function deleteWorkType(id) {
  const wt = getWorkTypeById(id);
  if (!wt) return;
  showConfirmDialog('Hapus Jenis Pekerjaan', `Hapus <strong>${wt.name}</strong>? Riwayat pekerjaan lama tidak akan dihapus.`, () => {
    (async()=>{try{const res=await apiRequest(`/api/work-types/${encodeURIComponent(id)}`,{method:'DELETE'});await syncFetchState(true);renderAdminWorkTypesList();showToast(res.message||'Jenis pekerjaan berhasil dihapus.','success');}catch(err){showToast(err.message||'Jenis pekerjaan gagal dihapus.','danger');}})();
  });
}

function renderAdminWorkManagement() {
  const tbody = document.getElementById('tbody-admin-work-reports');
  if (!tbody) return;
  tbody.innerHTML = '';

  const reports = appState.workReports || [];
  if (reports.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="text-center">Belum ada laporan pekerjaan masuk dari gudang.</td></tr>`;
    return;
  }

  reports.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatDateTime(r.createdAt)}</td>
      <td><strong>${r.workerName}</strong></td>
      <td><span class="badge badge-primary">${r.workTypeName}</span></td>
      <td>${r.productName} (${r.variantName})</td>
      <td><strong>${r.qty} Unit</strong></td>
      <td><span class="badge badge-success">${r.condition}</span></td>
      <td>Rp ${(r.ratePerUnit || 0).toLocaleString('id-ID')}</td>
      <td><strong class="text-success">Rp ${(r.totalWage || 0).toLocaleString('id-ID')}</strong></td>
      <td>${r.note || '-'}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderAdminWages() {
  const tbody = document.getElementById('tbody-admin-wages-summary');
  if (!tbody) return;
  tbody.innerHTML = '';
  const workers = (appState.users || []).filter(u => u.role === 'gudang');
  if (workers.length === 0) { tbody.innerHTML = `<tr><td colspan="7" class="text-center">Belum ada akun worker gudang.</td></tr>`; return; }
  const now = new Date();
  const today = now.toISOString().slice(0,10);
  const weekStart = new Date(now); weekStart.setHours(0,0,0,0); weekStart.setDate(weekStart.getDate() - ((weekStart.getDay()+6)%7));
  workers.forEach(w => {
    const reports = (appState.workReports || []).filter(r => r.workerId === w.id);
    const sum = arr => arr.reduce((a,r)=>a+Number(r.totalWage||0),0);
    const day = sum(reports.filter(r => (r.createdAt||'').slice(0,10) === today));
    const week = sum(reports.filter(r => new Date(r.createdAt) >= weekStart));
    const month = sum(reports.filter(r => { const d=new Date(r.createdAt); return d.getMonth()===now.getMonth() && d.getFullYear()===now.getFullYear(); }));
    const paid = (appState.payoutRequests || []).filter(p => p.workerId === w.id && p.status === 'Sudah Dibayar').reduce((a,p)=>a+Number(p.amount||0),0);
    const available = getWorkerAvailableWage(w.id);
    tbody.innerHTML += `<tr>
      <td><strong>${w.name}</strong><br><small class="text-muted">@${w.username}</small></td>
      <td>${reports.length} Laporan</td><td>${formatRupiah(day)}</td><td>${formatRupiah(week)}</td><td>${formatRupiah(month)}</td>
      <td><strong class="text-warning">${formatRupiah(available)}</strong></td><td><strong class="text-success">${formatRupiah(paid)}</strong></td>
    </tr>`;
  });
}

function renderAdminPayouts() {
  const tbody = document.getElementById('tbody-admin-payouts-list');
  if (!tbody) return;
  tbody.innerHTML = '';

  const payouts = appState.payoutRequests || [];
  if (payouts.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center">Belum ada pengajuan pencairan upah.</td></tr>`;
    return;
  }

  payouts.forEach(p => {
    let actionBtns = `-`;
    if (p.status === 'Menunggu Persetujuan') {
      actionBtns = `
        <button class="btn btn-success btn-sm" onclick="approvePayout('${p.id}')"><i class="fa-solid fa-check"></i> Setujui</button>
        <button class="btn btn-danger btn-sm" onclick="rejectPayout('${p.id}')"><i class="fa-solid fa-xmark"></i> Tolak</button>
      `;
    } else if (p.status === 'Disetujui') {
      actionBtns = `<button class="btn btn-primary btn-sm" onclick="markPayoutPaid('${p.id}')"><i class="fa-solid fa-money-bill-wave"></i> Tandai Sudah Dibayar</button>`;
    }

    let statusBadge = `<span class="badge badge-warning">${p.status}</span>`;
    if (p.status === 'Sudah Dibayar') statusBadge = `<span class="badge badge-success">Sudah Dibayar</span>`;
    else if (p.status === 'Ditolak') statusBadge = `<span class="badge badge-danger">Ditolak</span>`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatDateTime(p.createdAt)}</td>
      <td><strong>${p.workerName}</strong></td>
      <td><strong class="text-success" style="font-size:15px;">Rp ${p.amount.toLocaleString('id-ID')}</strong></td>
      <td>${p.paymentMethod}</td>
      <td><code>${p.accountNo}</code></td>
      <td>${p.note || '-'}</td>
      <td>${statusBadge}</td>
      <td class="text-right">${actionBtns}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function approvePayout(id) {
  try { const res=await apiRequest(`/api/wage-withdrawals/${encodeURIComponent(id)}/approve`,{method:'PATCH'}); await syncFetchState(true); renderAdminPayouts(); renderAdminWages(); showToast(res.message||'Pengajuan pencairan disetujui!','success'); }
  catch(err){ showToast(err.message||'Gagal memperbarui pengajuan.','danger'); }
}

async function rejectPayout(id) {
  try { const res=await apiRequest(`/api/wage-withdrawals/${encodeURIComponent(id)}/reject`,{method:'PATCH'}); await syncFetchState(true); renderAdminPayouts(); renderAdminWages(); showToast(res.message||'Pengajuan pencairan ditolak.','danger'); }
  catch(err){ showToast(err.message||'Gagal memperbarui pengajuan.','danger'); }
}

async function markPayoutPaid(id) {
  try { const res=await apiRequest(`/api/wage-withdrawals/${encodeURIComponent(id)}/paid`,{method:'PATCH'}); await syncFetchState(true); renderAdminPayouts(); renderAdminWages(); showToast(res.message||'Upah berhasil ditandai Lunas!','success'); }
  catch(err){ showToast(err.message||'Gagal memperbarui pengajuan.','danger'); }
}

// ==========================================================================
// 7. BOOKING SELLER & CLOSING SALES (SCAN RESI)
// ==========================================================================
function renderAdminSellerBookings() {
  const tbody = document.getElementById('tbody-admin-bookings-list');
  if (!tbody) return;
  tbody.innerHTML = '';

  const bookings = appState.sellerBookings || [];
  if (bookings.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center">Belum ada booking stok seller.</td></tr>`;
    return;
  }

  bookings.forEach(b => {
    let actionBtns = `-`;
    if (b.status === 'Menunggu Persetujuan') {
      actionBtns = `
        <button class="btn btn-success btn-sm" onclick="approveBooking('${b.id}')"><i class="fa-solid fa-check"></i> Setujui</button>
        <button class="btn btn-danger btn-sm" onclick="rejectBooking('${b.id}')"><i class="fa-solid fa-xmark"></i> Batalkan</button>
      `;
    }

    let statusBadge = `<span class="badge badge-purple">${b.status}</span>`;
    if (b.status === 'Menunggu Persetujuan') statusBadge = `<span class="badge badge-warning">Menunggu</span>`;
    else if (b.status === 'Aktif') statusBadge = `<span class="badge badge-success">Aktif</span>`;
    else if (b.status === 'Selesai') statusBadge = `<span class="badge badge-primary">Selesai (Closed)</span>`;
    else if (b.status === 'Dibatalkan') statusBadge = `<span class="badge badge-danger">Dibatalkan</span>`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${b.bookingNo}</code></td>
      <td>${b.date}</td>
      <td><strong>${b.sellerName}</strong></td>
      <td>${b.productName} (${b.variantName})</td>
      <td><strong>${b.qty} Unit</strong></td>
      <td>${formatDateTime(b.expiresAt)}</td>
      <td>${statusBadge}</td>
      <td class="text-right">${actionBtns}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function approveBooking(id) {
  try { const res=await apiRequest(`/api/bookings/${encodeURIComponent(id)}/approve`,{method:'PATCH'}); await syncFetchState(true); renderAdminSellerBookings(); showToast(res.message||'Booking seller disetujui!','success'); } catch(err){ showToast(err.message||'Gagal menyetujui booking.','danger'); }
}

async function rejectBooking(id) {
  showConfirmDialog('Batalkan Booking','Booking akan dibatalkan dan stok yang direservasi akan langsung dilepas.',async()=>{
    try { const res=await apiRequest(`/api/bookings/${encodeURIComponent(id)}/reject`,{method:'PATCH'}); await syncFetchState(true); renderAdminSellerBookings(); showToast(res.message||'Booking dibatalkan dan stok dibebaskan.','warning'); } catch(err){ showToast(err.message||'Gagal membatalkan booking.','danger'); }
  });
}

function renderAdminSalesClosing() {
  const bookingSelect = document.getElementById('closing-booking-id');
  if (bookingSelect) {
    const selected = bookingSelect.value;
    bookingSelect.innerHTML = '<option value="">-- Pilih booking aktif yang akan di-closing --</option>';
    (appState.sellerBookings || []).filter(b => b.status === 'Aktif').forEach(b => {
      bookingSelect.innerHTML += `<option value="${b.id}">${b.bookingNo} — ${b.sellerName} — ${b.productName} (${b.variantName}) — ${b.qty} Unit</option>`;
    });
    if (selected) bookingSelect.value = selected;
  }
  const tbody = document.getElementById('tbody-admin-closings-list');
  if (!tbody) return;
  tbody.innerHTML = '';

  const closings = appState.salesClosings || [];
  if (closings.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center">Belum ada transaksi closing resi.</td></tr>`;
    return;
  }

  closings.forEach(c => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${c.transactionNo}</code></td>
      <td><span class="badge badge-purple">${c.resiNo}</span></td>
      <td>${c.closingDate}</td>
      <td><strong>${c.sellerName}</strong></td>
      <td>${c.productName} (${c.variantName})</td>
      <td><strong class="text-success">${c.qty} Unit</strong></td>
      <td>Admin</td>
    `;
    tbody.appendChild(tr);
  });
}

async function executeClosingProcess(resiNo) {
  if (!currentUser || !hasPermission('sales.closing')) { showToast('Anda tidak memiliki hak akses untuk melakukan closing penjualan.', 'danger'); return; }
  const selectedBookingId = document.getElementById('closing-booking-id')?.value;
  const activeBooking = (appState.sellerBookings || []).find(b => b.id === selectedBookingId && b.status === 'Aktif');
  if (!activeBooking) { showToast(`Pilih booking aktif yang sesuai sebelum melakukan closing resi ${resiNo}.`, 'danger'); return; }
  showConfirmDialog('Konfirmasi Closing Penjualan', `Apakah Anda yakin ingin melakukan closing resi <strong>${resiNo}</strong> untuk booking <strong>${activeBooking.bookingNo}</strong> (${activeBooking.productName} - ${activeBooking.qty} Unit)?`, async () => {
    try {
      await apiRequest('/api/resi/scan', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({resiNo}) });
      const res=await apiRequest('/api/sales-closings', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({resiNo,bookingId:selectedBookingId}) });
      await syncFetchState(true);
      renderAdminSalesClosing();
      renderAdminSellerBookings();
      const inputResi=document.getElementById('input-closing-resi-no'); if(inputResi) inputResi.value='';
      const bookingSelect=document.getElementById('closing-booking-id'); if(bookingSelect) bookingSelect.value='';
      showToast(res.message||'Closing penjualan berhasil disimpan.','success');
    } catch(err) { showToast(err.message||'Gagal melakukan closing penjualan.','danger'); }
  });
}
// ==========================================================================
// 8. BARANG CACAT & RETUR
// ==========================================================================
function renderAdminDamagedGoods() {
  const tbody = document.getElementById('tbody-damaged-goods-list');
  if (!tbody) return;
  tbody.innerHTML = '';

  const list = appState.damagedGoods || [];
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center">Belum ada laporan barang cacat.</td></tr>`;
    return;
  }

  list.forEach(item => {
    const p = (appState.products || []).find(x => x.id === item.productId);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${item.date}</td>
      <td><strong>${p ? p.name : '-'}</strong> (${item.variantName})</td>
      <td><span class="badge badge-danger">${item.qty} Unit</span></td>
      <td>${item.reason}</td>
      <td>${item.reporterName}</td>
      <td><span class="badge badge-warning">${item.status}</span></td>
      <td class="text-right">
        <button class="btn btn-secondary btn-sm" onclick="resolveDamaged('${item.id}')">Tindak Lanjut</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function resolveDamaged(id) {
  const item = (appState.damagedGoods || []).find(x => x.id === id);
  if (item && item.status !== 'Diperbaiki') {
    item.status = 'Diperbaiki';
    const inv = getInventory(item.productId, item.variantId);
    if (inv) { inv.damagedStock = Math.max(0, Number(inv.damagedStock || 0) - Number(item.qty || 0)); inv.physicalStock = Number(inv.physicalStock || 0) + Number(item.qty || 0); }
    persistAppState('TINDAK_LANJUT_CACAT', `Barang cacat ${item.id} diperbaiki dan dikembalikan ke stok tersedia.`);
    showToast('Status barang cacat diperbarui dan stok direstok.', 'success');
  }
}

function renderAdminReturnedGoods() {
  const tbody = document.getElementById('tbody-returned-goods-list');
  if (!tbody) return;
  tbody.innerHTML = '';

  const list = appState.returnedGoods || [];
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center">Belum ada laporan barang retur.</td></tr>`;
    return;
  }

  list.forEach(item => {
    const p = (appState.products || []).find(x => x.id === item.productId);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${item.date}</td>
      <td><strong>${p ? p.name : '-'}</strong> (${item.variantName})</td>
      <td><span class="badge badge-warning">${item.qty} Unit</span></td>
      <td>${item.reason}</td>
      <td>${item.reporterName}</td>
      <td><span class="badge badge-success">${item.status}</span></td>
      <td class="text-right">
        <button class="btn btn-secondary btn-sm" onclick="resolveReturned('${item.id}')">Restok Gudang</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function resolveReturned(id) {
  const item = (appState.returnedGoods || []).find(x => x.id === id);
  if (item && item.status !== 'Dapat Dijual Kembali') {
    item.status = 'Dapat Dijual Kembali';

    const inv = (appState.inventory || []).find(i => i.productId === item.productId && i.variantId === item.variantId);
    if (inv) {
      inv.physicalStock = (inv.physicalStock || 0) + item.qty;
    }

    persistAppState("RESTOK_RETUR", `Mengembalikan barang retur ${item.id} ke stok gudang tersedia`);
    showToast("Barang retur dikembalikan ke stok tersedia!", "success");
  }
}

// ==========================================================================
// 9. LAPORAN & EKSPOR DATA
// ==========================================================================
function renderAdminReports() {
  const btnGen = document.getElementById('btn-generate-report');
  if (btnGen) btnGen.click();
}

function initReportListeners() {
  const btnGen = document.getElementById('btn-generate-report');
  if (btnGen) {
    btnGen.addEventListener('click', () => {
      const typeSelect = document.getElementById('report-type-select');
      const type = typeSelect ? typeSelect.value : 'stock';
      const thead = document.getElementById('report-table-head');
      const tbody = document.getElementById('report-table-body');
      const title = document.getElementById('report-title');

      if (!thead || !tbody) return;
      thead.innerHTML = '';
      tbody.innerHTML = '';

      if (type === 'stock') {
        if (title) title.innerText = "Laporan Posisi Stok Gudang";
        thead.innerHTML = `<tr><th>Produk & Varian</th><th>SKU</th><th>Stok Fisik</th><th>Stok Dibooking</th><th>Stok Tersedia</th><th>Stok Terjual</th></tr>`;
        
        (appState.products || []).forEach(p => {
          (p.variants || []).forEach(v => {
            const inv = (appState.inventory || []).find(i => i.productId === p.id && i.variantId === v.id) || { physicalStock:0, bookedStock:0, soldStock:0 };
            const avail = Math.max(0, inv.physicalStock - inv.bookedStock);
            tbody.innerHTML += `<tr><td>${p.name} - ${v.name}</td><td><code>${v.sku || p.sku}</code></td><td>${inv.physicalStock}</td><td>${inv.bookedStock}</td><td><strong>${avail}</strong></td><td>${inv.soldStock}</td></tr>`;
          });
        });
      } else if (type === 'sales') {
        if (title) title.innerText = "Laporan Barang Terjual (Closing Resi)";
        thead.innerHTML = `<tr><th>No Transaksi</th><th>No Resi</th><th>Tanggal</th><th>Seller</th><th>Produk & Varian</th><th>Jumlah</th></tr>`;
        
        (appState.salesClosings || []).forEach(c => {
          tbody.innerHTML += `<tr><td><code>${c.transactionNo}</code></td><td>${c.resiNo}</td><td>${c.closingDate}</td><td>${c.sellerName}</td><td>${c.productName} (${c.variantName})</td><td>${c.qty} Unit</td></tr>`;
        });
      } else {
        if (title) title.innerText = "Laporan Aktivitas Pekerjaan Gudang";
        thead.innerHTML = `<tr><th>Waktu</th><th>Worker</th><th>Jenis Pekerjaan</th><th>Produk & Varian</th><th>Jumlah</th><th>Total Upah</th></tr>`;
        
        (appState.workReports || []).forEach(r => {
          tbody.innerHTML += `<tr><td>${formatDateTime(r.createdAt)}</td><td>${r.workerName}</td><td>${r.workTypeName}</td><td>${r.productName} (${r.variantName})</td><td>${r.qty} Unit</td><td>Rp ${(r.totalWage || 0).toLocaleString('id-ID')}</td></tr>`;
        });
      }
    });
  }

  const btnExcel = document.getElementById('btn-export-excel');
  if (btnExcel) {
    btnExcel.addEventListener('click', () => {
      const table = document.getElementById('report-data-table');
      if (!table) return;
      let csv = [];
      for (let row of table.rows) {
        let cols = [];
        for (let cell of row.cells) cols.push('"' + cell.innerText.replace(/"/g, '""') + '"');
        csv.push(cols.join(','));
      }
      const csvContent = "data:text/csv;charset=utf-8," + csv.join("\n");
      const encodedUri = encodeURI(csvContent);
      const link = document.createElement("a");
      link.setAttribute("href", encodedUri);
      link.setAttribute("download", `Laporan_GUDANG_BAT_${Date.now()}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showToast("Laporan berhasil diekspor ke berkas CSV/Excel!", "success");
    });
  }

  const btnPrint = document.getElementById('btn-print-report');
  if (btnPrint) {
    btnPrint.addEventListener('click', () => {
      window.print();
    });
  }
}

// ==========================================================================
// 10. MANAJEMEN PENGGUNA & LOG AKTIVITAS (ADMIN)
// ==========================================================================
async function renderAdminUsers() {
  const tbody = document.getElementById('tbody-users-list');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">Memuat pengguna...</td></tr>`;
  try {
    const res=await apiRequest(`${API_BASE}/users`); const users=res.data||[]; appState.users=users;
    if(!users.length){tbody.innerHTML=`<tr><td colspan="6" class="text-center text-muted" style="padding:24px;">Belum ada akun pengguna.</td></tr>`;return;}
    tbody.innerHTML=users.map(u=>`<tr>
      <td><strong>${escapeHtml(u.name||'-')}</strong></td><td><code>${escapeHtml(u.username||'-')}</code></td>
      <td><span class="badge badge-role-${escapeHtml(u.role||'seller')}">${escapeHtml(String(u.role||'seller').toUpperCase())}</span></td>
      <td>${escapeHtml(u.email||'-')} / ${escapeHtml(u.phone||'-')}</td>
      <td><span class="badge ${u.status==='active'?'badge-success':'badge-warning'}">${escapeHtml(u.status||'-')}</span></td>
      <td class="text-right"><button class="btn btn-secondary btn-sm" onclick="editUser('${u.id}')"><i class="fa-solid fa-pen"></i></button> <button class="btn btn-danger btn-sm" onclick="deleteUser('${u.id}')"><i class="fa-solid fa-trash"></i></button></td>
    </tr>`).join('');
  } catch(e){ tbody.innerHTML=`<tr><td colspan="6" class="text-center text-danger">Gagal memuat pengguna: ${escapeHtml(e.message||'')}</td></tr>`; }
}
function escapeHtml(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
async function editUser(id){
  try{const res=await apiRequest(`${API_BASE}/users`); const u=(res.data||[]).find(x=>x.id===id); if(!u)return showToast('Pengguna tidak ditemukan.','danger');
    document.getElementById('usr-id').value=u.id; document.getElementById('usr-name').value=u.name||''; document.getElementById('usr-username').value=u.username||''; document.getElementById('usr-password').value=''; document.getElementById('usr-role').value=u.role||'seller'; document.getElementById('usr-email').value=u.email||''; document.getElementById('usr-phone').value=u.phone||''; document.getElementById('modal-user-title').textContent='Edit Akun & Hak Akses'; document.getElementById('usr-status').value=u.status||'active'; renderUserPermissionChecks(u.permissions||[]); document.getElementById('modal-user').classList.add('active');
  }catch(e){showToast(e.message||'Gagal membuka pengguna.','danger');}
}
async function deleteUser(id){ showConfirmDialog('Hapus Akun','Hapus akun ini secara permanen?',async()=>{try{const r=await apiRequest(`${API_BASE}/users/${id}`,{method:'DELETE'});showToast(r.message||'Akun dihapus.','success');renderAdminUsers();}catch(e){showToast(e.message||'Gagal menghapus akun.','danger');}}); }
function renderUserPermissionChecks(selected=[]){ const box=document.getElementById('usr-permissions'); if(!box)return; box.innerHTML=ALL_PERMISSIONS.map(p=>`<label class="permission-chip"><input type="checkbox" value="${p.id}" ${selected.includes(p.id)?'checked':''}> ${p.label}</label>`).join(''); }

async function runIntegrityAudit(){
  const box=document.getElementById('integrity-audit-result');
  if(box) box.innerHTML='<span class="text-muted"><i class="fa-solid fa-spinner fa-spin"></i> Memeriksa konsistensi data...</span>';
  try{
    const r=await apiRequest(`${API_BASE}/audit/integrity`);
    if(!box)return;
    if(r.healthy){
      box.innerHTML=`<div class="audit-ok"><i class="fa-solid fa-circle-check"></i><div><strong>Data sehat.</strong><br><small>Audit ${new Date(r.checkedAt).toLocaleString('id-ID')} • ${r.totals.products} produk • ${r.totals.inventoryRecords} record stok • ${r.totals.activeBookings} booking aktif</small></div></div>`;
    }else{
      box.innerHTML=`<div class="audit-warning"><i class="fa-solid fa-triangle-exclamation"></i><div><strong>Ditemukan ${r.issues.length} indikasi masalah.</strong><ul>${r.issues.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul><small>Jangan melakukan perubahan massal sebelum data diperiksa.</small></div></div>`;
    }
  }catch(e){if(box)box.innerHTML=`<div class="audit-warning"><i class="fa-solid fa-circle-xmark"></i> Audit gagal: ${escapeHtml(e.message||'Terjadi kesalahan.')}</div>`;}
}

function renderAdminActivityLogs() {
  const tbody = document.getElementById('tbody-activity-logs-list');
  if (!tbody) return;
  tbody.innerHTML = '';

  const logs = appState.activityLogs || [];
  logs.forEach(l => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatDateTime(l.createdAt)}</td>
      <td><strong>${l.userName}</strong></td>
      <td><span class="badge badge-primary">${(l.userRole || '').toUpperCase()}</span></td>
      <td><span class="badge badge-success">${l.action}</span></td>
      <td>${l.details}</td>
      <td><code>${l.ipAddress || '127.0.0.1'}</code></td>
    `;
    tbody.appendChild(tr);
  });
}

// ==========================================================================
// 11. WORKER GUDANG & SELLER VIEWS
// ==========================================================================
function renderGudangDashboard(){if(!currentUser)return;const range=getGudangRange(),reports=(appState.workReports||[]).filter(r=>r.workerId===currentUser.id&&inDateRange(r.createdAt||r.date,range)),targets=(appState.workTargets||[]).filter(t=>t.assignedToUserId===currentUser.id&&inDateRange(`${t.date}T12:00:00`,range));const targetQty=targets.reduce((s,t)=>s+Number(t.targetQty||0),0),doneQty=reports.reduce((s,r)=>s+Number(r.qty||0),0),wage=reports.reduce((s,r)=>s+Number(r.totalWage||0),0),unpaid=getWorkerAvailableWage(currentUser.id);const set=(id,v)=>{const e=document.getElementById(id);if(e)e.innerText=v;};set('gudang-stat-today-target',`${targetQty.toLocaleString('id-ID')} Unit`);set('gudang-stat-today-done',`${doneQty.toLocaleString('id-ID')} Unit`);set('gudang-stat-today-wage',formatRupiah(wage));set('gudang-stat-unpaid',formatRupiah(unpaid));set('gudang-period-label',range.label);const tbody=document.getElementById('tbody-gudang-today-targets');if(!tbody)return;tbody.innerHTML='';if(!targets.length){tbody.innerHTML=`<tr><td colspan="6" class="text-center">Belum ada target pekerjaan pada periode ${range.label.toLowerCase()}.</td></tr>`;return;}targets.forEach(t=>{const wt=(appState.workTypes||[]).find(x=>x.id===t.workTypeId),p=(appState.products||[]).find(x=>x.id===t.productId),v=(p?.variants||[]).find(x=>x.id===t.variantId),done=reports.filter(r=>r.workTypeId===t.workTypeId&&r.productId===t.productId&&r.variantId===t.variantId&&(r.createdAt||'').slice(0,10)===t.date).reduce((s,r)=>s+Number(r.qty||0),0),pct=t.targetQty?Math.min(100,Math.round(done/t.targetQty*100)):0,tr=document.createElement('tr');tr.innerHTML=`<td>${t.date}<br><strong>${wt?.name||'-'}</strong></td><td>${p?.name||'-'} (${v?.name||'-'})</td><td>${Number(t.targetQty||0)} Unit</td><td><strong class="text-success">${done} Unit</strong></td><td><div class="progress-label">${pct}%</div><div class="progress-bar-wrapper"><div class="progress-fill ${pct>=100?'success':''}" style="width:${pct}%"></div></div></td><td class="text-right"><button class="btn btn-primary btn-sm" onclick="openWorkReportForm('${t.workTypeId}','${t.productId}','${t.variantId}')">Lapor Kerja</button></td>`;tbody.appendChild(tr);});}
function openGudangSummary(type){const range=getGudangRange(),reports=(appState.workReports||[]).filter(r=>r.workerId===currentUser.id&&inDateRange(r.createdAt||r.date,range)),targets=(appState.workTargets||[]).filter(t=>t.assignedToUserId===currentUser.id&&inDateRange(`${t.date}T12:00:00`,range)),body=document.getElementById('gudang-summary-body'),title=document.getElementById('gudang-summary-title');if(!body)return;const totalTarget=targets.reduce((s,x)=>s+Number(x.targetQty||0),0),totalDone=reports.reduce((s,x)=>s+Number(x.qty||0),0),totalWage=reports.reduce((s,x)=>s+Number(x.totalWage||0),0);if(title)title.textContent={target:'Ringkasan Target Pekerjaan',done:'Ringkasan Pekerjaan Selesai',wage:'Ringkasan Pendapatan',unpaid:'Upah Belum Dicairkan'}[type]||'Ringkasan Dashboard';if(type==='unpaid'){body.innerHTML=`<div class="summary-highlight"><span>Saldo yang masih tersedia untuk dicairkan</span><strong>${formatRupiah(getWorkerAvailableWage(currentUser.id))}</strong></div><p class="text-muted" style="margin-top:12px">Saldo ini adalah akumulasi seluruh upah yang sudah diperoleh, dikurangi pengajuan yang masih diproses/disetujui dan pencairan yang sudah dibayar.</p><div class="report-actions"><button class="btn btn-primary" onclick="closeGudangSummary();switchView('gudang-payout-request')">Ajukan Pencairan</button></div>`;}else{body.innerHTML=`<div class="variant-report-grid"><div><small>Total Target</small><strong>${totalTarget.toLocaleString('id-ID')} Unit</strong></div><div><small>Total Selesai</small><strong>${totalDone.toLocaleString('id-ID')} Unit</strong></div><div><small>Total Upah</small><strong>${formatRupiah(totalWage)}</strong></div></div><div class="summary-list">${reports.slice(0,20).map(r=>`<div><span>${r.workTypeName||'-'} — ${r.productName||'-'} (${r.variantName||'-'})</span><strong>${Number(r.qty||0)} Unit • ${formatRupiah(r.totalWage||0)}</strong></div>`).join('')||'<p class="text-muted">Belum ada laporan pada periode ini.</p>'}</div>`;}document.getElementById('modal-gudang-summary')?.classList.add('active');}
function closeGudangSummary(){document.getElementById('modal-gudang-summary')?.classList.remove('active');}

function renderGudangTargets() {
  const tbody = document.getElementById('tbody-gudang-all-targets');
  if (!tbody) return;
  tbody.innerHTML = '';

  const targets = (appState.workTargets || []).filter(t => !currentUser || t.assignedToUserId === currentUser.id);
  if (targets.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center">Belum ada target pekerjaan.</td></tr>`;
    return;
  }

  targets.forEach(t => {
    const wt = (appState.workTypes || []).find(x => x.id === t.workTypeId);
    const p = (appState.products || []).find(x => x.id === t.productId);
    const v = (p ? p.variants : []).find(x => x.id === t.variantId);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${t.date}</td>
      <td><strong>${wt ? wt.name : '-'}</strong></td>
      <td>${p ? p.name : '-'} (${v ? v.name : '-'})</td>
      <td>${t.targetQty} Unit</td>
      <td><strong class="text-success">${(appState.workReports || []).filter(r => r.workerId === currentUser?.id && r.workTypeId === t.workTypeId && r.productId === t.productId && r.variantId === t.variantId && (r.createdAt || '').slice(0,10) === t.date).reduce((sum,r)=>sum+Number(r.qty||0),0)} Unit</strong></td>
      <td><span class="badge ${((appState.workReports || []).filter(r => r.workerId === currentUser?.id && r.workTypeId === t.workTypeId && r.productId === t.productId && r.variantId === t.variantId && (r.createdAt || '').slice(0,10) === t.date).reduce((sum,r)=>sum+Number(r.qty||0),0) >= t.targetQty) ? 'badge-success' : 'badge-warning'}">${((appState.workReports || []).filter(r => r.workerId === currentUser?.id && r.workTypeId === t.workTypeId && r.productId === t.productId && r.variantId === t.variantId && (r.createdAt || '').slice(0,10) === t.date).reduce((sum,r)=>sum+Number(r.qty||0),0) >= t.targetQty) ? 'Selesai' : 'Dalam Proses'}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

function renderGudangWorkHistory() {
  const tbody = document.getElementById('tbody-gudang-history');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!currentUser) return;
  const reports = (appState.workReports || []).filter(r => r.workerId === currentUser.id);
  if (reports.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center">Anda belum memasukkan laporan pekerjaan.</td></tr>`;
    return;
  }

  reports.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatDateTime(r.createdAt)}</td>
      <td><strong>${r.workTypeName}</strong></td>
      <td>${r.productName} (${r.variantName})</td>
      <td>${r.qty} Unit</td>
      <td><span class="badge badge-success">${r.condition}</span></td>
      <td>Rp ${(r.ratePerUnit || 0).toLocaleString('id-ID')}</td>
      <td><strong class="text-success">Rp ${(r.totalWage || 0).toLocaleString('id-ID')}</strong></td>
    `;
    tbody.appendChild(tr);
  });
}

function renderGudangEarnings() {
  if (!currentUser) return;
  const reports = (appState.workReports || []).filter(r => r.workerId === currentUser.id);
  const now = new Date();
  const todayKey = now.toISOString().slice(0,10);
  const dayReports = reports.filter(r => (r.createdAt || '').slice(0,10) === todayKey);
  const weekStart = new Date(now); weekStart.setHours(0,0,0,0); weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  const month = now.getMonth(), year = now.getFullYear();
  const sum = arr => arr.reduce((a,r)=>a+Number(r.totalWage||0),0);
  const today = sum(dayReports);
  const week = sum(reports.filter(r => new Date(r.createdAt) >= weekStart));
  const monthTotal = sum(reports.filter(r => { const d=new Date(r.createdAt); return d.getMonth()===month && d.getFullYear()===year; }));
  const unpaid = getWorkerAvailableWage(currentUser.id);
  const set = (id,val) => { const el=document.getElementById(id); if(el) el.innerText=formatRupiah(val); };
  set('earn-today',today); set('earn-week',week); set('earn-month',monthTotal); set('earn-unpaid',unpaid);
}

function renderGudangPayoutRequest() {
  const tbody = document.getElementById('tbody-gudang-payout-history');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!currentUser) return;
  const list = (appState.payoutRequests || []).filter(p => p.workerId === currentUser.id);
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center">Belum ada riwayat pengajuan pencairan upah.</td></tr>`;
    return;
  }

  list.forEach(p => {
    let statusBadge = `<span class="badge badge-warning">${p.status}</span>`;
    if (p.status === 'Sudah Dibayar') statusBadge = `<span class="badge badge-success">Sudah Dibayar</span>`;
    else if (p.status === 'Ditolak') statusBadge = `<span class="badge badge-danger">Ditolak</span>`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatDateTime(p.createdAt)}</td>
      <td><strong class="text-success">Rp ${p.amount.toLocaleString('id-ID')}</strong></td>
      <td>${p.paymentMethod}</td>
      <td><code>${p.accountNo}</code></td>
      <td>${statusBadge}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderSellerDashboard() {
  const inventory = appState.inventory || [];
  const totalAvail = inventory.reduce((acc, i) => acc + Math.max(0, i.physicalStock - i.bookedStock), 0);

  if (!currentUser) return;
  const myBookings = (appState.sellerBookings || []).filter(b => b.sellerId === currentUser.id);
  const activeCount = myBookings.filter(b => b.status === 'Aktif').length;
  const pendingCount = myBookings.filter(b => b.status === 'Menunggu Persetujuan').length;

  const elAvail = document.getElementById('seller-stat-available');
  if (elAvail) elAvail.innerText = `${totalAvail.toLocaleString('id-ID')} Unit`;

  const elAct = document.getElementById('seller-stat-active-booking');
  if (elAct) elAct.innerText = activeCount;

  const elPend = document.getElementById('seller-stat-pending-booking');
  if (elPend) elPend.innerText = pendingCount;

  const tbody = document.getElementById('tbody-seller-active-bookings');
  if (!tbody) return;
  tbody.innerHTML = '';

  const activeBookings = myBookings.filter(b => b.status === 'Aktif' || b.status === 'Menunggu Persetujuan');
  if (activeBookings.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center">Anda belum memiliki booking aktif.</td></tr>`;
    return;
  }

  activeBookings.forEach(b => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${b.bookingNo}</code></td>
      <td>${b.date}</td>
      <td>${b.productName} (${b.variantName})</td>
      <td><strong>${b.qty} Unit</strong></td>
      <td>${formatDateTime(b.expiresAt)}</td>
      <td><span class="badge badge-purple">${b.status}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

function renderSellerStockView(){const tbody=document.getElementById('tbody-seller-stock-catalog');if(!tbody)return;tbody.innerHTML='';const q=(document.getElementById('seller-stock-search')?.value||'').trim().toLowerCase(),cat=document.getElementById('seller-stock-category')?.value||'',products=(appState.products||[]).filter(p=>(!cat||p.categoryId===cat));const inventory=appState.inventory||[];let rows=0;products.forEach(p=>(p.variants||[]).forEach(v=>{const text=`${p.name} ${v.name} ${v.sku||p.sku||''}`.toLowerCase();if(q&&!text.includes(q))return;const inv=inventory.find(i=>i.productId===p.id&&i.variantId===v.id)||{physicalStock:0,bookedStock:0},avail=Math.max(0,Number(inv.physicalStock||0)-Number(inv.bookedStock||0));rows++;const tr=document.createElement('tr');tr.innerHTML=`<td><strong>${p.name}</strong><br><small class="text-primary">${v.name}</small></td><td><code>${v.sku||p.sku||'-'}</code></td><td><strong class="text-success" style="font-size:16px;">${avail} ${p.unit||'Unit'}</strong></td><td>${p.warehouseLocation||'-'}</td><td class="text-right"><button class="btn btn-purple btn-sm" style="background:var(--purple);color:#fff;" ${avail<=0?'disabled':''} onclick="quickBookProduct('${p.id}','${v.id}')">Booking Sekarang</button></td>`;tbody.appendChild(tr);}));if(!rows)tbody.innerHTML=`<tr><td colspan="5" class="text-center">Tidak ada stok yang sesuai pencarian.</td></tr>`;const catSel=document.getElementById('seller-stock-category');if(catSel&&catSel.options.length<=1)catSel.innerHTML='<option value="">Semua Kategori</option>'+(appState.categories||[]).map(c=>`<option value="${c.id}">${c.name}</option>`).join('');}

function renderSellerBookingHistory() {
  const tbody = document.getElementById('tbody-seller-booking-history');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!currentUser) return;
  const list = (appState.sellerBookings || []).filter(b => b.sellerId === currentUser.id);
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center">Belum ada riwayat booking.</td></tr>`;
    return;
  }
  list.forEach(b => {
    const canCancel=['Menunggu Persetujuan','Aktif'].includes(b.status);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${b.bookingNo}</code></td><td>${formatDateTime(b.createdAt)}</td><td>${b.productName} (${b.variantName})</td><td><strong>${b.qty} Unit</strong></td><td>${formatDateTime(b.expiresAt)}</td><td><span class="badge ${b.status==='Aktif'?'badge-success':b.status==='Dibatalkan'?'badge-danger':'badge-warning'}">${b.status}</span></td><td class="text-right">${canCancel?`<button class="btn btn-danger btn-sm" onclick="cancelSellerBooking('${b.id}')"><i class="fa-solid fa-xmark"></i> Batalkan</button>`:'-'}</td>`;
    tbody.appendChild(tr);
  });
}

async function cancelSellerBooking(id){showConfirmDialog('Batalkan Booking','Stok yang dibooking akan dilepas kembali ke stok tersedia.',async()=>{try{const r=await apiRequest(`${API_BASE}/bookings/${encodeURIComponent(id)}/cancel`,{method:'PATCH'});await syncFetchState(true);renderSellerDashboard();renderSellerBookingHistory();showToast(r.message||'Booking dibatalkan.','success');}catch(e){showToast(e.message||'Gagal membatalkan booking.','danger');}});}

function renderSellerSalesStatus() {
  const tbody = document.getElementById('tbody-seller-sales-history');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!currentUser) return;
  const closings = (appState.salesClosings || []).filter(c => c.sellerId === currentUser.id);
  if (closings.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center">Belum ada transaksi penjualan di-closing.</td></tr>`;
    return;
  }

  closings.forEach(c => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${c.transactionNo}</code></td>
      <td><span class="badge badge-purple">${c.resiNo}</span></td>
      <td>${c.closingDate}</td>
      <td>${c.productName} (${c.variantName})</td>
      <td><strong class="text-success">${c.qty} Unit</strong></td>
    `;
    tbody.appendChild(tr);
  });
}

// ==========================================================================
// 12. MODAL FORM SUBMISSIONS & EVENT HANDLERS
// ==========================================================================
function initModalActions() {
  // Product Modal Open
  const btnOpenProduct = document.getElementById('btn-open-product-modal');
  if (btnOpenProduct) {
    btnOpenProduct.addEventListener('click', () => {
      const form = document.getElementById('form-modal-product');
      if (form) form.reset();
      
      const prdId = document.getElementById('prd-id');
      if (prdId) prdId.value = '';
      
      const modalTitle = document.getElementById('modal-product-title');
      if (modalTitle) modalTitle.innerText = "Tambah Produk Baru";

      const catSelect = document.getElementById('prd-category-id');
      if (catSelect) {
        catSelect.innerHTML = '';
        (appState.categories || []).forEach(c => {
          catSelect.innerHTML += `<option value="${c.id}">${c.name}</option>`;
        });
      }

      const modalPrd = document.getElementById('modal-product');
      if (modalPrd) modalPrd.classList.add('active');
    });
  }

  // Save Product (Tambah / Edit) - langsung ke endpoint CRUD
  const btnSaveProduct = document.getElementById('btn-save-product');
  if (btnSaveProduct) btnSaveProduct.addEventListener('click', async () => {
    const id = document.getElementById('prd-id').value.trim();
    const name = document.getElementById('prd-name').value.trim(); const categoryId = document.getElementById('prd-category-id').value;
    const sku = document.getElementById('prd-sku').value.trim(); const unit = document.getElementById('prd-unit').value.trim() || 'Unit';
    const warehouseLocation = document.getElementById('prd-location').value.trim(); const minStock = parseInt(document.getElementById('prd-min-stock').value) || 10;
    const description = document.getElementById('prd-description').value.trim(); const varStr = document.getElementById('prd-variants-input').value.trim();
    if (!name || !sku || !categoryId) return showToast('Nama produk, kategori dan SKU wajib diisi!', 'warning');
    const existing=(appState.products||[]).find(p=>p.id===id);
    const names=varStr ? varStr.split(',').map(x=>x.trim()).filter(Boolean) : ['Standard'];
    const variants=names.map((n,i)=>{const old=existing?.variants?.find(v=>v.name===n);return {id:old?.id,name:n,sku:old?.sku||`${sku}-${i+1}`};});
    const imageUrl=document.getElementById('prd-image-url')?.value?.trim() || existing?.imageUrl || ''; const payload={name,categoryId,sku,description,unit,warehouseLocation,minStock,imageUrl,variants};
    const original=btnSaveProduct.innerHTML; btnSaveProduct.disabled=true; btnSaveProduct.innerHTML='<i class="fa-solid fa-spinner fa-spin"></i> Menyimpan...';
    try {
      await apiRequest(id?`/api/products/${encodeURIComponent(id)}`:'/api/products',{method:id?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      await syncFetchState(true); refreshCurrentView(); document.getElementById('modal-product')?.classList.remove('active'); showToast(`Produk ${name} berhasil ${id?'diperbarui':'ditambahkan'}!`,'success');
    } catch(err) { showToast(err.message||'Produk gagal disimpan.','danger'); }
    finally { btnSaveProduct.disabled=false; btnSaveProduct.innerHTML=original; }
  });

  // Category Modal
  const btnOpenCategory = document.getElementById('btn-open-category-modal');
  if (btnOpenCategory) {
    btnOpenCategory.addEventListener('click', () => {
      const modal = document.getElementById('modal-category');
      if (modal) modal.classList.add('active');
    });
  }

  const btnSaveCategory = document.getElementById('btn-save-category');
  if (btnSaveCategory) btnSaveCategory.addEventListener('click', async () => {
    const name = document.getElementById('cat-name').value.trim();
    const description = document.getElementById('cat-desc').value.trim();
    if (!name) return showToast('Nama kategori wajib diisi!', 'warning');
    const original=btnSaveCategory.innerHTML; btnSaveCategory.disabled=true;
    try {
      await apiRequest('/api/categories',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,description})});
      await syncFetchState(true); refreshCurrentView(); document.getElementById('modal-category')?.classList.remove('active'); showToast(`Kategori ${name} berhasil ditambahkan!`, 'success');
    } catch(err){ showToast(err.message||'Kategori gagal ditambahkan.','danger'); }
    finally { btnSaveCategory.disabled=false; btnSaveCategory.innerHTML=original; }
  });

  // Stock In Modal
  const btnOpenStockIn = document.getElementById('btn-open-stock-in-modal');
  if (btnOpenStockIn) {
    btnOpenStockIn.addEventListener('click', () => {
      const formIn = document.getElementById('form-stock-in');
      if (formIn) formIn.reset();
      
      const prodSelect = document.getElementById('in-product-id');
      if (prodSelect) {
        prodSelect.innerHTML = '<option value="">-- Pilih Produk --</option>';
        (appState.products || []).forEach(p => {
          prodSelect.innerHTML += `<option value="${p.id}">${p.name}</option>`;
        });
      }

      const modalIn = document.getElementById('modal-stock-in');
      if (modalIn) modalIn.classList.add('active');
    });
  }

  const inProdSelect = document.getElementById('in-product-id');
  if (inProdSelect) {
    inProdSelect.addEventListener('change', function() {
      const p = (appState.products || []).find(x => x.id === this.value);
      const varSelect = document.getElementById('in-variant-id');
      if (varSelect) {
        varSelect.innerHTML = '';
        if (p) {
          p.variants.forEach(v => {
            varSelect.innerHTML += `<option value="${v.id}">${v.name}</option>`;
          });
        }
      }
    });
  }

  const btnSaveStockIn = document.getElementById('btn-save-stock-in');
  if (btnSaveStockIn) {
    btnSaveStockIn.addEventListener('click', async () => {
      const productId = document.getElementById('in-product-id').value;
      const variantId = document.getElementById('in-variant-id').value;
      const qty = Number(document.getElementById('in-qty').value || 0);
      const supplier = document.getElementById('in-supplier').value.trim();
      const docNo = document.getElementById('in-doc-no').value.trim();
      const note = document.getElementById('in-note').value.trim();
      if (!productId || !variantId || qty <= 0) return showToast('Pilih produk, varian, dan masukkan jumlah barang!', 'warning');
      const original = btnSaveStockIn.innerHTML;
      btnSaveStockIn.disabled = true;
      btnSaveStockIn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menyimpan...';
      try {
        await apiRequest('/api/inventory/in', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({productId,variantId,qty,supplier,docNo,note}) });
        await syncFetchState(true);
        refreshCurrentView();
        document.getElementById('modal-stock-in')?.classList.remove('active');
        showToast('Barang masuk berhasil disimpan dan stok diperbarui!', 'success');
      } catch (err) {
        showToast(err.message || 'Barang masuk gagal disimpan.', 'danger');
      } finally {
        btnSaveStockIn.disabled = false;
        btnSaveStockIn.innerHTML = original;
      }
    });
  }

  // Stock Out Modal
  const btnOpenStockOut = document.getElementById('btn-open-stock-out-modal');
  if (btnOpenStockOut) {
    btnOpenStockOut.addEventListener('click', () => {
      const formOut = document.getElementById('form-stock-out');
      if (formOut) formOut.reset();

      const prodSelect = document.getElementById('out-product-id');
      if (prodSelect) {
        prodSelect.innerHTML = '<option value="">-- Pilih Produk --</option>';
        (appState.products || []).forEach(p => {
          prodSelect.innerHTML += `<option value="${p.id}">${p.name}</option>`;
        });
      }

      const modalOut = document.getElementById('modal-stock-out');
      if (modalOut) modalOut.classList.add('active');
    });
  }

  const outProdSelect = document.getElementById('out-product-id');
  if (outProdSelect) {
    outProdSelect.addEventListener('change', function() {
      const p = (appState.products || []).find(x => x.id === this.value);
      const varSelect = document.getElementById('out-variant-id');
      if (varSelect) {
        varSelect.innerHTML = '';
        if (p) {
          p.variants.forEach(v => {
            varSelect.innerHTML += `<option value="${v.id}">${v.name}</option>`;
          });
        }
      }
    });
  }

  const btnSaveStockOut = document.getElementById('btn-save-stock-out');
  if (btnSaveStockOut) {
    btnSaveStockOut.addEventListener('click', async () => {
      const productId = document.getElementById('out-product-id').value;
      const variantId = document.getElementById('out-variant-id').value;
      const qty = Number(document.getElementById('out-qty').value || 0);
      const destination = document.getElementById('out-destination').value.trim();
      const reason = document.getElementById('out-reason').value.trim();
      const note = document.getElementById('out-note').value.trim();
      if (!productId || !variantId || qty <= 0) return showToast('Pilih produk, varian, dan masukkan jumlah barang keluar!', 'warning');
      const original = btnSaveStockOut.innerHTML;
      btnSaveStockOut.disabled = true;
      btnSaveStockOut.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menyimpan...';
      try {
        await apiRequest('/api/inventory/out', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({productId,variantId,qty,destination,reason,note}) });
        await syncFetchState(true);
        refreshCurrentView();
        document.getElementById('modal-stock-out')?.classList.remove('active');
        showToast('Barang keluar berhasil disimpan dan stok diperbarui!', 'success');
      } catch (err) {
        showToast(err.message || 'Barang keluar gagal disimpan.', 'danger');
      } finally {
        btnSaveStockOut.disabled = false;
        btnSaveStockOut.innerHTML = original;
      }
    });
  }

  // Work Type Modal
  const btnOpenWorkType = document.getElementById('btn-open-work-type-modal');
  if (btnOpenWorkType) {
    btnOpenWorkType.addEventListener('click', () => {
      document.getElementById('form-work-type')?.reset();
      const wtId = document.getElementById('wt-id'); if (wtId) wtId.value = '';
      const modal = document.getElementById('modal-work-type');
      if (modal) modal.classList.add('active');
    });
  }

  const btnSaveWorkType = document.getElementById('btn-save-work-type');
  if (btnSaveWorkType) {
    btnSaveWorkType.addEventListener('click', async () => {
      const name = document.getElementById('wt-name').value.trim();
      const rate = parseInt(document.getElementById('wt-rate').value) || 0;
      const desc = document.getElementById('wt-desc').value.trim();

      if (!name || rate <= 0) {
        showToast("Nama pekerjaan dan tarif upah wajib diisi!", "warning");
        return;
      }

      const editId = document.getElementById('wt-id')?.value;
      const existing = editId ? getWorkTypeById(editId) : null;
      try {
        const res=await apiRequest(existing?`/api/work-types/${encodeURIComponent(editId)}`:'/api/work-types',{method:existing?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,rate,description:desc})});
        await syncFetchState(true);
        const modal=document.getElementById('modal-work-type'); if(modal) modal.classList.remove('active');
        renderAdminWorkTypesList();
        showToast(res.message||`Jenis pekerjaan ${name} berhasil disimpan.`,"success");
      } catch(err){ showToast(err.message||'Jenis pekerjaan gagal disimpan.',"danger"); }
    });
  }

  // Work Target Modal
  const btnOpenWorkTarget = document.getElementById('btn-open-work-target-modal');
  if (btnOpenWorkTarget) {
    btnOpenWorkTarget.addEventListener('click', () => {
      const workerSelect = document.getElementById('tgt-worker-id');
      if (workerSelect) {
        workerSelect.innerHTML = '';
        (appState.users || []).filter(u => u.role === 'gudang').forEach(w => {
          workerSelect.innerHTML += `<option value="${w.id}">${w.name}</option>`;
        });
      }

      const wtSelect = document.getElementById('tgt-work-type-id');
      if (wtSelect) {
        wtSelect.innerHTML = '';
        (appState.workTypes || []).forEach(wt => {
          wtSelect.innerHTML += `<option value="${wt.id}">${wt.name}</option>`;
        });
      }

      const prodSelect = document.getElementById('tgt-product-id');
      if (prodSelect) {
        prodSelect.innerHTML = '<option value="">-- Pilih Produk --</option>';
        (appState.products || []).forEach(p => {
          prodSelect.innerHTML += `<option value="${p.id}">${p.name}</option>`;
        });
      }

      const modal = document.getElementById('modal-work-target');
      if (modal) modal.classList.add('active');
    });
  }

  const tgtProdSelect = document.getElementById('tgt-product-id');
  if (tgtProdSelect) {
    tgtProdSelect.addEventListener('change', function() {
      const p = (appState.products || []).find(x => x.id === this.value);
      const varSelect = document.getElementById('tgt-variant-id');
      if (varSelect) {
        varSelect.innerHTML = '';
        if (p) {
          p.variants.forEach(v => {
            varSelect.innerHTML += `<option value="${v.id}">${v.name}</option>`;
          });
        }
      }
    });
  }

  const btnSaveWorkTarget = document.getElementById('btn-save-work-target');
  if (btnSaveWorkTarget) {
    btnSaveWorkTarget.addEventListener('click', () => {
      const wId = document.getElementById('tgt-worker-id').value;
      const wtId = document.getElementById('tgt-work-type-id').value;
      const pId = document.getElementById('tgt-product-id').value;
      const vId = document.getElementById('tgt-variant-id').value;
      const qty = parseInt(document.getElementById('tgt-qty').value) || 0;

      if (!wId || !wtId || !pId || !vId || qty <= 0) {
        showToast("Pilih worker, jenis pekerjaan, produk, varian, dan target!", "warning");
        return;
      }

      const newTgt = {
        id: "TGT-" + Date.now(),
        date: new Date().toISOString().slice(0,10),
        workTypeId: wtId,
        productId: pId,
        variantId: vId,
        targetQty: qty,
        assignedToUserId: wId,
        status: 'in_progress',
        createdAt: new Date().toISOString()
      };

      if (!appState.workTargets) appState.workTargets = [];
      appState.workTargets.unshift(newTgt);

      const modal = document.getElementById('modal-work-target');
      if (modal) modal.classList.remove('active');
      persistAppState("TUGASKAN_TARGET", `Menugaskan target ${qty} unit ke worker ${wId}`);
      showToast("Target harian berhasil ditugaskan ke pekerja gudang!", "success");
    });
  }

  // Damaged Goods Modal
  const btnOpenDamaged = document.getElementById('btn-open-damaged-modal');
  if (btnOpenDamaged) {
    btnOpenDamaged.addEventListener('click', () => {
      const prodSelect = document.getElementById('dmg-product-id');
      if (prodSelect) {
        prodSelect.innerHTML = '<option value="">-- Pilih Produk --</option>';
        (appState.products || []).forEach(p => {
          prodSelect.innerHTML += `<option value="${p.id}">${p.name}</option>`;
        });
      }
      const modal = document.getElementById('modal-damaged');
      if (modal) modal.classList.add('active');
    });
  }

  const dmgProdSelect = document.getElementById('dmg-product-id');
  if (dmgProdSelect) {
    dmgProdSelect.addEventListener('change', function() {
      const p = (appState.products || []).find(x => x.id === this.value);
      const varSelect = document.getElementById('dmg-variant-id');
      if (varSelect) {
        varSelect.innerHTML = '';
        if (p) {
          p.variants.forEach(v => {
            varSelect.innerHTML += `<option value="${v.id}">${v.name}</option>`;
          });
        }
      }
    });
  }

  const btnSaveDamaged = document.getElementById('btn-save-damaged');
  if (btnSaveDamaged) {
    btnSaveDamaged.addEventListener('click', () => {
      const pId = document.getElementById('dmg-product-id').value;
      const vId = document.getElementById('dmg-variant-id').value;
      const qty = parseInt(document.getElementById('dmg-qty').value) || 0;
      const reason = document.getElementById('dmg-reason').value.trim();

      if (!pId || !vId || qty <= 0 || !reason) {
        showToast("Lengkapi form laporan barang cacat!", "warning");
        return;
      }

      const p = (appState.products || []).find(x => x.id === pId);
      const v = (p ? p.variants : []).find(x => x.id === vId);

      const newDmg = {
        id: "DMG-" + Date.now(),
        date: new Date().toISOString().slice(0,10),
        productId: pId,
        variantId: vId,
        variantName: v ? v.name : '-',
        qty: qty,
        reason: reason,
        reporterUserId: currentUser ? currentUser.id : 'USR-001',
        reporterName: currentUser ? currentUser.name : 'Admin',
        status: 'Menunggu Pemeriksaan',
        photoUrl: '',
        note: '',
        createdAt: new Date().toISOString()
      };

      const inv = getInventory(pId, vId);
      if (!inv || qty > getAvailableStock(inv)) { showToast('Jumlah barang cacat melebihi stok tersedia.', 'danger'); return; }
      inv.physicalStock = Math.max(0, Number(inv.physicalStock || 0) - qty);
      inv.damagedStock = Number(inv.damagedStock || 0) + qty;
      if (!appState.damagedGoods) appState.damagedGoods = [];
      appState.damagedGoods.unshift(newDmg);

      const modal = document.getElementById('modal-damaged');
      if (modal) modal.classList.remove('active');
      persistAppState("LAPOR_BARANG_CACAT", `Melaporkan barang cacat ${qty} unit: ${reason}`);
      showToast("Laporan barang cacat berhasil disimpan!", "warning");
    });
  }

  // Returned Goods Modal
  const btnOpenReturned = document.getElementById('btn-open-returned-modal');
  if (btnOpenReturned) {
    btnOpenReturned.addEventListener('click', () => {
      const prodSelect = document.getElementById('ret-product-id');
      if (prodSelect) {
        prodSelect.innerHTML = '<option value="">-- Pilih Produk --</option>';
        (appState.products || []).forEach(p => {
          prodSelect.innerHTML += `<option value="${p.id}">${p.name}</option>`;
        });
      }
      const modal = document.getElementById('modal-returned');
      if (modal) modal.classList.add('active');
    });
  }

  const retProdSelect = document.getElementById('ret-product-id');
  if (retProdSelect) {
    retProdSelect.addEventListener('change', function() {
      const p = (appState.products || []).find(x => x.id === this.value);
      const varSelect = document.getElementById('ret-variant-id');
      if (varSelect) {
        varSelect.innerHTML = '';
        if (p) {
          p.variants.forEach(v => {
            varSelect.innerHTML += `<option value="${v.id}">${v.name}</option>`;
          });
        }
      }
    });
  }

  const btnSaveReturned = document.getElementById('btn-save-returned');
  if (btnSaveReturned) {
    btnSaveReturned.addEventListener('click', () => {
      const pId = document.getElementById('ret-product-id').value;
      const vId = document.getElementById('ret-variant-id').value;
      const qty = parseInt(document.getElementById('ret-qty').value) || 0;
      const reason = document.getElementById('ret-reason').value.trim();

      if (!pId || !vId || qty <= 0 || !reason) {
        showToast("Lengkapi form laporan barang retur!", "warning");
        return;
      }

      const p = (appState.products || []).find(x => x.id === pId);
      const v = (p ? p.variants : []).find(x => x.id === vId);

      const newRet = {
        id: "RET-" + Date.now(),
        date: new Date().toISOString().slice(0,10),
        productId: pId,
        variantId: vId,
        variantName: v ? v.name : '-',
        qty: qty,
        reason: reason,
        reporterUserId: currentUser ? currentUser.id : 'USR-001',
        reporterName: currentUser ? currentUser.name : 'Admin',
        status: 'Menunggu Pemeriksaan',
        photoUrl: '',
        note: '',
        createdAt: new Date().toISOString()
      };

      if (!appState.returnedGoods) appState.returnedGoods = [];
      appState.returnedGoods.unshift(newRet);

      const modal = document.getElementById('modal-returned');
      if (modal) modal.classList.remove('active');
      persistAppState("LAPOR_BARANG_RETUR", `Melaporkan barang retur ${qty} unit: ${reason}`);
      showToast("Laporan barang retur berhasil disimpan!", "warning");
    });
  }

  // User Modal
  const btnOpenUser = document.getElementById('btn-open-user-modal');
  if (btnOpenUser) {
    btnOpenUser.addEventListener('click', () => {
      const form = document.getElementById('form-user');
      if (form) form.reset();
      document.getElementById('usr-id').value=''; document.getElementById('modal-user-title').textContent='Tambah Akun Pengguna System'; document.getElementById('usr-status').value='active'; renderUserPermissionChecks([]);
      const modal = document.getElementById('modal-user');
      if (modal) modal.classList.add('active');
    });
  }

  const btnSaveUser = document.getElementById('btn-save-user');
  if (btnSaveUser) btnSaveUser.addEventListener('click', async () => {
    const id=document.getElementById('usr-id').value.trim(), name=document.getElementById('usr-name').value.trim(), username=document.getElementById('usr-username').value.trim(), password=document.getElementById('usr-password').value, role=document.getElementById('usr-role').value, email=document.getElementById('usr-email').value.trim(), phone=document.getElementById('usr-phone').value.trim(), status=document.getElementById('usr-status').value;
    const permissions=[...document.querySelectorAll('#usr-permissions input:checked')].map(x=>x.value);
    if(!name||!username||(!id&&!password)) return showToast('Nama, username, dan password wajib diisi untuk akun baru.','warning');
    try{const payload={name,username,role,email,phone,status,permissions};if(password)payload.password=password; const res=await apiRequest(`${API_BASE}/users${id?'/'+id:''}`,{method:id?'PATCH':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}); document.getElementById('modal-user')?.classList.remove('active');showToast(res.message||'Akun berhasil disimpan.','success');renderAdminUsers();}catch(e){showToast(e.message||'Gagal menyimpan akun.','danger');}
  });

  // App Settings Form Submit
  const formSettings = document.getElementById('form-settings');
  if (formSettings) {
    formSettings.addEventListener('submit', (e) => {
      e.preventDefault();
      const appName = document.getElementById('setting-app-name').value.trim();
      const whName = document.getElementById('setting-warehouse-name').value.trim();
      const bkgExp = parseInt(document.getElementById('setting-booking-expiry').value) || 3;
      const minStock = parseInt(document.getElementById('setting-min-stock').value) || 10;

      if (!appState.settings) appState.settings = {};
      appState.settings.appName = appName;
      appState.settings.warehouseName = whName;
      appState.settings.bookingExpiryDays = bkgExp;
      appState.settings.minStockDefault = minStock;

      const sidebarName = document.getElementById('sidebar-app-name');
      if (sidebarName) sidebarName.innerHTML = `${appName.slice(0,6)}<span>${appName.slice(6)}</span>`;

      persistAppState("PENGATURAN_SISTEM", `Mengubah pengaturan nama gudang: ${whName}`);
      showToast("Pengaturan aplikasi berhasil disimpan!", "success");
    });
  }

  // Closing Scan Button
  const btnClosingProcess = document.getElementById('btn-process-closing-scan');
  if (btnClosingProcess) {
    btnClosingProcess.addEventListener('click', () => {
      const resiInput = document.getElementById('input-closing-resi-no');
      const resiNo = resiInput ? resiInput.value.trim() : '';
      if (!resiNo) {
        showToast("Masukkan atau scan nomor resi terlebih dahulu!", "warning");
        return;
      }
      executeClosingProcess(resiNo);
    });
  }

  // Top Bar Scanner Button
  const btnTopScan = document.getElementById('btn-top-scan-resi');
  if (btnTopScan) {
    btnTopScan.addEventListener('click', () => {
      const modalScan = document.getElementById('modal-barcode-scanner');
      if (modalScan) modalScan.classList.add('active');
    });
  }

  const btnSubmitBarcode = document.getElementById('btn-submit-scanned-barcode');
  if (btnSubmitBarcode) {
    btnSubmitBarcode.addEventListener('click', () => {
      const barcodeInput = document.getElementById('simulated-barcode-input');
      const val = (barcodeInput && barcodeInput.value.trim()) ? barcodeInput.value.trim() : 'JX-88391204-ID';
      
      const modalScan = document.getElementById('modal-barcode-scanner');
      if (modalScan) modalScan.classList.remove('active');

      const closingNav = document.querySelector('.nav-link[data-view="admin-sales-closing"]');
      if (closingNav) closingNav.click();

      const inputResi = document.getElementById('input-closing-resi-no');
      if (inputResi) inputResi.value = val;

      showToast(`Resi ${val} terpindai! Klik 'Cari & Proses Closing'`, "success");
    });
  }

  // Confirm Actions Listeners
  const btnConfirmProceed = document.getElementById('btn-confirm-proceed');
  if (btnConfirmProceed) {
    btnConfirmProceed.addEventListener('click', () => {
      if (pendingConfirmAction) pendingConfirmAction();
      pendingConfirmAction = null;
      const modalConfirm = document.getElementById('modal-confirm');
      if (modalConfirm) modalConfirm.classList.remove('active');
    });
  }

  const btnConfirmCancel = document.getElementById('btn-confirm-cancel');
  if (btnConfirmCancel) {
    btnConfirmCancel.addEventListener('click', () => {
      pendingConfirmAction = null;
      const modalConfirm = document.getElementById('modal-confirm');
      if (modalConfirm) modalConfirm.classList.remove('active');
    });
  }

  initReportListeners();
}

function openWorkReportForm(workTypeId, productId, variantId) {
  switchView('gudang-work-report');
  populateWorkReportForm();
  const wtSelect = document.getElementById('wrk-work-type-id');
  const pSelect = document.getElementById('wrk-product-id');
  if (wtSelect) wtSelect.value = workTypeId;
  if (pSelect) pSelect.value = productId;
  updateWorkVariantOptions();
  const vSelect = document.getElementById('wrk-variant-id');
  if (vSelect) vSelect.value = variantId;
  updateWorkWagePreview();
}

function quickBookProduct(productId, variantId) {
  switchView('seller-booking-form');
  populateBookingForm();
  
  const pSelect = document.getElementById('bkg-product-id');
  if (pSelect) {
    pSelect.innerHTML = '';
    (appState.products || []).forEach(p => {
      pSelect.innerHTML += `<option value="${p.id}">${p.name}</option>`;
    });
    pSelect.value = productId;
  }

  const p = (appState.products || []).find(x => x.id === productId);
  const vSelect = document.getElementById('bkg-variant-id');
  if (vSelect) {
    vSelect.innerHTML = '';
    if (p) {
      p.variants.forEach(v => {
        vSelect.innerHTML += `<option value="${v.id}">${v.name}</option>`;
      });
    }
    vSelect.value = variantId;
  }
  updateBookingAvailability();
}

// ==========================================================================
// 13. CONFIRMATION DIALOG & TOAST NOTIFICATIONS
// ==========================================================================
function showConfirmDialog(title, message, onProceed) {
  const titleEl = document.getElementById('confirm-title');
  const msgEl = document.getElementById('confirm-message');
  if (titleEl) titleEl.innerText = title;
  if (msgEl) msgEl.innerHTML = message;
  pendingConfirmAction = onProceed;

  const modalConfirm = document.getElementById('modal-confirm');
  if (modalConfirm) modalConfirm.classList.add('active');
}

function showToast(message, type = 'primary') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast border-${type}`;
  toast.innerHTML = `
    <i class="fa-solid fa-circle-info text-${type}"></i>
    <span style="font-size:13px; font-weight:500;">${message}</span>
  `;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function formatDateTime(isoStr) {
  if (!isoStr) return '-';
  try {
    const d = new Date(isoStr);
    return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return isoStr; }
}


// ========================================================================== 
// 13. PENYEMPURNAAN MOBILE, DASHBOARD BERTINGKAT, PROFIL & SCANNER KAMERA
// ========================================================================== 
function editProduct(id){
  const p=(appState.products||[]).find(x=>x.id===id); if(!p) return;
  document.getElementById('prd-id').value=p.id; if(document.getElementById('prd-image-url'))document.getElementById('prd-image-url').value=p.imageUrl||''; document.getElementById('prd-name').value=p.name||''; document.getElementById('prd-sku').value=p.sku||''; document.getElementById('prd-unit').value=p.unit||'Unit'; document.getElementById('prd-location').value=p.warehouseLocation||''; document.getElementById('prd-min-stock').value=p.minStock||10; document.getElementById('prd-description').value=p.description||''; document.getElementById('prd-variants-input').value=(p.variants||[]).map(v=>v.name).join(', ');
  const sel=document.getElementById('prd-category-id'); sel.innerHTML=(appState.categories||[]).map(c=>`<option value="${c.id}">${c.name}</option>`).join(''); sel.value=p.categoryId||'';
  document.getElementById('modal-product-title').innerText='Edit Produk'; document.getElementById('modal-product').classList.add('active');
}
function confirmDeleteProduct(id){ const p=(appState.products||[]).find(x=>x.id===id); if(!p)return; showConfirmDialog('Hapus Produk',`Hapus <strong>${p.name}</strong> beserta data variannya? Data booking/riwayat lama tetap disimpan sebagai arsip.`,async()=>{try{await apiRequest(`/api/products/${encodeURIComponent(id)}`,{method:'DELETE'});await syncFetchState(true);refreshCurrentView();showToast('Produk berhasil dihapus.','success');}catch(err){showToast(err.message||'Produk gagal dihapus.','danger');}}); }
function editUser(id){ const u=(appState.users||[]).find(x=>x.id===id); if(!u)return; document.getElementById('usr-id').value=u.id; document.getElementById('usr-name').value=u.name||''; document.getElementById('usr-username').value=u.username||''; document.getElementById('usr-password').value=''; document.getElementById('usr-role').value=u.role||'gudang'; document.getElementById('usr-email').value=u.email||''; document.getElementById('usr-phone').value=u.phone||''; document.getElementById('modal-user-title').innerText='Edit Akun Pengguna'; document.getElementById('modal-user').classList.add('active'); }

function openDashboardBookings(){ switchView('admin-seller-bookings'); document.querySelector('.nav-link[data-view="admin-seller-bookings"]')?.classList.add('active'); }
function openDashboardPayouts(){ switchView('admin-payouts'); document.querySelector('.nav-link[data-view="admin-payouts"]')?.classList.add('active'); }
function openDashboardScanner(){ document.getElementById('modal-barcode-scanner')?.classList.add('active'); }
function closeDashboardDetail(){ document.getElementById('modal-dashboard-detail')?.classList.remove('active'); }
function openDashboardCategory(categoryId){
  const c=(appState.categories||[]).find(x=>x.id===categoryId); const products=(appState.products||[]).filter(p=>p.categoryId===categoryId);
  document.getElementById('dashboard-detail-title').innerText=`${c?.name||'Kategori'} — Pilih Varian`;
  document.getElementById('dashboard-detail-body').innerHTML=products.length?products.flatMap(p=>(p.variants||[]).map(v=>{const inv=getInventory(p.id,v.id)||{}; return `<button class="detail-choice" onclick="openDashboardVariant('${p.id}','${v.id}')"><span><strong>${p.name}</strong><small>${v.name} • ${v.sku||p.sku}</small></span><b>${Number(inv.physicalStock||0).toLocaleString('id-ID')} unit</b><i class="fa-solid fa-chevron-right"></i></button>`;})).join(''):'<div class="empty-state">Belum ada produk pada kategori ini.</div>';
  document.getElementById('modal-dashboard-detail').classList.add('active');
}
function openDashboardVariant(productId,variantId){
  const p=(appState.products||[]).find(x=>x.id===productId); const v=(p?.variants||[]).find(x=>x.id===variantId); const inv=getInventory(productId,variantId)||{};
  const damaged=(appState.damagedGoods||[]).filter(x=>x.productId===productId&&x.variantId===variantId).reduce((s,x)=>s+Number(x.qty||0),0);
  const total=Number(inv.physicalStock||0), checked=Math.max(0,total-Number(inv.processStock||0)-damaged), available=getAvailableStock(inv), ready=Math.max(0,available-Number(inv.processStock||0));
  document.getElementById('dashboard-detail-title').innerText=`${p?.name||''} — ${v?.name||''}`;
  document.getElementById('dashboard-detail-body').innerHTML=`<div class="variant-report-grid"><div><small>Stok Tersedia</small><strong>${available}</strong></div><div><small>Stok Lolos Pengecekan</small><strong>${checked}</strong></div><div><small>Stok Siap Kirim</small><strong>${ready}</strong></div><div><small>Stok Cacat</small><strong>${damaged}</strong></div><div><small>Stok Dibooking</small><strong>${Number(inv.bookedStock||0)}</strong></div><div><small>Jumlah Keseluruhan</small><strong>${total}</strong></div></div><div class="report-actions"><button class="btn btn-secondary" onclick="closeDashboardDetail();switchView('admin-stocks')"><i class="fa-solid fa-list"></i> Lihat Detail Stok</button><button class="btn btn-primary" onclick="closeDashboardDetail();switchView('admin-stock-ins')"><i class="fa-solid fa-plus"></i> Input Perubahan Stok</button></div>`;
}

async function loadDashboardSummary(){
  try{
    const r=await fetch(`${API_BASE}/dashboard/summary`,{headers:getAuthHeaders()});
    if(!r.ok) return null;
    const j=await r.json(); return j.data||null;
  }catch(_){return null;}
}

async function renderAdminDashboard(){
  const cats=appState.categories||[]; const grid=document.getElementById('dashboard-category-grid'); if(!grid)return;
  const catCount=document.getElementById('dash-category-count'); if(catCount)catCount.innerText=`${cats.length} kategori`;
  grid.innerHTML=cats.length?cats.map(c=>{const products=(appState.products||[]).filter(p=>p.categoryId===c.id); const variants=products.reduce((n,p)=>n+(p.variants||[]).length,0); const stock=products.reduce((sum,p)=>sum+(p.variants||[]).reduce((s,v)=>s+Number((getInventory(p.id,v.id)||{}).physicalStock||0),0),0); return `<button class="category-dashboard-card" onclick="openDashboardCategory('${c.id}')"><span class="category-card-icon"><i class="fa-solid fa-boxes-stacked"></i></span><span class="category-card-main"><strong>${c.name}</strong><small>${products.length} produk • ${variants} variasi</small><em>${stock.toLocaleString('id-ID')} total unit</em></span><i class="fa-solid fa-chevron-right"></i></button>`;}).join(''):'<div class="empty-state">Belum ada kategori. Tambahkan kategori dan produk dari menu Manajemen Produk.</div>';
  const bookings=(appState.sellerBookings||[]).filter(b=>['Menunggu Persetujuan','Aktif'].includes(b.status)); const payouts=(appState.payoutRequests||[]).filter(p=>p.status==='Menunggu Persetujuan');
  const inv=appState.inventory||[]; const fallbackBooked=inv.reduce((s,x)=>s+Number(x.bookedStock||0),0); const payoutTotal=payouts.reduce((s,p)=>s+Number(p.amount||0),0);
  const summary=await loadDashboardSummary();
  const booked=summary?.totalBookedStock ?? fallbackBooked;
  document.getElementById('dash-booking-count').innerText=`${Number(booked).toLocaleString('id-ID')} unit`;
  document.getElementById('dash-payout-total').innerText=formatRupiah(payoutTotal);
  document.getElementById('dash-resi-count').innerText=`${summary?.scannedResi ?? (appState.scannedResi||appState.salesClosings||[]).length} resi`;
  const available=summary?.totalAvailableStock ?? inv.reduce((s,x)=>s+getAvailableStock(x),0), sold=summary?.totalSoldStock ?? inv.reduce((s,x)=>s+Number(x.soldStock||0),0), damaged=summary?.totalDamagedStock ?? (appState.damagedGoods||[]).reduce((s,x)=>s+Number(x.qty||0),0), returned=summary?.returnsInPeriod ?? (appState.returnedGoods||[]).reduce((s,x)=>s+Number(x.qty||0),0);
  renderAdminCharts(summary?.stockIn||0,summary?.stockOut||0,sold,available,booked,damaged,returned);
}

function getProfileRecord(){ if(!currentUser)return {}; return appState.userProfiles?.[currentUser.id]||{}; }
async function loadMyProfile(){if(!currentUser)return{};try{const r=await apiRequest(`${API_BASE}/me/profile`);const p=r.data||{};if(!appState.userProfiles)appState.userProfiles={};appState.userProfiles[currentUser.id]={...getProfileRecord(),...p,avatarData:p.avatarData||getProfileRecord().avatarData||''};currentUser={...currentUser,name:p.name||currentUser.name,username:p.username||currentUser.username,email:p.email||currentUser.email||'',phone:p.phone||currentUser.phone||''};localStorage.setItem('gudangbat_user',JSON.stringify(currentUser));return appState.userProfiles[currentUser.id];}catch{return getProfileRecord();}}
async function renderProfileView(){if(!currentUser)return;const p=await loadMyProfile(),profile={...currentUser,...p};document.querySelectorAll('[data-profile-name]').forEach(e=>e.textContent=profile.name||currentUser.name);document.querySelectorAll('[data-profile-role]').forEach(e=>e.textContent=(currentUser.role||'').toUpperCase());document.querySelectorAll('[data-profile-field="name"]').forEach(e=>e.value=profile.name||'');document.querySelectorAll('[data-profile-field="username"]').forEach(e=>e.value=profile.username||'');document.querySelectorAll('[data-profile-field="email"]').forEach(e=>e.value=profile.email||'');document.querySelectorAll('[data-profile-field="phone"]').forEach(e=>e.value=profile.phone||'');setProfilePhotoUI(profile.avatarData||'');}
function setProfilePhotoUI(data){document.querySelectorAll('[data-profile-image]').forEach(img=>{img.src=data||'';img.style.display=data?'block':'none';});document.querySelectorAll('[data-profile-fallback]').forEach(el=>{el.style.display=data?'none':'flex';el.textContent=(currentUser?.name||'U').trim().charAt(0).toUpperCase();});const mini=document.getElementById('user-avatar');if(mini){if(data)mini.innerHTML=`<img src="${data}" alt="Avatar">`;else mini.textContent=(currentUser?.name||'U').charAt(0).toUpperCase();}}
async function saveProfileForm(form){if(!currentUser)return;const payload={};['name','username','email','phone'].forEach(k=>{const el=form.querySelector(`[data-profile-field="${k}"]`);if(el)payload[k]=el.value.trim();});try{const res=await apiRequest(`${API_BASE}/me/profile`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});currentUser={...currentUser,...(res.user||{})};localStorage.setItem('gudangbat_user',JSON.stringify(currentUser));if(!appState.userProfiles)appState.userProfiles={};appState.userProfiles[currentUser.id]={...getProfileRecord(),...payload};document.getElementById('user-display-name').textContent=currentUser.name;renderProfileView();showToast(res.message||'Profil berhasil diperbarui.','success');}catch(err){showToast(err.message||'Gagal memperbarui profil.','danger');}}
document.addEventListener('submit',e=>{if(e.target.matches('[data-profile-form]')){e.preventDefault();saveProfileForm(e.target);}});
document.addEventListener('change',e=>{if(e.target.matches('[data-profile-upload]')){const f=e.target.files?.[0];if(!f)return;if(f.size>2*1024*1024)return showToast('Ukuran foto maksimal 2 MB.','warning');if(!f.type.startsWith('image/'))return showToast('Pilih file gambar.','warning');const r=new FileReader();r.onload=async()=>{try{const res=await apiRequest(`${API_BASE}/me/profile`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({avatarData:r.result})});setProfilePhotoUI(r.result);if(res.user){currentUser={...currentUser,...res.user};localStorage.setItem('gudangbat_user',JSON.stringify(currentUser));}if(!appState.userProfiles)appState.userProfiles={};appState.userProfiles[currentUser.id]={...getProfileRecord(),avatarData:r.result};showToast('Foto profil berhasil diperbarui.','success');}catch(err){showToast(err.message||'Gagal menyimpan foto profil.','danger');}};r.readAsDataURL(f);}});

let barcodeStream=null, barcodeTimer=null;
async function startCameraScanner(){
  try{stopCameraScanner(); barcodeStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false}); const v=document.getElementById('barcode-camera-video'); if(!v)return; v.srcObject=barcodeStream; v.style.display='block'; document.getElementById('barcode-camera-icon')?.style.setProperty('display','none'); await v.play();
    if('BarcodeDetector' in window){const detector=new BarcodeDetector({formats:['code_128','code_39','ean_13','ean_8','qr_code']}); barcodeTimer=setInterval(async()=>{try{const codes=await detector.detect(v); if(codes[0]?.rawValue){document.getElementById('simulated-barcode-input').value=codes[0].rawValue; showToast(`Resi ${codes[0].rawValue} terbaca.`,'success'); stopCameraScanner();}}catch{}},600);} else showToast('Kamera aktif. Browser ini belum mendukung pembacaan barcode otomatis; masukkan nomor resi secara manual.','info');
  }catch(err){showToast('Kamera tidak dapat diakses. Izinkan permission kamera di browser.','danger');}
}
function stopCameraScanner(){if(barcodeTimer){clearInterval(barcodeTimer);barcodeTimer=null;} if(barcodeStream){barcodeStream.getTracks().forEach(t=>t.stop());barcodeStream=null;} const v=document.getElementById('barcode-camera-video');if(v){v.pause?.();v.srcObject=null;v.style.display='none';} document.getElementById('barcode-camera-icon')?.style.setProperty('display','block');}
document.addEventListener('click',e=>{if(e.target.closest('#btn-start-camera-scan'))startCameraScanner(); if(e.target.closest('.modal-close')||e.target.closest('#btn-submit-scanned-barcode'))setTimeout(stopCameraScanner,50);});
document.getElementById('btn-dashboard-refresh')?.addEventListener('click',()=>syncFetchState());


// === Upgrade Auth & Identitas Perusahaan ===
document.addEventListener('change', (e) => {
  if (e.target?.id === 'setting-company-logo-file') {
    const file=e.target.files?.[0]; if(!file)return;
    if(!file.type.startsWith('image/')) return showToast('Pilih file gambar untuk logo perusahaan.','warning');
    if(file.size>2*1024*1024) return showToast('Ukuran logo maksimal 2 MB.','warning');
    const r=new FileReader(); r.onload=()=>{ const input=document.getElementById('setting-company-logo'); if(input){input.value=r.result; renderCompanyLogo();} }; r.readAsDataURL(file);
  }
});

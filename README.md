# GUDANG BAT Online - PostgreSQL

Versi ini memigrasikan aplikasi lokal PowerShell/JSON menjadi aplikasi web online:

- Frontend: HTML, CSS, JavaScript
- Backend: Node.js + Express
- Database: PostgreSQL
- Login: JWT
- Hosting: siap untuk Railway/Render/VPS
- Port hosting mengikuti variabel `PORT`

## Jalankan lokal

1. Instal Node.js 20+ dan PostgreSQL.
2. Buat database PostgreSQL.
3. Salin `.env.example` menjadi `.env` dan isi `DATABASE_URL` serta `JWT_SECRET`.
4. Jalankan `npm install`.
5. Jalankan `npm start`.
6. Buka `http://localhost:8080`.

## Akun awal

- admin / admin123
- gudang / gudang123
- seller / seller123

Segera ganti password akun demo sebelum digunakan sungguhan.

## Catatan migrasi

Frontend lama masih dipertahankan agar tampilan dan fitur yang sudah dibuat tidak hilang. Data state sekarang disimpan di PostgreSQL, bukan `database.json`, dan login memakai password hash + JWT. Endpoint state memakai versi data (`X-State-Version`) untuk mengurangi risiko perangkat berbeda menimpa perubahan secara diam-diam.

## Deployment

Untuk Railway: buat Project -> PostgreSQL -> Deploy from GitHub -> isi `JWT_SECRET`. Railway menyediakan `DATABASE_URL` dari PostgreSQL. Setelah service hidup, pasang Custom Domain.


## Upgrade fitur
- Sidebar mobile kini memiliki overlay dan otomatis menutup setelah menu dipilih.
- Dashboard admin bertingkat: Kategori → Produk/Varian → laporan stok.
- Profil admin, pekerja, dan seller dapat mengubah foto serta informasi akun.
- Tombol edit/hapus produk dan edit pengguna diperbaiki.
- Scanner resi mendukung kamera browser (BarcodeDetector bila tersedia) dengan fallback input manual.
- Dashboard menyediakan akses cepat Booking, Pengajuan Upah, Scan Resi, dan grafik statistik.


## Tahap 7.3 Safe Sync
Versi ini menambahkan snapshot otomatis, blokir overwrite state kosong/pengurangan massal, pemulihan snapshot khusus admin, dan perbaikan pemuatan state setelah login.


## Tahap 10 — Audit Keamanan & Hak Akses
- Backend memperketat akses baca dashboard, inventaris, mutasi, upah, dan jenis pekerjaan.
- Hak akses frontend tidak lagi bergantung hanya pada role Gudang/Seller untuk beberapa aksi utama.
- Ditambahkan security log untuk jejak mutasi API.
- Respons API diberi no-store untuk mengurangi data sensitif tersimpan cache browser.
- Perbaikan duplikasi return pada mutateState.

## Tahap 12 — Audit transaksi & keamanan operasional
- Validasi integritas inventaris pada setiap mutation atomik.
- Endpoint admin `GET /api/audit/integrity` untuk pemeriksaan tanpa mengubah data.
- Perbaikan endpoint identitas publik agar logo perusahaan di halaman login dapat dibaca dengan benar.
- Sidebar mobile ditutup otomatis setelah memilih menu.
- Panel audit tersedia di Pengaturan Admin.
- Tidak mereset atau menghapus data PostgreSQL yang sudah ada.


Upgrade tambahan: perbaikan role canonical (admin/gudang/seller), foto produk admin pada menu stok, branding login lebih besar, dan profil admin lebih profesional. Tidak ada reset database.

# GUDANG BAT — Tahap 18A

Tahap 18A mengubah fondasi GUDANG BAT agar **portable dan siap self-hosted**. Railway tidak lagi menjadi bagian wajib dari arsitektur aplikasi.

## Prinsip utama

- PostgreSQL tetap menjadi database utama.
- `app_state` dipertahankan sebagai compatibility layer agar versi Tahap 17 tidak rusak.
- Ditambahkan normalized core PostgreSQL untuk gudang, akses user-gudang, produk, varian, inventaris, dan mutasi stok.
- Setiap mutasi state penting disinkronkan secara atomik ke normalized core dalam transaksi database yang sama.
- Backup JSON dapat dibuat oleh Admin.
- Snapshot sebelum perubahan tetap dipertahankan untuk recovery.
- Multi-gudang tetap menggunakan satu akun dan konteks `x-location-id`.

## Instalasi lokal / self-hosted

1. Gunakan Node.js 20+.
2. Sediakan PostgreSQL.
3. Salin `.env.example` menjadi `.env`.
4. Isi `DATABASE_URL` dan **wajib mengganti `JWT_SECRET` dengan rahasia panjang yang acak**.
5. Jalankan `npm install`.
6. Jalankan `npm start`.
7. Bootstrap akan membuat tabel yang diperlukan dan melakukan sinkronisasi database inti.

## Pemeriksaan Tahap 18A

Setelah login sebagai Admin:

- `GET /api/admin/core-status` untuk melihat jumlah record pada normalized core.
- `POST /api/admin/core-sync` untuk memaksa sinkronisasi ulang.
- `GET /api/admin/backup` untuk mengunduh backup JSON.
- `GET /api/audit/integrity` untuk pemeriksaan konsistensi data.
- `GET /api/state-snapshots` untuk melihat snapshot sebelum perubahan.

## Catatan migrasi

Tahap 18A **belum menghapus `app_state`**. Ini disengaja agar migrasi aman dan kompatibel dengan frontend Tahap 17.

Urutan berikutnya:

- Tahap 18B: migrasi server/domain dari Railway ke server self-hosted.
- Tahap 19: memindahkan transaksi utama secara bertahap dari `app_state` ke tabel normalized core.
- Setelah Tahap 19 stabil, `app_state` dapat dihentikan secara bertahap.

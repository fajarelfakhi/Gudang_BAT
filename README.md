# GUDANG BAT — Tahap 17

Upgrade lanjutan multi-gudang: konteks Gudang Aktif kini diterapkan secara konsisten pada dashboard summary, laporan pekerjaan, upah, booking, scan resi/closing, dan tampilan administrasi. Transaksi baru tetap membawa locationId; data lama tanpa locationId menggunakan GUD-01 sebagai fallback. Tidak ada reset database.

## Instalasi
Replace file project di GitHub dengan isi paket ini dan deploy kembali di Railway. Jangan membuat PostgreSQL baru dan jangan mereset database.

## Uji
1. Login PJ/Admin dan pilih Gudang Aktif.
2. Pastikan dashboard mengikuti lokasi.
3. Buat booking di satu gudang, lalu pastikan closing/scan hanya menampilkan booking gudang tersebut.
4. Buat laporan pekerjaan dan pastikan laporan mengikuti gudang aktif.
5. Cek upah dan pengajuan pencairan mengikuti lokasi aktif.
6. Gunakan Semua Gudang untuk melihat ringkasan lintas lokasi.

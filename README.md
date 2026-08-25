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

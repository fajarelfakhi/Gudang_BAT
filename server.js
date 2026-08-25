require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = Number(process.env.PORT || 8080);
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || 'GANTI_DENGAN_RAHASIA_PANJANG_SEBELUM_PRODUKSI';
if (!DATABASE_URL) throw new Error('DATABASE_URL wajib diisi.');
const pool = new Pool({ connectionString: DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function publicUser(u) { return { id:u.id, username:u.username, name:u.name, role:u.role, email:u.email || '', phone:u.phone || '', status:u.status }; }
function auth(req,res,next) {
  const h=req.headers.authorization||''; const token=h.startsWith('Bearer ')?h.slice(7):null;
  if(!token) return res.status(401).json({success:false,message:'Sesi tidak ditemukan. Silakan login kembali.'});
  try { req.user=jwt.verify(token,JWT_SECRET); next(); } catch { return res.status(401).json({success:false,message:'Sesi tidak valid atau sudah berakhir.'}); }
}
async function syncUsers(client, users) {
  for (const u of users || []) {
    if(!u.id || !u.username) continue;
    const old = await client.query('SELECT password_hash FROM users WHERE id=$1',[u.id]);
    let hash = old.rows[0]?.password_hash;
    if (u.password) hash = await bcrypt.hash(String(u.password), 12);
    if (!hash) hash = await bcrypt.hash('ubah123',12);
    await client.query(`INSERT INTO users(id,username,password_hash,name,role,email,phone,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(id) DO UPDATE SET username=EXCLUDED.username,password_hash=EXCLUDED.password_hash,name=EXCLUDED.name,role=EXCLUDED.role,email=EXCLUDED.email,phone=EXCLUDED.phone,status=EXCLUDED.status`,
      [u.id,u.username,hash,u.name||u.username,u.role||'seller',u.email||null,u.phone||null,u.status||'active']);
  }
}
async function getState(client) {
  const r=await client.query('SELECT state, version FROM app_state WHERE id=1');
  const state=r.rows[0]?.state || {}; const version=Number(r.rows[0]?.version||0);
  const users=(await client.query('SELECT id,username,name,role,email,phone,status FROM users ORDER BY id')).rows.map(publicUser);
  return { state:{...state, users}, version };
}

app.get('/api/health', async (req,res)=>{ try { await pool.query('SELECT 1'); res.json({success:true,status:'ok',app:'GUDANG BAT',timestamp:new Date().toISOString()}); } catch(e){res.status(503).json({success:false,message:'Database tidak tersedia'});} });
app.post('/api/login', async (req,res)=>{
  try {
    const {username,password}=req.body||{}; if(!username||!password) return res.status(400).json({success:false,message:'Username dan password wajib diisi.'});
    const r=await pool.query('SELECT * FROM users WHERE username=$1 OR email=$1 LIMIT 1',[String(username)]); const u=r.rows[0];
    if(!u || u.status!=='active' || !(await bcrypt.compare(String(password),u.password_hash))) return res.status(401).json({success:false,message:'Username atau password salah, atau akun tidak aktif.'});
    const user=publicUser(u); const token=jwt.sign({id:user.id,role:user.role,username:user.username},JWT_SECRET,{expiresIn:'12h'});
    res.json({success:true,message:'Login berhasil.',token,user});
  } catch(e){ console.error(e); res.status(500).json({success:false,message:'Terjadi kesalahan saat login.'}); }
});
app.get('/api/state', auth, async (req,res)=>{
  try { const {state,version}=await getState(pool); res.set('X-State-Version',String(version)); res.json({...state,_version:version}); }
  catch(e){console.error(e);res.status(500).json({success:false,message:'Gagal memuat data.'});}
});
app.post('/api/state', auth, async (req,res)=>{
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const current=await client.query('SELECT version FROM app_state WHERE id=1 FOR UPDATE');
    const version=Number(current.rows[0]?.version||0); const expected=Number(req.headers['x-state-version']||0);
    if(expected && expected!==version){ await client.query('ROLLBACK'); return res.status(409).json({success:false,message:'Data telah berubah di perangkat lain.',version}); }
    const incoming=req.body||{}; await syncUsers(client,incoming.users||[]);
    const {users,...state}=incoming;
    const saved=await client.query('UPDATE app_state SET state=$1::jsonb, version=version+1, updated_at=NOW() WHERE id=1 RETURNING version',[JSON.stringify(state)]);
    await client.query('COMMIT'); res.json({success:true,message:'Data berhasil disimpan.',version:Number(saved.rows[0].version)});
  } catch(e){ try{await client.query('ROLLBACK')}catch{}; console.error(e); res.status(500).json({success:false,message:'Gagal menyimpan data.'}); }
  finally{client.release();}
});
app.use('/api',(req,res)=>res.status(404).json({success:false,message:'Endpoint API tidak ditemukan.'}));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

async function bootstrap(){
  await pool.query(`CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, username text UNIQUE NOT NULL, password_hash text NOT NULL, name text NOT NULL, role text NOT NULL CHECK(role IN ('admin','gudang','seller')), email text, phone text, status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS app_state (id integer PRIMARY KEY CHECK(id=1), state jsonb NOT NULL DEFAULT '{}'::jsonb, version bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());`);
  const exists=await pool.query('SELECT 1 FROM app_state WHERE id=1');
  if(!exists.rowCount){ const seed=JSON.parse(fs.readFileSync(path.join(__dirname,'database','seed.json'),'utf8')); await pool.query('INSERT INTO app_state(id,state,version) VALUES(1,$1::jsonb,1)',[JSON.stringify(Object.fromEntries(Object.entries(seed).filter(([k])=>k!=='users')))]); await syncUsers(pool,seed.users||[]); console.log('Data awal berhasil diimpor.'); }
  app.listen(PORT,'0.0.0.0',()=>console.log(`GUDANG BAT online server berjalan di port ${PORT}`));
}
bootstrap().catch(e=>{console.error('Gagal bootstrap:',e);process.exit(1)});

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


function requireRole(...roles) {
  return (req,res,next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({success:false,message:'Anda tidak memiliki akses untuk melakukan tindakan ini.'});
    next();
  };
}

async function mutateState(mutator) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT state, version FROM app_state WHERE id=1 FOR UPDATE');
    const state = r.rows[0]?.state || {};
    const result = await mutator(state, client);
    const saved = await client.query('UPDATE app_state SET state=$1::jsonb, version=version+1, updated_at=NOW() WHERE id=1 RETURNING version', [JSON.stringify(state)]);
    await client.query('COMMIT');
    return { result, version:Number(saved.rows[0].version) };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally { client.release(); }
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

// Tahap 2: CRUD langsung untuk kategori dan produk. Aksi ini tidak memakai X-State-Version.
app.get('/api/categories', auth, async (req,res)=>{
  try { const {state}=await getState(pool); res.json({success:true,data:state.categories||[]}); }
  catch(e){ console.error(e); res.status(500).json({success:false,message:'Gagal memuat kategori.'}); }
});
app.post('/api/categories', auth, requireRole('admin'), async (req,res)=>{
  try {
    const name=String(req.body?.name||'').trim(), description=String(req.body?.description||'').trim();
    if(!name) return res.status(400).json({success:false,message:'Nama kategori wajib diisi.'});
    const {result,version}=await mutateState(state=>{
      state.categories=state.categories||[];
      if(state.categories.some(c=>String(c.name).toLowerCase()===name.toLowerCase())) throw Object.assign(new Error('Nama kategori sudah digunakan.'),{status:409});
      const category={id:'CAT-'+Date.now(),name,description,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
      state.categories.push(category); return category;
    });
    res.status(201).json({success:true,message:'Kategori berhasil ditambahkan.',data:result,version});
  } catch(e){ res.status(e.status||500).json({success:false,message:e.message||'Gagal menambah kategori.'}); }
});
app.put('/api/categories/:id', auth, requireRole('admin'), async (req,res)=>{
  try { const name=String(req.body?.name||'').trim(), description=String(req.body?.description||'').trim(); if(!name)return res.status(400).json({success:false,message:'Nama kategori wajib diisi.'});
    const {result,version}=await mutateState(state=>{ state.categories=state.categories||[]; const c=state.categories.find(x=>x.id===req.params.id); if(!c) throw Object.assign(new Error('Kategori tidak ditemukan.'),{status:404}); if(state.categories.some(x=>x.id!==c.id&&String(x.name).toLowerCase()===name.toLowerCase()))throw Object.assign(new Error('Nama kategori sudah digunakan.'),{status:409}); Object.assign(c,{name,description,updatedAt:new Date().toISOString()}); return c; });
    res.json({success:true,message:'Kategori berhasil diperbarui.',data:result,version});
  } catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal memperbarui kategori.'});}
});
app.delete('/api/categories/:id', auth, requireRole('admin'), async (req,res)=>{
  try { const {result,version}=await mutateState(state=>{ state.categories=state.categories||[]; state.products=state.products||[]; const c=state.categories.find(x=>x.id===req.params.id); if(!c)throw Object.assign(new Error('Kategori tidak ditemukan.'),{status:404}); if(state.products.some(p=>p.categoryId===c.id))throw Object.assign(new Error('Kategori masih digunakan oleh produk dan tidak dapat dihapus.'),{status:409}); state.categories=state.categories.filter(x=>x.id!==c.id); return c; }); res.json({success:true,message:'Kategori berhasil dihapus.',data:result,version}); }
  catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal menghapus kategori.'});}
});
app.get('/api/products', auth, async (req,res)=>{ try{const {state}=await getState(pool);res.json({success:true,data:state.products||[]});}catch(e){res.status(500).json({success:false,message:'Gagal memuat produk.'});} });
app.post('/api/products', auth, requireRole('admin'), async (req,res)=>{
  try { const payload=req.body||{}; const {result,version}=await mutateState(state=>{
    state.products=state.products||[]; state.categories=state.categories||[]; state.inventory=state.inventory||[];
    const name=String(payload.name||'').trim(), sku=String(payload.sku||'').trim(), categoryId=String(payload.categoryId||'');
    if(!name||!sku||!categoryId)throw Object.assign(new Error('Nama produk, kategori dan SKU wajib diisi.'),{status:400});
    if(!state.categories.some(c=>c.id===categoryId))throw Object.assign(new Error('Kategori tidak ditemukan.'),{status:400});
    if(state.products.some(p=>String(p.sku).toLowerCase()===sku.toLowerCase()))throw Object.assign(new Error('SKU produk sudah digunakan.'),{status:409});
    const now=new Date().toISOString(); const id='PRD-'+Date.now(); const variants=(Array.isArray(payload.variants)&&payload.variants.length?payload.variants:[{name:'Standard'}]).map((v,i)=>({id:v.id||'VAR-'+Date.now()+'-'+i,name:String(v.name||'Standard').trim(),sku:v.sku||`${sku}-${i+1}`}));
    const product={id,categoryId,name,sku,description:String(payload.description||''),unit:String(payload.unit||'Unit'),warehouseLocation:String(payload.warehouseLocation||'Rak Gudang Utama'),minStock:Number(payload.minStock||10),status:'active',imageUrl:String(payload.imageUrl||''),variants,createdAt:now,updatedAt:now}; state.products.push(product); variants.forEach(v=>{if(!state.inventory.some(i=>i.productId===id&&i.variantId===v.id))state.inventory.push({productId:id,variantId:v.id,physicalStock:0,bookedStock:0,processStock:0,soldStock:0,damagedStock:0});}); return product;
  }); res.status(201).json({success:true,message:'Produk berhasil ditambahkan.',data:result,version}); }
  catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal menambah produk.'});}
});
app.put('/api/products/:id', auth, requireRole('admin'), async (req,res)=>{
  try { const payload=req.body||{}; const {result,version}=await mutateState(state=>{
    state.products=state.products||[]; state.categories=state.categories||[]; state.inventory=state.inventory||[]; const p=state.products.find(x=>x.id===req.params.id); if(!p)throw Object.assign(new Error('Produk tidak ditemukan.'),{status:404});
    const name=String(payload.name||'').trim(), sku=String(payload.sku||'').trim(), categoryId=String(payload.categoryId||''); if(!name||!sku||!categoryId)throw Object.assign(new Error('Nama produk, kategori dan SKU wajib diisi.'),{status:400}); if(!state.categories.some(c=>c.id===categoryId))throw Object.assign(new Error('Kategori tidak ditemukan.'),{status:400}); if(state.products.some(x=>x.id!==p.id&&String(x.sku).toLowerCase()===sku.toLowerCase()))throw Object.assign(new Error('SKU produk sudah digunakan.'),{status:409});
    const incoming=Array.isArray(payload.variants)&&payload.variants.length?payload.variants:[{name:'Standard'}]; const variants=incoming.map((v,i)=>{const old=(p.variants||[]).find(x=>x.id===v.id||x.name===v.name);return {id:old?.id||v.id||'VAR-'+Date.now()+'-'+i,name:String(v.name||'Standard').trim(),sku:v.sku||old?.sku||`${sku}-${i+1}`};}); Object.assign(p,{categoryId,name,sku,description:String(payload.description||''),unit:String(payload.unit||'Unit'),warehouseLocation:String(payload.warehouseLocation||'Rak Gudang Utama'),minStock:Number(payload.minStock||10),variants,updatedAt:new Date().toISOString()}); variants.forEach(v=>{if(!state.inventory.some(i=>i.productId===p.id&&i.variantId===v.id))state.inventory.push({productId:p.id,variantId:v.id,physicalStock:0,bookedStock:0,processStock:0,soldStock:0,damagedStock:0});}); return p;
  }); res.json({success:true,message:'Produk berhasil diperbarui.',data:result,version}); }
  catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal memperbarui produk.'});}
});
app.delete('/api/products/:id', auth, requireRole('admin'), async (req,res)=>{
  try { const {result,version}=await mutateState(state=>{ state.products=state.products||[]; state.inventory=state.inventory||[]; const p=state.products.find(x=>x.id===req.params.id); if(!p)throw Object.assign(new Error('Produk tidak ditemukan.'),{status:404}); state.products=state.products.filter(x=>x.id!==p.id); state.inventory=state.inventory.filter(i=>i.productId!==p.id); return p; }); res.json({success:true,message:'Produk berhasil dihapus.',data:result,version}); }
  catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal menghapus produk.'});}
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

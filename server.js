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

app.use((req,res,next)=>{
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control','no-store');
  next();
});

function requireAnyPermission(...permissions) {
  return (req,res,next) => {
    const p=req.user?.permissions || [];
    if (req.user?.role==='admin' || p.includes('*') || permissions.some(x=>p.includes(x))) return next();
    return res.status(403).json({success:false,message:'Hak akses Anda tidak mencakup tindakan ini.'});
  };
}

async function writeSecurityLog(userId, action, detail, req) {
  try {
    const values=[userId||null,String(action),String(detail||''),String(req.ip||''),String(req.get('user-agent')||'').slice(0,500)];
    await pool.query(`INSERT INTO security_logs(user_id,action,detail,ip,user_agent) VALUES($1,$2,$3,$4,$5)`,values);
    // Normalized audit trail for the self-hosted core. This intentionally mirrors, not replaces, security_logs.
    try { await pool.query(`INSERT INTO audit_logs_core(user_id,action,detail,ip,user_agent) VALUES($1,$2,$3,$4,$5)`,values); } catch(e) {}
  } catch(e) {}
}

function normalizeRole(role){
  const r=String(role||'').trim().toLowerCase();
  if(['admin','administrator','admin utama','administrator utama'].includes(r)) return 'admin';
  if(['gudang','pekerja gudang','worker','warehouse','warehouse worker','staff gudang'].includes(r)) return 'gudang';
  if(['seller','seller / penjual','penjual','sales'].includes(r)) return 'seller';
  return r || 'seller';
}
function publicUser(u) { return { id:u.id, username:u.username, name:u.name, role:normalizeRole(u.role), email:u.email || '', phone:u.phone || '', status:u.status, requestedRole:u.requested_role || u.requestedRole || '', permissions:Array.isArray(u.permissions)?u.permissions:(u.permissions||[]), avatarData:u.avatar_data || u.avatarData || '' }; }
function getActiveLocationId(req, state) { const locations=Array.isArray(state?.locations)?state.locations:[]; const requested=String(req.headers['x-location-id']||'').trim(); const fallback=locations.find(x=>x.isDefault)?.id || locations[0]?.id || 'GUD-01'; if(!requested || requested==='ALL') return req.user?.role==='admin' ? 'ALL' : fallback; if(locations.some(x=>x.id===requested && x.status!=='inactive')) return requested; return fallback; }
function userAllowedLocation(state, req, locationId) { if(req.user?.role==='admin') return true; const map=state?.userLocations||{}; const assigned=Array.isArray(map[req.user.id])?map[req.user.id]:[]; return assigned.length===0 || assigned.includes(locationId); }
function stampLocation(item, locationId){ if(item && !item.locationId) item.locationId=locationId; return item; }
const DEFAULT_ROLE_PERMISSIONS = {
  admin: ['*'],
  gudang: ['dashboard.view','stocks.view','inventory.qc','work.reports','wages.manage'],
  seller: ['dashboard.view','stocks.view','seller.booking','sales.closing']
};
async function getRolePermissions(role) {
  try {
    const r = await pool.query('SELECT state FROM app_state WHERE id=1');
    const map = r.rows[0]?.state?.rbac?.rolePermissions || {};
    return map[role] || DEFAULT_ROLE_PERMISSIONS[role] || ['dashboard.view'];
  } catch { return DEFAULT_ROLE_PERMISSIONS[role] || ['dashboard.view']; }
}
async function auth(req,res,next) {
  const h=req.headers.authorization||''; const token=h.startsWith('Bearer ')?h.slice(7):null;
  if(!token) return res.status(401).json({success:false,message:'Sesi tidak ditemukan. Silakan login kembali.'});
  try {
    const decoded=jwt.verify(token,JWT_SECRET);
    const r=await pool.query('SELECT id,username,name,role,email,phone,status,permissions,avatar_data FROM users WHERE id=$1 LIMIT 1',[decoded.id]);
    const u=r.rows[0];
    if(!u || u.status!=='active') return res.status(401).json({success:false,message:'Akun sudah tidak aktif. Silakan login kembali.'});
    const normalizedRole=normalizeRole(u.role); const rolePermissions=await getRolePermissions(normalizedRole);
    const permissions=(Array.isArray(u.permissions)&&u.permissions.length?u.permissions:rolePermissions);
    req.user={...publicUser({...u,role:normalizedRole}), permissions}; next();
  } catch { return res.status(401).json({success:false,message:'Sesi tidak valid atau sudah berakhir.'}); }
}
function requirePermission(permission) {
  return (req,res,next) => {
    const p=req.user?.permissions || [];
    if(req.user?.role==='admin' || p.includes('*') || p.includes(permission)) return next();
    return res.status(403).json({success:false,message:'Hak akses Anda tidak mencakup tindakan ini.'});
  };
}

function requireRole(...roles) {
  return (req,res,next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({success:false,message:'Anda tidak memiliki akses untuk melakukan tindakan ini.'});
    next();
  };
}

async function createStateSnapshot(client, state, version, reason, userId) {
  await client.query(`INSERT INTO app_state_snapshots (state, source_version, reason, user_id) VALUES ($1::jsonb,$2,$3,$4)`, [JSON.stringify(state||{}), Number(version||0), String(reason||'STATE_SAVE'), userId||null]);
}

function collectionSize(state, key) { return Array.isArray(state?.[key]) ? state[key].length : 0; }
function significantStateDrop(dbState, incoming) {
  const keys=['products','categories','inventory','inventoryMovements','sellerBookings','workReports','payoutRequests','scannedResi','salesClosings','damagedGoods','returnedGoods'];
  const drops=[];
  for (const key of keys) {
    const before=collectionSize(dbState,key), after=collectionSize(incoming,key);
    if (before >= 3 && after === 0) drops.push(key);
    else if (before >= 10 && after < Math.floor(before*0.5)) drops.push(key);
  }
  return drops;
}

function stateIntegrityIssues(state) {
  const issues=[];
  const inventory=Array.isArray(state?.inventory)?state.inventory:[];
  const invMap=new Map(inventory.map(i=>[`${i.productId}::${i.variantId}`,i]));
  for (const i of inventory) {
    for (const key of ['physicalStock','bookedStock','processStock','soldStock','damagedStock']) {
      const n=Number(i?.[key]||0);
      if (!Number.isFinite(n) || n < 0) issues.push(`inventaris ${i.productId}/${i.variantId}: ${key} tidak valid`);
    }
    if (Number(i.bookedStock||0) > Number(i.physicalStock||0)) issues.push(`inventaris ${i.productId}/${i.variantId}: booking melebihi stok fisik`);
  }
  for (const b of (Array.isArray(state?.sellerBookings)?state.sellerBookings:[])) {
    if (!['Menunggu Persetujuan','Aktif'].includes(b.status)) continue;
    const inv=invMap.get(`${b.productId}::${b.variantId}`);
    if (inv && Number(b.qty||0) < 0) issues.push(`booking ${b.id}: qty negatif`);
  }
  const resi=new Set();
  for (const c of (Array.isArray(state?.salesClosings)?state.salesClosings:[])) {
    const key=String(c.resiNo||'').trim().toLowerCase();
    if (key && resi.has(key)) issues.push(`resi closing ganda: ${c.resiNo}`);
    if (key) resi.add(key);
  }
  return issues.slice(0,25);
}

function newlyIntroducedIntegrityIssues(before, after) {
  const beforeSet=new Set(stateIntegrityIssues(before));
  return stateIntegrityIssues(after).filter(x=>!beforeSet.has(x));
}


async function ensureCoreSchema(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());`);
  await client.query(`CREATE TABLE IF NOT EXISTS warehouses (id text PRIMARY KEY, code text UNIQUE NOT NULL, name text NOT NULL, address text NOT NULL DEFAULT '', manager text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'active', is_default boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());`);
  await client.query(`CREATE TABLE IF NOT EXISTS user_warehouses (user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id, warehouse_id));`);
  await client.query(`CREATE TABLE IF NOT EXISTS product_catalog (id text PRIMARY KEY, category_id text, name text NOT NULL, sku text UNIQUE NOT NULL, description text NOT NULL DEFAULT '', unit text NOT NULL DEFAULT 'Unit', warehouse_location text NOT NULL DEFAULT '', min_stock numeric NOT NULL DEFAULT 10, image_url text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());`);
  await client.query(`CREATE TABLE IF NOT EXISTS product_variants (id text PRIMARY KEY, product_id text NOT NULL REFERENCES product_catalog(id) ON DELETE CASCADE, name text NOT NULL, sku text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(product_id, sku));`);
  await client.query(`CREATE TABLE IF NOT EXISTS inventory_core (id text PRIMARY KEY, warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE, product_id text NOT NULL REFERENCES product_catalog(id) ON DELETE CASCADE, variant_id text NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE, physical_stock numeric NOT NULL DEFAULT 0, booked_stock numeric NOT NULL DEFAULT 0, process_stock numeric NOT NULL DEFAULT 0, sold_stock numeric NOT NULL DEFAULT 0, damaged_stock numeric NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(warehouse_id, product_id, variant_id));`);
  await client.query(`CREATE TABLE IF NOT EXISTS stock_movements_core (id text PRIMARY KEY, warehouse_id text REFERENCES warehouses(id) ON DELETE SET NULL, type text NOT NULL, product_id text, variant_id text, qty numeric NOT NULL DEFAULT 0, before_qty numeric, after_qty numeric, reference_id text, reference_no text, user_id text, note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now());`);
  await client.query(`CREATE TABLE IF NOT EXISTS audit_logs_core (id bigserial PRIMARY KEY, user_id text, action text NOT NULL, detail text NOT NULL DEFAULT '', ip text, user_agent text, created_at timestamptz NOT NULL DEFAULT now());`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_inventory_core_warehouse ON inventory_core(warehouse_id);`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_stock_movements_core_warehouse_created ON stock_movements_core(warehouse_id, created_at DESC);`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_user_warehouses_user ON user_warehouses(user_id);`);
}

async function syncCoreFromState(client, state) {
  await ensureCoreSchema(client);
  const locations = Array.isArray(state?.locations) ? state.locations : [];
  for (const w of locations) {
    await client.query(`INSERT INTO warehouses(id,code,name,address,manager,status,is_default,created_at,updated_at)
      VALUES($1,$1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,now()),now())
      ON CONFLICT(id) DO UPDATE SET code=EXCLUDED.code,name=EXCLUDED.name,address=EXCLUDED.address,manager=EXCLUDED.manager,status=EXCLUDED.status,is_default=EXCLUDED.is_default,updated_at=now()`,
      [w.id,w.name||w.id,w.address||'',w.manager||'',w.status||'active',!!w.isDefault,w.createdAt||null]);
  }
  if (locations.length) await client.query(`DELETE FROM warehouses WHERE id <> ALL($1::text[])`, [locations.map(x=>String(x.id))]);

  const userLocations = state?.userLocations || {};
  await client.query('DELETE FROM user_warehouses');
  for (const [userId, ids] of Object.entries(userLocations)) {
    for (const warehouseId of (Array.isArray(ids) ? ids : [])) {
      await client.query(`INSERT INTO user_warehouses(user_id,warehouse_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[userId,warehouseId]);
    }
  }

  const categories = Array.isArray(state?.categories) ? state.categories : [];
  const categoryIds = new Set(categories.map(c=>String(c.id)));
  const products = Array.isArray(state?.products) ? state.products : [];
  for (const p of products) {
    await client.query(`INSERT INTO product_catalog(id,category_id,name,sku,description,unit,warehouse_location,min_stock,image_url,status,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11::timestamptz,now()),now())
      ON CONFLICT(id) DO UPDATE SET category_id=EXCLUDED.category_id,name=EXCLUDED.name,sku=EXCLUDED.sku,description=EXCLUDED.description,unit=EXCLUDED.unit,warehouse_location=EXCLUDED.warehouse_location,min_stock=EXCLUDED.min_stock,image_url=EXCLUDED.image_url,status=EXCLUDED.status,updated_at=now()`,
      [p.id,categoryIds.has(String(p.categoryId))?p.categoryId:null,p.name||p.id,p.sku||p.id,p.description||'',p.unit||'Unit',p.warehouseLocation||'',Number(p.minStock||10),p.imageUrl||'',p.status||'active',p.createdAt||null]);
    for (const v of (Array.isArray(p.variants)?p.variants:[])) {
      await client.query(`INSERT INTO product_variants(id,product_id,name,sku,created_at,updated_at)
        VALUES($1,$2,$3,$4,now(),now()) ON CONFLICT(id) DO UPDATE SET product_id=EXCLUDED.product_id,name=EXCLUDED.name,sku=EXCLUDED.sku,updated_at=now()`,
        [v.id,p.id,v.name||v.id,v.sku||`${p.sku||p.id}-${v.id}`]);
    }
  }
  if (products.length) await client.query(`DELETE FROM product_catalog WHERE id <> ALL($1::text[])`, [products.map(x=>String(x.id))]);

  const inventory = Array.isArray(state?.inventory) ? state.inventory : [];
  const validInventoryIds=[];
  for (const i of inventory) {
    const warehouseId=String(i.locationId||locations.find(x=>x.isDefault)?.id||locations[0]?.id||'GUD-01');
    const id=String(i.id||`INV-${warehouseId}-${i.productId}-${i.variantId}`);
    validInventoryIds.push(id);
    await client.query(`INSERT INTO inventory_core(id,warehouse_id,product_id,variant_id,physical_stock,booked_stock,process_stock,sold_stock,damaged_stock,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
      ON CONFLICT(id) DO UPDATE SET warehouse_id=EXCLUDED.warehouse_id,product_id=EXCLUDED.product_id,variant_id=EXCLUDED.variant_id,physical_stock=EXCLUDED.physical_stock,booked_stock=EXCLUDED.booked_stock,process_stock=EXCLUDED.process_stock,sold_stock=EXCLUDED.sold_stock,damaged_stock=EXCLUDED.damaged_stock,updated_at=now()`,
      [id,warehouseId,i.productId,i.variantId,Number(i.physicalStock||0),Number(i.bookedStock||0),Number(i.processStock||0),Number(i.soldStock||0),Number(i.damagedStock||0)]);
  }
  if (validInventoryIds.length) await client.query(`DELETE FROM inventory_core WHERE id <> ALL($1::text[])`,[validInventoryIds]);
  else await client.query('DELETE FROM inventory_core');

  const movements = Array.isArray(state?.stockMutations) ? state.stockMutations : [];
  // The JSON state remains the historical source of truth for now. Core movements are refreshed
  // idempotently so the normalized layer can become the primary transaction store in a later stage.
  for (const m of movements) {
    const warehouseId=m.locationId || null;
    await client.query(`INSERT INTO stock_movements_core(id,warehouse_id,type,product_id,variant_id,qty,before_qty,after_qty,reference_id,reference_no,user_id,note,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13::timestamptz,now()))
      ON CONFLICT(id) DO NOTHING`,
      [m.id,warehouseId,m.type||'UNKNOWN',m.productId||null,m.variantId||null,Number(m.qty||0),m.before==null?null:Number(m.before),m.after==null?null:Number(m.after),m.referenceId||null,m.referenceNo||null,m.userId||null,m.note||'',m.createdAt||null]);
  }
}

async function mutateState(mutator) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT state, version FROM app_state WHERE id=1 FOR UPDATE');
    const state = r.rows[0]?.state || {};
    const previousState = JSON.parse(JSON.stringify(state));
    const previousVersion = Number(r.rows[0]?.version||0);
    const result = await mutator(state, client);
    const integrityIssues = newlyIntroducedIntegrityIssues(previousState, state);
    if (integrityIssues.length) {
      throw Object.assign(new Error(`Perubahan dibatalkan demi menjaga konsistensi data: ${integrityIssues.join('; ')}`), {status:409, code:'STATE_INTEGRITY'});
    }
    await createStateSnapshot(client, previousState, previousVersion, 'MUTATION', null);
    await syncCoreFromState(client, state);
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

app.post('/api/register', async (req,res)=>{
  try {
    const { username, password, name, email, phone, requestedRole, note } = req.body || {};
    const uName = String(username || '').trim().toLowerCase();
    const uPass = String(password || '').trim();
    const fullName = String(name || uName).trim();
    if (!uName || !uPass || !fullName) return res.status(400).json({ success: false, message: 'Username, password, dan nama lengkap wajib diisi.' });
    if (uPass.length < 6) return res.status(400).json({ success: false, message: 'Password minimal 6 karakter.' });

    const existing = await pool.query('SELECT id FROM users WHERE LOWER(username)=$1 OR (email IS NOT NULL AND LOWER(email)=$2) LIMIT 1', [uName, String(email || '').trim().toLowerCase()]);
    if (existing.rowCount > 0) return res.status(409).json({ success: false, message: 'Username atau Email sudah terdaftar.' });

    const hash = await bcrypt.hash(uPass, 12);
    const userId = 'USR-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const userRole = 'pending';
    const status = 'pending';

    await pool.query(
      `INSERT INTO users(id, username, password_hash, name, role, email, phone, status, requested_role, permissions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [userId, uName, hash, fullName, userRole, String(email || '').trim() || null, String(phone || '').trim() || null, status, String(requestedRole || 'seller'), JSON.stringify([])]
    );

    // Tambahkan log pendaftaran ke state
    await mutateState((state) => {
      state.pendingRegistrations = state.pendingRegistrations || [];
      state.pendingRegistrations.unshift({
        id: userId,
        username: uName,
        name: fullName,
        email: email || '',
        phone: phone || '',
        requestedRole: requestedRole || 'seller',
        note: note || '',
        registeredAt: new Date().toISOString()
      });
      state.activityLogs = state.activityLogs || [];
      state.activityLogs.unshift({
        id: 'ACT-' + Date.now(),
        type: 'REGISTRASI_BARU',
        description: `Pengguna baru '${fullName}' (${uName}) mendaftar dan menunggu persetujuan Admin.`,
        userId,
        createdAt: new Date().toISOString()
      });
    });

    res.status(201).json({
      success: true,
      message: 'Registrasi berhasil! Akun Anda telah terdaftar dan sedang menunggu persetujuan & penentuan hak akses oleh Admin.'
    });
  } catch (e) {
    console.error('Error register:', e);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan saat pendaftaran.' });
  }
});

app.post('/api/login', async (req,res)=>{
  try {
    const {username,password}=req.body||{}; if(!username||!password) return res.status(400).json({success:false,message:'Username dan password wajib diisi.'});
    const r=await pool.query('SELECT * FROM users WHERE LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($1) LIMIT 1',[String(username).trim()]); const u=r.rows[0];
    if(!u) return res.status(401).json({success:false,message:'Username atau password salah.'});
    if(u.status === 'pending') return res.status(403).json({success:false,message:'Akun Anda masih dalam status Menunggu Persetujuan Admin.'});
    if(u.status !== 'active') return res.status(403).json({success:false,message:'Akun Anda telah dinonaktifkan atau ditolak.'});
    if(!(await bcrypt.compare(String(password),u.password_hash))) return res.status(401).json({success:false,message:'Username atau password salah.'});
    const user=publicUser(u); const token=jwt.sign({id:user.id,role:user.role,username:user.username},JWT_SECRET,{expiresIn:'24h'});
    res.json({success:true,message:'Login berhasil.',token,user});
  } catch(e){ console.error(e); res.status(500).json({success:false,message:'Terjadi kesalahan saat login.'}); }
});

app.get('/api/users/pending', auth, requireRole('admin'), async (req,res)=>{
  try {
    const r = await pool.query("SELECT id,username,name,role,email,phone,status,requested_role,created_at FROM users WHERE status='pending' ORDER BY created_at DESC");
    res.json({success:true, data: r.rows.map(u => ({...publicUser(u), requestedRole:u.requested_role || 'seller', createdAt:u.created_at}))});
  } catch(e){ res.status(500).json({success:false,message:'Gagal mengambil daftar pengguna pending.'}); }
});

app.patch('/api/users/:id/approve', auth, requireRole('admin'), async (req,res)=>{
  try {
    const { role, permissions } = req.body || {};
    const assignedRole = String(role || 'seller').trim();
    const userId = req.params.id;
    const rolePermissions = await getRolePermissions(assignedRole);
    const assignedPermissions = Array.isArray(permissions) ? permissions : rolePermissions;
    const r = await pool.query("UPDATE users SET status='active', role=$1, requested_role=NULL, permissions=$2::jsonb, updated_at=NOW() WHERE id=$3 RETURNING id,username,name,role,status,permissions", [assignedRole, JSON.stringify(assignedPermissions), userId]);
    if (!r.rowCount) return res.status(404).json({success:false,message:'Pengguna tidak ditemukan.'});
    const u = r.rows[0];
    await mutateState((state) => {
      state.pendingRegistrations = (state.pendingRegistrations || []).filter(x => x.id !== userId);
      state.activityLogs = state.activityLogs || [];
      state.activityLogs.unshift({
        id: 'ACT-' + Date.now(),
        type: 'SETUJUI_AKUN',
        description: `Admin menyetujui akun '${u.name}' (${u.username}) dengan peran '${u.role}'.`,
        userId: req.user.id,
        createdAt: new Date().toISOString()
      });
    });
    res.json({success:true, message: `Akun '${u.name}' berhasil disetujui sebagai '${u.role}'.`, data: publicUser(u)});
  } catch(e){ res.status(500).json({success:false,message:'Gagal menyetujui akun.'}); }
});

app.patch('/api/users/:id/reject', auth, requireRole('admin'), async (req,res)=>{
  try {
    const userId = req.params.id;
    const r = await pool.query("UPDATE users SET status='rejected', updated_at=NOW() WHERE id=$1 RETURNING id,username,name", [userId]);
    if (!r.rowCount) return res.status(404).json({success:false,message:'Pengguna tidak ditemukan.'});
    const u = r.rows[0];
    await mutateState((state) => {
      state.pendingRegistrations = (state.pendingRegistrations || []).filter(x => x.id !== userId);
      state.activityLogs = state.activityLogs || [];
      state.activityLogs.unshift({
        id: 'ACT-' + Date.now(),
        type: 'TOLAK_AKUN',
        description: `Admin menolak pendaftaran akun '${u.name}' (${u.username}).`,
        userId: req.user.id,
        createdAt: new Date().toISOString()
      });
    });
    res.json({success:true, message: `Pendaftaran akun '${u.name}' ditolak.`, data: publicUser(u)});
  } catch(e){ res.status(500).json({success:false,message:'Gagal menolak akun.'}); }
});

app.patch('/api/users/:id/role', auth, requireRole('admin'), async (req,res)=>{
  try {
    const { role, status } = req.body || {};
    const userId = req.params.id;
    const old = await pool.query('SELECT * FROM users WHERE id=$1', [userId]);
    if (!old.rowCount) return res.status(404).json({success:false,message:'Pengguna tidak ditemukan.'});
    const newRole = role ? String(role).trim() : old.rows[0].role;
    const newStatus = status ? String(status).trim() : old.rows[0].status;
    const r = await pool.query("UPDATE users SET role=$1, status=$2, updated_at=NOW() WHERE id=$3 RETURNING id,username,name,role,status", [newRole, newStatus, userId]);
    res.json({success:true, message: 'Peran & status pengguna berhasil diperbarui.', data: publicUser(r.rows[0])});
  } catch(e){ res.status(500).json({success:false,message:'Gagal memperbarui pengguna.'}); }
});


// Admin: manajemen pengguna individual (Tahap 9)
app.get('/api/users', auth, requireRole('admin'), async (req,res)=>{
  try {
    const r=await pool.query("SELECT id,username,name,role,email,phone,status,requested_role,permissions,created_at,updated_at FROM users ORDER BY created_at DESC");
    res.json({success:true,data:r.rows.map(u=>({...publicUser(u),requestedRole:u.requested_role||'',createdAt:u.created_at,updatedAt:u.updated_at}))});
  } catch(e){ console.error('GET users',e); res.status(500).json({success:false,message:'Gagal mengambil daftar pengguna.'}); }
});

app.post('/api/users', auth, requireRole('admin'), async (req,res)=>{
  try {
    const {name,username,password,role='seller',email='',phone='',permissions,status='active'}=req.body||{};
    if(!name||!username||!password) return res.status(400).json({success:false,message:'Nama, username, dan password wajib diisi.'});
    const exists=await pool.query('SELECT id FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1',[String(username).trim()]);
    if(exists.rowCount) return res.status(409).json({success:false,message:'Username sudah digunakan.'});
    const rolePerms=await getRolePermissions(String(role));
    const assigned=Array.isArray(permissions)?permissions:rolePerms;
    const hash=await bcrypt.hash(String(password),10); const id='USR-'+Date.now()+'-'+Math.random().toString(36).slice(2,7);
    const r=await pool.query(`INSERT INTO users(id,username,password_hash,name,role,email,phone,status,permissions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING id,username,name,role,email,phone,status,permissions,created_at,updated_at`,[id,String(username).trim(),hash,String(name).trim(),String(role),String(email).trim(),String(phone).trim(),String(status),JSON.stringify(assigned)]);
    res.status(201).json({success:true,message:'Akun pengguna berhasil dibuat.',data:{...publicUser(r.rows[0]),createdAt:r.rows[0].created_at,updatedAt:r.rows[0].updated_at}});
  } catch(e){ console.error('POST users',e); res.status(500).json({success:false,message:'Gagal membuat akun pengguna.'}); }
});

app.patch('/api/users/:id', auth, requireRole('admin'), async (req,res)=>{
  try {
    const id=req.params.id, body=req.body||{}; const old=await pool.query('SELECT * FROM users WHERE id=$1',[id]);
    if(!old.rowCount)return res.status(404).json({success:false,message:'Pengguna tidak ditemukan.'}); const u=old.rows[0];
    const username=body.username!==undefined?String(body.username).trim():u.username;
    const dup=await pool.query('SELECT id FROM users WHERE LOWER(username)=LOWER($1) AND id<>$2 LIMIT 1',[username,id]); if(dup.rowCount)return res.status(409).json({success:false,message:'Username sudah digunakan.'});
    const role=body.role!==undefined?String(body.role):u.role; const status=body.status!==undefined?String(body.status):u.status;
    const perms=Array.isArray(body.permissions)?body.permissions:(Array.isArray(u.permissions)?u.permissions:[]);
    const fields=[`username=$1`,`name=$2`,`role=$3`,`email=$4`,`phone=$5`,`status=$6`,`permissions=$7::jsonb`,`updated_at=NOW()`];
    const vals=[username,body.name!==undefined?String(body.name).trim():u.name,role,body.email!==undefined?String(body.email).trim():u.email||'',body.phone!==undefined?String(body.phone).trim():u.phone||'',status,JSON.stringify(perms),id];
    if(body.password){ fields.push(`password_hash=$${vals.length}`); vals.splice(vals.length-1,0,await bcrypt.hash(String(body.password),10)); }
    const idPos=vals.length; const q=`UPDATE users SET ${fields.join(', ')} WHERE id=$${idPos} RETURNING id,username,name,role,email,phone,status,permissions,created_at,updated_at`;
    const r=await pool.query(q,vals); res.json({success:true,message:'Akun pengguna berhasil diperbarui.',data:{...publicUser(r.rows[0]),createdAt:r.rows[0].created_at,updatedAt:r.rows[0].updated_at}});
  } catch(e){ console.error('PATCH users',e); res.status(500).json({success:false,message:'Gagal memperbarui akun pengguna.'}); }
});

app.delete('/api/users/:id', auth, requireRole('admin'), async (req,res)=>{
  try { if(req.params.id===req.user.id)return res.status(400).json({success:false,message:'Akun yang sedang digunakan tidak dapat dihapus.'}); const r=await pool.query('DELETE FROM users WHERE id=$1 RETURNING id,name,username',[req.params.id]); if(!r.rowCount)return res.status(404).json({success:false,message:'Pengguna tidak ditemukan.'}); res.json({success:true,message:`Akun ${r.rows[0].name} berhasil dihapus.`}); } catch(e){res.status(500).json({success:false,message:'Gagal menghapus akun pengguna.'});}
});

app.get('/api/me', auth, async (req,res)=>{ res.json({success:true,user:req.user}); });

// Profil pengguna disimpan terpisah agar perubahan profil/foto tidak pernah
// menimpa app_state global yang dipakai bersama antar perangkat.
app.get('/api/me/profile', auth, async (req,res)=>{
  try {
    const r=await pool.query('SELECT user_id,name,username,email,phone,store_name,avatar_data,updated_at FROM user_profiles WHERE user_id=$1',[req.user.id]);
    const row=r.rows[0];
    res.json({success:true,data:row?{userId:row.user_id,name:row.name||req.user.name,username:row.username||req.user.username,email:row.email||req.user.email||'',phone:row.phone||req.user.phone||'',storeName:row.store_name||'',avatarData:row.avatar_data||'',updatedAt:row.updated_at}: {userId:req.user.id,name:req.user.name,username:req.user.username,email:req.user.email||'',phone:req.user.phone||'',avatarData:''}});
  } catch(e){ console.error('GET profile',e); res.status(500).json({success:false,message:'Gagal memuat profil pengguna.'}); }
});
app.patch('/api/me/profile', auth, async (req,res)=>{
  try {
    const body=req.body||{};
    const name=body.name!==undefined?String(body.name).trim():req.user.name;
    const username=body.username!==undefined?String(body.username).trim().toLowerCase():req.user.username;
    const email=body.email!==undefined?String(body.email).trim():req.user.email||'';
    const phone=body.phone!==undefined?String(body.phone).trim():req.user.phone||'';
    const storeName=body.storeName!==undefined?String(body.storeName).trim():'';
    const avatarData=body.avatarData!==undefined?String(body.avatarData):null;
    if(!name||!username) return res.status(400).json({success:false,message:'Nama dan username wajib diisi.'});
    const dup=await pool.query('SELECT id FROM users WHERE LOWER(username)=LOWER($1) AND id<>$2 LIMIT 1',[username,req.user.id]);
    if(dup.rowCount)return res.status(409).json({success:false,message:'Username sudah digunakan pengguna lain.'});
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query('UPDATE users SET name=$1,username=$2,email=$3,phone=$4,updated_at=NOW() WHERE id=$5',[name,username,email||null,phone||null,req.user.id]);
      if(avatarData!==null && avatarData.length>2_800_000) throw Object.assign(new Error('Foto profil terlalu besar. Maksimal sekitar 2 MB.'),{status:400});
      await client.query(`INSERT INTO user_profiles(user_id,name,username,email,phone,store_name,avatar_data,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,NOW()) ON CONFLICT(user_id) DO UPDATE SET name=EXCLUDED.name,username=EXCLUDED.username,email=EXCLUDED.email,phone=EXCLUDED.phone,store_name=EXCLUDED.store_name,avatar_data=CASE WHEN $7 IS NULL THEN user_profiles.avatar_data ELSE EXCLUDED.avatar_data END,updated_at=NOW()`,[req.user.id,name,username,email||'',phone||'',storeName,avatarData]);
      await client.query('COMMIT');
    }catch(e){try{await client.query('ROLLBACK')}catch{};throw e}finally{client.release()}
    const r=await pool.query('SELECT id,username,name,role,email,phone,status,permissions FROM users WHERE id=$1',[req.user.id]);
    const u=publicUser(r.rows[0]);
    res.json({success:true,message:'Profil berhasil diperbarui.',user:u,data:{name,username,email,phone,storeName,avatarData:avatarData===null?undefined:avatarData}});
  }catch(e){ console.error('PATCH profile',e); res.status(e.status||500).json({success:false,message:e.message||'Gagal memperbarui profil pengguna.'}); }
});
app.get('/api/me/permissions', auth, async (req,res)=>{ res.json({success:true,data:{role:req.user.role,permissions:req.user.permissions||[]}}); });
app.patch('/api/me', auth, async (req,res)=>{
  try {
    const body=req.body||{};
    const name=body.name!==undefined?String(body.name).trim():req.user.name;
    const username=body.username!==undefined?String(body.username).trim():req.user.username;
    const email=body.email!==undefined?String(body.email).trim():req.user.email||'';
    const phone=body.phone!==undefined?String(body.phone).trim():req.user.phone||'';
    const avatarData=body.avatarData!==undefined?String(body.avatarData):req.user.avatarData||'';
    if(!name||!username) return res.status(400).json({success:false,message:'Nama dan username wajib diisi.'});
    const dup=await pool.query('SELECT id FROM users WHERE LOWER(username)=LOWER($1) AND id<>$2 LIMIT 1',[username,req.user.id]);
    if(dup.rowCount)return res.status(409).json({success:false,message:'Username sudah digunakan.'});
    if(avatarData && avatarData.length>3*1024*1024) return res.status(413).json({success:false,message:'Foto profil terlalu besar.'});
    const r=await pool.query('UPDATE users SET name=$1,username=$2,email=$3,phone=$4,avatar_data=$5,updated_at=NOW() WHERE id=$6 RETURNING id,username,name,role,email,phone,status,permissions,avatar_data',[name,username,email,phone,avatarData,req.user.id]);
    await writeSecurityLog(req.user.id,'UPDATE_PROFILE','Memperbarui profil pribadi.',req);
    res.json({success:true,message:'Profil berhasil diperbarui.',user:publicUser(r.rows[0])});
  } catch(e){ console.error('PATCH me',e); res.status(500).json({success:false,message:'Gagal memperbarui profil.'}); }
});
app.patch('/api/users/:id/permissions', auth, requireRole('admin'), async (req,res)=>{
  try {
    const permissions=Array.isArray(req.body?.permissions)?req.body.permissions:[];
    const r=await pool.query('UPDATE users SET permissions=$1::jsonb, updated_at=NOW() WHERE id=$2 RETURNING id,username,name,role,permissions',[JSON.stringify(permissions),req.params.id]);
    if(!r.rowCount)return res.status(404).json({success:false,message:'Pengguna tidak ditemukan.'});
    res.json({success:true,message:'Hak akses pengguna berhasil diperbarui.',data:publicUser(r.rows[0])});
  }catch(e){res.status(500).json({success:false,message:'Gagal memperbarui hak akses pengguna.'});}
});

app.get('/api/sync/version', auth, async (req,res)=>{
  try {
    const r = await pool.query('SELECT version, updated_at FROM app_state WHERE id=1');
    res.json({success:true, version:Number(r.rows[0]?.version||0), updatedAt:r.rows[0]?.updated_at||null});
  } catch(e) { res.status(500).json({success:false,message:'Gagal memeriksa versi sinkronisasi.'}); }
});

app.get('/api/dashboard/summary', auth, requirePermission('dashboard.view'), async (req,res)=>{
  try {
    const {state,version}=await getState(pool);
    const start=req.query.start ? new Date(req.query.start) : null;
    const end=req.query.end ? new Date(req.query.end+'T23:59:59.999Z') : null;
    const inRange=(d)=>{ if(!d) return true; const t=new Date(d); return (!start||t>=start)&&(!end||t<=end); };
    const activeLocation=getActiveLocationId(req,state);
    const inLocation=(x)=>activeLocation==='ALL' || String(x?.locationId||'GUD-01')===activeLocation;
    const inv=(state.inventory||[]).filter(inLocation);
    const movements=(state.inventoryMovements||[]).filter(x=>inLocation(x)&&inRange(x.createdAt));
    const reports=(state.workReports||[]).filter(x=>inLocation(x)&&inRange(x.createdAt||x.date));
    const closings=(state.salesClosings||[]).filter(x=>inLocation(x)&&inRange(x.closedAt||x.createdAt));
    const returns=(state.returnedGoods||[]).filter(x=>inLocation(x)&&inRange(x.createdAt));
    const defects=(state.damagedGoods||[]).filter(x=>inLocation(x)&&inRange(x.createdAt));
    const sum=(arr,key)=>arr.reduce((n,x)=>n+Number(x[key]||0),0);
    const summary={
      totalPhysicalStock:sum(inv,'physicalStock'), totalBookedStock:sum(inv,'bookedStock'),
      totalAvailableStock:inv.reduce((n,x)=>n+Math.max(0,Number(x.physicalStock||0)-Number(x.bookedStock||0)),0),
      totalSoldStock:sum(inv,'soldStock'), totalDamagedStock:sum(inv,'damagedStock'),
      stockIn:movements.filter(x=>x.type==='IN').reduce((n,x)=>n+Number(x.qty||0),0),
      stockOut:movements.filter(x=>x.type==='OUT').reduce((n,x)=>n+Number(x.qty||0),0),
      qcPassed:movements.filter(x=>x.type==='QC').reduce((n,x)=>n+Number(x.passedQty||x.qty||0),0),
      soldInPeriod:closings.reduce((n,x)=>n+Number(x.qty||0),0),
      returnsInPeriod:sum(returns,'qty'), defectsInPeriod:sum(defects,'qty'),
      workWage:reports.reduce((n,x)=>n+Number(x.totalWage||0),0),
      pendingBookings:(state.sellerBookings||[]).filter(x=>inLocation(x)&&['Menunggu Persetujuan','Aktif'].includes(x.status)).length,
      pendingPayouts:(state.payoutRequests||[]).filter(x=>inLocation(x)&&x.status==='Menunggu Persetujuan').length,
      scannedResi:(state.scannedResi||[]).length, closings:closings.length
    };
    res.json({success:true,data:summary,version});
  } catch(e){ console.error(e); res.status(500).json({success:false,message:'Gagal memuat ringkasan dashboard.'}); }
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
app.post('/api/categories', auth, requirePermission('products.manage'), async (req,res)=>{
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
app.put('/api/categories/:id', auth, requirePermission('products.manage'), async (req,res)=>{
  try { const name=String(req.body?.name||'').trim(), description=String(req.body?.description||'').trim(); if(!name)return res.status(400).json({success:false,message:'Nama kategori wajib diisi.'});
    const {result,version}=await mutateState(state=>{ state.categories=state.categories||[]; const c=state.categories.find(x=>x.id===req.params.id); if(!c) throw Object.assign(new Error('Kategori tidak ditemukan.'),{status:404}); if(state.categories.some(x=>x.id!==c.id&&String(x.name).toLowerCase()===name.toLowerCase()))throw Object.assign(new Error('Nama kategori sudah digunakan.'),{status:409}); Object.assign(c,{name,description,updatedAt:new Date().toISOString()}); return c; });
    res.json({success:true,message:'Kategori berhasil diperbarui.',data:result,version});
  } catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal memperbarui kategori.'});}
});
app.delete('/api/categories/:id', auth, requirePermission('products.manage'), async (req,res)=>{
  try { const {result,version}=await mutateState(state=>{ state.categories=state.categories||[]; state.products=state.products||[]; const c=state.categories.find(x=>x.id===req.params.id); if(!c)throw Object.assign(new Error('Kategori tidak ditemukan.'),{status:404}); if(state.products.some(p=>p.categoryId===c.id))throw Object.assign(new Error('Kategori masih digunakan oleh produk dan tidak dapat dihapus.'),{status:409}); state.categories=state.categories.filter(x=>x.id!==c.id); return c; }); res.json({success:true,message:'Kategori berhasil dihapus.',data:result,version}); }
  catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal menghapus kategori.'});}
});
app.get('/api/products', auth, async (req,res)=>{ try{const {state}=await getState(pool);res.json({success:true,data:state.products||[]});}catch(e){res.status(500).json({success:false,message:'Gagal memuat produk.'});} });
app.post('/api/products', auth, requirePermission('products.manage'), async (req,res)=>{
  try { const payload=req.body||{}; const {result,version}=await mutateState(state=>{
    state.products=state.products||[]; state.categories=state.categories||[]; state.inventory=state.inventory||[];
    const name=String(payload.name||'').trim(), sku=String(payload.sku||'').trim(), categoryId=String(payload.categoryId||'');
    if(!name||!sku||!categoryId)throw Object.assign(new Error('Nama produk, kategori dan SKU wajib diisi.'),{status:400});
    if(!state.categories.some(c=>c.id===categoryId))throw Object.assign(new Error('Kategori tidak ditemukan.'),{status:400});
    if(state.products.some(p=>String(p.sku).toLowerCase()===sku.toLowerCase()))throw Object.assign(new Error('SKU produk sudah digunakan.'),{status:409});
    const now=new Date().toISOString(); const id='PRD-'+Date.now(); const variants=(Array.isArray(payload.variants)&&payload.variants.length?payload.variants:[{name:'Standard'}]).map((v,i)=>({id:v.id||'VAR-'+Date.now()+'-'+i,name:String(v.name||'Standard').trim(),sku:v.sku||`${sku}-${i+1}`}));
    const product={id,categoryId,name,sku,description:String(payload.description||''),unit:String(payload.unit||'Unit'),warehouseLocation:String(payload.warehouseLocation||'Rak Gudang Utama'),minStock:Number(payload.minStock||10),status:'active',imageUrl:String(payload.imageUrl||''),variants,createdAt:now,updatedAt:now}; state.products.push(product); variants.forEach(v=>{if(!state.inventory.some(i=>i.productId===id&&i.variantId===v.id))state.inventory.push({id:'INV-'+Date.now()+'-'+Math.floor(Math.random()*10000),productId:id,variantId:v.id,locationId:getActiveLocationId(req,state),physicalStock:0,bookedStock:0,processStock:0,soldStock:0,damagedStock:0});}); return product;
  }); res.status(201).json({success:true,message:'Produk berhasil ditambahkan.',data:result,version}); }
  catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal menambah produk.'});}
});
app.put('/api/products/:id', auth, requirePermission('products.manage'), async (req,res)=>{
  try { const payload=req.body||{}; const {result,version}=await mutateState(state=>{
    state.products=state.products||[]; state.categories=state.categories||[]; state.inventory=state.inventory||[]; const p=state.products.find(x=>x.id===req.params.id); if(!p)throw Object.assign(new Error('Produk tidak ditemukan.'),{status:404});
    const name=String(payload.name||'').trim(), sku=String(payload.sku||'').trim(), categoryId=String(payload.categoryId||''); if(!name||!sku||!categoryId)throw Object.assign(new Error('Nama produk, kategori dan SKU wajib diisi.'),{status:400}); if(!state.categories.some(c=>c.id===categoryId))throw Object.assign(new Error('Kategori tidak ditemukan.'),{status:400}); if(state.products.some(x=>x.id!==p.id&&String(x.sku).toLowerCase()===sku.toLowerCase()))throw Object.assign(new Error('SKU produk sudah digunakan.'),{status:409});
    const incoming=Array.isArray(payload.variants)&&payload.variants.length?payload.variants:[{name:'Standard'}]; const variants=incoming.map((v,i)=>{const old=(p.variants||[]).find(x=>x.id===v.id||x.name===v.name);return {id:old?.id||v.id||'VAR-'+Date.now()+'-'+i,name:String(v.name||'Standard').trim(),sku:v.sku||old?.sku||`${sku}-${i+1}`};}); Object.assign(p,{categoryId,name,sku,description:String(payload.description||''),unit:String(payload.unit||'Unit'),warehouseLocation:String(payload.warehouseLocation||'Rak Gudang Utama'),minStock:Number(payload.minStock||10),imageUrl:payload.imageUrl!==undefined?String(payload.imageUrl||''):String(p.imageUrl||''),variants,updatedAt:new Date().toISOString()}); variants.forEach(v=>{if(!state.inventory.some(i=>i.productId===p.id&&i.variantId===v.id))state.inventory.push({productId:p.id,variantId:v.id,physicalStock:0,bookedStock:0,processStock:0,soldStock:0,damagedStock:0});}); return p;
  }); res.json({success:true,message:'Produk berhasil diperbarui.',data:result,version}); }
  catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal memperbarui produk.'});}
});
app.delete('/api/products/:id', auth, requirePermission('products.manage'), async (req,res)=>{
  try { const {result,version}=await mutateState(state=>{ state.products=state.products||[]; state.inventory=state.inventory||[]; const p=state.products.find(x=>x.id===req.params.id); if(!p)throw Object.assign(new Error('Produk tidak ditemukan.'),{status:404}); state.products=state.products.filter(x=>x.id!==p.id); state.inventory=state.inventory.filter(i=>i.productId!==p.id); return p; }); res.json({success:true,message:'Produk berhasil dihapus.',data:result,version}); }
  catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal menghapus produk.'});}
});


// ============================================================================
// INVENTORY CRUD / MUTATION API
// Tahap 3: setiap transaksi stok diproses atomik di backend.
// ============================================================================
function makeInventoryRecord(state, productId, variantId, locationId='GUD-01') {
  state.inventory = state.inventory || [];
  let inv = state.inventory.find(i => i.productId === productId && i.variantId === variantId && (i.locationId||'GUD-01') === locationId);
  if (!inv) {
    inv = { id:'INV-'+Date.now()+'-'+Math.floor(Math.random()*10000), productId, variantId, locationId, physicalStock: 0, bookedStock: 0, processStock: 0, soldStock: 0, damagedStock: 0 };
    state.inventory.push(inv);
  }
  ['physicalStock','bookedStock','processStock','soldStock','damagedStock'].forEach(k => inv[k] = Number(inv[k] || 0));
  return inv;
}
function requireProductVariant(state, productId, variantId) {
  const product = (state.products || []).find(p => p.id === productId);
  if (!product) throw Object.assign(new Error('Produk tidak ditemukan.'), {status:404});
  const variant = (product.variants || []).find(v => v.id === variantId);
  if (!variant) throw Object.assign(new Error('Varian produk tidak ditemukan.'), {status:404});
  return {product, variant};
}
function addInventoryActivity(state, req, action, description, meta = {}) {
  state.activityLogs = state.activityLogs || [];
  state.activityLogs.unshift({
    id: 'LOG-' + Date.now() + '-' + Math.floor(Math.random()*10000),
    userId: req.user.id,
    userName: req.user.name || req.user.username,
    action,
    description,
    meta,
    createdAt: new Date().toISOString()
  });
}
function addStockMutation(state, payload) {
  state.stockMutations = state.stockMutations || [];
  state.stockMutations.unshift({
    id: 'MUT-' + Date.now() + '-' + Math.floor(Math.random()*10000),
    createdAt: new Date().toISOString(),
    ...payload
  });
}

app.get('/api/inventory', auth, requireAnyPermission('stocks.view','inventory.in_out','inventory.qc'), async (req,res) => {
  try {
    const {state, version} = await getState(pool);
    res.json({success:true, data: state.inventory || [], version});
  } catch(e) { res.status(500).json({success:false,message:'Gagal mengambil data inventaris.'}); }
});

app.get('/api/inventory/movements', auth, requireAnyPermission('stocks.view','inventory.in_out','inventory.qc'), async (req,res) => {
  try {
    const {state, version} = await getState(pool);
    res.json({success:true, data: state.stockMutations || [], version});
  } catch(e) { res.status(500).json({success:false,message:'Gagal mengambil riwayat mutasi stok.'}); }
});

app.post('/api/inventory/in', auth, requirePermission('inventory.in_out'), async (req,res) => {
  try {
    const payload = req.body || {};
    const {result, version} = await mutateState((state) => {
      const productId=String(payload.productId||''), variantId=String(payload.variantId||'');
      const qty=Number(payload.qty||0);
      if(!productId||!variantId||!Number.isFinite(qty)||qty<=0) throw Object.assign(new Error('Produk, varian, dan jumlah barang masuk wajib valid.'),{status:400});
      const {product,variant}=requireProductVariant(state,productId,variantId);
      const locationId=getActiveLocationId(req,state); if(!userAllowedLocation(state,req,locationId)) throw Object.assign(new Error('Anda tidak memiliki akses ke gudang ini.'),{status:403}); const inv=makeInventoryRecord(state,productId,variantId,locationId);
      inv.physicalStock += qty;
      state.stockIns=state.stockIns||[];
      const now=new Date().toISOString();
      const item={id:'STI-'+Date.now(),docNo:String(payload.docNo||('IN-'+Date.now())),supplier:String(payload.supplier||'Supplier Utama'),date:now.slice(0,10),productId,variantId,qty,note:String(payload.note||''),userId:req.user.id,createdAt:now};
      state.stockIns.unshift(item);
      addStockMutation(state,{type:'MASUK',productId,variantId,qty,before:inv.physicalStock-qty,after:inv.physicalStock,referenceId:item.id,referenceNo:item.docNo,userId:req.user.id,note:item.note});
      addInventoryActivity(state,req,'BARANG_MASUK',`Barang masuk ${product.name} - ${variant.name}: ${qty} ${product.unit}.`,{referenceId:item.id});
      return {transaction:item,inventory:inv};
    });
    res.status(201).json({success:true,message:'Barang masuk berhasil disimpan dan stok diperbarui.',data:result,version});
  } catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal mencatat barang masuk.'});}
});

app.post('/api/inventory/out', auth, requirePermission('inventory.in_out'), async (req,res) => {
  try {
    const payload=req.body||{};
    const {result,version}=await mutateState((state)=>{
      const productId=String(payload.productId||''),variantId=String(payload.variantId||''),qty=Number(payload.qty||0);
      if(!productId||!variantId||!Number.isFinite(qty)||qty<=0) throw Object.assign(new Error('Produk, varian, dan jumlah barang keluar wajib valid.'),{status:400});
      const {product,variant}=requireProductVariant(state,productId,variantId);
      const locationId=getActiveLocationId(req,state); if(!userAllowedLocation(state,req,locationId)) throw Object.assign(new Error('Anda tidak memiliki akses ke gudang ini.'),{status:403}); const inv=makeInventoryRecord(state,productId,variantId,locationId);
      const available=Math.max(0,inv.physicalStock-inv.bookedStock);
      if(qty>available) throw Object.assign(new Error(`Stok tersedia tidak mencukupi. Tersedia ${available} ${product.unit}.`),{status:409});
      const before=inv.physicalStock; inv.physicalStock-=qty;
      state.stockOuts=state.stockOuts||[]; const now=new Date().toISOString();
      const item={id:'STO-'+Date.now(),docNo:String(payload.docNo||('OUT-'+Date.now())),destination:String(payload.destination||'Tujuan Khusus'),reason:String(payload.reason||'Pengeluaran Khusus'),date:now.slice(0,10),productId,variantId,qty,note:String(payload.note||''),userId:req.user.id,locationId,createdAt:now};
      state.stockOuts.unshift(item);
      addStockMutation(state,{type:'KELUAR',productId,variantId,qty,before,after:inv.physicalStock,referenceId:item.id,referenceNo:item.docNo,userId:req.user.id,note:item.note});
      addInventoryActivity(state,req,'BARANG_KELUAR',`Barang keluar ${product.name} - ${variant.name}: ${qty} ${product.unit}.`,{referenceId:item.id});
      return {transaction:item,inventory:inv};
    });
    res.json({success:true,message:'Barang keluar berhasil disimpan dan stok diperbarui.',data:result,version});
  } catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal mencatat barang keluar.'});}
});

app.post('/api/inventory/qc', auth, requirePermission('inventory.qc'), async (req,res) => {
  try {
    const payload=req.body||{};
    const {result,version}=await mutateState((state)=>{
      const productId=String(payload.productId||''),variantId=String(payload.variantId||''),passQty=Number(payload.passQty||0),defectQty=Number(payload.defectQty||0);
      if(!productId||!variantId||passQty<0||defectQty<0||(passQty+defectQty)<=0) throw Object.assign(new Error('Data QC tidak valid.'),{status:400});
      const {product,variant}=requireProductVariant(state,productId,variantId); const locationId=getActiveLocationId(req,state); if(!userAllowedLocation(state,req,locationId)) throw Object.assign(new Error('Anda tidak memiliki akses ke gudang ini.'),{status:403}); const inv=makeInventoryRecord(state,productId,variantId,locationId);
      if(passQty+defectQty>inv.physicalStock) throw Object.assign(new Error('Jumlah QC melebihi stok fisik.'),{status:409});
      inv.processStock += passQty; inv.damagedStock += defectQty;
      if(defectQty){ state.damagedGoods=state.damagedGoods||[]; state.damagedGoods.unshift({id:'DMG-'+Date.now(),productId,variantId,qty:defectQty,reason:String(payload.note||'Hasil pemeriksaan QC'),status:'Tercatat',date:new Date().toISOString().slice(0,10),userId:req.user.id,createdAt:new Date().toISOString()}); }
      addInventoryActivity(state,req,'QC_STOK',`QC ${product.name} - ${variant.name}: lolos ${passQty}, cacat ${defectQty}.`);
      return inv;
    });
    res.json({success:true,message:'Hasil QC berhasil disimpan.',data:result,version});
  } catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal menyimpan hasil QC.'});}
});

app.post('/api/inventory/defect', auth, requirePermission('inventory.qc'), async (req,res) => {
  try {
    const payload=req.body||{};
    const {result,version}=await mutateState((state)=>{
      const productId=String(payload.productId||''),variantId=String(payload.variantId||''),qty=Number(payload.qty||0);
      if(!productId||!variantId||qty<=0) throw Object.assign(new Error('Data barang cacat tidak valid.'),{status:400});
      const {product,variant}=requireProductVariant(state,productId,variantId); const locationId=getActiveLocationId(req,state); if(!userAllowedLocation(state,req,locationId)) throw Object.assign(new Error('Anda tidak memiliki akses ke gudang ini.'),{status:403}); const inv=makeInventoryRecord(state,productId,variantId,locationId);
      const available=Math.max(0,inv.physicalStock-inv.bookedStock);
      if(qty>available) throw Object.assign(new Error('Stok tersedia tidak mencukupi untuk ditandai cacat.'),{status:409});
      inv.physicalStock-=qty; inv.damagedStock+=qty; state.damagedGoods=state.damagedGoods||[];
      const item={id:'DMG-'+Date.now(),productId,variantId,qty,reason:String(payload.reason||payload.note||'Barang cacat'),status:'Tercatat',date:new Date().toISOString().slice(0,10),userId:req.user.id,createdAt:new Date().toISOString()};
      state.damagedGoods.unshift(item); addStockMutation(state,{type:'CACAT',productId,variantId,qty,before:available,after:inv.physicalStock,referenceId:item.id,userId:req.user.id,note:item.reason}); addInventoryActivity(state,req,'BARANG_CACAT',`Barang cacat ${product.name} - ${variant.name}: ${qty} ${product.unit}.`);
      return {transaction:item,inventory:inv};
    });
    res.status(201).json({success:true,message:'Barang cacat berhasil dicatat.',data:result,version});
  } catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal mencatat barang cacat.'});}
});

app.post('/api/inventory/return', auth, requirePermission('inventory.qc'), async (req,res) => {
  try {
    const payload=req.body||{};
    const {result,version}=await mutateState((state)=>{
      const productId=String(payload.productId||''),variantId=String(payload.variantId||''),qty=Number(payload.qty||0);
      if(!productId||!variantId||qty<=0) throw Object.assign(new Error('Data retur tidak valid.'),{status:400});
      const {product,variant}=requireProductVariant(state,productId,variantId); const locationId=getActiveLocationId(req,state); if(!userAllowedLocation(state,req,locationId)) throw Object.assign(new Error('Anda tidak memiliki akses ke gudang ini.'),{status:403}); const inv=makeInventoryRecord(state,productId,variantId,locationId);
      state.returnedGoods=state.returnedGoods||[]; const now=new Date().toISOString();
      const item={id:'RET-'+Date.now(),productId,variantId,qty,source:String(payload.source||'Pelanggan'),reason:String(payload.reason||'Retur'),status:String(payload.status||'Menunggu Pemeriksaan'),note:String(payload.note||''),date:now.slice(0,10),userId:req.user.id,locationId,createdAt:now};
      state.returnedGoods.unshift(item); addInventoryActivity(state,req,'BARANG_RETUR',`Retur ${product.name} - ${variant.name}: ${qty} ${product.unit}.`,{referenceId:item.id});
      return {transaction:item,inventory:inv};
    });
    res.status(201).json({success:true,message:'Barang retur berhasil dicatat.',data:result,version});
  } catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal mencatat retur.'});}
});


// Tahap 5: CRUD langsung modul pekerjaan dan upah pekerja.
function calculateWorkerBalance(state, workerId) {
  const earned=(state.workReports||[]).filter(r=>r.workerId===workerId).reduce((a,r)=>a+Number(r.totalWage||0),0);
  const reserved=(state.payoutRequests||[]).filter(p=>p.workerId===workerId && ['Menunggu Persetujuan','Disetujui'].includes(p.status)).reduce((a,p)=>a+Number(p.amount||0),0);
  const paid=(state.payoutRequests||[]).filter(p=>p.workerId===workerId && p.status==='Sudah Dibayar').reduce((a,p)=>a+Number(p.amount||0),0);
  return {earned,reserved,paid,available:Math.max(0,earned-reserved-paid)};
}
app.get('/api/work-types', auth, requireAnyPermission('work.reports','wages.manage'), async (req,res)=>{try{const {state}=await getState(pool);res.json({success:true,data:state.workTypes||[]});}catch(e){res.status(500).json({success:false,message:'Gagal memuat jenis pekerjaan.'});}});
app.post('/api/work-types', auth, requirePermission('wages.manage'), async (req,res)=>{try{const name=String(req.body?.name||'').trim(),rate=Number(req.body?.rate||req.body?.defaultRate||0),description=String(req.body?.description||'').trim();if(!name||rate<=0)return res.status(400).json({success:false,message:'Nama pekerjaan dan tarif wajib diisi.'});const {result,version}=await mutateState((state)=>{state.workTypes=state.workTypes||[];if(state.workTypes.some(x=>String(x.name).toLowerCase()===name.toLowerCase()))throw Object.assign(new Error('Jenis pekerjaan sudah ada.'),{status:409});const now=new Date().toISOString();const item={id:'WRK-'+Date.now(),name,defaultRate:rate,description,createdAt:now,updatedAt:now};state.workTypes.push(item);state.activityLogs=state.activityLogs||[];state.activityLogs.unshift({id:'ACT-'+Date.now(),type:'TAMBAH_JENIS_PEKERJAAN',description:`Menambahkan ${name} dengan tarif ${rate}`,userId:req.user.id,createdAt:now});return item;});res.status(201).json({success:true,message:'Jenis pekerjaan berhasil ditambahkan.',data:result,version});}catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal menambah jenis pekerjaan.'});}});
app.put('/api/work-types/:id', auth, requirePermission('wages.manage'), async (req,res)=>{try{const name=String(req.body?.name||'').trim(),rate=Number(req.body?.rate||req.body?.defaultRate||0),description=String(req.body?.description||'').trim();if(!name||rate<=0)return res.status(400).json({success:false,message:'Nama pekerjaan dan tarif wajib diisi.'});const {result,version}=await mutateState((state)=>{state.workTypes=state.workTypes||[];const item=state.workTypes.find(x=>x.id===req.params.id);if(!item)throw Object.assign(new Error('Jenis pekerjaan tidak ditemukan.'),{status:404});Object.assign(item,{name,defaultRate:rate,description,updatedAt:new Date().toISOString()});return item;});res.json({success:true,message:'Jenis pekerjaan berhasil diperbarui.',data:result,version});}catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal memperbarui jenis pekerjaan.'});}});
app.delete('/api/work-types/:id', auth, requirePermission('wages.manage'), async (req,res)=>{try{const {result,version}=await mutateState((state)=>{state.workTypes=state.workTypes||[];const item=state.workTypes.find(x=>x.id===req.params.id);if(!item)throw Object.assign(new Error('Jenis pekerjaan tidak ditemukan.'),{status:404});state.workTypes=state.workTypes.filter(x=>x.id!==item.id);return item;});res.json({success:true,message:'Jenis pekerjaan berhasil dihapus.',data:result,version});}catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal menghapus jenis pekerjaan.'});}});
app.get('/api/work-reports', auth, async (req,res)=>{try{const {state}=await getState(pool);const activeLocation=getActiveLocationId(req,state);let data=(state.workReports||[]).filter(x=>activeLocation==='ALL'||String(x.locationId||'GUD-01')===activeLocation);if(req.user.role==='gudang')data=data.filter(x=>x.workerId===req.user.id);res.json({success:true,data});}catch(e){res.status(500).json({success:false,message:'Gagal memuat laporan pekerjaan.'});}});
app.post('/api/work-reports', auth, requirePermission('work.reports'), async (req,res)=>{try{const p=req.body||{};const {result,version}=await mutateState((state)=>{const wt=(state.workTypes||[]).find(x=>x.id===String(p.workTypeId||''));const product=(state.products||[]).find(x=>x.id===String(p.productId||''));const variant=(product?.variants||[]).find(x=>x.id===String(p.variantId||''));const qty=Number(p.qty||0);if(!wt||!product||!variant||qty<=0)throw Object.assign(new Error('Data laporan pekerjaan tidak lengkap.'),{status:400});const rate=Number(wt.defaultRate||wt.ratePerUnit||0);if(rate<=0)throw Object.assign(new Error('Tarif pekerjaan belum ditentukan.'),{status:409});state.workReports=state.workReports||[];const now=new Date().toISOString();const locationId=getActiveLocationId(req,state); if(!userAllowedLocation(state,req,locationId))throw Object.assign(new Error('Anda tidak memiliki akses ke gudang ini.'),{status:403});const item={id:'RPT-'+Date.now(),locationId,workerId:req.user.id,workerName:String(p.workerName||req.user.username),workTypeId:wt.id,workTypeName:wt.name,productId:product.id,productName:product.name,variantId:variant.id,variantName:variant.name,qty,condition:String(p.condition||'Lolos'),note:String(p.note||''),ratePerUnit:rate,totalWage:rate*qty,createdAt:now};state.workReports.unshift(item);return item;});res.status(201).json({success:true,message:'Laporan pekerjaan berhasil disimpan.',data:result,version});}catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal menyimpan laporan pekerjaan.'});}});
app.get('/api/wages/me', auth, requireAnyPermission('work.reports','wages.manage'), async (req,res)=>{try{const {state}=await getState(pool);const activeLocation=getActiveLocationId(req,state);const scoped={...state,workReports:(state.workReports||[]).filter(x=>activeLocation==='ALL'||String(x.locationId||'GUD-01')===activeLocation),payoutRequests:(state.payoutRequests||[]).filter(x=>activeLocation==='ALL'||String(x.locationId||'GUD-01')===activeLocation)};res.json({success:true,data:calculateWorkerBalance(scoped,req.user.id)});}catch(e){res.status(500).json({success:false,message:'Gagal memuat saldo upah.'});}});
app.get('/api/wage-withdrawals', auth, requireAnyPermission('work.reports','wages.manage'), async (req,res)=>{try{const {state}=await getState(pool);const activeLocation=getActiveLocationId(req,state);let data=(state.payoutRequests||[]).filter(x=>activeLocation==='ALL'||String(x.locationId||'GUD-01')===activeLocation);if(req.user.role==='gudang')data=data.filter(x=>x.workerId===req.user.id);res.json({success:true,data});}catch(e){res.status(500).json({success:false,message:'Gagal memuat pengajuan pencairan.'});}});
app.post('/api/wage-withdrawals', auth, requireAnyPermission('work.reports','wages.manage'), async (req,res)=>{try{const p=req.body||{};const {result,version}=await mutateState((state)=>{const amount=Number(p.amount||0);if(amount<=0||!p.paymentMethod||!p.accountNo)throw Object.assign(new Error('Data pencairan tidak lengkap.'),{status:400});const locationId=getActiveLocationId(req,state);if(!userAllowedLocation(state,req,locationId))throw Object.assign(new Error('Anda tidak memiliki akses ke gudang ini.'),{status:403});const scoped={...state,workReports:(state.workReports||[]).filter(x=>String(x.locationId||'GUD-01')===locationId),payoutRequests:(state.payoutRequests||[]).filter(x=>String(x.locationId||'GUD-01')===locationId)};const bal=calculateWorkerBalance(scoped,req.user.id);if(amount>bal.available)throw Object.assign(new Error(`Nominal melebihi saldo tersedia (${bal.available}).`),{status:409});state.payoutRequests=state.payoutRequests||[];const now=new Date().toISOString();const item={id:'PAY-'+Date.now(),locationId,workerId:req.user.id,workerName:String(p.workerName||req.user.username),amount,paymentMethod:String(p.paymentMethod),accountNo:String(p.accountNo),note:String(p.note||''),status:'Menunggu Persetujuan',createdAt:now};state.payoutRequests.unshift(item);return item;});res.status(201).json({success:true,message:'Pengajuan pencairan berhasil dikirim.',data:result,version});}catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal mengajukan pencairan.'});}});
async function updateWithdrawal(req,res,status){try{const {result,version}=await mutateState((state)=>{state.payoutRequests=state.payoutRequests||[];const item=state.payoutRequests.find(x=>x.id===req.params.id);if(!item)throw Object.assign(new Error('Pengajuan tidak ditemukan.'),{status:404});if(status==='Disetujui'&&item.status!=='Menunggu Persetujuan')throw Object.assign(new Error('Status pengajuan tidak dapat disetujui.'),{status:409});if(status==='Ditolak'&&item.status!=='Menunggu Persetujuan')throw Object.assign(new Error('Status pengajuan tidak dapat ditolak.'),{status:409});if(status==='Sudah Dibayar'&&item.status!=='Disetujui')throw Object.assign(new Error('Pengajuan harus disetujui terlebih dahulu.'),{status:409});item.status=status;if(status==='Disetujui')item.approvedBy=req.user.username;if(status==='Sudah Dibayar')item.paidAt=new Date().toISOString();if(status==='Ditolak')item.rejectedBy=req.user.username;return item;});res.json({success:true,message:`Pengajuan berhasil ${status.toLowerCase()}.`,data:result,version});}catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal memperbarui pengajuan.'});}}
app.patch('/api/wage-withdrawals/:id/approve', auth, requireRole('admin'), (req,res)=>updateWithdrawal(req,res,'Disetujui'));
app.patch('/api/wage-withdrawals/:id/reject', auth, requireRole('admin'), (req,res)=>updateWithdrawal(req,res,'Ditolak'));
app.patch('/api/wage-withdrawals/:id/paid', auth, requireRole('admin'), (req,res)=>updateWithdrawal(req,res,'Sudah Dibayar'));



// Booking seller: seluruh perubahan booking dilakukan atomik di PostgreSQL.
app.get('/api/bookings', auth, async (req,res)=>{
  try { const {state}=await getState(pool); let data=state.sellerBookings||[]; if(req.user.role==='seller') data=data.filter(x=>x.sellerId===req.user.id); res.json({success:true,data}); }
  catch(e){res.status(500).json({success:false,message:'Gagal memuat booking stok.'});}
});
app.post('/api/bookings', auth, requirePermission('seller.booking'), async (req,res)=>{
  try{
    const p=req.body||{}, productId=String(p.productId||''), variantId=String(p.variantId||''), qty=Number(p.qty||0);
    if(!productId||!variantId||qty<=0)return res.status(400).json({success:false,message:'Produk, varian, dan jumlah booking wajib diisi.'});
    const {result,version}=await mutateState((state)=>{
      const product=(state.products||[]).find(x=>x.id===productId); const variant=(product?.variants||[]).find(x=>x.id===variantId);
      if(!product||!variant)throw Object.assign(new Error('Produk atau varian tidak ditemukan.'),{status:404});
      const locationId=getActiveLocationId(req,state); if(!userAllowedLocation(state,req,locationId))throw Object.assign(new Error('Anda tidak memiliki akses ke gudang ini.'),{status:403}); state.inventory=state.inventory||[]; let inv=state.inventory.find(x=>x.productId===productId&&x.variantId===variantId&&(x.locationId||'GUD-01')===locationId);
      if(!inv){inv={id:'INV-'+Date.now()+'-'+Math.floor(Math.random()*10000),productId,variantId,locationId,physicalStock:0,bookedStock:0,processStock:0,soldStock:0,damagedStock:0};state.inventory.push(inv)}
      const available=Math.max(0,Number(inv.physicalStock||0)-Number(inv.bookedStock||0)); if(qty>available)throw Object.assign(new Error(`Stok tersedia hanya ${available} unit.`),{status:409});
      const now=new Date(), expiryDays=Number(state.settings?.bookingExpiryDays||3), expires=new Date(now.getTime()+expiryDays*86400000);
      const booking={locationId,id:'BKG-'+Date.now()+'-'+Math.random().toString(36).slice(2,6),bookingNo:'BKG-'+now.getTime(),sellerId:req.user.id,sellerName:req.user.name,productId,productName:product.name,variantId,variantName:variant.name,qty,date:now.toISOString().slice(0,10),createdAt:now.toISOString(),expiresAt:expires.toISOString(),status:'Menunggu Persetujuan',note:String(p.note||'')};
      inv.bookedStock=Number(inv.bookedStock||0)+qty; state.sellerBookings=state.sellerBookings||[]; state.sellerBookings.unshift(booking); return booking;
    });
    res.status(201).json({success:true,message:'Booking berhasil dibuat dan menunggu persetujuan Admin.',data:result,version});
  }catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal membuat booking.'});}
});
app.patch('/api/bookings/:id/cancel', auth, requirePermission('seller.booking'), async (req,res)=>{
  try{const {result,version}=await mutateState((state)=>{const b=(state.sellerBookings||[]).find(x=>x.id===req.params.id);if(!b)throw Object.assign(new Error('Booking tidak ditemukan.'),{status:404});if(b.sellerId!==req.user.id)throw Object.assign(new Error('Anda hanya dapat membatalkan booking milik sendiri.'),{status:403});if(!['Menunggu Persetujuan','Aktif'].includes(b.status))throw Object.assign(new Error('Booking ini sudah tidak dapat dibatalkan.'),{status:409});const inv=(state.inventory||[]).find(x=>x.productId===b.productId&&x.variantId===b.variantId&&(x.locationId||'GUD-01')===(b.locationId||'GUD-01'));if(inv)inv.bookedStock=Math.max(0,Number(inv.bookedStock||0)-Number(b.qty||0));b.status='Dibatalkan';b.cancelledBy=req.user.username;b.cancelledAt=new Date().toISOString();return b;});res.json({success:true,message:'Booking berhasil dibatalkan dan stok reservasi dilepas.',data:result,version});}catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal membatalkan booking.'});}
});
app.patch('/api/bookings/:id/approve', auth, requireRole('admin'), async (req,res)=>{
  try{const {result,version}=await mutateState((state)=>{const b=(state.sellerBookings||[]).find(x=>x.id===req.params.id);if(!b)throw Object.assign(new Error('Booking tidak ditemukan.'),{status:404});if(b.status!=='Menunggu Persetujuan')throw Object.assign(new Error('Booking tidak lagi menunggu persetujuan.'),{status:409});b.status='Aktif';b.approvedBy=req.user.username;b.approvedAt=new Date().toISOString();return b;});res.json({success:true,message:'Booking seller disetujui.',data:result,version});}catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal menyetujui booking.'});}
});
app.patch('/api/bookings/:id/reject', auth, requireRole('admin'), async (req,res)=>{
  try{const {result,version}=await mutateState((state)=>{const b=(state.sellerBookings||[]).find(x=>x.id===req.params.id);if(!b)throw Object.assign(new Error('Booking tidak ditemukan.'),{status:404});if(!['Menunggu Persetujuan','Aktif'].includes(b.status))throw Object.assign(new Error('Booking sudah tidak dapat dibatalkan.'),{status:409});const inv=(state.inventory||[]).find(x=>x.productId===b.productId&&x.variantId===b.variantId&&(x.locationId||'GUD-01')===(b.locationId||'GUD-01'));if(inv)inv.bookedStock=Math.max(0,Number(inv.bookedStock||0)-Number(b.qty||0));b.status='Dibatalkan';b.rejectedBy=req.user.username;b.rejectedAt=new Date().toISOString();return b;});res.json({success:true,message:'Booking dibatalkan dan stok reservasi dilepas.',data:result,version});}catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal membatalkan booking.'});}
});

// Tahap 6: Scan resi dan closing penjualan langsung ke backend.
app.get('/api/sales-closings', auth, async (req,res)=>{
  try {
    const {state}=await getState(pool);
    let data=state.salesClosings||[];
    if(req.user.role==='seller') data=data.filter(x=>x.sellerId===req.user.id);
    res.json({success:true,data});
  } catch(e){ res.status(500).json({success:false,message:'Gagal memuat data closing penjualan.'}); }
});

app.post('/api/resi/scan', auth, requirePermission('sales.closing'), async (req,res)=>{
  try {
    const resiNo=String(req.body?.resiNo||'').trim();
    const bookingId=String(req.body?.bookingId||'').trim();
    if(!resiNo) return res.status(400).json({success:false,message:'Nomor resi wajib diisi atau dipindai.'});
    const {result,version}=await mutateState((state)=>{
      state.scannedResi=state.scannedResi||[];
      const booking=bookingId ? (state.sellerBookings||[]).find(b=>b.id===bookingId && ['Aktif','Selesai'].includes(b.status)) : null;
      if(bookingId && !booking) throw Object.assign(new Error('Booking tidak ditemukan atau sudah tidak aktif.'),{status:404});
      const now=new Date().toISOString();
      let item=state.scannedResi.find(x=>String(x.resiNo).toLowerCase()===resiNo.toLowerCase());
      if(!item){
        item={id:'SCN-'+Date.now(),resiNo,scannedAt:now,scannedBy:req.user.username,scannedByUserId:req.user.id,status:'Dipindai'};
        state.scannedResi.unshift(item);
      }
      if(booking){
        item.bookingId=booking.id;
        item.bookingNo=booking.bookingNo;
        item.sellerId=booking.sellerId;
        item.sellerName=booking.sellerName;
        item.storeName=booking.storeName||booking.sellerName;
        item.productId=booking.productId;
        item.productName=booking.productName;
        item.variantId=booking.variantId;
        item.variantName=booking.variantName;
        item.qty=Number(booking.qty||0);
        item.unit=String((state.products||[]).find(p=>p.id===booking.productId)?.unit||'Unit');
        item.note=booking.note||'';
        item.linkedAt=now;
      }
      addInventoryActivity(state,req,'SCAN_RESI',booking ? `Resi ${resiNo} dipindai dan dicatat: ${item.storeName} — ${item.productName} (${item.variantName}) ${item.qty} ${item.unit}.` : `Nomor resi ${resiNo} dipindai.`);
      return item;
    });
    res.status(201).json({success:true,message:'Resi berhasil dipindai dan data pengiriman dicatat.',data:result,version});
  } catch(e){ res.status(e.status||500).json({success:false,message:e.message||'Gagal menyimpan hasil scan resi.'}); }
});

app.post('/api/sales-closings', auth, requirePermission('sales.closing'), async (req,res)=>{
  try {
    const payload=req.body||{};
    const resiNo=String(payload.resiNo||'').trim();
    const bookingId=String(payload.bookingId||'').trim();
    if(!resiNo||!bookingId) return res.status(400).json({success:false,message:'Nomor resi dan booking aktif wajib dipilih.'});
    const {result,version}=await mutateState((state)=>{
      state.salesClosings=state.salesClosings||[];
      if(state.salesClosings.some(c=>String(c.resiNo).toLowerCase()===resiNo.toLowerCase())) throw Object.assign(new Error('Nomor resi ini sudah pernah di-closing.'),{status:409});
      state.sellerBookings=state.sellerBookings||[];
      const booking=state.sellerBookings.find(b=>b.id===bookingId && b.status==='Aktif');
      if(!booking) throw Object.assign(new Error('Booking aktif tidak ditemukan atau sudah tidak dapat di-closing.'),{status:404});
      const {product,variant}=requireProductVariant(state,String(booking.productId),String(booking.variantId));
      const qty=Number(booking.qty||0);
      if(qty<=0) throw Object.assign(new Error('Jumlah booking tidak valid.'),{status:400});
      const locationId=booking.locationId||getActiveLocationId(req,state); if(!userAllowedLocation(state,req,locationId)) throw Object.assign(new Error('Anda tidak memiliki akses ke gudang ini.'),{status:403}); const inv=makeInventoryRecord(state,booking.productId,booking.variantId,locationId);
      if(inv.bookedStock<qty) throw Object.assign(new Error('Data stok booking tidak konsisten. Closing dibatalkan demi keamanan.'),{status:409});
      if(inv.physicalStock<qty) throw Object.assign(new Error('Stok fisik tidak mencukupi untuk closing.'),{status:409});
      const now=new Date().toISOString();
      const transactionNo='TRX-'+now.slice(0,10).replace(/-/g,'')+'-'+String(Date.now()).slice(-6);
      const before=inv.physicalStock;
      inv.physicalStock-=qty;
      inv.bookedStock-=qty;
      inv.soldStock=Number(inv.soldStock||0)+qty;
      booking.status='Selesai'; booking.closedAt=now; booking.closedBy=req.user.username;
      state.scannedResi=state.scannedResi||[];
      let scan=state.scannedResi.find(x=>String(x.resiNo).toLowerCase()===resiNo.toLowerCase());
      if(!scan){ scan={id:'SCN-'+Date.now(),locationId:booking?.locationId||getActiveLocationId(req,state),resiNo,scannedAt:now,scannedBy:req.user.username,scannedByUserId:req.user.id,status:'Dipindai'}; state.scannedResi.unshift(scan); }
      Object.assign(scan,{bookingId:booking.id,bookingNo:booking.bookingNo,sellerId:booking.sellerId,sellerName:booking.sellerName,storeName:booking.storeName||booking.sellerName,productId:product.id,productName:product.name,variantId:variant.id,variantName:variant.name,qty,unit:product.unit||'Unit',status:'Digunakan Closing',usedAt:now});
      const closing={id:'CLS-'+Date.now(),locationId,transactionNo,resiNo,sellerId:booking.sellerId,sellerName:booking.sellerName,storeName:booking.storeName||booking.sellerName,bookingId:booking.id,bookingNo:booking.bookingNo,productId:booking.productId,productName:product.name,variantId:booking.variantId,variantName:variant.name,qty,unit:product.unit||'Unit',closingDate:now.slice(0,10),closedByUserId:req.user.id,closedBy:req.user.username,createdAt:now};
      state.salesClosings.unshift(closing);
      addStockMutation(state,{type:'TERJUAL',productId:booking.productId,variantId:booking.variantId,qty,before,after:inv.physicalStock,referenceId:closing.id,referenceNo:transactionNo,userId:req.user.id,note:`Closing penjualan resi ${resiNo}`});
      addInventoryActivity(state,req,'CLOSING_PENJUALAN',`Closing ${transactionNo}: ${product.name} - ${variant.name}, ${qty} ${product.unit}, resi ${resiNo}.`,{referenceId:closing.id});
      return {closing,inventory:inv};
    });
    res.status(201).json({success:true,message:'Closing penjualan berhasil disimpan dan stok diperbarui.',data:result,version});
  } catch(e){ res.status(e.status||500).json({success:false,message:e.message||'Gagal melakukan closing penjualan.'}); }
});

// MULTI-GUDANG: satu akun dapat berpindah gudang aktif tanpa logout.
app.get('/api/locations', auth, async (req,res)=>{ try { const {state}=await getState(pool); let locations=Array.isArray(state.locations)?state.locations:[]; const map=state.userLocations||{}; if(req.user.role!=='admin' && Array.isArray(map[req.user.id]) && map[req.user.id].length) locations=locations.filter(x=>map[req.user.id].includes(x.id)); res.json({success:true,data:locations.filter(x=>x.status!=='inactive'),activeLocationId:getActiveLocationId(req,state)}); } catch(e){res.status(500).json({success:false,message:'Gagal memuat lokasi gudang.'});} });
app.post('/api/locations', auth, requireRole('admin'), async (req,res)=>{ try { const name=String(req.body?.name||'').trim(), code=String(req.body?.code||'').trim().toUpperCase(); if(!name||!code)return res.status(400).json({success:false,message:'Kode dan nama gudang wajib diisi.'}); const {result,version}=await mutateState(state=>{state.locations=state.locations||[]; if(state.locations.some(x=>x.id===code||String(x.name).toLowerCase()===name.toLowerCase()))throw Object.assign(new Error('Kode atau nama gudang sudah digunakan.'),{status:409}); const item={id:code,name,address:String(req.body?.address||''),manager:String(req.body?.manager||''),status:'active',isDefault:state.locations.length===0,createdAt:new Date().toISOString()}; state.locations.push(item); return item;}); res.status(201).json({success:true,message:'Gudang berhasil ditambahkan.',data:result,version}); }catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal menambah gudang.'});} });

// TRANSFER ANTAR GUDANG
app.get('/api/transfers', auth, async (req,res)=>{ try { const {state,version}=await getState(pool); let rows=Array.isArray(state.transfers)?state.transfers:[]; const map=state.userLocations||{}; if(req.user.role!=='admin' && Array.isArray(map[req.user.id]) && map[req.user.id].length){ rows=rows.filter(x=>map[req.user.id].includes(x.fromLocationId)||map[req.user.id].includes(x.toLocationId)); } res.json({success:true,data:rows,version}); }catch(e){res.status(500).json({success:false,message:'Gagal mengambil transfer antar gudang.'});} });
app.post('/api/transfers', auth, requireRole('admin'), async (req,res)=>{ try { const p=req.body||{}; const from=String(p.fromLocationId||'').trim(), to=String(p.toLocationId||'').trim(), productId=String(p.productId||'').trim(), variantId=String(p.variantId||'').trim(), qty=Number(p.qty||0); if(!from||!to||from===to||!productId||!variantId||!Number.isFinite(qty)||qty<=0) return res.status(400).json({success:false,message:'Gudang asal, tujuan, produk, varian, dan jumlah wajib valid.'}); const {result,version}=await mutateState(state=>{ state.locations=state.locations||[]; if(!state.locations.some(l=>l.id===from&&l.status!=='inactive')||!state.locations.some(l=>l.id===to&&l.status!=='inactive')) throw Object.assign(new Error('Gudang asal/tujuan tidak ditemukan.'),{status:404}); const {product,variant}=requireProductVariant(state,productId,variantId); const inv=makeInventoryRecord(state,productId,variantId,from); const available=Math.max(0,Number(inv.physicalStock||0)-Number(inv.bookedStock||0)-Number(inv.processStock||0)); if(qty>available) throw Object.assign(new Error(`Stok tersedia di gudang asal hanya ${available} ${product.unit||'Unit'}.`),{status:409}); state.transfers=state.transfers||[]; const now=new Date().toISOString(); const item={id:'TRF-'+Date.now()+'-'+Math.random().toString(36).slice(2,6),transferNo:'TRF-'+now.slice(0,10).replace(/-/g,'')+'-'+String(Date.now()).slice(-5),fromLocationId:from,toLocationId:to,productId,productName:product.name,variantId,variantName:variant.name,qty,unit:product.unit||'Unit',status:'Diajukan',note:String(p.note||''),requestedBy:req.user.id,requestedByName:req.user.name||req.user.username,createdAt:now}; state.transfers.unshift(item); return item;}); res.status(201).json({success:true,message:'Transfer stok berhasil diajukan.',data:result,version}); }catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal membuat transfer.'});} });
app.patch('/api/transfers/:id/ship', auth, requireRole('admin'), async (req,res)=>{ try { const {result,version}=await mutateState(state=>{ const t=(state.transfers||[]).find(x=>x.id===req.params.id); if(!t)throw Object.assign(new Error('Transfer tidak ditemukan.'),{status:404}); if(t.status!=='Diajukan')throw Object.assign(new Error('Transfer hanya dapat dikirim dari status Diajukan.'),{status:409}); const inv=makeInventoryRecord(state,t.productId,t.variantId,t.fromLocationId); const available=Math.max(0,Number(inv.physicalStock||0)-Number(inv.bookedStock||0)-Number(inv.processStock||0)); if(Number(t.qty)>available)throw Object.assign(new Error(`Stok gudang asal tidak mencukupi. Tersedia ${available} ${t.unit||'Unit'}.`),{status:409}); inv.physicalStock-=Number(t.qty); inv.processStock=Number(inv.processStock||0)+Number(t.qty); t.status='Dikirim'; t.shippedAt=new Date().toISOString(); t.shippedBy=req.user.id; t.shippedByName=req.user.name||req.user.username; addStockMutation(state,{type:'TRANSFER_KELUAR',locationId:t.fromLocationId,productId:t.productId,variantId:t.variantId,qty:Number(t.qty),before:Number(inv.physicalStock)+Number(t.qty),after:Number(inv.physicalStock),referenceId:t.id,referenceNo:t.transferNo,userId:req.user.id,note:`Transfer ke ${t.toLocationId}`}); return t;}); res.json({success:true,message:'Transfer ditandai Dikirim. Stok asal sudah dipindahkan ke proses pengiriman.',data:result,version}); }catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal mengirim transfer.'});} });
app.patch('/api/transfers/:id/receive', auth, requireRole('admin'), async (req,res)=>{ try { const {result,version}=await mutateState(state=>{ const t=(state.transfers||[]).find(x=>x.id===req.params.id); if(!t)throw Object.assign(new Error('Transfer tidak ditemukan.'),{status:404}); if(t.status!=='Dikirim')throw Object.assign(new Error('Transfer harus berstatus Dikirim sebelum diterima.'),{status:409}); const src=makeInventoryRecord(state,t.productId,t.variantId,t.fromLocationId); if(Number(src.processStock||0)<Number(t.qty))throw Object.assign(new Error('Stok proses pengiriman tidak mencukupi untuk diterima.'),{status:409}); src.processStock-=Number(t.qty); const dst=makeInventoryRecord(state,t.productId,t.variantId,t.toLocationId); dst.physicalStock+=Number(t.qty); t.status='Diterima'; t.receivedAt=new Date().toISOString(); t.receivedBy=req.user.id; t.receivedByName=req.user.name||req.user.username; addStockMutation(state,{type:'TRANSFER_MASUK',locationId:t.toLocationId,productId:t.productId,variantId:t.variantId,qty:Number(t.qty),before:Number(dst.physicalStock)-Number(t.qty),after:Number(dst.physicalStock),referenceId:t.id,referenceNo:t.transferNo,userId:req.user.id,note:`Transfer dari ${t.fromLocationId}`}); return t;}); res.json({success:true,message:'Transfer diterima. Stok gudang tujuan sudah bertambah.',data:result,version}); }catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal menerima transfer.'});} });
app.patch('/api/transfers/:id/cancel', auth, requireRole('admin'), async (req,res)=>{ try { const {result,version}=await mutateState(state=>{ const t=(state.transfers||[]).find(x=>x.id===req.params.id); if(!t)throw Object.assign(new Error('Transfer tidak ditemukan.'),{status:404}); if(!['Diajukan'].includes(t.status))throw Object.assign(new Error('Transfer hanya dapat dibatalkan sebelum dikirim.'),{status:409}); t.status='Dibatalkan'; t.cancelledAt=new Date().toISOString(); t.cancelledBy=req.user.id; return t;}); res.json({success:true,message:'Transfer dibatalkan.',data:result,version}); }catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal membatalkan transfer.'});} });

app.patch('/api/users/:id/locations', auth, requireRole('admin'), async (req,res)=>{ try { const ids=Array.isArray(req.body?.locationIds)?req.body.locationIds.map(String):[]; const {result,version}=await mutateState(state=>{state.locations=state.locations||[]; if(ids.some(id=>!state.locations.some(l=>l.id===id)))throw Object.assign(new Error('Ada lokasi gudang yang tidak ditemukan.'),{status:400}); state.userLocations=state.userLocations||{}; state.userLocations[req.params.id]=ids; return {userId:req.params.id,locationIds:ids};}); res.json({success:true,message:'Akses lokasi akun berhasil diperbarui.',data:result,version}); }catch(e){res.status(e.status||500).json({success:false,message:e.message||'Gagal memperbarui akses lokasi.'});} });

app.post('/api/state', auth, async (req,res)=>{
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const current=await client.query('SELECT state, version FROM app_state WHERE id=1 FOR UPDATE');
    const dbState=current.rows[0]?.state || {};
    const version=Number(current.rows[0]?.version||0);
    const rawHeader = req.headers['x-state-version'];
    const expected = (rawHeader !== undefined && rawHeader !== null && rawHeader !== '') ? Number(rawHeader) : null;

    if (expected !== null && !isNaN(expected) && expected !== version) {
      await client.query('ROLLBACK');
      return res.status(409).json({success:false, message:'Data telah berubah di perangkat lain. Silakan sinkronkan ulang.', version});
    }

    const incoming = req.body || {};

    // Safe Sync: tolak overwrite kosong atau pengurangan massal yang mencurigakan.
    const keys=['products','categories','inventory','inventoryMovements','sellerBookings','workReports','payoutRequests','scannedResi','salesClosings','damagedGoods','returnedGoods'];
    const dbHasData = keys.some(k=>collectionSize(dbState,k)>0);
    const incomingHasData = keys.some(k=>collectionSize(incoming,k)>0);
    if (dbHasData && !incomingHasData) {
      await client.query('ROLLBACK');
      return res.status(400).json({success:false,message:'Penyimpanan diblokir: perangkat mencoba mengganti data server dengan state kosong.',version});
    }
    const dropped = significantStateDrop(dbState, incoming);
    if (dropped.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({success:false,message:`Penyimpanan diblokir karena terdeteksi pengurangan data besar pada: ${dropped.join(', ')}. Data terbaru perlu dimuat ulang terlebih dahulu.`,version,collections:dropped});
    }

    await createStateSnapshot(client, dbState, version, 'STATE_SAVE', req.user?.id||null);
    await syncUsers(client, incoming.users || []);
    const {users, ...state} = incoming;
    await syncCoreFromState(client, state);
    const saved=await client.query('UPDATE app_state SET state=$1::jsonb, version=version+1, updated_at=NOW() WHERE id=1 RETURNING version',[JSON.stringify(state)]);
    await client.query('COMMIT');
    res.json({success:true, message:'Data berhasil disimpan.', version:Number(saved.rows[0].version)});
  } catch(e){
    try{await client.query('ROLLBACK')}catch{};
    console.error(e);
    res.status(500).json({success:false, message:'Gagal menyimpan data.'});
  }
  finally{client.release();}
});

app.get('/api/audit/integrity', auth, requireRole('admin'), async (req,res)=>{
  try {
    const {state}=await getState(pool);
    const issues=stateIntegrityIssues(state);
    const inventory=state.inventory||[];
    const bookingActive=(state.sellerBookings||[]).filter(x=>['Menunggu Persetujuan','Aktif'].includes(x.status));
    const totals={
      products:(state.products||[]).length,
      categories:(state.categories||[]).length,
      inventoryRecords:inventory.length,
      activeBookings:bookingActive.length,
      workReports:(state.workReports||[]).length,
      payoutRequests:(state.payoutRequests||[]).length,
      salesClosings:(state.salesClosings||[]).length
    };
    res.json({success:true,healthy:issues.length===0,issues,totals,checkedAt:new Date().toISOString()});
  } catch(e){res.status(500).json({success:false,message:'Gagal melakukan audit integritas data.'});}
});

app.get('/api/state-snapshots', auth, requireRole('admin'), async (req,res)=>{
  try { const r=await pool.query('SELECT id, source_version, reason, user_id, created_at FROM app_state_snapshots ORDER BY id DESC LIMIT 30'); res.json({success:true,data:r.rows}); }
  catch(e){res.status(500).json({success:false,message:'Gagal memuat riwayat snapshot.'});}
});
app.post('/api/state-snapshots/:id/restore', auth, requireRole('admin'), async (req,res)=>{
  const client=await pool.connect();
  try { await client.query('BEGIN'); const cur=await client.query('SELECT state,version FROM app_state WHERE id=1 FOR UPDATE'); const snap=await client.query('SELECT state FROM app_state_snapshots WHERE id=$1',[req.params.id]); if(!snap.rowCount) throw Object.assign(new Error('Snapshot tidak ditemukan.'),{status:404}); await createStateSnapshot(client,cur.rows[0]?.state||{},Number(cur.rows[0]?.version||0),'BEFORE_RESTORE',req.user?.id||null); const saved=await client.query('UPDATE app_state SET state=$1::jsonb,version=version+1,updated_at=NOW() WHERE id=1 RETURNING version',[JSON.stringify(snap.rows[0].state)]); await client.query('COMMIT'); res.json({success:true,message:'Snapshot berhasil dipulihkan.',version:Number(saved.rows[0].version)}); }
  catch(e){try{await client.query('ROLLBACK')}catch{};res.status(e.status||500).json({success:false,message:e.message||'Gagal memulihkan snapshot.'});}
  finally{client.release();}
});


app.use('/api', (req,res,next) => {
  if (req.user && !['GET','OPTIONS'].includes(req.method)) writeSecurityLog(req.user.id, `${req.method} ${req.path}`, 'API mutation', req);
  next();
});

// Public branding endpoint MUST be registered before the API 404 fallback.
app.get('/api/public/settings', async (req,res)=>{
  try {
    const r=await pool.query('SELECT state FROM app_state WHERE id=1');
    const settings=r.rows[0]?.state?.settings || {};
    res.setHeader('Cache-Control','no-store');
    res.json({success:true,data:{appName:settings.appName||'GUDANG BAT',warehouseName:settings.warehouseName||'',companyLogo:settings.companyLogo||''}});
  } catch(e){res.status(500).json({success:false,message:'Gagal memuat identitas perusahaan.'});}
});


app.get('/api/admin/core-status', auth, requireRole('admin'), async (req,res)=>{
  try {
    const q=async(sql)=>Number((await pool.query(sql)).rows[0].count||0);
    const [warehouses,users,products,variants,inventory,movements,snapshots]=await Promise.all([
      q('SELECT count(*) FROM warehouses'),q('SELECT count(*) FROM users'),q('SELECT count(*) FROM product_catalog'),q('SELECT count(*) FROM product_variants'),q('SELECT count(*) FROM inventory_core'),q('SELECT count(*) FROM stock_movements_core'),q('SELECT count(*) FROM app_state_snapshots')
    ]);
    res.json({success:true,data:{warehouses,users,products,variants,inventory,movements,snapshots,mode:'dual-layer',sourceOfTruth:'app_state',normalizedLayer:'core PostgreSQL',checkedAt:new Date().toISOString()}});
  } catch(e){res.status(500).json({success:false,message:'Gagal memeriksa fondasi database.'});}
});

app.post('/api/admin/core-sync', auth, requireRole('admin'), async (req,res)=>{
  try { const {state,version}=await getState(pool); await syncCoreFromState(pool,state); await pool.query(`INSERT INTO schema_migrations(version,name) VALUES(18,'self_hosted_core_foundation') ON CONFLICT(version) DO NOTHING`); res.json({success:true,message:'Lapisan database inti berhasil disinkronkan.',version}); }
  catch(e){res.status(500).json({success:false,message:'Gagal sinkronisasi database inti.'});}
});

app.get('/api/admin/backup', auth, requireRole('admin'), async (req,res)=>{
  try {
    const {state,version}=await getState(pool);
    const payload={format:'GUDANG-BAT-BACKUP',backupVersion:1,createdAt:new Date().toISOString(),appVersion:require('./package.json').version,stateVersion:version,state};
    const filename=`gudang-bat-backup-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);
    res.send(JSON.stringify(payload,null,2));
  } catch(e){res.status(500).json({success:false,message:'Gagal membuat backup data.'});}
});

app.use('/api',(req,res)=>res.status(404).json({success:false,message:'Endpoint API tidak ditemukan.'}));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

async function bootstrap(){
  await pool.query(`CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, username text UNIQUE NOT NULL, password_hash text NOT NULL, name text NOT NULL, role text NOT NULL, email text, phone text, status text NOT NULL DEFAULT 'active', requested_role text, permissions jsonb NOT NULL DEFAULT '[]'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_profiles (user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, name text, username text, email text, phone text, store_name text, avatar_data text, updated_at timestamptz NOT NULL DEFAULT now());`);
  try { await pool.query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS store_name text;`); } catch(e) {}
  await pool.query(`CREATE TABLE IF NOT EXISTS security_logs (id bigserial PRIMARY KEY, user_id text, action text NOT NULL, detail text, ip text, user_agent text, created_at timestamptz NOT NULL DEFAULT now());`);
  try { await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;`); } catch(e){}
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS requested_role text;`); } catch(e){}
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions jsonb NOT NULL DEFAULT '[]'::jsonb;`); } catch(e){}
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_data text NOT NULL DEFAULT '';`); } catch(e){}
  await pool.query(`CREATE TABLE IF NOT EXISTS app_state (id integer PRIMARY KEY CHECK(id=1), state jsonb NOT NULL DEFAULT '{}'::jsonb, version bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS app_state_snapshots (id bigserial PRIMARY KEY, state jsonb NOT NULL, source_version bigint NOT NULL, reason text NOT NULL, user_id text NULL, created_at timestamptz NOT NULL DEFAULT now());`);
  await ensureCoreSchema(pool);
  const exists=await pool.query('SELECT 1 FROM app_state WHERE id=1');
  if(!exists.rowCount){
    const seed=JSON.parse(fs.readFileSync(path.join(__dirname,'database','seed.json'),'utf8'));
    const seeded=Object.fromEntries(Object.entries(seed).filter(([k])=>k!=='users')); seeded.locations=[{id:'GUD-01',name:seeded.settings?.warehouseName||'Gudang Utama',address:'',manager:'',status:'active',isDefault:true,createdAt:new Date().toISOString()}]; seeded.userLocations={}; (seed.users||[]).forEach(u=>{seeded.userLocations[u.id]=['GUD-01'];}); (seeded.inventory||[]).forEach(i=>{i.locationId='GUD-01';});
    for(const key of ['stockIns','stockOuts','workReports','payoutRequests','sellerBookings','shippingResi','scannedResi','salesClosings','damagedGoods','returnedGoods','stockMutations','activityLogs']) if(Array.isArray(seeded[key])) seeded[key].forEach(x=>{if(x&&!x.locationId)x.locationId='GUD-01';});
    await pool.query('INSERT INTO app_state(id,state,version) VALUES(1,$1::jsonb,1)',[JSON.stringify(seeded)]);
    await syncUsers(pool,seed.users||[]);
    console.log('Data awal berhasil diimpor.');
  } else {
    const r=await pool.query('SELECT state FROM app_state WHERE id=1'); const st=r.rows[0]?.state||{}; let changed=false; if(!Array.isArray(st.locations)||!st.locations.length){st.locations=[{id:'GUD-01',name:st.settings?.warehouseName||'Gudang Utama',address:'',manager:'',status:'active',isDefault:true,createdAt:new Date().toISOString()}];changed=true;} if(!st.userLocations){st.userLocations={}; changed=true;} for(const key of ['inventory','stockIns','stockOuts','workReports','payoutRequests','sellerBookings','shippingResi','scannedResi','salesClosings','damagedGoods','returnedGoods','stockMutations','activityLogs']) if(Array.isArray(st[key])) st[key].forEach(x=>{if(x&&!x.locationId){x.locationId='GUD-01';changed=true;}}); if(changed) await pool.query('UPDATE app_state SET state=$1::jsonb,version=version+1,updated_at=NOW() WHERE id=1',[JSON.stringify(st)]);
  }
  const bootState=(await pool.query('SELECT state FROM app_state WHERE id=1')).rows[0]?.state || {};
  await syncCoreFromState(pool, bootState);
  await pool.query(`INSERT INTO schema_migrations(version,name) VALUES(18,'self_hosted_core_foundation') ON CONFLICT(version) DO NOTHING`);
  app.listen(PORT,'0.0.0.0',()=>console.log(`GUDANG BAT online server berjalan di port ${PORT}`));
}
bootstrap().catch(e=>{console.error('Gagal bootstrap:',e);process.exit(1)});


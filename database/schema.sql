-- GUDANG BAT — Tahap 18A
-- Fondasi database portable/self-hosted.
-- app_state tetap dipertahankan sebagai compatibility layer pada tahap ini.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS warehouses (
  id text PRIMARY KEY,
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  address text NOT NULL DEFAULT '',
  manager text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_warehouses (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, warehouse_id)
);

CREATE TABLE IF NOT EXISTS product_catalog (
  id text PRIMARY KEY,
  category_id text,
  name text NOT NULL,
  sku text UNIQUE NOT NULL,
  description text NOT NULL DEFAULT '',
  unit text NOT NULL DEFAULT 'Unit',
  warehouse_location text NOT NULL DEFAULT '',
  min_stock numeric NOT NULL DEFAULT 10,
  image_url text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_variants (
  id text PRIMARY KEY,
  product_id text NOT NULL REFERENCES product_catalog(id) ON DELETE CASCADE,
  name text NOT NULL,
  sku text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(product_id, sku)
);

CREATE TABLE IF NOT EXISTS inventory_core (
  id text PRIMARY KEY,
  warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  product_id text NOT NULL REFERENCES product_catalog(id) ON DELETE CASCADE,
  variant_id text NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  physical_stock numeric NOT NULL DEFAULT 0,
  booked_stock numeric NOT NULL DEFAULT 0,
  process_stock numeric NOT NULL DEFAULT 0,
  sold_stock numeric NOT NULL DEFAULT 0,
  damaged_stock numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(warehouse_id, product_id, variant_id)
);

CREATE TABLE IF NOT EXISTS stock_movements_core (
  id text PRIMARY KEY,
  warehouse_id text REFERENCES warehouses(id) ON DELETE SET NULL,
  type text NOT NULL,
  product_id text,
  variant_id text,
  qty numeric NOT NULL DEFAULT 0,
  before_qty numeric,
  after_qty numeric,
  reference_id text,
  reference_no text,
  user_id text,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs_core (
  id bigserial PRIMARY KEY,
  user_id text,
  action text NOT NULL,
  detail text NOT NULL DEFAULT '',
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_core_warehouse ON inventory_core(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_core_warehouse_created ON stock_movements_core(warehouse_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_warehouses_user ON user_warehouses(user_id);

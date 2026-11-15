CREATE TABLE products (
  sku TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  duration_months INTEGER NOT NULL CHECK (duration_months IN (1, 3, 12)),
  price_cny INTEGER NOT NULL CHECK (price_cny > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);
CREATE TABLE cards (
  card_hash TEXT PRIMARY KEY,
  sku TEXT NOT NULL REFERENCES products(sku),
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'redeemed', 'revoked')),
  license_id TEXT UNIQUE,
  redeemed_at INTEGER,
  order_id TEXT
);
CREATE TABLE licenses (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  expires_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  max_devices INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE devices (
  license_id TEXT NOT NULL REFERENCES licenses(id),
  public_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  activated_at INTEGER NOT NULL,
  PRIMARY KEY (license_id, public_key)
);
CREATE TABLE nonces (
  public_key TEXT NOT NULL,
  nonce TEXT NOT NULL,
  used_at INTEGER NOT NULL,
  PRIMARY KEY (public_key, nonce)
);
INSERT INTO products (sku, plugin_id, duration_months, price_cny) VALUES
  ('sales-agent-month', 'studio.sales-agent', 1, 1500),
  ('sales-agent-quarter', 'studio.sales-agent', 3, 3000),
  ('sales-agent-year', 'studio.sales-agent', 12, 10000),
  ('sim8-month', 'studio.sim8', 1, 1500),
  ('sim8-quarter', 'studio.sim8', 3, 3000),
  ('sim8-year', 'studio.sim8', 12, 10000);

-- "shop": customers, products, orders; roles with different rights
CREATE ROLE shop_app LOGIN PASSWORD 'shop-app-pw';
CREATE ROLE reporting LOGIN PASSWORD 'reporting-pw' CONNECTION LIMIT 5;
CREATE DATABASE shop OWNER shop_app;
CREATE DATABASE wiki;
\c shop
SET ROLE shop_app;
CREATE TABLE customers (id serial PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL, country char(2), created_at timestamptz DEFAULT now(), notes text);
CREATE TABLE products (id serial PRIMARY KEY, sku text UNIQUE NOT NULL, title text NOT NULL, price numeric(10,2) NOT NULL, stock int DEFAULT 0, tags text[], attrs jsonb);
CREATE TABLE orders (id bigserial PRIMARY KEY, customer_id int REFERENCES customers(id), placed_at timestamptz NOT NULL, status text NOT NULL, total numeric(12,2));
CREATE TABLE order_lines (order_id bigint REFERENCES orders(id) ON DELETE CASCADE, product_id int REFERENCES products(id), qty int NOT NULL, PRIMARY KEY (order_id, product_id));
CREATE INDEX orders_customer ON orders(customer_id);
CREATE INDEX orders_placed ON orders(placed_at);
INSERT INTO customers (email, name, country, created_at, notes)
  SELECT 'user' || i || '@example.com', 'Customer ' || i, (ARRAY['FR','DE','US','IT','ES'])[1 + i % 5], now() - (i || ' hours')::interval,
         CASE WHEN i % 7 = 0 THEN NULL WHEN i = 3 THEN 'line one' || chr(10) || 'line, "two"' ELSE 'regular' END
  FROM generate_series(1, 2500) i;
INSERT INTO products (sku, title, price, stock, tags, attrs)
  SELECT 'SKU-' || lpad(i::text, 5, '0'), 'Product ' || i, (i % 97) + 0.99, i % 40, ARRAY['tag' || (i % 3), 'all'], jsonb_build_object('color', (ARRAY['red','blue','green'])[1 + i % 3], 'weight', i % 13)
  FROM generate_series(1, 400) i;
INSERT INTO orders (customer_id, placed_at, status, total)
  SELECT 1 + i % 2500, now() - (i || ' minutes')::interval, (ARRAY['paid','shipped','cancelled','pending'])[1 + i % 4], (i % 500) + 9.5
  FROM generate_series(1, 20000) i;
INSERT INTO order_lines SELECT o, 1 + (o * 7) % 400, 1 + o % 3 FROM generate_series(1, 20000) o;
CREATE VIEW paid_orders AS SELECT * FROM orders WHERE status = 'paid';
RESET ROLE;
GRANT CONNECT ON DATABASE shop TO reporting;
GRANT USAGE ON SCHEMA public TO reporting;
GRANT SELECT ON orders, customers TO reporting;
\c wiki
CREATE SCHEMA content;
CREATE TABLE content.pages (slug text PRIMARY KEY, body text, updated timestamptz DEFAULT now());
INSERT INTO content.pages (slug, body) VALUES ('home', 'Welcome'), ('faq', 'Questions');

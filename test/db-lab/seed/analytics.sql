CREATE TABLE events (id bigserial PRIMARY KEY, kind text, at timestamptz DEFAULT now(), payload jsonb);
INSERT INTO events (kind, payload) SELECT (ARRAY['view','click','buy'])[1 + i % 3], jsonb_build_object('i', i) FROM generate_series(1, 5000) i;

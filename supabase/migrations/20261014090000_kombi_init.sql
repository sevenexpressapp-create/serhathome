-- Kombi uzaktan kontrol — ilk sema (Faz 1)
-- Plan: ai sirket/shared/memory/plan/kombi-kontrol.md §2, §6
--
-- Guvenlik modeli:
--   · Her tabloda RLS ACIK. Politika YALNIZ `authenticated` icin ve yalniz
--     cihazin SAHIBI (owner_id = auth.uid()) icin yazilmistir.
--   · `anon` rolunden public semadaki tablo yetkileri AYRICA geri alinir
--     (ikinci, bagimsiz kapi — RLS tek basina kalmasin).
--   · Cihaz (ESP32) bu tablolara HIC dokunmaz: tek kapisi `device-sync` Edge
--     Function, o da service_role ile calisir ve cihaz sirrinin SHA-256
--     ozetini dogrular. Sirrin kendisi veritabaninda DURMAZ.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Cihaz kaydi
create table if not exists public.devices (
  id            text primary key,
  owner_id      uuid not null references auth.users (id) on delete cascade,
  name          text not null default 'Kombi',
  -- Cihaz sirrinin SHA-256 ozeti (64 karakter onaltilik). Sir sizarsa yalniz
  -- ozet degistirilir; tablolar hic acilmadigi icin hasar yuzeyi dar.
  secret_sha256 text not null check (secret_sha256 ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Ayarlar (dashboard yazar, cihaz okur). Sinirlar cihazdaki clampSettings ile
-- AYNI; bozuk deger iki tarafta da reddedilsin.
create table if not exists public.device_settings (
  device_id        text primary key references public.devices (id) on delete cascade,
  target_c         numeric(4, 1) not null default 21.0 check (target_c >= 5 and target_c <= 30),
  hysteresis_c     numeric(3, 1) not null default 3.0 check (hysteresis_c >= 0.5 and hysteresis_c <= 6),
  freeze_guard_c   numeric(3, 1) not null default 6.0 check (freeze_guard_c >= 4 and freeze_guard_c <= 12),
  manual_mode      boolean not null default false,
  min_relay_hold_s integer not null default 300 check (min_relay_hold_s >= 0 and min_relay_hold_s <= 1800),
  sensor_timeout_s integer not null default 120 check (sensor_timeout_s >= 10 and sensor_timeout_s <= 3600),
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Anlik durum (cihaz yazar, dashboard okur). Tek satir/cihaz.
create table if not exists public.device_state (
  device_id       text primary key references public.devices (id) on delete cascade,
  temp_c          numeric(4, 1),
  humidity        numeric(4, 1),
  relay_on        boolean,
  sensor_ok       boolean,
  time_valid      boolean,
  rules_suspended boolean,
  target_c        numeric(4, 1),
  reason          text,
  uptime_s        integer,
  wifi_rssi       integer,
  fw_version      text,
  last_seen_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Senaryo kurallari. days_mask: bit0=Pazar ... bit6=Cumartesi (cihazla ayni).
create table if not exists public.scenario_rules (
  id         uuid primary key default gen_random_uuid(),
  device_id  text not null references public.devices (id) on delete cascade,
  enabled    boolean not null default true,
  days_mask  smallint not null check (days_mask >= 1 and days_mask <= 127),
  hour       smallint not null check (hour >= 0 and hour <= 23),
  minute     smallint not null check (minute >= 0 and minute <= 59),
  target_c   numeric(4, 1) not null check (target_c >= 5 and target_c <= 30),
  created_at timestamptz not null default now()
);
create index if not exists scenario_rules_device_idx on public.scenario_rules (device_id);

-- Plan §2: "arayuz ayni dakikaya ikinci kural girilmesine izin vermez".
-- Arayuze guvenmek yetmez — kurali veritabani uygular: ayni cihazda ayni
-- saat:dakika icin gun maskeleri CAKISAN ikinci ACIK kural yazilamaz.
-- (Hafta ici 07:30 + hafta sonu 07:30 cakismadigi icin SERBEST kalir.)
create or replace function public.reject_overlapping_rule()
  returns trigger
  language plpgsql
  security invoker
  set search_path = ''
as $$
begin
  if new.enabled and exists (
    select 1
    from public.scenario_rules r
    where r.device_id = new.device_id
      and r.id <> new.id
      and r.enabled
      and r.hour = new.hour
      and r.minute = new.minute
      and (r.days_mask & new.days_mask) <> 0
  ) then
    raise exception 'ayni dakikada cakisan gun maskesiyle ikinci kural var (%:%)', new.hour, new.minute
      using errcode = '23505';
  end if;
  return new;
end;
$$;

drop trigger if exists scenario_rules_no_overlap on public.scenario_rules;
create trigger scenario_rules_no_overlap
  before insert or update on public.scenario_rules
  for each row execute function public.reject_overlapping_rule();

-- ---------------------------------------------------------------------------
-- Telemetri gecmisi (grafik icin). Cihaz adina Edge Function yazar.
create table if not exists public.telemetry (
  id        bigserial primary key,
  device_id text not null references public.devices (id) on delete cascade,
  ts        timestamptz not null default now(),
  temp_c    numeric(4, 1),
  humidity  numeric(4, 1),
  relay_on  boolean,
  sensor_ok boolean,
  target_c  numeric(4, 1)
);
create index if not exists telemetry_device_ts_idx on public.telemetry (device_id, ts desc);

-- Olaylar (sensor arizasi, acilis, bekci sifirlamasi...). Faz 2 alarmlari buradan beslenir.
create table if not exists public.events (
  id        bigserial primary key,
  device_id text not null references public.devices (id) on delete cascade,
  ts        timestamptz not null default now(),
  kind      text not null,
  detail    text
);
create index if not exists events_device_ts_idx on public.events (device_id, ts desc);

-- ---------------------------------------------------------------------------
-- Sahiplik yardimcisi. security definer: cocuk tablolarin politikalari
-- `devices` tablosunun RLS'ine takilmasin ve ic ice politika degerlendirmesi
-- olusmasin. search_path bos birakildi (sema karistirma saldirisina kapali).
create or replace function public.owns_device(p_device_id text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select exists (
    select 1 from public.devices d
    where d.id = p_device_id and d.owner_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- "Cihaz sustu" ve donma kontrolu BULUT tarafinda (plan §4 Faz 2 alarmlarinin
-- veri kaynagi). security_invoker: goruntu, cagiranin RLS'ini uygular.
create or replace view public.device_health
  with (security_invoker = true)
as
select d.id                                              as device_id,
       d.name,
       s.last_seen_at,
       (s.last_seen_at is not null
         and s.last_seen_at > now() - interval '10 minutes') as online,
       s.temp_c,
       s.relay_on,
       s.sensor_ok,
       (s.temp_c is not null and s.temp_c < 6)           as freeze_risk
from public.devices d
left join public.device_state s on s.device_id = d.id;

-- ---------------------------------------------------------------------------
-- RLS
alter table public.devices enable row level security;
alter table public.device_settings enable row level security;
alter table public.device_state enable row level security;
alter table public.scenario_rules enable row level security;
alter table public.telemetry enable row level security;
alter table public.events enable row level security;

-- devices: yalniz sahibi gorur/yazar.
drop policy if exists devices_owner_all on public.devices;
create policy devices_owner_all on public.devices
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Cocuk tablolar: cihazin sahibi.
drop policy if exists device_settings_owner_all on public.device_settings;
create policy device_settings_owner_all on public.device_settings
  for all to authenticated
  using (public.owns_device(device_id))
  with check (public.owns_device(device_id));

drop policy if exists device_state_owner_read on public.device_state;
-- Durumu CIHAZ yazar (Edge Function/service_role). Kullanici yalniz OKUR —
-- panelden sahte durum yazilamasin.
create policy device_state_owner_read on public.device_state
  for select to authenticated
  using (public.owns_device(device_id));

drop policy if exists scenario_rules_owner_all on public.scenario_rules;
create policy scenario_rules_owner_all on public.scenario_rules
  for all to authenticated
  using (public.owns_device(device_id))
  with check (public.owns_device(device_id));

drop policy if exists telemetry_owner_read on public.telemetry;
create policy telemetry_owner_read on public.telemetry
  for select to authenticated
  using (public.owns_device(device_id));

drop policy if exists events_owner_read on public.events;
create policy events_owner_read on public.events
  for select to authenticated
  using (public.owns_device(device_id));

-- ---------------------------------------------------------------------------
-- IKINCI KAPI: anon rolunden yetkileri geri al. RLS'te bir hata olsa bile
-- girissiz ziyaretci tablolara ERISEMEZ (plan §6 "anon anahtarla hicbir satir
-- okunamaz/yazilamaz").
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;

-- Supabase'in varsayilan yetkileri `authenticated` role yeni tablolarda TUM
-- haklari verir. Salt-okunur olmasi gereken tablolarda bunu geri aliyoruz:
-- boylece "durumu yalniz cihaz yazar" kurali RLS'e EK OLARAK yetki katmaninda
-- da duruyor (tek kapiya guvenmiyoruz).
revoke all on public.device_state from authenticated;
revoke all on public.telemetry from authenticated;
revoke all on public.events from authenticated;

grant select, insert, update, delete on public.devices to authenticated;
grant select, insert, update, delete on public.device_settings to authenticated;
grant select on public.device_state to authenticated;
grant select, insert, update, delete on public.scenario_rules to authenticated;
grant select on public.telemetry to authenticated;
grant select on public.events to authenticated;
grant select on public.device_health to authenticated;
grant usage, select on all sequences in schema public to authenticated;

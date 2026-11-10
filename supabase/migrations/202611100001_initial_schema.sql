create extension if not exists pgcrypto;

create table if not exists public.login_names (
  username text primary key,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint login_names_format check (username ~ '^[a-z0-9._-]{3,30}$')
);

alter table public.login_names enable row level security;
revoke all on public.login_names from anon, authenticated;
grant all on public.login_names to service_role;

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  name text not null check (length(trim(name)) > 0),
  phone text not null default '',
  created_at timestamptz not null,
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  name text not null check (length(trim(name)) > 0),
  code text not null default '',
  price numeric not null check (price > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) > 0),
  total numeric not null check (total > 0),
  date timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,
  amount numeric not null check (amount > 0),
  date timestamptz not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_settings (
  owner_id uuid not null references auth.users(id) on delete restrict,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (owner_id, key),
  constraint commission_rate_range check (
    key <> 'commissionRate'
    or (jsonb_typeof(value) = 'number' and (value #>> '{}')::numeric between 0 and 100)
  )
);

create index if not exists clients_owner_name_idx on public.clients (owner_id, name);
create index if not exists products_owner_name_idx on public.products (owner_id, name);
create index if not exists sales_owner_date_idx on public.sales (owner_id, date desc);
create index if not exists sales_client_date_idx on public.sales (client_id, date desc);
create index if not exists payments_owner_date_idx on public.payments (owner_id, date desc);
create index if not exists payments_client_date_idx on public.payments (client_id, date desc);

alter table public.clients enable row level security;
alter table public.products enable row level security;
alter table public.sales enable row level security;
alter table public.payments enable row level security;
alter table public.user_settings enable row level security;

create policy "Users read their own clients"
  on public.clients for select to authenticated using (owner_id = (select auth.uid()));
create policy "Users insert their own clients"
  on public.clients for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "Users update their own clients"
  on public.clients for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

create policy "Users read their own products"
  on public.products for select to authenticated using (owner_id = (select auth.uid()));
create policy "Users insert their own products"
  on public.products for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "Users update their own products"
  on public.products for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

create policy "Users read their own sales"
  on public.sales for select to authenticated using (owner_id = (select auth.uid()));
create policy "Users insert their own sales"
  on public.sales for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "Users update their own sales"
  on public.sales for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

create policy "Users read their own payments"
  on public.payments for select to authenticated using (owner_id = (select auth.uid()));
create policy "Users insert their own payments"
  on public.payments for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "Users update their own payments"
  on public.payments for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

create policy "Users read their own settings"
  on public.user_settings for select to authenticated using (owner_id = (select auth.uid()));
create policy "Users insert their own settings"
  on public.user_settings for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "Users update their own settings"
  on public.user_settings for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

grant select, insert, update on public.clients, public.products, public.sales, public.payments, public.user_settings to authenticated;

create or replace function public.verify_owned_client()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  client_owner uuid;
begin
  select c.owner_id into client_owner
  from public.clients c
  where c.id = new.client_id
  for update;

  if client_owner is null or client_owner <> new.owner_id
    or new.owner_id <> (select auth.uid()) then
    raise exception 'Cliente inválido para esta conta.';
  end if;

  return new;
end;
$$;

create trigger sales_verify_client
  before insert or update of client_id, owner_id on public.sales
  for each row execute function public.verify_owned_client();
create trigger payments_verify_client
  before insert or update of client_id, owner_id on public.payments
  for each row execute function public.verify_owned_client();

create or replace function public.verify_sale_items()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  item jsonb;
  calculated_total numeric;
begin
  for item in select value from jsonb_array_elements(new.items) loop
    if jsonb_typeof(item -> 'name') <> 'string'
      or jsonb_typeof(item -> 'code') <> 'string'
      or jsonb_typeof(item -> 'price') <> 'number'
      or (item ->> 'price')::numeric <= 0 then
      raise exception 'Item de venda inválido.';
    end if;

    if item ->> 'product_id' is not null
      and not exists (
        select 1 from public.products p
        where p.id = (item ->> 'product_id')::uuid
          and p.owner_id = new.owner_id
      ) then
      raise exception 'Produto inválido para esta conta.';
    end if;
  end loop;

  select coalesce(sum((value ->> 'price')::numeric), 0)
    into calculated_total
  from jsonb_array_elements(new.items);

  if abs(calculated_total - new.total) > 0.0000000001 then
    raise exception 'O total da venda não corresponde aos itens.';
  end if;

  return new;
end;
$$;

create trigger sales_verify_items
  before insert or update of items, total on public.sales
  for each row execute function public.verify_sale_items();

create or replace function public.verify_payment_balance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  total_sales numeric;
  total_payments numeric;
begin
  perform 1
  from public.clients c
  where c.id = new.client_id
    and c.owner_id = new.owner_id
    and new.owner_id = (select auth.uid())
  for update;

  if not found then
    raise exception 'Cliente inválido para esta conta.';
  end if;

  select coalesce(sum(s.total), 0) into total_sales
  from public.sales s
  where s.client_id = new.client_id;

  select coalesce(sum(p.amount), 0) into total_payments
  from public.payments p
  where p.client_id = new.client_id
    and p.id <> new.id;

  if new.amount + total_payments > total_sales then
    raise exception 'O pagamento excede o saldo devedor atual.';
  end if;

  return new;
end;
$$;

create trigger payments_validate_balance
  before insert or update of amount, client_id on public.payments
  for each row execute function public.verify_payment_balance();

revoke execute on function public.verify_owned_client() from public, anon, authenticated;
revoke execute on function public.verify_sale_items() from public, anon, authenticated;
revoke execute on function public.verify_payment_balance() from public, anon, authenticated;

create or replace view public.client_balances
with (security_invoker = true)
as
  with sold as (
    select client_id, sum(total) as total_sold
    from public.sales
    group by client_id
  ),
  paid as (
    select client_id, sum(amount) as total_paid
    from public.payments
    group by client_id
  )
  select c.id as client_id,
         c.owner_id,
         coalesce(sold.total_sold, 0) as total_sold,
         coalesce(paid.total_paid, 0) as total_paid,
         greatest(coalesce(sold.total_sold, 0) - coalesce(paid.total_paid, 0), 0) as balance_due
  from public.clients c
  left join sold on sold.client_id = c.id
  left join paid on paid.client_id = c.id;

do $$
declare
  table_name text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach table_name in array array['clients', 'products', 'sales', 'payments', 'user_settings'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', table_name);
      exception when duplicate_object then
        null;
      end;
    end loop;
  end if;
end;
$$;

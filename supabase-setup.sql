create table if not exists public.shop_products (
  id text primary key,
  name text not null,
  description text not null default '',
  price numeric(10, 2) not null check (price >= 0),
  stock integer not null default 0 check (stock >= 0),
  badge text not null default '',
  search_terms text[] not null default '{}',
  active boolean not null default true,
  sort_order integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.shop_products enable row level security;
grant usage on schema public to anon, authenticated;
grant select on table public.shop_products to anon, authenticated;

drop policy if exists "Anyone can view active shop products" on public.shop_products;
create policy "Anyone can view active shop products"
  on public.shop_products for select
  to anon, authenticated
  using (active = true);

insert into public.shop_products
  (id, name, description, price, stock, badge, search_terms, sort_order)
values
  ('dumbbell', 'Power Dumbbell Set', 'Heavy-duty training pair', 49, 20, 'DB 20', array['dumbbell', 'weights', 'strength'], 1),
  ('band', 'Resistance Band Kit', 'Portable full-body training', 24, 30, 'BAND', array['resistance', 'band', 'portable'], 2),
  ('shaker', 'Built Shaker Bottle', 'Leak-proof gym essential', 15, 25, 'SHAKE', array['shaker', 'bottle', 'drink'], 3),
  ('whey', 'Performance Whey', 'Post-workout protein fuel', 39, 15, 'FUEL', array['protein', 'fuel', 'whey', 'supplement'], 4),
  ('gloves', 'Power Grip Gloves', 'Secure support for heavy lifts', 19, 18, 'GRIP', array['lifting', 'gloves', 'training'], 5),
  ('belt', 'Core Lifting Belt', 'Strong support for every set', 29, 12, 'CORE', array['training', 'belt', 'lifting'], 6)
on conflict (id) do nothing;

create table if not exists public.shop_orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  customer_name text not null,
  customer_email text not null,
  customer_phone text not null,
  delivery_address text not null,
  payment_method text not null check (
    payment_method in ('gcash', 'bank_transfer', 'cash_on_delivery', 'credit_debit')
  ),
  status text not null default 'pending' check (
    status in ('pending', 'confirmed', 'shipped', 'completed', 'cancelled')
  ),
  total_amount numeric(10, 2) not null check (total_amount > 0),
  currency text not null default 'USD',
  created_at timestamptz not null default now()
);

alter table public.shop_orders
  drop constraint if exists shop_orders_payment_method_check;
alter table public.shop_orders
  add constraint shop_orders_payment_method_check check (
    payment_method in ('gcash', 'bank_transfer', 'cash_on_delivery', 'credit_debit')
  );

create table if not exists public.shop_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.shop_orders(id) on delete cascade,
  product_id text not null,
  product_name text not null,
  unit_price numeric(10, 2) not null check (unit_price >= 0),
  quantity integer not null check (quantity > 0),
  line_total numeric(10, 2) not null check (line_total >= 0)
);

alter table public.shop_orders enable row level security;
alter table public.shop_order_items enable row level security;
revoke all on table public.shop_orders from anon, authenticated;
revoke all on table public.shop_order_items from anon, authenticated;

create or replace function public.place_shop_order(
  p_customer_name text,
  p_customer_email text,
  p_customer_phone text,
  p_delivery_address text,
  p_payment_method text,
  p_items jsonb
)
returns table (order_number text, total_amount numeric)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_item jsonb;
  v_product_id text;
  v_quantity integer;
  v_product record;
  v_order_id uuid;
  v_order_number text;
  v_total numeric(10, 2) := 0;
begin
  if length(trim(coalesce(p_customer_name, ''))) not between 2 and 120 then
    raise exception 'Enter a name between 2 and 120 characters.';
  end if;
  if length(trim(coalesce(p_customer_email, ''))) > 254
     or trim(coalesce(p_customer_email, '')) !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' then
    raise exception 'Enter a valid email address.';
  end if;
  if length(trim(coalesce(p_customer_phone, ''))) not between 7 and 30 then
    raise exception 'Enter a valid phone number.';
  end if;
  if length(trim(coalesce(p_delivery_address, ''))) not between 8 and 500 then
    raise exception 'Enter a delivery address between 8 and 500 characters.';
  end if;
  if p_payment_method is null then
    raise exception 'Choose a supported payment method.';
  end if;
  if p_payment_method not in ('gcash', 'bank_transfer', 'cash_on_delivery', 'credit_debit') then
    raise exception 'Choose a supported payment method.';
  end if;
  if jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0
     or jsonb_array_length(p_items) > 50 then
    raise exception 'Your cart is empty or contains too many different items.';
  end if;
  if (
    select count(distinct item->>'id')
    from jsonb_array_elements(p_items) as items(item)
  ) <> jsonb_array_length(p_items) then
    raise exception 'The cart contains duplicate products.';
  end if;

  for v_item in
    select item from jsonb_array_elements(p_items) as items(item)
    order by item->>'id'
  loop
    v_product_id := v_item->>'id';
    if coalesce(v_item->>'quantity', '') !~ '^[0-9]{1,4}$' then
      raise exception 'A product quantity is invalid.';
    end if;
    v_quantity := (v_item->>'quantity')::integer;
    if v_quantity < 1 or v_quantity > 999 then
      raise exception 'A product quantity is outside the allowed range.';
    end if;

    select id, name, price, stock
      into v_product
      from public.shop_products
      where id = v_product_id and active = true
      for update;
    if not found then
      raise exception 'A product in your cart is no longer available.';
    end if;
    if v_product.stock < v_quantity then
      raise exception 'Not enough stock for %. Only % remain.', v_product.name, v_product.stock;
    end if;
    v_total := v_total + v_product.price * v_quantity;
  end loop;

  if v_total <= 0 then
    raise exception 'The order total must be greater than zero.';
  end if;

  v_order_number := 'JS-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  insert into public.shop_orders (
    order_number, customer_name, customer_email, customer_phone,
    delivery_address, payment_method, total_amount
  )
  values (
    trim(p_customer_name), lower(trim(p_customer_email)), trim(p_customer_phone),
    trim(p_delivery_address), p_payment_method, v_total
  )
  returning id into v_order_id;

  for v_item in
    select item from jsonb_array_elements(p_items) as items(item)
    order by item->>'id'
  loop
    v_product_id := v_item->>'id';
    v_quantity := (v_item->>'quantity')::integer;

    select id, name, price, stock
      into v_product
      from public.shop_products
      where id = v_product_id and active = true
      for update;

    update public.shop_products
      set stock = stock - v_quantity, updated_at = now()
      where id = v_product_id;

    insert into public.shop_order_items (
      order_id, product_id, product_name, unit_price, quantity, line_total
    )
    values (
      v_order_id, v_product_id, v_product.name, v_product.price,
      v_quantity, v_product.price * v_quantity
    );
  end loop;

  return query select v_order_number, v_total;
end;
$$;

revoke all on function public.place_shop_order(text, text, text, text, text, jsonb) from public;
grant execute on function public.place_shop_order(text, text, text, text, text, jsonb) to anon, authenticated;

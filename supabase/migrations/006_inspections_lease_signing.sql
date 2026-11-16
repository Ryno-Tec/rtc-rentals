-- 006: inspections with photos, and the in-app lease with electronic signatures
--
-- Inspections (move-in, move-out, routine)
--   Either the owner or the tenant starts a check and rates each item room by room, with
--   notes and photos. Each party then confirms. A change by one party removes the other
--   party's confirmation, so nobody is held to something that changed after they agreed.
--   Once both have confirmed, the record is locked for good.
--
-- Lease documents
--   The owner builds the lease in the app and sends it. Owner and tenant sign in their own
--   accounts. Witnesses (optional) sign on the same phone or through a one-time link, with
--   no account. Every signature stores the name, time, a fingerprint (SHA-256) of the exact
--   text that was signed, and the network address and browser it came from.

-- ----------------------------------------------------------------------------
-- Helpers
-- ----------------------------------------------------------------------------
-- Every lease of the signed-in tenant, whatever its status (they must be able to read a
-- lease that is waiting for their signature, and the move-out record of one that ended).
create or replace function public.tenant_lease_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select l.id from public.leases l join public.tenants t on t.id = l.tenant_id where t.user_id = auth.uid()
$$;

create or replace function public.tenant_inspection_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select i.id from public.inspections i where i.lease_id in (select public.tenant_lease_ids())
$$;

-- A request header (PostgREST exposes them), or null outside a web request.
create or replace function public.request_header(p_name text)
returns text language plpgsql stable as $$
begin
  return left(nullif(current_setting('request.headers', true), '')::json ->> p_name, 300);
exception when others then
  return null;
end $$;

-- A drawn signature: a PNG image as a data URL, within a sensible size.
create or replace function public.valid_signature(p text)
returns boolean language sql immutable as $$
  select p is not null and length(p) between 200 and 400000 and p ~ '^data:image/png;base64,[A-Za-z0-9+/=]+$'
$$;

-- ============================================================================
-- Inspections
-- ============================================================================
alter table public.inspections
  add column started_by text not null default 'landlord' check (started_by in ('landlord', 'tenant')),
  add column notes text check (notes is null or length(notes) <= 2000),
  add column landlord_signed_name text,
  add column tenant_signed_name text,
  add constraint inspections_id_landlord_key unique (id, landlord_id);

create table public.inspection_items (
  id            uuid primary key default gen_random_uuid(),
  landlord_id   uuid not null,
  inspection_id uuid not null,
  room          text not null check (length(trim(room)) between 1 and 80),
  item          text not null check (length(trim(item)) between 1 and 120),
  condition     text check (condition in ('good', 'fair', 'poor', 'na')),
  landlord_note text check (landlord_note is null or length(landlord_note) <= 1000),
  tenant_note   text check (tenant_note is null or length(tenant_note) <= 1000),
  sort          integer not null default 0,
  created_by    text not null default 'landlord' check (created_by in ('landlord', 'tenant')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (inspection_id, landlord_id) references public.inspections(id, landlord_id) on delete cascade
);
create index inspection_items_inspection_idx on public.inspection_items(inspection_id, sort);

create table public.inspection_photos (
  id            uuid primary key default gen_random_uuid(),
  landlord_id   uuid not null,
  inspection_id uuid not null,
  item_id       uuid references public.inspection_items(id) on delete cascade,
  path          text not null unique,          -- object in the private 'inspections' storage bucket
  added_by      text not null default 'landlord' check (added_by in ('landlord', 'tenant')),
  created_at    timestamptz not null default now(),
  foreign key (inspection_id, landlord_id) references public.inspections(id, landlord_id) on delete cascade
);
create index inspection_photos_inspection_idx on public.inspection_photos(inspection_id);

create trigger inspection_items_updated_at before update on public.inspection_items
  for each row execute function public.set_updated_at();

-- The inspection itself: the browser can't write confirmations or change a locked record.
create or replace function public.inspections_guard()
returns trigger language plpgsql as $$
begin
  if current_user not in ('authenticated', 'anon') then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.landlord_id is null then
      select landlord_id into new.landlord_id from public.leases where id = new.lease_id;
    end if;
    new.started_by := case when new.landlord_id = public.get_landlord_id() then 'landlord' else 'tenant' end;
    new.landlord_signed_at := null; new.landlord_signed_name := null;
    new.tenant_signed_at := null;   new.tenant_signed_name := null;
    return new;
  end if;
  if old.landlord_signed_at is not null and old.tenant_signed_at is not null then
    raise exception 'This inspection was confirmed by both parties and can no longer be changed' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if (new.landlord_signed_at, new.landlord_signed_name, new.tenant_signed_at, new.tenant_signed_name,
      new.lease_id, new.landlord_id, new.started_by)
     is distinct from
     (old.landlord_signed_at, old.landlord_signed_name, old.tenant_signed_at, old.tenant_signed_name,
      old.lease_id, old.landlord_id, old.started_by) then
    raise exception 'Confirmations are recorded when each party confirms in the app' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger inspections_guard before insert or update or delete on public.inspections
  for each row execute function public.inspections_guard();

-- Items and photos: who may change what, and what a change does to the confirmations.
create or replace function public.inspection_children_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_insp public.inspections;
  v_id   uuid;
  v_role text;
  v_changed boolean := true;
begin
  if tg_op = 'DELETE' then v_id := old.inspection_id; else v_id := new.inspection_id; end if;
  select * into v_insp from public.inspections where id = v_id for update;
  if not found then
    if tg_op = 'DELETE' then return old; end if;       -- the inspection itself is being deleted
    raise exception 'Inspection not found' using errcode = 'P0002';
  end if;
  if tg_op <> 'DELETE' then new.landlord_id := v_insp.landlord_id; end if;
  if auth.uid() is null then                            -- maintenance outside the app
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  v_role := case when v_insp.landlord_id = public.get_landlord_id() then 'landlord'
                 when v_insp.lease_id in (select public.tenant_lease_ids()) then 'tenant' end;
  if v_role is null then raise exception 'You are not part of this inspection' using errcode = '42501'; end if;
  if v_insp.landlord_signed_at is not null and v_insp.tenant_signed_at is not null then
    raise exception 'This inspection was confirmed by both parties and can no longer be changed' using errcode = 'P0001';
  end if;

  if tg_table_name = 'inspection_items' then
    if tg_op = 'INSERT' then
      new.created_by := v_role;
      if v_role = 'tenant' then new.landlord_note := null; else new.tenant_note := null; end if;
    elsif tg_op = 'UPDATE' then
      if new.inspection_id <> old.inspection_id then raise exception 'An item can''t move to another inspection' using errcode = '42501'; end if;
      new.created_by := old.created_by;
      -- Each party writes only their own note.
      if v_role = 'tenant' then new.landlord_note := old.landlord_note; else new.tenant_note := old.tenant_note; end if;
      v_changed := (new.room, new.item, new.condition, new.landlord_note, new.tenant_note)
                   is distinct from (old.room, old.item, old.condition, old.landlord_note, old.tenant_note);
    elsif v_role = 'tenant' and old.created_by <> 'tenant' then
      raise exception 'Only the landlord can remove this item. Mark it "Not applicable" instead' using errcode = '42501';
    end if;
  else
    if tg_op = 'INSERT' then
      new.added_by := v_role;
      if new.path not like v_insp.landlord_id::text || '/' || v_insp.id::text || '/%' then
        raise exception 'Photo is filed in the wrong place' using errcode = '42501';
      end if;
      if new.item_id is not null and not exists
         (select 1 from public.inspection_items where id = new.item_id and inspection_id = v_insp.id) then
        raise exception 'That item is not part of this inspection' using errcode = '42501';
      end if;
    elsif tg_op = 'UPDATE' then
      raise exception 'Photos can''t be edited. Remove it and add a new one' using errcode = '42501';
    elsif old.added_by <> v_role then
      raise exception 'Only the person who added a photo can remove it' using errcode = '42501';
    end if;
  end if;

  -- The other party agreed to what was there before: they must confirm again.
  if v_changed then
    if v_role = 'landlord' and v_insp.tenant_signed_at is not null then
      update public.inspections set tenant_signed_at = null, tenant_signed_name = null where id = v_id;
    elsif v_role = 'tenant' and v_insp.landlord_signed_at is not null then
      update public.inspections set landlord_signed_at = null, landlord_signed_name = null where id = v_id;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create trigger inspection_items_guard before insert or update or delete on public.inspection_items
  for each row execute function public.inspection_children_guard();
create trigger inspection_photos_guard before insert or update or delete on public.inspection_photos
  for each row execute function public.inspection_children_guard();

-- Confirm an inspection as the signed-in owner or tenant.
create or replace function public.confirm_inspection(p_inspection uuid, p_name text)
returns void language plpgsql security definer set search_path = public as $$
declare v_insp public.inspections; v_role text; v_left integer; v_total integer;
begin
  select * into v_insp from public.inspections where id = p_inspection for update;
  if found then
    v_role := case when v_insp.landlord_id = public.get_landlord_id() then 'landlord'
                   when v_insp.lease_id in (select public.tenant_lease_ids()) then 'tenant' end;
  end if;
  if v_role is null then raise exception 'Inspection not found' using errcode = 'P0002'; end if;
  if length(trim(coalesce(p_name, ''))) < 3 then raise exception 'Type your full name to confirm' using errcode = 'P0001'; end if;
  select count(*), count(*) filter (where condition is null) into v_total, v_left
    from public.inspection_items where inspection_id = p_inspection;
  if v_total = 0 then raise exception 'Add at least one item before confirming' using errcode = 'P0001'; end if;
  if v_left > 0 then raise exception 'Rate every item before confirming (% still to do)', v_left using errcode = 'P0001'; end if;
  if v_role = 'landlord' then
    update public.inspections set landlord_signed_at = coalesce(landlord_signed_at, now()), landlord_signed_name = trim(p_name) where id = p_inspection;
  else
    update public.inspections set tenant_signed_at = coalesce(tenant_signed_at, now()), tenant_signed_name = trim(p_name) where id = p_inspection;
  end if;
end $$;

alter table public.inspection_items  enable row level security;
alter table public.inspection_photos enable row level security;

create policy inspections_tenant_read on public.inspections for select to authenticated
  using (lease_id in (select public.tenant_lease_ids()));
create policy inspections_tenant_start on public.inspections for insert to authenticated
  with check (lease_id in (select public.tenant_lease_ids()));

create policy inspection_items_owner on public.inspection_items for all to authenticated
  using (landlord_id = public.get_landlord_id()) with check (landlord_id = public.get_landlord_id());
create policy inspection_items_tenant on public.inspection_items for all to authenticated
  using (inspection_id in (select public.tenant_inspection_ids()))
  with check (inspection_id in (select public.tenant_inspection_ids()));

create policy inspection_photos_owner on public.inspection_photos for all to authenticated
  using (landlord_id = public.get_landlord_id()) with check (landlord_id = public.get_landlord_id());
create policy inspection_photos_tenant on public.inspection_photos for all to authenticated
  using (inspection_id in (select public.tenant_inspection_ids()))
  with check (inspection_id in (select public.tenant_inspection_ids()));

-- ============================================================================
-- Lease documents and signatures
-- ============================================================================
create table public.lease_documents (
  id            uuid primary key default gen_random_uuid(),
  landlord_id   uuid not null default public.get_landlord_id(),
  lease_id      uuid not null,
  title         text not null default 'Residential lease agreement' check (length(trim(title)) between 1 and 160),
  body          jsonb not null,                -- the agreement exactly as shown: parties, terms, sections
  body_hash     text,                          -- SHA-256 of the body, fixed when it is sent for signing
  witnesses_per_party smallint not null default 0 check (witnesses_per_party between 0 and 2),
  status        text not null default 'draft' check (status in ('draft', 'sent', 'signed', 'void')),
  sent_at       timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (lease_id, landlord_id) references public.leases(id, landlord_id) on delete cascade,
  unique (id, landlord_id)
);
-- One document in progress per lease. Signed ones are kept (renewals add a new one).
create unique index lease_documents_one_open on public.lease_documents(lease_id) where status in ('draft', 'sent');
create trigger lease_documents_updated_at before update on public.lease_documents
  for each row execute function public.set_updated_at();

create table public.lease_signatures (
  id            uuid primary key default gen_random_uuid(),
  landlord_id   uuid not null,
  document_id   uuid not null,
  role          text not null check (role in ('landlord', 'tenant', 'witness')),
  witness_for   text check (witness_for in ('landlord', 'tenant')),
  signer_name   text not null check (length(trim(signer_name)) between 3 and 120),
  signature     text not null check (public.valid_signature(signature)),
  method        text not null check (method in ('account', 'in_person', 'link')),
  user_id       uuid,
  body_hash     text not null,
  ip            text,
  user_agent    text,
  signed_at     timestamptz not null default now(),
  check ((role = 'witness') = (witness_for is not null)),
  foreign key (document_id, landlord_id) references public.lease_documents(id, landlord_id) on delete cascade
);
create unique index lease_signatures_one_per_party on public.lease_signatures(document_id, role) where role <> 'witness';
create index lease_signatures_document_idx on public.lease_signatures(document_id);

create table public.lease_witness_links (
  id            uuid primary key default gen_random_uuid(),
  landlord_id   uuid not null,
  document_id   uuid not null,
  witness_for   text not null check (witness_for in ('landlord', 'tenant')),
  token_hash    text not null unique,
  expires_at    timestamptz not null default now() + interval '7 days',
  used_at       timestamptz,
  created_at    timestamptz not null default now(),
  foreign key (document_id, landlord_id) references public.lease_documents(id, landlord_id) on delete cascade
);

-- The browser may only write a draft. Sending, signing and completing go through the functions below.
create or replace function public.lease_documents_guard()
returns trigger language plpgsql as $$
begin
  if current_user not in ('authenticated', 'anon') then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.status := 'draft'; new.body_hash := null; new.sent_at := null; new.completed_at := null;
    return new;
  end if;
  if old.status <> 'draft' then
    raise exception 'This lease was already sent for signing. Cancel it and start a new one to change it' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if (new.status, new.body_hash, new.sent_at, new.completed_at, new.lease_id, new.landlord_id)
     is distinct from (old.status, old.body_hash, old.sent_at, old.completed_at, old.lease_id, old.landlord_id) then
    raise exception 'Use Send for signing in the app' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger lease_documents_guard before insert or update or delete on public.lease_documents
  for each row execute function public.lease_documents_guard();

alter table public.lease_documents     enable row level security;
alter table public.lease_signatures    enable row level security;
alter table public.lease_witness_links enable row level security;

create policy lease_documents_owner on public.lease_documents for all to authenticated
  using (landlord_id = public.get_landlord_id()) with check (landlord_id = public.get_landlord_id());
create policy lease_documents_tenant_read on public.lease_documents for select to authenticated
  using (status <> 'draft' and lease_id in (select public.tenant_lease_ids()));

-- Signatures and witness links are read-only from the browser.
create or replace function public.tenant_lease_document_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select d.id from public.lease_documents d
  where d.status <> 'draft' and d.lease_id in (select public.tenant_lease_ids())
$$;
create policy lease_signatures_owner_read on public.lease_signatures for select to authenticated
  using (landlord_id = public.get_landlord_id());
create policy lease_signatures_tenant_read on public.lease_signatures for select to authenticated
  using (document_id in (select public.tenant_lease_document_ids()));
create policy lease_witness_links_owner_read on public.lease_witness_links for select to authenticated
  using (landlord_id = public.get_landlord_id());
revoke insert, update, delete on public.lease_signatures, public.lease_witness_links from anon, authenticated;

-- Which party the signed-in user is on a document (null = neither).
create or replace function public.lease_document_party(p_doc public.lease_documents)
returns text language sql stable security definer set search_path = public as $$
  select case when p_doc.landlord_id = public.get_landlord_id() then 'landlord'
              when p_doc.status <> 'draft' and p_doc.lease_id in (select public.tenant_lease_ids()) then 'tenant' end
$$;

-- Mark the document signed once every required signature is in, and bring the lease into force.
create or replace function public.lease_document_finish(p_doc uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_doc public.lease_documents; v_unit uuid;
begin
  select * into v_doc from public.lease_documents where id = p_doc for update;
  if not found or v_doc.status <> 'sent' then return; end if;
  if (select count(*) from public.lease_signatures where document_id = p_doc and role = 'landlord') = 0
     or (select count(*) from public.lease_signatures where document_id = p_doc and role = 'tenant') = 0
     or (select count(*) from public.lease_signatures where document_id = p_doc and witness_for = 'landlord') < v_doc.witnesses_per_party
     or (select count(*) from public.lease_signatures where document_id = p_doc and witness_for = 'tenant') < v_doc.witnesses_per_party
  then return; end if;

  update public.lease_documents set status = 'signed', completed_at = now() where id = p_doc;
  begin
    update public.leases
       set signed_at = now(),
           status = case when status in ('draft', 'sent')
                         then (case when start_date <= current_date then 'active' else 'signed' end)::public.lease_status
                         else status end
     where id = v_doc.lease_id
     returning unit_id into v_unit;
  exception when unique_violation then                 -- the unit still has another live lease
    update public.leases set signed_at = now() where id = v_doc.lease_id;
    v_unit := null;
  end;
  if v_unit is not null then
    update public.units set status = 'occupied' where id = v_unit and status = 'vacant'
      and exists (select 1 from public.leases where id = v_doc.lease_id and status in ('active', 'signed'));
  end if;
end $$;

-- Owner: lock the text and send it for signing.
create or replace function public.send_lease_document(p_doc uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_doc public.lease_documents;
begin
  select * into v_doc from public.lease_documents where id = p_doc and landlord_id = public.get_landlord_id() for update;
  if not found then raise exception 'Lease not found' using errcode = 'P0002'; end if;
  if v_doc.status <> 'draft' then raise exception 'This lease was already sent' using errcode = 'P0001'; end if;
  if jsonb_typeof(v_doc.body -> 'sections') is distinct from 'array' or jsonb_array_length(v_doc.body -> 'sections') = 0 then
    raise exception 'The lease has no terms yet' using errcode = 'P0001';
  end if;
  update public.lease_documents
     set status = 'sent', sent_at = now(), body_hash = encode(sha256(convert_to(body::text, 'UTF8')), 'hex')
   where id = p_doc;
  update public.leases set status = 'sent' where id = v_doc.lease_id and status = 'draft';
end $$;

-- Owner: cancel a lease that is out for signing (signatures so far are kept with it).
create or replace function public.void_lease_document(p_doc uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_doc public.lease_documents;
begin
  select * into v_doc from public.lease_documents where id = p_doc and landlord_id = public.get_landlord_id() for update;
  if not found then raise exception 'Lease not found' using errcode = 'P0002'; end if;
  if v_doc.status <> 'sent' then raise exception 'Only a lease that is out for signing can be cancelled' using errcode = 'P0001'; end if;
  update public.lease_documents set status = 'void' where id = p_doc;
  update public.lease_witness_links set expires_at = now() where document_id = p_doc and used_at is null;
  update public.leases set status = 'draft' where id = v_doc.lease_id and status = 'sent';
end $$;

-- Owner or tenant: sign as yourself.
create or replace function public.sign_lease_document(p_doc uuid, p_name text, p_signature text)
returns void language plpgsql security definer set search_path = public as $$
declare v_doc public.lease_documents; v_role text;
begin
  select * into v_doc from public.lease_documents where id = p_doc for update;
  if found then v_role := public.lease_document_party(v_doc); end if;
  if v_role is null then raise exception 'Lease not found' using errcode = 'P0002'; end if;
  if v_doc.status <> 'sent' then raise exception 'This lease is not open for signing' using errcode = 'P0001'; end if;
  if length(trim(coalesce(p_name, ''))) < 3 then raise exception 'Type your full name' using errcode = 'P0001'; end if;
  if not public.valid_signature(p_signature) then raise exception 'Draw your signature in the box' using errcode = 'P0001'; end if;
  if exists (select 1 from public.lease_signatures where document_id = p_doc and role = v_role) then
    raise exception 'You have already signed this lease' using errcode = 'P0001';
  end if;
  insert into public.lease_signatures (landlord_id, document_id, role, signer_name, signature, method, user_id, body_hash, ip, user_agent)
  values (v_doc.landlord_id, p_doc, v_role, trim(p_name), p_signature, 'account', auth.uid(), v_doc.body_hash,
          public.request_header('x-forwarded-for'), public.request_header('user-agent'));
  perform public.lease_document_finish(p_doc);
end $$;

-- Shared by both ways a witness signs.
create or replace function public.lease_witness_record(p_doc public.lease_documents, p_for text, p_name text, p_signature text, p_method text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_doc.status <> 'sent' then raise exception 'This lease is not open for signing' using errcode = 'P0001'; end if;
  if p_doc.witnesses_per_party = 0 then raise exception 'This lease does not ask for witnesses' using errcode = 'P0001'; end if;
  if length(trim(coalesce(p_name, ''))) < 3 then raise exception 'The witness must type their full name' using errcode = 'P0001'; end if;
  if not public.valid_signature(p_signature) then raise exception 'The witness must draw their signature in the box' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.lease_signatures where document_id = p_doc.id and role = p_for) then
    raise exception 'The % must sign before their witness', p_for using errcode = 'P0001';
  end if;
  if exists (select 1 from public.lease_signatures where document_id = p_doc.id and role in ('landlord', 'tenant')
             and lower(trim(signer_name)) = lower(trim(p_name))) then
    raise exception 'A witness can''t be one of the people signing the lease' using errcode = 'P0001';
  end if;
  if (select count(*) from public.lease_signatures where document_id = p_doc.id and witness_for = p_for) >= p_doc.witnesses_per_party then
    raise exception 'All the witnesses for the % have already signed', p_for using errcode = 'P0001';
  end if;
  insert into public.lease_signatures (landlord_id, document_id, role, witness_for, signer_name, signature, method, user_id, body_hash, ip, user_agent)
  values (p_doc.landlord_id, p_doc.id, 'witness', p_for, trim(p_name), p_signature, p_method, auth.uid(), p_doc.body_hash,
          public.request_header('x-forwarded-for'), public.request_header('user-agent'));
  perform public.lease_document_finish(p_doc.id);
end $$;

-- Owner or tenant: a witness who is with you signs on your phone.
create or replace function public.add_lease_witness(p_doc uuid, p_name text, p_signature text)
returns void language plpgsql security definer set search_path = public as $$
declare v_doc public.lease_documents; v_role text;
begin
  select * into v_doc from public.lease_documents where id = p_doc for update;
  if found then v_role := public.lease_document_party(v_doc); end if;
  if v_role is null then raise exception 'Lease not found' using errcode = 'P0002'; end if;
  perform public.lease_witness_record(v_doc, v_role, p_name, p_signature, 'in_person');
end $$;

-- Owner or tenant: a one-time link for a witness who is somewhere else. Returned once; only its hash is stored.
create or replace function public.create_lease_witness_link(p_doc uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_doc public.lease_documents; v_role text; v_token text;
begin
  select * into v_doc from public.lease_documents where id = p_doc for update;
  if found then v_role := public.lease_document_party(v_doc); end if;
  if v_role is null then raise exception 'Lease not found' using errcode = 'P0002'; end if;
  if v_doc.status <> 'sent' then raise exception 'This lease is not open for signing' using errcode = 'P0001'; end if;
  if v_doc.witnesses_per_party = 0 then raise exception 'This lease does not ask for witnesses' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.lease_signatures where document_id = p_doc and role = v_role) then
    raise exception 'Sign the lease yourself first, then invite your witness' using errcode = 'P0001';
  end if;
  if (select count(*) from public.lease_signatures where document_id = p_doc and witness_for = v_role) >= v_doc.witnesses_per_party then
    raise exception 'All your witnesses have already signed' using errcode = 'P0001';
  end if;
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.lease_witness_links (landlord_id, document_id, witness_for, token_hash)
  values (v_doc.landlord_id, p_doc, v_role, public.invite_hash(v_token));
  return v_token;
end $$;

-- Anyone holding a witness link: what they are being asked to witness. They see who signed and
-- for which home, not the lease itself (it holds ID numbers and bank details).
create or replace function public.lease_witness_preview(p_token text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'valid', k.used_at is null and k.expires_at > now() and d.status = 'sent'
             and (select count(*) from public.lease_signatures w where w.document_id = d.id and w.witness_for = k.witness_for) < d.witnesses_per_party,
    'title', d.title,
    'witness_for', k.witness_for,
    'party_name', s.signer_name,
    'party_signature', s.signature,
    'party_signed_at', s.signed_at,
    'landlord_name', d.body #>> '{parties,landlord,name}',
    'tenant_name', d.body #>> '{parties,tenant,name}',
    'premises', d.body #>> '{premises,address}',
    'fingerprint', d.body_hash)
  from public.lease_witness_links k
  join public.lease_documents d on d.id = k.document_id
  left join public.lease_signatures s on s.document_id = d.id and s.role = k.witness_for
  where k.token_hash = public.invite_hash(p_token)
$$;

create or replace function public.lease_witness_sign(p_token text, p_name text, p_signature text)
returns void language plpgsql security definer set search_path = public as $$
declare v_link public.lease_witness_links; v_doc public.lease_documents;
begin
  select * into v_link from public.lease_witness_links where token_hash = public.invite_hash(p_token) for update;
  if not found then raise exception 'This witness link is not valid' using errcode = 'P0002'; end if;
  if v_link.used_at is not null then raise exception 'This witness link has already been used' using errcode = 'P0001'; end if;
  if v_link.expires_at <= now() then raise exception 'This witness link has expired. Ask for a new one' using errcode = 'P0001'; end if;
  select * into v_doc from public.lease_documents where id = v_link.document_id for update;
  perform public.lease_witness_record(v_doc, v_link.witness_for, p_name, p_signature, 'link');
  update public.lease_witness_links set used_at = now() where id = v_link.id;
end $$;

-- Who may call what. New functions are open to everyone by default, so close them first.
revoke all on function
  public.tenant_lease_ids(), public.tenant_inspection_ids(), public.tenant_lease_document_ids(),
  public.request_header(text), public.valid_signature(text),
  public.confirm_inspection(uuid, text),
  public.lease_document_party(public.lease_documents), public.lease_document_finish(uuid),
  public.lease_witness_record(public.lease_documents, text, text, text, text),
  public.send_lease_document(uuid), public.void_lease_document(uuid),
  public.sign_lease_document(uuid, text, text), public.add_lease_witness(uuid, text, text),
  public.create_lease_witness_link(uuid), public.lease_witness_preview(text), public.lease_witness_sign(text, text, text)
  from public, anon, authenticated;
grant execute on function
  public.tenant_lease_ids(), public.tenant_inspection_ids(), public.tenant_lease_document_ids(),
  public.valid_signature(text),
  public.confirm_inspection(uuid, text),
  public.send_lease_document(uuid), public.void_lease_document(uuid),
  public.sign_lease_document(uuid, text, text), public.add_lease_witness(uuid, text, text),
  public.create_lease_witness_link(uuid)
  to authenticated;
grant execute on function public.lease_witness_preview(text), public.lease_witness_sign(text, text, text) to anon, authenticated;

-- ============================================================================
-- Photo storage: a private bucket. Files live at <landlord id>/<inspection id>/<file>.
-- ============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('inspections', 'inspections', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy inspection_files_owner on storage.objects for all to authenticated
  using (bucket_id = 'inspections' and (storage.foldername(objects.name))[1] = public.get_landlord_id()::text)
  with check (bucket_id = 'inspections' and (storage.foldername(objects.name))[1] = public.get_landlord_id()::text);

create policy inspection_files_tenant_read on storage.objects for select to authenticated
  using (bucket_id = 'inspections' and exists (
    select 1 from public.inspections i
    where i.id::text = (storage.foldername(objects.name))[2] and i.landlord_id::text = (storage.foldername(objects.name))[1]
      and i.id in (select public.tenant_inspection_ids())));

create policy inspection_files_tenant_add on storage.objects for insert to authenticated
  with check (bucket_id = 'inspections' and exists (
    select 1 from public.inspections i
    where i.id::text = (storage.foldername(objects.name))[2] and i.landlord_id::text = (storage.foldername(objects.name))[1]
      and i.id in (select public.tenant_inspection_ids())
      and not (i.landlord_signed_at is not null and i.tenant_signed_at is not null)));

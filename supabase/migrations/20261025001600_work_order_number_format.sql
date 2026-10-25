-- Work order numbers use the format WO00059270: prefix, no separator, no year,
-- 8 digits, numbered continuously. Document sequences gain a configurable separator.

alter table public.document_sequences
  add column separator text not null default '-' check (separator in ('-', '/', ''));

create or replace function app_private.next_document_number(p_code text) returns text
language plpgsql security definer set search_path = public as $$
declare
  s public.document_sequences;
  y int := extract(year from (now() at time zone 'Africa/Johannesburg'))::int;
  v bigint;
begin
  select * into s from document_sequences where code = p_code for update;
  if not found then
    raise exception 'Unknown document sequence %', p_code;
  end if;
  v := s.next_value;
  if s.include_year and coalesce(s.current_year, 0) <> y then
    v := 1;
  end if;
  update document_sequences set next_value = v + 1, current_year = y, updated_at = now() where code = p_code;
  return s.prefix || s.separator
    || case when s.include_year then y::text || s.separator else '' end
    || lpad(v::text, s.padding, '0');
end $$;

drop function if exists public.update_document_sequence(text, text, int, bigint);

create or replace function public.update_document_sequence(p_code text, p_prefix text, p_padding int, p_next_value bigint default null,
  p_separator text default null, p_include_year boolean default null) returns void
language plpgsql security definer set search_path = public as $$
declare s public.document_sequences;
begin
  perform app_private.require_permission('settings.manage');
  select * into s from document_sequences where code = p_code for update;
  if not found then raise exception 'Unknown sequence'; end if;
  if p_next_value is not null and p_next_value < s.next_value then
    raise exception 'The next number can only be increased (to avoid duplicate document numbers)';
  end if;
  if p_separator is not null and p_separator not in ('-', '/', '') then
    raise exception 'The separator must be "-", "/" or none';
  end if;
  update document_sequences set prefix = upper(p_prefix), padding = p_padding, next_value = coalesce(p_next_value, next_value),
    separator = coalesce(p_separator, separator), include_year = coalesce(p_include_year, include_year), updated_at = now()
  where code = p_code;
end $$;

revoke execute on function public.update_document_sequence(text, text, int, bigint, text, boolean) from public, anon;
grant execute on function public.update_document_sequence(text, text, int, bigint, text, boolean) to authenticated, service_role;

update public.document_sequences
set prefix = 'WO', separator = '', include_year = false, padding = 8
where code = 'work_order';

-- Convert work orders numbered in the old WO-YYYY-NNNNNN format, keeping their sequence number.
update public.work_orders
set wo_number = 'WO' || lpad(substring(wo_number from '(\d+)$'), 8, '0')
where wo_number ~ '^WO-\d{4}-\d+$';

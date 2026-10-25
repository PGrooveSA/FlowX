-- =====================================================================
-- DEVELOPMENT / DEMONSTRATION SEED DATA ONLY.
-- Runs automatically on `supabase db reset` against the LOCAL stack.
-- Never run against production. All schools, EMIS numbers, people and
-- serial numbers below are fictional.
-- Users are created separately by `npm run setup:demo` (scripts/seed-demo.mjs).
-- =====================================================================

insert into public.system_settings (key, value, category, description) values
  ('environment.is_demo', 'true', 'general', 'Marks this database as containing demonstration data')
on conflict (key) do update set value = excluded.value;

insert into public.provinces (code, name) values
  ('EC','Eastern Cape'),('FS','Free State'),('GP','Gauteng'),('KZN','KwaZulu-Natal'),('LP','Limpopo'),
  ('MP','Mpumalanga'),('NC','Northern Cape'),('NW','North West'),('WC','Western Cape');

insert into public.districts (province_id, code, name)
select p.id, x.code, x.name from (values
  ('GP','GP-JN','Johannesburg North'),('GP','GP-JS','Johannesburg South'),('GP','GP-TW','Tshwane West'),('GP','GP-EK','Ekurhuleni East'),
  ('KZN','KZN-UM','Umlazi'),('KZN','KZN-PN','Pinetown'),('KZN','KZN-IL','iLembe'),
  ('WC','WC-MN','Metro North'),('WC','WC-MS','Metro South'),('WC','WC-CW','Cape Winelands'),
  ('EC','EC-BC','Buffalo City'),('LP','LP-CA','Capricorn'),('MP','MP-EH','Ehlanzeni'),
  ('FS','FS-MO','Motheo'),('NW','NW-BO','Bojanala'),('NC','NC-FB','Frances Baard')
) as x(prov, code, name) join public.provinces p on p.code = x.prov;

insert into public.warehouses (code, name, province_id, address_line1, city, postal_code, phone)
select x.code, x.name, p.id, x.addr, x.city, x.pc, x.phone from (values
  ('JHB-01','Johannesburg Central Warehouse','GP','12 Demo Logistics Park','Johannesburg','2001','+27 11 000 0001'),
  ('DBN-01','Durban Distribution Centre','KZN','4 Example Harbour Road','Durban','4001','+27 31 000 0002'),
  ('CPT-01','Cape Town Depot','WC','88 Sample Industrial Way','Cape Town','8001','+27 21 000 0003')
) as x(code, name, prov, addr, city, pc, phone) join public.provinces p on p.code = x.prov;

insert into public.warehouse_locations (warehouse_id, code, zone, shelf, bin, location_type)
select w.id, l.code, l.zone, l.shelf, l.bin, l.ltype
from public.warehouses w
cross join (values
  ('RCV-01','Receiving',null,null,'receiving'),
  ('A-01-01','A','01','01','storage'),('A-01-02','A','01','02','storage'),
  ('A-02-01','A','02','01','storage'),('B-01-01','B','01','01','storage'),
  ('QUA-01','Quarantine',null,null,'quarantine'),('RET-01','Returns',null,null,'returns'),
  ('REP-01','Repair bench',null,null,'repair'),('DSP-01','Dispatch bay',null,null,'dispatch')
) as l(code, zone, shelf, bin, ltype);

insert into public.institutions (emis_number, name, institution_type, phase, province_id, district_id, address_line1, town, postal_code,
                                 delivery_address, phone, email, principal_name, billing_name, billing_address)
select x.emis, x.name, x.itype, x.phase, d.province_id, d.id, x.addr, x.town, x.pc,
       x.addr || ', ' || x.town, x.phone, x.email, x.principal, x.billing, 'Provincial Education Department (demo), Private Bag X0, ' || x.town
from (values
  ('900100101','Masakhane Primary School','school','Primary','GP-JN','1 Ubuntu Street','Alexandra','2090','+27 11 100 0101','office@masakhane.example','Ms N. Dlamini','Gauteng Dept of Education (demo)'),
  ('900100102','Riverside Secondary School','school','Secondary','GP-JS','22 River Road','Soweto','1804','+27 11 100 0102','admin@riverside.example','Mr T. Mokoena','Gauteng Dept of Education (demo)'),
  ('900100103','Thuto Ke Lesedi High School','school','Secondary','GP-TW','5 Lesedi Avenue','Atteridgeville','0008','+27 12 100 0103','info@thuto.example','Mrs P. Molefe','Gauteng Dept of Education (demo)'),
  ('900100104','Sunrise Combined School','school','Combined','GP-EK','9 Dawn Crescent','Daveyton','1520','+27 11 100 0104','office@sunrise.example','Mr J. van Wyk','Gauteng Dept of Education (demo)'),
  ('900200201','Ithemba Primary School','school','Primary','KZN-UM','14 Hope Lane','Umlazi','4031','+27 31 200 0201','office@ithemba.example','Mrs Z. Ndlovu','KZN Dept of Education (demo)'),
  ('900200202','Hillcrest View Secondary','school','Secondary','KZN-PN','3 Ridge Road','Pinetown','3610','+27 31 200 0202','admin@hillview.example','Mr S. Naidoo','KZN Dept of Education (demo)'),
  ('900200203','Inkanyezi High School','school','Secondary','KZN-IL','77 Star Street','KwaDukuza','4450','+27 32 200 0203','info@inkanyezi.example','Ms L. Zulu','KZN Dept of Education (demo)'),
  ('900300301','Table View Primary','school','Primary','WC-MN','45 Coastal Drive','Milnerton','7441','+27 21 300 0301','office@tableview.example','Mrs A. Petersen','WC Education Dept (demo)'),
  ('900300302','Southern Peninsula High','school','Secondary','WC-MS','8 Bay Street','Muizenberg','7945','+27 21 300 0302','admin@southpen.example','Mr R. Adams','WC Education Dept (demo)'),
  ('900300303','Vineyard Valley School','special_school','Combined','WC-CW','2 Valley Road','Paarl','7646','+27 21 300 0303','info@vineyard.example','Ms C. Jacobs','WC Education Dept (demo)'),
  ('900400401','Buffalo Flats Primary','school','Primary','EC-BC','16 Buffalo Way','East London','5201','+27 43 400 0401','office@buffalo.example','Mr M. Mthembu','EC Dept of Education (demo)'),
  ('900500501','Capricorn District Office','district_office',null,'LP-CA','1 Government Square','Polokwane','0700','+27 15 500 0501','district@capricorn.example','Dr K. Maluleke','Limpopo Dept of Education (demo)')
) as x(emis, name, itype, phase, dist, addr, town, pc, phone, email, principal, billing)
join public.districts d on d.code = x.dist;

insert into public.institution_contacts (institution_id, full_name, role_title, phone, email, is_primary)
select id, principal_name, 'Principal', phone, email, true from public.institutions;

insert into public.recipients (institution_id, recipient_type, full_name, reference_number, grade, class_name)
select i.id, x.rtype, x.name, x.ref, x.grade, x.cls from (values
  ('900100101','teacher','Demo Teacher Sipho','T-0001',null,null),
  ('900100101','learner','Demo Learner A','L-0001','7','7A'),
  ('900100101','learner','Demo Learner B','L-0002','7','7B'),
  ('900100102','teacher','Demo Teacher Anele','T-0002',null,null),
  ('900100102','school','Riverside ICT Lab',null,null,null),
  ('900200201','teacher','Demo Teacher Musa','T-0003',null,null),
  ('900300301','learner','Demo Learner C','L-0003','5','5C')
) as x(emis, rtype, name, ref, grade, cls) join public.institutions i on i.emis_number = x.emis;

insert into public.suppliers (code, name, contact_name, phone, email, vat_number) values
  ('SUP-TECHDIST','Example Tech Distributors (Pty) Ltd','Sales Desk','+27 11 900 0001','sales@techdist.example','4100000001'),
  ('SUP-EDUTAB','Sample EduTab Supplies','Account Manager','+27 21 900 0002','accounts@edutab.example','4100000002');

insert into public.device_categories (code, name, requires_serial, requires_imei) values
  ('LAPTOP','Laptop',true,false),
  ('TABLET','Tablet (Wi-Fi)',true,false),
  ('TABLET-LTE','Tablet (LTE)',true,true),
  ('ACCESSORY','Accessory',false,false);

insert into public.device_models (category_id, manufacturer, model_name, model_code, unit_price_cents, warranty_months, low_stock_threshold)
select c.id, x.mfr, x.model, x.code, x.price, x.warranty, x.low from (values
  ('LAPTOP','Lenovo','100e Chromebook Gen 4','LNV-100E-G4',450000,24,40),
  ('LAPTOP','HP','ProBook 440 G10','HP-PB440-G10',1150000,36,10),
  ('LAPTOP','Dell','Latitude 3440','DELL-LAT3440',1020000,36,10),
  ('TABLET','Samsung','Galaxy Tab A9','SAM-TABA9',320000,12,15),
  ('TABLET-LTE','Samsung','Galaxy Tab A9+ LTE','SAM-TABA9P-LTE',480000,12,5),
  ('ACCESSORY','Generic','Laptop Carry Bag','GEN-BAG-15',25000,6,0)
) as x(cat, mfr, model, code, price, warranty, low) join public.device_categories c on c.code = x.cat;

-- Devices with unique fictional serials
create temporary table seed_devices as
select x.wh, x.model_code, x.prefix || lpad(g::text, 6, '0') as serial, x.loc
from (values
  ('JHB-01','LNV-100E-G4','PF4J',120,'A-01-01'),
  ('JHB-01','HP-PB440-G10','5CG',40,'A-01-02'),
  ('JHB-01','SAM-TABA9','R9TJ',30,'A-02-01'),
  ('DBN-01','LNV-100E-G4','PF4D',60,'A-01-01'),
  ('DBN-01','DELL-LAT3440','DLD',20,'A-01-02'),
  ('CPT-01','LNV-100E-G4','PF4C',40,'A-01-01'),
  ('CPT-01','DELL-LAT3440','DLC',20,'A-01-02')
) as x(wh, model_code, prefix, qty, loc)
cross join lateral generate_series(1, x.qty) g;

-- The two serials used in the anti-swap demonstration
insert into seed_devices values ('JHB-01','LNV-100E-G4','ABC123','B-01-01'), ('JHB-01','LNV-100E-G4','XYZ789','B-01-01');

insert into public.devices (asset_tag, model_id, category_id, manufacturer, serial_number, barcode_value, status, condition,
                            warehouse_id, location_id, supplier_id, acquisition_reference, purchase_date, unit_cost_cents,
                            warranty_expires_on, received_at, last_verified_at)
select app_private.next_document_number('asset_tag'), m.id, m.category_id, m.manufacturer, s.serial, s.serial, 'available', 'new',
       w.id, l.id, (select id from public.suppliers where code = 'SUP-TECHDIST'), 'PO-DEMO-2026-001',
       date '2026-02-01', round(m.unit_price_cents * 0.8)::bigint, date '2026-02-01' + make_interval(months => m.warranty_months),
       now() - interval '60 days', now() - interval '30 days'
from seed_devices s
join public.device_models m on m.model_code = s.model_code
join public.warehouses w on w.code = s.wh
join public.warehouse_locations l on l.warehouse_id = w.id and l.code = s.loc
order by s.wh, s.model_code, s.serial;

insert into public.device_movements (device_id, movement_type, to_status, to_warehouse_id, to_location_id, reference, reason, performed_at)
select id, 'registered', 'available', warehouse_id, location_id, 'PO-DEMO-2026-001', 'Initial demo stock import', now() - interval '60 days'
from public.devices;

-- IMEIs for LTE tablets would be registered through receiving; none seeded.
drop table seed_devices;

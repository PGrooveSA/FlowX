-- Stock Room look: black is the main colour. Only switch installations still on the old default blue.
update public.system_settings set value = '"#1d1d1b"'
where key = 'org.primary_color' and value = '"#1d4ed8"';
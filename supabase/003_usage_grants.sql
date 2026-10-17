-- The generate function records pages used per month with the server (service_role) key.
-- Automatic exposure is off, so give that role access to the usage table explicitly.
grant select, insert, update on usage to service_role;

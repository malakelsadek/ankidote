-- The monthly limit now counts AI questions written, not slide pages.
alter table usage rename column pages to questions;

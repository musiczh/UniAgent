-- Apply only after the core migration. The job acts on the three monitoring data tables only.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('uniagent-monitor-retention', '17 3 * * *', 'select public.monitor_prune()');

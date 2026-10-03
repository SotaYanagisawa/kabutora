import type { MarketRefreshJob } from "../../server-market-types";
import { canonicalDomainSecurityId } from "@kabutora/domain";
import { marketProviderPolicy } from "./provider-policy";
export type SqlLike = {
    exec<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...bindings: Array<string | number | null>): {
        toArray(): T[];
        rowsRead?: number;
        rowsWritten?: number;
    };
};
export type DurableJob = {
    id: string;
    body: string;
    status: string;
    attempts: number;
    due: number;
    lease: number;
    run_id: string;
};
const DAY = 86400000;
export const PROVIDER_ATTEMPTS_PER_DAY = 12000;
/** Synchronous SQLite operations reserve before yielding, even across concurrent requests. */
export class CoordinatorStore {
    private rawSql: SqlLike;
    private sqliteDay = "";
    private sqliteUsage = { reads: 0, writes: 0, measured: false };
    private d1Totals = new Map<string, {
        reads: number;
        writes: number;
    }>();
    constructor(private sql: SqlLike) {
        this.rawSql = sql;
        sql.exec(`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, body TEXT NOT NULL, run_id TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL, lease INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status,due);
      CREATE INDEX IF NOT EXISTS jobs_run ON jobs(run_id);
      CREATE TABLE IF NOT EXISTS job_runs (run_id TEXT NOT NULL, job_id TEXT NOT NULL, PRIMARY KEY(run_id,job_id));
      CREATE TABLE IF NOT EXISTS resource_jobs (resource_key TEXT PRIMARY KEY, job_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS budget (day TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, jobs INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS providers (host TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS provider_budget (day TEXT NOT NULL,provider TEXT NOT NULL,attempts INTEGER NOT NULL,PRIMARY KEY(day,provider));
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
        this.sql = { exec: <T extends Record<string, unknown>>(query: string, ...bindings: Array<string | number | null>) => {
                this.resetUsageDay();
                const cursor = this.rawSql.exec<T>(query, ...bindings), rows = cursor.toArray();
                if (typeof cursor.rowsRead === "number" && typeof cursor.rowsWritten === "number") {
                    this.sqliteUsage.measured = true;
                    this.sqliteUsage.reads += cursor.rowsRead;
                    this.sqliteUsage.writes += cursor.rowsWritten;
                }
                return { toArray: () => rows };
            } };
    }
    private resetUsageDay() {
        const day = new Date().toISOString().slice(0, 10);
        if (day === this.sqliteDay)
            return;
        this.sqliteDay = day;
        const row = this.rawSql.exec<{
            value: string;
        }>("SELECT value FROM metadata WHERE key=?", `sqlite:${day}`).toArray()[0];
        this.sqliteUsage = row ? JSON.parse(row.value) : { reads: 0, writes: 0, measured: false };
    }
    sqliteBudgetAvailable() { this.resetUsageDay(); return this.sqliteUsage.reads < 990000 && this.sqliteUsage.writes < 39000; }
    d1Usage(day: string) {
        let totals = this.d1Totals.get(day);
        if (!totals) {
            totals = JSON.parse(this.metadata(`d1:${day}`) ?? '{"reads":0,"writes":0}');
            this.d1Totals.set(day, totals!);
        }
        return totals!;
    }
    flushUsage() {
        this.resetUsageDay();
        for (const [day, totals] of this.d1Totals) {
            if (day < new Date(Date.now() - DAY).toISOString().slice(0, 10)) {
                this.d1Totals.delete(day);
                continue;
            }
            this.sql.exec("INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", `d1:${day}`, JSON.stringify(totals));
        }
        // Include counter checkpoint overhead conservatively, without one extra
        // durable write for every D1 query or SQL statement.
        this.sqliteUsage.writes += 2;
        this.rawSql.exec("INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", `sqlite:${this.sqliteDay}`, JSON.stringify(this.sqliteUsage));
    }
    metadata(key: string) {
        return this.sql.exec<{
            value: string;
        }>("SELECT value FROM metadata WHERE key=?", key).toArray()[0]?.value;
    }
    setMetadata(key: string, value: string) { this.sql.exec("INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value); }
    admit(job: MarketRefreshJob, now = Date.now()) {
        if (!this.sqliteBudgetAvailable())
            throw new Error("sqlite_daily_budget_deferred");
        const bucket = `${job.kind}:parser-3:${job.scheduledAt.slice(0, 16)}:`;
        const requested = [...new Set(job.securityIds.map(canonicalDomainSecurityId))];
        const keys = requested.length ? requested.map(id => bucket + id) : [bucket + "shared"];
        const existing = this.sql.exec<{
            resource_key: string;
            job_id: string;
        }>("SELECT resource_key,job_id FROM resource_jobs WHERE resource_key IN (SELECT value FROM json_each(?))", JSON.stringify(keys)).toArray();
        for (const row of existing)
            this.sql.exec("INSERT OR IGNORE INTO job_runs VALUES (?,?)", job.runId, row.job_id);
        const known = new Set(existing.map(row => row.resource_key));
        if (keys.every(key => known.has(key)))
            return 0;
        const ids = [requested.filter(id => !known.has(bucket + id))];
        let admitted = 0;
        const day = new Date(now).toISOString().slice(0, 10);
        this.sql.exec("INSERT OR IGNORE INTO budget(day) VALUES (?)", day);
        for (const securityIds of ids) {
            const id = `${job.kind}:parser-2:${job.scheduledAt.slice(0, 16)}:${securityIds.map(canonicalDomainSecurityId).sort().join("|")}`;
            if (this.sql.exec("SELECT id FROM jobs WHERE id=?", id).toArray().length) {
                this.sql.exec("INSERT OR IGNORE INTO job_runs VALUES (?,?)", job.runId, id);
                continue;
            }
            const usage = this.sql.exec<{
                jobs: number;
            }>("SELECT jobs FROM budget WHERE day=?", day).toArray()[0];
            if (usage.jobs >= 2500)
                break;
            this.sql.exec("INSERT INTO jobs(id,body,run_id,status,due) VALUES (?,?,?,'queued',?)", id, JSON.stringify({ ...job, claimId: id, securityIds }), job.runId, now);
            this.sql.exec("UPDATE budget SET jobs=jobs+1 WHERE day=?", day);
            this.sql.exec("INSERT OR IGNORE INTO job_runs VALUES (?,?)", job.runId, id);
            for (const key of securityIds.length ? securityIds.map(instrument => bucket + instrument) : [bucket + "shared"])
                this.sql.exec("INSERT OR IGNORE INTO resource_jobs VALUES (?,?)", key, id);
            admitted++;
        }
        return admitted;
    }
    claim(now = Date.now()): DurableJob | undefined {
        const job = this.sql.exec<DurableJob>(`SELECT * FROM jobs WHERE (status IN ('queued','retry_at','budget_deferred') AND due<=?) OR (status='running' AND lease<=?) ORDER BY CASE json_extract(body,'$.kind') WHEN 'manual' THEN 0 WHEN 'quotes' THEN 1 WHEN 'benchmarks' THEN 2 ELSE 3 END,due LIMIT 1`, now, now).toArray()[0];
        if (!job)
            return;
        this.sql.exec("UPDATE jobs SET status='running',attempts=attempts+1,lease=? WHERE id=?", now + 120000, job.id);
        return { ...job, attempts: job.attempts + 1 };
    }
    finish(id: string, status: string, due = Date.now()) { this.sql.exec("UPDATE jobs SET status=?,due=?,lease=0 WHERE id=?", status, due, id); }
    retrySubset(id: string, job: MarketRefreshJob, securityIds: string[], due: number) {
        this.sql.exec("UPDATE jobs SET body=?,status='retry_at',due=?,lease=0 WHERE id=?", JSON.stringify({ ...job, securityIds }), due, id);
    }
    diagnostics(now = Date.now()) {
        const day = new Date(now).toISOString().slice(0, 10);
        const jobs = this.sql.exec<{
            status: string;
            count: number;
        }>("SELECT status,COUNT(*) AS count FROM jobs GROUP BY status").toArray();
        const budget = this.sql.exec<{
            attempts: number;
            jobs: number;
        }>("SELECT attempts,jobs FROM budget WHERE day=?", day).toArray()[0] ?? { attempts: 0, jobs: 0 };
        return { schemaVersion: 2, day, jobs, providerAttempts: budget.attempts, admittedJobs: budget.jobs,
            d1: this.d1Usage(day), sqlite: { ...this.sqliteUsage },
            lastAlarmAt: this.metadata("lastAlarmAt") ?? null, lastPublicationAt: this.metadata("lastPublicationAt") ?? null,
            storageBlockedUntil: Number(this.metadata("storage:blockedUntil") ?? 0), providerBlockedUntil: Number(this.metadata("provider:blockedUntil") ?? 0) };
    }
    reserve(host: string, now = Date.now()) {
        if (!this.sqliteBudgetAvailable())
            throw new Error("sqlite_daily_budget_deferred");
        const health = this.sql.exec<{
            retry_at: number;
        }>("SELECT retry_at FROM providers WHERE host=?", host).toArray()[0];
        if (health && health.retry_at > now)
            throw new Error("provider_cooldown");
        const day = new Date(now).toISOString().slice(0, 10);
        this.sql.exec("INSERT OR IGNORE INTO budget(day) VALUES (?)", day);
        const current = this.sql.exec<{
            attempts: number;
        }>("SELECT attempts FROM budget WHERE day=?", day).toArray()[0];
        if (current.attempts >= PROVIDER_ATTEMPTS_PER_DAY) {
            this.setMetadata("provider:blockedUntil", String(Math.floor(now / DAY) * DAY + DAY + 60000));
            throw new Error("provider_budget_deferred");
        }
        const policy = marketProviderPolicy(host);
        if (policy) {
            const usage = this.sql.exec<{
                attempts: number;
            }>("SELECT attempts FROM provider_budget WHERE day=? AND provider=?", day, policy.id).toArray()[0]?.attempts ?? 0;
            if (usage >= policy.attemptsPerDay) {
                this.outcome(host, 429, now);
                throw new Error("provider_daily_budget_deferred");
            }
            this.sql.exec("INSERT INTO provider_budget VALUES (?,?,1) ON CONFLICT(day,provider) DO UPDATE SET attempts=attempts+1", day, policy.id);
        }
        this.sql.exec("UPDATE budget SET attempts=attempts+1 WHERE day=?", day);
    }
    outcome(host: string, status: number, now = Date.now()) {
        if (status === 429 || status >= 500) {
            this.sql.exec("INSERT INTO providers(host,failures,retry_at) VALUES (?,1,?) ON CONFLICT(host) DO UPDATE SET failures=MIN(failures+1,8),retry_at=?+MIN(3600000,60000*(1<<MIN(failures,6)))", host, now + 60000, now);
        }
        else if (status < 400)
            this.sql.exec("DELETE FROM providers WHERE host=?", host);
    }
    published(kind: string, changed: boolean) {
        this.sql.exec("UPDATE jobs SET status=CASE WHEN status='publishing_partial' THEN 'partial' ELSE ? END,due=?,lease=0 WHERE status IN ('publishing','publishing_partial') AND json_extract(body,'$.kind')=?", changed ? "succeeded_changed" : "succeeded_unchanged", Date.now(), kind);
    }
    progress(runId: string) {
        const rows = this.sql.exec<{
            status: string;
            count: number;
        }>("SELECT jobs.status,COUNT(*) AS count FROM jobs JOIN job_runs ON job_runs.job_id=jobs.id WHERE job_runs.run_id=? GROUP BY jobs.status", runId).toArray();
        const pending = rows.filter((row) => ["queued", "running", "publishing", "publishing_partial", "retry_at", "budget_deferred"].includes(row.status)).reduce((n, row) => n + row.count, 0);
        const failed = rows.filter((row) => row.status === "failed" || row.status === "partial").reduce((n, row) => n + row.count, 0);
        const budgetDeferred = rows.filter(row => row.status === "budget_deferred").reduce((sum, row) => sum + row.count, 0);
        return { runId, status: !rows.length ? "unknown" : pending ? "pending" : failed ? "partial" : "complete", pending, failed, budgetDeferred };
    }
    nextDue(now = Date.now()) {
        const row = this.sql.exec<{
            due: number | null;
        }>("SELECT MIN(CASE WHEN status='running' THEN lease ELSE due END) AS due FROM jobs WHERE status IN ('queued','running','publishing','publishing_partial','retry_at','budget_deferred')").toArray()[0];
        return Math.max(now + 1000, Math.min(row?.due ?? now + 60000, now + 60000));
    }
    cleanup(now = Date.now()) {
        this.sql.exec("DELETE FROM jobs WHERE status IN ('succeeded_changed','succeeded_unchanged','partial','failed') AND due<?", now - 2 * DAY);
        this.sql.exec("DELETE FROM metadata WHERE key LIKE 'd1:%' AND key<?", `d1:${new Date(now - 7 * DAY).toISOString().slice(0, 10)}`);
        this.sql.exec("DELETE FROM metadata WHERE key LIKE 'sqlite:%' AND key<?", `sqlite:${new Date(now - 7 * DAY).toISOString().slice(0, 10)}`);
        this.sql.exec("DELETE FROM job_runs WHERE job_id NOT IN (SELECT id FROM jobs)");
        this.sql.exec("DELETE FROM resource_jobs WHERE job_id NOT IN (SELECT id FROM jobs)");
        this.sql.exec("DELETE FROM budget WHERE day<?", new Date(now - 7 * DAY).toISOString().slice(0, 10));
        this.sql.exec("DELETE FROM provider_budget WHERE day<?", new Date(now - 7 * DAY).toISOString().slice(0, 10));
    }
}

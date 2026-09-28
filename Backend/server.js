const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());


// ===============================
// PostgreSQL CONNECTION
// ===============================

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT
});


// ===============================
// SCHEMA CHECK (runs once on boot)
//
// Adds nullable, additive columns that features below need.
// IF NOT EXISTS makes this safe to run on every restart - it never
// touches existing columns or data, and does nothing once the
// columns are already there.
//
// NOTE: tasks.actual_date and tasks.priority were already added
// manually (per project instructions) - they are intentionally NOT
// repeated here to avoid a redundant migration. This block only
// keeps the two additive columns from the previous deploy.
//
// task_revisions.planned_date
//   Needed so "Revision History" can show what the planned date was
//   changed TO at each revision.
//
// tasks.created_at
//   Needed for the "Assigned Date" column in Doer History.
// ===============================

async function ensureSchema() {

    try {

        await pool.query(`
            ALTER TABLE task_revisions
            ADD COLUMN IF NOT EXISTS planned_date DATE
        `);

        await pool.query(`
            ALTER TABLE tasks
            ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        `);

        console.log("Schema check complete.");

    } catch (error) {

        console.error("Schema check failed:", error);

    }

}

ensureSchema();


// ===============================
// HELPERS
// ===============================

const ALLOWED_PRIORITIES = ["High", "Medium", "Low"];

// Detects a leading date such as "21-09-2026" or "08/10/2026" at the
// very start of a task description and returns it as YYYY-MM-DD, or
// null if no recognizable leading date is present. The original task
// text is never modified by this - it is only used to derive
// actual_date on NEW inserts.
function extractLeadingDate(text) {

    if (!text || typeof text !== "string") return null;

    const match = text.trim().match(/^(\d{1,2})[\-\/](\d{1,2})[\-\/](\d{4})/);

    if (!match) return null;

    const day = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const year = parseInt(match[3], 10);

    if (month < 1 || month > 12) return null;
    if (day < 1 || day > 31) return null;
    if (year < 1000 || year > 9999) return null;

    const mm = String(month).padStart(2, "0");
    const dd = String(day).padStart(2, "0");

    return `${year}-${mm}-${dd}`;
}

function normalizePriority(value) {
    return ALLOWED_PRIORITIES.includes(value) ? value : "Medium";
}

const TASK_PRIORITY_ORDER_SQL = `
    CASE t.priority
        WHEN 'High' THEN 1
        WHEN 'Medium' THEN 2
        WHEN 'Low' THEN 3
        ELSE 4
    END
`;


// ===============================
// WKNDOT HELPERS
//
// WKNDOT ("Weekly Work Not Done On Time") always works on
// Monday -> Saturday weeks, which is intentionally different from
// the Monday -> Sunday weeks used by the existing Dashboard date
// filter. These two week definitions are kept completely separate
// so this feature can never change the Dashboard's own math.
//
// Postgres ISODOW returns 1 = Monday ... 7 = Sunday, so the Monday
// of the week containing a date is: date - (ISODOW - 1) days, and
// the Saturday of that same week is Monday + 5 days.
// ===============================

// Returns a SQL fragment (as text) that evaluates to the DATE of
// the Monday of the Mon-Sat week containing `dateExpr`. `dateExpr`
// must already be a valid SQL date expression (a placeholder like
// $1::date, or a column, or CURRENT_DATE).
function weekStartSQL(dateExpr) {
    return `(${dateExpr} - ((EXTRACT(ISODOW FROM ${dateExpr})::int - 1) || ' days')::interval)::date`;
}

// Returns a SQL fragment for the Saturday (Monday + 5 days) of the
// Mon-Sat week containing `dateExpr`.
function weekEndSQL(dateExpr) {
    return `(${weekStartSQL(dateExpr)} + interval '5 days')::date`;
}

// node-postgres returns DATE columns as JS Date objects (UTC
// midnight). This normalizes any of {Date object, ISO string,
// null} down to a plain "YYYY-MM-DD" string so week boundaries can
// be compared with simple ===.
function toISODate(value) {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString().split("T")[0];
    return String(value).split("T")[0];
}

// Accepts any of the wordings the frontend/spec use for the two
// WKNDOT outcomes and normalizes them to the two values actually
// stored in wkndot_reviews.review_status.
function normalizeWkndotDecision(value) {
    if (value === "Negative" || value === "MARK_NEGATIVE") return "Negative";
    if (value === "Non-Negative" || value === "DO_NOT_MARK_NEGATIVE") return "Non-Negative";
    return null;
}


// ===============================
// BASIC TEST
// ===============================

app.get("/", (req, res) => {
    res.json({
        message: "Delegation API is running!"
    });
});


// ===============================
// TEST DATABASE
// ===============================

app.get("/api/test-db", async (req, res) => {

    try {

        const result = await pool.query("SELECT NOW()");

        res.json({
            success: true,
            message: "PostgreSQL connected!",
            time: result.rows[0].now
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            success: false,
            message: "Database connection failed"
        });

    }

});


// ===============================
// GET ALL USERS / DOERS
//
// UPDATED: now also returns phone, needed by the Daily Pending
// Tasks WhatsApp feature. This was already selected before, just
// not documented - no shape change for existing callers.
// ===============================

app.get("/api/users", async (req, res) => {

    try {

        const result = await pool.query(`
            SELECT id, name, phone, email, role
            FROM users
            ORDER BY name
        `);

        res.json(result.rows);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "Failed to fetch users"
        });

    }

});


// ===============================
// GET ALL DOERS (role = 'Doer')
// ===============================

app.get("/api/doers", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT id, name, phone FROM users WHERE role = 'Doer' ORDER BY name"
        );

        res.json(result.rows);
    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch doers"
        });
    }
});


// ===============================
// GET TODAY'S TASKS
// ===============================

app.get("/api/tasks/today", async (req, res) => {

    try {

        const result = await pool.query(`
            SELECT
                t.id,
                t.task_code,
                u.name,
                t.task,
                t.planned_date,
                t.actual_date,
                t.priority,
                t.status,
                t.total_revisions
            FROM tasks t
            JOIN users u
                ON t.user_id = u.id
            WHERE t.status = 'Pending'
              AND t.planned_date = CURRENT_DATE
            ORDER BY ${TASK_PRIORITY_ORDER_SQL}, t.id DESC
        `);

        res.json(result.rows);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "Failed to fetch today's tasks"
        });

    }

});


// ===============================
// ADD NEW TASK
//
// UPDATED: accepts an optional "priority" (High/Medium/Low, default
// Medium) and automatically derives actual_date from a leading date
// in the task text. The task text itself is stored exactly as
// given - only used to *read* a date from, never modified. This
// only ever affects brand-new inserts; nothing here touches
// existing rows.
// ===============================

app.post("/api/tasks", async (req, res) => {

    try {

        const {
            user_id,
            task,
            planned_date,
            priority
        } = req.body;


        if (!user_id || !task || !planned_date) {

            return res.status(400).json({
                error: "Doer, task and planned date are required"
            });

        }


        // Reject past dates server-side too, so the restriction
        // can't be bypassed by calling the API directly.
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const chosenDate = new Date(planned_date + "T00:00:00");

        if (chosenDate < today) {

            return res.status(400).json({
                error: "Planned date cannot be in the past"
            });

        }


        // Generate task code
        const task_code =
            Math.random().toString(36).substring(2, 9);

        const finalPriority = normalizePriority(priority);
        const actual_date = extractLeadingDate(task);


        // original_planned_date is set once, at creation, to the same
        // value as planned_date, and is never overwritten again after
        // this (see /revise below). It is what WKNDOT uses to decide
        // which Monday-Saturday week a task's commitment belongs to,
        // regardless of how many times the task is later shifted.
        const result = await pool.query(`
            INSERT INTO tasks
            (
                task_code,
                user_id,
                task,
                planned_date,
                status,
                priority,
                actual_date,
                original_planned_date
            )
            VALUES
            ($1, $2, $3, $4, 'Pending', $5, $6, $4)
            RETURNING *
        `, [
            task_code,
            user_id,
            task,
            planned_date,
            finalPriority,
            actual_date
        ]);


        res.status(201).json({
            success: true,
            message: "Task added successfully",
            task: result.rows[0]
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "Failed to add task"
        });

    }

});


// ===============================
// MARK TASK AS DONE
// ===============================

app.put("/api/tasks/:id/done", async (req, res) => {

    try {

        const { id } = req.params;


        const result = await pool.query(`
            UPDATE tasks
            SET
                status = 'Completed',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING *
        `, [id]);


        if (result.rows.length === 0) {

            return res.status(404).json({
                error: "Task not found"
            });

        }


        res.json({
            success: true,
            message: "Task marked as completed",
            task: result.rows[0]
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "Failed to complete task"
        });

    }

});


// ===============================
// GET SINGLE TASK (detail)
//
// NEW: backs the Revise modal's WKNDOT pre-check on the frontend -
// it needs original_planned_date (not returned by the list
// endpoints) to work out whether a task's original commitment falls
// inside the current WKNDOT week before the modal opens.
// ===============================

app.get("/api/tasks/:id", async (req, res) => {

    try {

        const { id } = req.params;

        const result = await pool.query(`
            SELECT
                t.id,
                t.task_code,
                t.user_id,
                u.name AS doer_name,
                t.task,
                t.planned_date,
                t.original_planned_date,
                t.actual_date,
                t.priority,
                t.status,
                t.total_revisions,
                t.created_at,
                t.updated_at
            FROM tasks t
            LEFT JOIN users u ON t.user_id = u.id
            WHERE t.id = $1
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Task not found" });
        }

        res.json(result.rows[0]);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "Failed to fetch task"
        });

    }

});


// ===============================
// REVISE TASK
//
// Also stores planned_date on the task_revisions row it inserts, so
// Revision History can show what the plan changed to.
//
// UPDATED for WKNDOT (mid-week task shifting):
//
// 1. A revision now always sets the normal task status to
//    "Week Shifted" - this was previously missing. WKNDOT
//    classification (below) is a completely separate concept and
//    NEVER touches tasks.status.
//
// 2. original_planned_date is never modified here - it stays
//    whatever it was set to when the task was created, so WKNDOT
//    always has the true original commitment date to work from,
//    no matter how many times the task is shifted afterwards.
//
// 3. If the task's original_planned_date falls inside the CURRENT
//    Monday-Saturday WKNDOT week, and no WKNDOT decision has been
//    recorded yet for that task+week, the caller must include
//    wkndot_decision ("Negative" or "Non-Negative") in the request
//    body. If it's missing, this responds 409 with
//    wkndot_required:true instead of saving anything, so the
//    frontend can show the decision prompt. If a decision already
//    exists for that task+week, it is reused and the caller is
//    never asked again - wkndot_decision is simply ignored in that
//    case (no duplicate row is ever created, enforced additionally
//    by the UNIQUE(task_id, week_start, week_end) constraint).
// ===============================

app.put("/api/tasks/:id/revise", async (req, res) => {

    try {

        const { id } = req.params;

        const {
            planned_date,
            revision_text,
            wkndot_decision
        } = req.body;


        // Reject past dates server-side too.
        if (planned_date) {

            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const chosenDate = new Date(planned_date + "T00:00:00");

            if (chosenDate < today) {

                return res.status(400).json({
                    error: "Planned date cannot be in the past"
                });

            }

        }


        const taskResult = await pool.query(`
            SELECT
                id,
                user_id,
                total_revisions,
                planned_date,
                original_planned_date,
                status
            FROM tasks
            WHERE id = $1
        `, [id]);


        if (taskResult.rows.length === 0) {

            return res.status(404).json({
                error: "Task not found"
            });

        }

        const currentTask = taskResult.rows[0];

        // Fallback for any task that predates the original_planned_date
        // column and was not covered by the migration's backfill for
        // some reason - never let this be NULL going into the WKNDOT
        // week calculation below.
        const originalDate = currentTask.original_planned_date || currentTask.planned_date;


        // ---- WKNDOT: does this revision need a decision? ----

        const weekResult = await pool.query(`
            SELECT
                ${weekStartSQL("$1::date")} AS task_week_start,
                ${weekEndSQL("$1::date")}   AS task_week_end,
                ${weekStartSQL("CURRENT_DATE")} AS current_week_start
        `, [originalDate]);

        const weekRow = weekResult.rows[0];
        const taskWeekStart = weekRow.task_week_start;
        const taskWeekEnd = weekRow.task_week_end;

        const needsWkndotDecision =
            toISODate(taskWeekStart) === toISODate(weekRow.current_week_start);

        let wkndotOutcome = null;

        if (needsWkndotDecision) {

            const existing = await pool.query(`
                SELECT review_status
                FROM wkndot_reviews
                WHERE task_id = $1 AND week_start = $2 AND week_end = $3
            `, [id, taskWeekStart, taskWeekEnd]);

            if (existing.rows.length > 0) {

                // Already classified earlier this week - never ask
                // again, just carry the existing decision through.
                wkndotOutcome = existing.rows[0].review_status;

            } else {

                const normalizedDecision = normalizeWkndotDecision(wkndot_decision);

                if (!normalizedDecision) {

                    return res.status(409).json({
                        error: "A WKNDOT decision is required for this revision",
                        wkndot_required: true,
                        week_start: toISODate(taskWeekStart),
                        week_end: toISODate(taskWeekEnd)
                    });

                }

                await pool.query(`
                    INSERT INTO wkndot_reviews
                        (task_id, doer_id, week_start, week_end, review_status, review_date, decided_mid_week)
                    VALUES
                        ($1, $2, $3, $4, $5, CURRENT_DATE, TRUE)
                    ON CONFLICT (task_id, week_start, week_end)
                    DO UPDATE SET
                        review_status = EXCLUDED.review_status,
                        updated_at = CURRENT_TIMESTAMP
                `, [id, currentTask.user_id, taskWeekStart, taskWeekEnd, normalizedDecision]);

                wkndotOutcome = normalizedDecision;

            }

        }


        const newRevisionNumber =
            currentTask.total_revisions + 1;


        await pool.query(`
            INSERT INTO task_revisions
            (
                task_id,
                revision_number,
                revision_date,
                planned_date,
                revision_text
            )
            VALUES
            ($1, $2, CURRENT_DATE, $3, $4)
        `, [
            id,
            newRevisionNumber,
            planned_date,
            revision_text || null
        ]);


        // original_planned_date is deliberately NOT in this SET list -
        // it must never change once a task exists.
        const result = await pool.query(`
            UPDATE tasks
            SET
                planned_date = $1,
                total_revisions = $2,
                status = 'Week Shifted',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $3
            RETURNING *
        `, [
            planned_date,
            newRevisionNumber,
            id
        ]);


        res.json({
            success: true,
            message: "Task revised successfully",
            task: result.rows[0],
            wkndot: needsWkndotDecision
                ? {
                    required: true,
                    decision: wkndotOutcome,
                    week_start: toISODate(taskWeekStart),
                    week_end: toISODate(taskWeekEnd)
                }
                : { required: false }
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "Failed to revise task"
        });

    }

});


// ===============================
// GET REVISION HISTORY FOR A TASK
// ===============================

app.get("/api/tasks/:id/revisions", async (req, res) => {

    try {

        const { id } = req.params;

        const result = await pool.query(`
            SELECT
                revision_number,
                revision_date,
                planned_date,
                revision_text
            FROM task_revisions
            WHERE task_id = $1
            ORDER BY revision_number ASC
        `, [id]);

        res.json(result.rows);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "Failed to fetch revision history"
        });

    }

});


// ===============================
// WKNDOT (Weekly Work Not Done On Time)
//
// New module. Nothing in this block ever writes to tasks.status -
// WKNDOT classification lives entirely in its own wkndot_reviews
// table (see the migration SQL). Weeks here are always Monday-
// Saturday, computed with weekStartSQL/weekEndSQL above - callers
// pass week_start/week_end explicitly (YYYY-MM-DD), computed on the
// frontend the same way.
//
// "Completed on time" / delay-days below use tasks.updated_at as
// the best available proxy for completion date, because the
// existing schema has no dedicated "completed_at" column and
// tasks.actual_date already means something else (a date extracted
// from the task text, not a completion date). This is a known
// limitation: if a Completed task's updated_at was touched by
// something other than the Done action, its delay figure would be
// off. Flagged here rather than silently assumed correct.
// ===============================

function requireWeekParams(req, res) {
    const { week_start, week_end } = req.query;
    if (!week_start || !week_end) {
        res.status(400).json({ error: "week_start and week_end are required (YYYY-MM-DD)" });
        return null;
    }
    return { week_start, week_end };
}

const WKNDOT_TASK_ROW_SQL = `
    SELECT
        t.id,
        t.task_code,
        t.task,
        t.user_id AS doer_id,
        u.name AS doer_name,
        t.original_planned_date,
        t.planned_date,
        t.status,
        t.priority,
        t.total_revisions,
        t.updated_at,
        wr.review_status,
        wr.review_date,
        wr.decided_mid_week,
        (t.status = 'Completed' AND t.updated_at::date <= t.original_planned_date) AS completed_on_time,
        (t.status = 'Completed' AND t.updated_at::date > t.original_planned_date) AS completed_late,
        CASE
            WHEN t.status = 'Completed' AND t.updated_at::date > t.original_planned_date
                THEN GREATEST((t.updated_at::date - t.original_planned_date)::int, 0)
        END AS delay_days,
        CASE
            WHEN t.status != 'Completed'
                THEN GREATEST((CURRENT_DATE - t.original_planned_date)::int, 0)
        END AS currently_delayed_days
    FROM tasks t
    JOIN users u ON t.user_id = u.id
    LEFT JOIN wkndot_reviews wr
        ON wr.task_id = t.id AND wr.week_start = $1 AND wr.week_end = $2
    WHERE t.original_planned_date BETWEEN $1 AND $2
`;

// ===============================
// WKNDOT: TASKS FOR A WEEK
//
// Backs the WKNDOT review screen - one row per task whose ORIGINAL
// commitment fell in the given Monday-Saturday week, each already
// carrying its classification (completed on time / already
// Negative / already Non-Negative / needs a decision).
// ===============================

app.get("/api/wkndot/tasks", async (req, res) => {

    try {

        const weekParams = requireWeekParams(req, res);
        if (!weekParams) return;

        const { week_start, week_end } = weekParams;
        const { doer_id } = req.query;

        const params = [week_start, week_end];
        let doerClause = "";

        if (doer_id) {
            params.push(doer_id);
            doerClause = ` AND t.user_id = $${params.length}`;
        }

        const result = await pool.query(`
            ${WKNDOT_TASK_ROW_SQL}
            ${doerClause}
            ORDER BY u.name, t.original_planned_date
        `, params);

        res.json(result.rows);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "Failed to fetch WKNDOT tasks"
        });

    }

});


// ===============================
// WKNDOT: DECISION LOOKUP (single task + week)
//
// Used by the Revise modal to check - before showing the mid-week
// WKNDOT prompt - whether this task already has a decision for its
// current-week WKNDOT window, so it never asks twice.
// ===============================

app.get("/api/wkndot/decision", async (req, res) => {

    try {

        const { task_id, week_start, week_end } = req.query;

        if (!task_id || !week_start || !week_end) {
            return res.status(400).json({
                error: "task_id, week_start and week_end are required"
            });
        }

        const result = await pool.query(`
            SELECT review_status, review_date, decided_mid_week
            FROM wkndot_reviews
            WHERE task_id = $1 AND week_start = $2 AND week_end = $3
        `, [task_id, week_start, week_end]);

        if (result.rows.length === 0) {
            return res.json({ review_status: null });
        }

        res.json(result.rows[0]);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "Failed to fetch WKNDOT decision"
        });

    }

});


// ===============================
// WKNDOT: SUBMIT A REVIEW DECISION
//
// Used both by the Monday review screen (Negative / Non-Negative
// buttons on tasks that still need a decision) and, indirectly, is
// the same shape of record the mid-week Revise flow writes. Upserts
// on (task_id, week_start, week_end), so this can never create a
// duplicate WKNDOT record for the same task+week - calling it again
// for an already-decided task simply updates that one row.
// ===============================

app.post("/api/wkndot/review", async (req, res) => {

    try {

        const { task_id, week_start, week_end, review_status, reviewed_by } = req.body;

        const normalizedDecision = normalizeWkndotDecision(review_status);

        if (!task_id || !week_start || !week_end || !normalizedDecision) {
            return res.status(400).json({
                error: "task_id, week_start, week_end and a valid review_status ('Negative' or 'Non-Negative') are required"
            });
        }

        const taskResult = await pool.query(`
            SELECT id, user_id FROM tasks WHERE id = $1
        `, [task_id]);

        if (taskResult.rows.length === 0) {
            return res.status(404).json({ error: "Task not found" });
        }

        const doer_id = taskResult.rows[0].user_id;

        const result = await pool.query(`
            INSERT INTO wkndot_reviews
                (task_id, doer_id, week_start, week_end, review_status, review_date, decided_mid_week, reviewed_by)
            VALUES
                ($1, $2, $3, $4, $5, CURRENT_DATE, FALSE, $6)
            ON CONFLICT (task_id, week_start, week_end)
            DO UPDATE SET
                review_status = EXCLUDED.review_status,
                reviewed_by = EXCLUDED.reviewed_by,
                updated_at = CURRENT_TIMESTAMP
            RETURNING *
        `, [task_id, doer_id, week_start, week_end, normalizedDecision, reviewed_by || null]);

        res.json({
            success: true,
            message: "WKNDOT decision saved",
            review: result.rows[0]
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "Failed to save WKNDOT decision"
        });

    }

});


// ===============================
// WKNDOT: SUMMARY (per Doer, for a week)
//
// One row per Doer who had at least one task due in the given week.
// Backs both the single-Doer summary cards and the All-Doers report
// table - the caller just filters by doer_id or not.
//
// WKNDOT % = Completed On Time / Total Tasks Due x 100 (per spec -
// Non-Negative is explicitly NOT counted as on-time here).
// Negative Rate = Negative / Total Tasks Due x 100, tracked
// separately so a Non-Negative task is never treated as a failure.
// ===============================

app.get("/api/wkndot/summary", async (req, res) => {

    try {

        const weekParams = requireWeekParams(req, res);
        if (!weekParams) return;

        const { week_start, week_end } = weekParams;
        const { doer_id } = req.query;

        const params = [week_start, week_end];
        let doerClause = "";

        if (doer_id) {
            params.push(doer_id);
            doerClause = ` AND u.id = $${params.length}`;
        }

        const result = await pool.query(`
            SELECT
                u.id AS doer_id,
                u.name AS doer_name,
                COUNT(t.id) AS total_due,
                COUNT(*) FILTER (
                    WHERE t.status = 'Completed' AND t.updated_at::date <= t.original_planned_date
                ) AS completed_on_time,
                COUNT(*) FILTER (WHERE wr.review_status = 'Negative') AS negative,
                COUNT(*) FILTER (WHERE wr.review_status = 'Non-Negative') AS non_negative,
                COUNT(*) FILTER (
                    WHERE wr.review_status IS NULL
                      AND NOT (t.status = 'Completed' AND t.updated_at::date <= t.original_planned_date)
                ) AS pending_review,
                ROUND(AVG(
                    CASE
                        WHEN t.status = 'Completed' AND t.updated_at::date > t.original_planned_date
                            THEN (t.updated_at::date - t.original_planned_date)
                    END
                ), 1) AS avg_delay,
                MAX(
                    CASE
                        WHEN t.status = 'Completed' AND t.updated_at::date > t.original_planned_date
                            THEN (t.updated_at::date - t.original_planned_date)
                    END
                ) AS max_delay
            FROM users u
            JOIN tasks t
                ON t.user_id = u.id
               AND t.original_planned_date BETWEEN $1 AND $2
            LEFT JOIN wkndot_reviews wr
                ON wr.task_id = t.id AND wr.week_start = $1 AND wr.week_end = $2
            WHERE u.role = 'Doer'
            ${doerClause}
            GROUP BY u.id, u.name
            HAVING COUNT(t.id) > 0
            ORDER BY u.name
        `, params);

        const rows = result.rows.map(row => {
            const totalDue = Number(row.total_due);
            const completedOnTime = Number(row.completed_on_time);
            const negative = Number(row.negative);

            return {
                doer_id: row.doer_id,
                doer_name: row.doer_name,
                total_due: totalDue,
                completed_on_time: completedOnTime,
                negative,
                non_negative: Number(row.non_negative),
                pending_review: Number(row.pending_review),
                wkndot_percentage: totalDue > 0 ? Math.round((completedOnTime / totalDue) * 100) : 0,
                negative_rate: totalDue > 0 ? Math.round((negative / totalDue) * 100) : 0,
                avg_delay: row.avg_delay !== null ? Number(row.avg_delay) : null,
                max_delay: row.max_delay !== null ? Number(row.max_delay) : null
            };
        });

        res.json(rows);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "Failed to fetch WKNDOT summary"
        });

    }

});


// ===============================
// WKNDOT: FULL REPORT (summary + detail, for Print/PDF)
//
// With doer_id: one doer's summary row plus their full task detail
// list for that week (drives the single-Doer printable report).
// Without doer_id: every Doer's summary row only, for the All-Doers
// report table - matches the spec's "do not download the entire
// tasks database to the browser" instruction, since the per-task
// detail rows are only fetched when a single Doer is in view.
// ===============================

app.get("/api/wkndot/report", async (req, res) => {

    try {

        const weekParams = requireWeekParams(req, res);
        if (!weekParams) return;

        const { week_start, week_end } = weekParams;
        const { doer_id } = req.query;

        const params = [week_start, week_end];
        let doerClause = "";

        if (doer_id) {
            params.push(doer_id);
            doerClause = ` AND u.id = $${params.length}`;
        }

        const summaryResult = await pool.query(`
            SELECT
                u.id AS doer_id,
                u.name AS doer_name,
                COUNT(t.id) AS total_due,
                COUNT(*) FILTER (
                    WHERE t.status = 'Completed' AND t.updated_at::date <= t.original_planned_date
                ) AS completed_on_time,
                COUNT(*) FILTER (WHERE wr.review_status = 'Negative') AS negative,
                COUNT(*) FILTER (WHERE wr.review_status = 'Non-Negative') AS non_negative,
                COUNT(*) FILTER (
                    WHERE wr.review_status IS NULL
                      AND NOT (t.status = 'Completed' AND t.updated_at::date <= t.original_planned_date)
                ) AS pending_review,
                ROUND(AVG(
                    CASE
                        WHEN t.status = 'Completed' AND t.updated_at::date > t.original_planned_date
                            THEN (t.updated_at::date - t.original_planned_date)
                    END
                ), 1) AS avg_delay,
                MAX(
                    CASE
                        WHEN t.status = 'Completed' AND t.updated_at::date > t.original_planned_date
                            THEN (t.updated_at::date - t.original_planned_date)
                    END
                ) AS max_delay
            FROM users u
            JOIN tasks t
                ON t.user_id = u.id
               AND t.original_planned_date BETWEEN $1 AND $2
            LEFT JOIN wkndot_reviews wr
                ON wr.task_id = t.id AND wr.week_start = $1 AND wr.week_end = $2
            WHERE u.role = 'Doer'
            ${doerClause}
            GROUP BY u.id, u.name
            HAVING COUNT(t.id) > 0
            ORDER BY u.name
        `, params);

        const summary = summaryResult.rows.map(row => {
            const totalDue = Number(row.total_due);
            const completedOnTime = Number(row.completed_on_time);
            const negative = Number(row.negative);

            return {
                doer_id: row.doer_id,
                doer_name: row.doer_name,
                total_due: totalDue,
                completed_on_time: completedOnTime,
                negative,
                non_negative: Number(row.non_negative),
                pending_review: Number(row.pending_review),
                wkndot_percentage: totalDue > 0 ? Math.round((completedOnTime / totalDue) * 100) : 0,
                negative_rate: totalDue > 0 ? Math.round((negative / totalDue) * 100) : 0,
                avg_delay: row.avg_delay !== null ? Number(row.avg_delay) : null,
                max_delay: row.max_delay !== null ? Number(row.max_delay) : null
            };
        });

        let tasks = [];

        if (doer_id) {
            const taskResult = await pool.query(`
                ${WKNDOT_TASK_ROW_SQL}
                AND t.user_id = $3
                ORDER BY t.original_planned_date
            `, [week_start, week_end, doer_id]);

            tasks = taskResult.rows;
        }

        res.json({
            week_start,
            week_end,
            summary,
            tasks
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "Failed to build WKNDOT report"
        });

    }

});


// ===============================
// GET TASKS (general purpose, filterable)
//
// UPDATED - this now backs the Tasks view, the Daily Pending Tasks
// view, and the clickable dashboard cards. It stays backward
// compatible: called with no "status" param it still defaults to
// Pending only, exactly like before, so any old cached frontend
// still works.
//
// Supported query params (all optional):
//   status     "Pending" | "Completed" | "Week Shifted" | "All"
//   doer_id    filter by user_id (also accepts "user_id")
//   priority   "High" | "Medium" | "Low" | "All"
//   from, to   filter by planned_date range (YYYY-MM-DD)
//   due        "today" | "overdue" (only meaningful for Pending tasks)
//
// Sort order: High -> Medium -> Low -> (NULL priority, historical
// tasks) last, then by planned_date. This never re-labels historical
// NULL-priority rows as any priority - they just sort after the
// prioritized ones.
// ===============================

app.get("/api/tasks", async (req, res) => {
    try {

        const {
            status,
            doer_id,
            user_id,
            priority,
            from,
            to,
            due
        } = req.query;

        const doerId = doer_id || user_id;

        // Preserve old default behaviour (Pending-only) when the
        // caller doesn't specify a status at all.
        const statusFilter = status || "Pending";

        const conditions = [];
        const params = [];

        if (statusFilter && statusFilter !== "All") {
            params.push(statusFilter);
            conditions.push(`t.status = $${params.length}`);
        }

        if (doerId) {
            params.push(doerId);
            conditions.push(`t.user_id = $${params.length}`);
        }

        if (priority && priority !== "All") {
            params.push(priority);
            conditions.push(`t.priority = $${params.length}`);
        }

        if (from && to) {
            params.push(from);
            params.push(to);
            conditions.push(`t.planned_date BETWEEN $${params.length - 1} AND $${params.length}`);
        }

        if (due === "today") {
            conditions.push(`t.planned_date = CURRENT_DATE`);
        } else if (due === "overdue") {
            conditions.push(`t.planned_date < CURRENT_DATE`);
        }

        const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

        const result = await pool.query(`
            SELECT
                t.id,
                t.task_code,
                u.name AS doer_name,
                u.phone AS doer_phone,
                t.task,
                t.planned_date,
                t.actual_date,
                t.priority,
                t.status,
                t.total_revisions,
                t.created_at,
                t.updated_at
            FROM tasks t
            LEFT JOIN users u ON t.user_id = u.id
            ${whereClause}
            ORDER BY ${TASK_PRIORITY_ORDER_SQL}, t.planned_date ASC
        `, params);

        res.json(result.rows);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch tasks"
        });
    }
});


// ===============================
// DASHBOARD: SUMMARY COUNTS
//
// UPDATED: also returns week_shifted as its own count, separate
// from completed/pending, per the Week Shifted requirement. Accepts
// optional ?from=&to= exactly as before.
// ===============================

app.get("/api/dashboard/summary", async (req, res) => {

    try {

        const { from, to } = req.query;
        const hasRange = Boolean(from && to);

        const result = await pool.query(`
            SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE status = 'Completed') AS completed,
                COUNT(*) FILTER (WHERE status = 'Pending') AS pending,
                COUNT(*) FILTER (WHERE status = 'Week Shifted') AS week_shifted,
                COUNT(*) FILTER (
                    WHERE status = 'Pending'
                    AND planned_date = CURRENT_DATE
                ) AS due_today,
                COUNT(*) FILTER (
                    WHERE status = 'Pending'
                    AND planned_date < CURRENT_DATE
                ) AS overdue
            FROM tasks
            ${hasRange ? "WHERE planned_date BETWEEN $1 AND $2" : ""}
        `, hasRange ? [from, to] : []);

        const row = result.rows[0];

        res.json({
            total: Number(row.total),
            completed: Number(row.completed),
            pending: Number(row.pending),
            week_shifted: Number(row.week_shifted),
            due_today: Number(row.due_today),
            overdue: Number(row.overdue)
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "Failed to fetch dashboard summary"
        });

    }

});


// ===============================
// DASHBOARD: DOER PERFORMANCE
// ===============================

app.get("/api/dashboard/doers", async (req, res) => {

    try {

        const { from, to } = req.query;
        const hasRange = Boolean(from && to);

        const result = await pool.query(`
            SELECT
                u.id,
                u.name,
                COUNT(t.id) AS total_assigned,
                COUNT(t.id) FILTER (WHERE t.status = 'Completed') AS completed,
                COUNT(t.id) FILTER (WHERE t.status = 'Pending') AS pending,
                COUNT(t.id) FILTER (WHERE t.status = 'Week Shifted') AS week_shifted
            FROM users u
            LEFT JOIN tasks t
                ON t.user_id = u.id
                ${hasRange ? "AND t.planned_date BETWEEN $1 AND $2" : ""}
            GROUP BY u.id, u.name
            ORDER BY total_assigned DESC, u.name ASC
        `, hasRange ? [from, to] : []);

        const doers = result.rows.map(row => {

            const total = Number(row.total_assigned);
            const completed = Number(row.completed);

            return {
                id: row.id,
                name: row.name,
                total_assigned: total,
                completed,
                pending: Number(row.pending),
                week_shifted: Number(row.week_shifted),
                completion_percentage:
                    total > 0
                        ? Math.round((completed / total) * 100)
                        : 0
            };

        });

        res.json(doers);

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "Failed to fetch doer performance"
        });

    }

});


// ===============================
// DASHBOARD: REVISION STATISTICS
// ===============================

app.get("/api/dashboard/revisions", async (req, res) => {

    try {

        const { from, to } = req.query;
        const hasRange = Boolean(from && to);

        const result = await pool.query(`
            SELECT
                COUNT(*) FILTER (WHERE total_revisions = 0) AS never_revised,
                COUNT(*) FILTER (WHERE total_revisions > 0) AS revised,
                COALESCE(AVG(total_revisions), 0) AS avg_revisions
            FROM tasks
            ${hasRange ? "WHERE planned_date BETWEEN $1 AND $2" : ""}
        `, hasRange ? [from, to] : []);

        const row = result.rows[0];

        res.json({
            never_revised: Number(row.never_revised),
            revised: Number(row.revised),
            avg_revisions: Number(parseFloat(row.avg_revisions).toFixed(2))
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "Failed to fetch revision statistics"
        });

    }

});


// ===============================
// DASHBOARD: TODAY'S PRIORITY
// (due today + overdue task lists)
//
// Intentionally NOT affected by the dashboard date filter - these
// are real-time operational flags, not a historical reporting
// period.
// ===============================

app.get("/api/dashboard/priority", async (req, res) => {

    try {

        const dueToday = await pool.query(`
            SELECT
                t.id,
                t.task_code,
                u.name AS doer_name,
                t.task,
                t.planned_date,
                t.priority,
                t.total_revisions
            FROM tasks t
            LEFT JOIN users u ON t.user_id = u.id
            WHERE t.status = 'Pending'
              AND t.planned_date = CURRENT_DATE
            ORDER BY ${TASK_PRIORITY_ORDER_SQL}, t.id DESC
        `);

        const overdue = await pool.query(`
            SELECT
                t.id,
                t.task_code,
                u.name AS doer_name,
                t.task,
                t.planned_date,
                t.priority,
                t.total_revisions
            FROM tasks t
            LEFT JOIN users u ON t.user_id = u.id
            WHERE t.status = 'Pending'
              AND t.planned_date < CURRENT_DATE
            ORDER BY ${TASK_PRIORITY_ORDER_SQL}, t.planned_date ASC
        `);

        res.json({
            due_today: dueToday.rows,
            overdue: overdue.rows
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "Failed to fetch today's priority"
        });

    }

});


// ===============================
// DASHBOARD: SINGLE DOER - COMPLETE HISTORY
// ===============================

app.get("/api/dashboard/doers/:id/history", async (req, res) => {

    try {

        const { id } = req.params;
        const { from, to } = req.query;
        const hasRange = Boolean(from && to);

        const doerResult = await pool.query(`
            SELECT id, name FROM users WHERE id = $1
        `, [id]);

        if (doerResult.rows.length === 0) {

            return res.status(404).json({
                error: "Doer not found"
            });

        }

        const summaryResult = await pool.query(`
            SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE status = 'Completed') AS completed,
                COUNT(*) FILTER (WHERE status = 'Pending') AS pending,
                COUNT(*) FILTER (WHERE status = 'Week Shifted') AS week_shifted,
                COUNT(*) FILTER (WHERE total_revisions > 0) AS revised,
                COUNT(*) FILTER (
                    WHERE status = 'Pending'
                    AND planned_date < CURRENT_DATE
                ) AS overdue
            FROM tasks
            WHERE user_id = $1
            ${hasRange ? "AND planned_date BETWEEN $2 AND $3" : ""}
        `, hasRange ? [id, from, to] : [id]);

        const row = summaryResult.rows[0];
        const total = Number(row.total);
        const completed = Number(row.completed);

        const tasksResult = await pool.query(`
            SELECT
                id,
                task_code,
                task,
                created_at,
                planned_date,
                actual_date,
                priority,
                status,
                total_revisions,
                updated_at
            FROM tasks
            WHERE user_id = $1
            ${hasRange ? "AND planned_date BETWEEN $2 AND $3" : ""}
            ORDER BY planned_date DESC
        `, hasRange ? [id, from, to] : [id]);

        res.json({
            doer: doerResult.rows[0],
            summary: {
                total,
                completed,
                pending: Number(row.pending),
                week_shifted: Number(row.week_shifted),
                revised: Number(row.revised),
                overdue: Number(row.overdue),
                completion_percentage:
                    total > 0
                        ? Math.round((completed / total) * 100)
                        : 0
            },
            tasks: tasksResult.rows
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "Failed to fetch doer history"
        });

    }

});


// ===============================
// START SERVER
// ===============================

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

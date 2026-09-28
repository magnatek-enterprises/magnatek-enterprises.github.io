const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config({ path: __dirname + "/.env" });

const app = express();

app.use(cors());
app.use(express.json());


// ===============================
// PostgreSQL CONNECTION
// ===============================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});


// ===============================
// SCHEMA CHECK (runs once on boot)
// Additive, safe to run on every restart.
// ===============================

async function ensureSchema() {

    try {

        await pool.query(`
            ALTER TABLE task_revisions
            ADD COLUMN IF NOT EXISTS planned_date DATE
        `);

        await pool.query(`
            ALTER TABLE task_revisions
            ADD COLUMN IF NOT EXISTS previous_planned_date DATE
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
// ===============================

function weekStartSQL(dateExpr) {
    return `(${dateExpr} - ((EXTRACT(ISODOW FROM ${dateExpr})::int - 1) || ' days')::interval)::date`;
}

function weekEndSQL(dateExpr) {
    return `(${weekStartSQL(dateExpr)} + interval '5 days')::date`;
}

function toISODate(value) {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString().split("T")[0];
    return String(value).split("T")[0];
}

function normalizeWkndotDecision(value) {
    if (value === "Negative" || value === "MARK_NEGATIVE") return "Negative";
    if (value === "Non-Negative" || value === "DO_NOT_MARK_NEGATIVE") return "Non-Negative";
    return null;
}

// ---------------------------------------------------------
// WKNDOT DEFINITIONS - SINGLE SOURCE OF TRUTH
//
// These fragments assume the tasks table is aliased "t" and that
// $1 = week_start (Monday), $2 = week_end (Saturday) in EVERY query
// that uses them. Extra parameters (e.g. doer id) always come AFTER
// $2.
//
// WKNDOT date = COALESCE(original_planned_date, planned_date), so a
// revised task stays in the week it was originally committed to.
// A task also belongs to a week if it was revised OUT of that week
// (task_revisions.previous_planned_date) within 7 days after it.
//
// Completed for the week: status Completed AND completion date
// (updated_at) <= week_end + 2 days grace.
// ---------------------------------------------------------

const WKNDOT_GRACE_DAYS = 2;

const WKNDOT_REVIEW_DATE_SQL =
    `COALESCE(t.original_planned_date, t.planned_date)`;

const WKNDOT_DATE_SQL = WKNDOT_REVIEW_DATE_SQL;

const WKNDOT_COMPLETED_SQL =
    `(t.status = 'Completed' AND t.updated_at::date <= ($2::date + ${WKNDOT_GRACE_DAYS}))`;

const WKNDOT_DELAY_SQL =
    `(t.updated_at::date - ${WKNDOT_REVIEW_DATE_SQL})`;

const WKNDOT_COMPLETED_LATE_SQL =
    `(${WKNDOT_COMPLETED_SQL} AND ${WKNDOT_DELAY_SQL} > 0)`;

// ---------------------------------------------------------
// WKNDOT SCORING
//   Green = completed / total
//   Red   = MAX(negative / total, revised / total)
// ---------------------------------------------------------

function computeWkndotScores({ totalDue, completed, negative, revised }) {

    const greenScore = totalDue > 0 ? Math.round((completed / totalDue) * 100) : 0;
    const actualRedScore = totalDue > 0 ? Math.round((negative / totalDue) * 100) : 0;
    const revisionRedScore = totalDue > 0 ? Math.round((revised / totalDue) * 100) : 0;
    const finalRedScore = Math.max(actualRedScore, revisionRedScore);

    return { greenScore, actualRedScore, revisionRedScore, finalRedScore };
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
// WKNDOT DECISION SAVE (shared by revise + review routes)
//
// UPDATE first, INSERT only if nothing was updated. This does not
// depend on which UNIQUE constraint exists on wkndot_reviews, so it
// can never raise "no unique or exclusion constraint matching the
// ON CONFLICT specification". `db` is a pool OR a checked-out client.
// The stored column is "decision"; the API exposes it as review_status.
// ===============================

async function saveWkndotDecision(db, taskId, weekStart, weekEnd, decision) {

    const updated = await db.query(`
        UPDATE wkndot_reviews
        SET decision = $3,
            week_end = $4,
            updated_at = CURRENT_TIMESTAMP
        WHERE task_id = $1 AND week_start = $2
        RETURNING task_id, week_start, week_end, decision AS review_status
    `, [taskId, weekStart, decision, weekEnd]);

    if (updated.rows.length > 0) return updated.rows[0];

    const inserted = await db.query(`
        INSERT INTO wkndot_reviews
            (task_id, week_start, week_end, decision)
        VALUES
            ($1, $2, $3, $4)
        RETURNING task_id, week_start, week_end, decision AS review_status
    `, [taskId, weekStart, weekEnd, decision]);

    return inserted.rows[0];
}


// ===============================
// REVISE TASK
//
// The WKNDOT week is the week of the date the task is being moved
// FROM (its current planned_date). One client, released exactly once
// in "finally" - no other release() calls anywhere in this route.
// ===============================

app.put("/api/tasks/:id/revise", async (req, res) => {

    const { id } = req.params;

    const {
        planned_date,
        revision_text,
        wkndot_decision
    } = req.body;

    if (!planned_date) {
        return res.status(400).json({ error: "A new planned date is required" });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (new Date(planned_date + "T00:00:00") < today) {
        return res.status(400).json({ error: "Planned date cannot be in the past" });
    }

    const client = await pool.connect();

    try {

        await client.query("BEGIN");

        const taskResult = await client.query(`
            SELECT
                id,
                total_revisions,
                planned_date::text AS planned_date_text,
                original_planned_date::text AS original_date_text
            FROM tasks
            WHERE id = $1
            FOR UPDATE
        `, [id]);

        if (taskResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: "Task not found" });
        }

        const currentTask = taskResult.rows[0];

        // Date the task is being moved FROM.
        const movedFromDate = currentTask.planned_date_text || currentTask.original_date_text;

        const weekResult = await client.query(`
            SELECT
                ${weekStartSQL("$1::date")}::text AS week_start,
                ${weekEndSQL("$1::date")}::text   AS week_end
        `, [movedFromDate]);

        const weekStart = weekResult.rows[0].week_start;
        const weekEnd = weekResult.rows[0].week_end;

        let wkndotOutcome;

        const existing = await client.query(`
            SELECT decision
            FROM wkndot_reviews
            WHERE task_id = $1 AND week_start = $2::date
        `, [id, weekStart]);

        if (existing.rows.length > 0) {

            wkndotOutcome = existing.rows[0].decision;

        } else {

            const normalizedDecision = normalizeWkndotDecision(wkndot_decision);

            if (!normalizedDecision) {

                await client.query("ROLLBACK");

                return res.status(409).json({
                    error: "A WKNDOT decision is required for this revision",
                    wkndot_required: true,
                    week_start: weekStart,
                    week_end: weekEnd
                });

            }

            const saved = await saveWkndotDecision(client, id, weekStart, weekEnd, normalizedDecision);
            wkndotOutcome = saved.review_status;

        }

        const newRevisionNumber = Number(currentTask.total_revisions || 0) + 1;

        await client.query(`
            INSERT INTO task_revisions
                (task_id, revision_number, revision_date, previous_planned_date, planned_date, revision_text)
            VALUES
                ($1, $2, CURRENT_DATE, $3::date, $4::date, $5)
        `, [
            id,
            newRevisionNumber,
            movedFromDate,
            planned_date,
            revision_text || null
        ]);

        const result = await client.query(`
            UPDATE tasks
            SET
                planned_date = $1::date,
                total_revisions = $2,
                status = 'Week Shifted',
                original_planned_date = COALESCE(original_planned_date, $4::date),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $3
            RETURNING *
        `, [
            planned_date,
            newRevisionNumber,
            id,
            movedFromDate
        ]);

        await client.query("COMMIT");

        res.json({
            success: true,
            message: "Task revised successfully",
            task: result.rows[0],
            wkndot: {
                required: true,
                decision: wkndotOutcome,
                week_start: weekStart,
                week_end: weekEnd
            }
        });

    } catch (error) {

        await client.query("ROLLBACK").catch(() => {});

        console.error("REVISE TASK ERROR:", error);

        res.status(500).json({
            error: "Failed to revise task",
            detail: error.message
        });

    } finally {

        client.release();

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
                previous_planned_date,
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
// WKNDOT
//
// EVERY query below uses the shared fragments with
//   $1 = week_start (Monday), $2 = week_end (Saturday)
// and any extra parameter (doer id / task id) is $3.
//
// A task belongs to week $1 when EITHER
//   - the week of COALESCE(original_planned_date, planned_date) is $1, OR
//   - some revision moved it FROM a date whose week is $1
//     (task_revisions.previous_planned_date).
// "Week of a date" uses the same weekStartSQL() the revise route
// uses, so the two can never disagree.
// ===============================

const WKNDOT_IN_WEEK_SQL_FINAL = `(
    ${weekStartSQL(WKNDOT_REVIEW_DATE_SQL)} = $1::date
    OR EXISTS (
        SELECT 1
        FROM task_revisions tr
        WHERE tr.task_id = t.id
          AND tr.previous_planned_date IS NOT NULL
          AND ${weekStartSQL("tr.previous_planned_date")} = $1::date
    )
)`;

// Date in THIS week the task was due: the original date if it falls
// in the week, otherwise the earliest date a revision moved it from.
const WKNDOT_DUE_IN_WEEK_SQL = `COALESCE(
    CASE WHEN ${weekStartSQL(WKNDOT_REVIEW_DATE_SQL)} = $1::date
         THEN ${WKNDOT_REVIEW_DATE_SQL} END,
    (
        SELECT MIN(tr.previous_planned_date)
        FROM task_revisions tr
        WHERE tr.task_id = t.id
          AND tr.previous_planned_date IS NOT NULL
          AND ${weekStartSQL("tr.previous_planned_date")} = $1::date
    )
)`;

function requireWeekParams(req, res) {
    const { week_start, week_end } = req.query;
    if (!week_start || !week_end) {
        res.status(400).json({ error: "week_start and week_end are required (YYYY-MM-DD)" });
        return null;
    }
    return { week_start, week_end };
}

// One row per task belonging to the week.
async function fetchWkndotTasks(weekStart, weekEnd, doerId) {

    const params = [weekStart, weekEnd];
    let doerClause = "";

    if (doerId) {
        params.push(doerId);
        doerClause = ` AND t.user_id = $${params.length}`;
    }

    const result = await pool.query(`
        SELECT
            t.id,
            t.task_code,
            t.task,
            t.user_id AS doer_id,
            u.name AS doer_name,
            ${WKNDOT_DUE_IN_WEEK_SQL} AS original_planned_date,
            t.planned_date,
            t.status,
            t.priority,
            t.total_revisions,
            t.updated_at,
            wr.decision AS review_status,
            ${WKNDOT_COMPLETED_SQL} AS completed_on_time,
            ${WKNDOT_COMPLETED_SQL} AS completed_in_window,
            ${WKNDOT_COMPLETED_LATE_SQL} AS completed_late,
            (wr.decision IS NULL) AS pending_review,
            CASE
                WHEN t.status = 'Completed' AND ${WKNDOT_DELAY_SQL} > 0
                    THEN ${WKNDOT_DELAY_SQL}
            END AS delay_days,
            CASE
                WHEN t.status != 'Completed'
                    THEN GREATEST((CURRENT_DATE - ${WKNDOT_DUE_IN_WEEK_SQL})::int, 0)
            END AS currently_delayed_days
        FROM tasks t
        JOIN users u ON t.user_id = u.id
        LEFT JOIN wkndot_reviews wr
            ON wr.task_id = t.id AND wr.week_start = $1::date
        WHERE ${WKNDOT_IN_WEEK_SQL_FINAL}
        ${doerClause}
        ORDER BY u.name, 6, t.id
    `, params);

    return result.rows;
}

// One row per doer with at least one task in the week.
// negative / non_negative / pending_review are counted from the
// saved review (or its absence) for ANY task in the week, so saving a
// review changes the counts immediately.
async function fetchWkndotSummary(weekStart, weekEnd, doerId) {

    const params = [weekStart, weekEnd];
    let doerClause = "";

    if (doerId) {
        params.push(doerId);
        doerClause = ` AND u.id = $${params.length}`;
    }

    const result = await pool.query(`
        SELECT
            u.id AS doer_id,
            u.name AS doer_name,
            COUNT(t.id) AS total_due,
            COUNT(*) FILTER (WHERE ${WKNDOT_COMPLETED_SQL}) AS completed,
            COUNT(*) FILTER (WHERE wr.decision = 'Negative') AS negative,
            COUNT(*) FILTER (WHERE wr.decision = 'Non-Negative') AS non_negative,
            COUNT(*) FILTER (WHERE wr.decision IS NULL) AS pending_review,
            COUNT(*) FILTER (WHERE NOT ${WKNDOT_COMPLETED_SQL}) AS open_tasks,
            COUNT(*) FILTER (WHERE COALESCE(t.total_revisions, 0) > 0) AS revised,
            ROUND(AVG(
                CASE WHEN ${WKNDOT_COMPLETED_LATE_SQL} THEN ${WKNDOT_DELAY_SQL} END
            ), 1) AS avg_delay,
            MAX(
                CASE WHEN ${WKNDOT_COMPLETED_LATE_SQL} THEN ${WKNDOT_DELAY_SQL} END
            ) AS max_delay
        FROM users u
        JOIN tasks t
            ON t.user_id = u.id
           AND ${WKNDOT_IN_WEEK_SQL_FINAL}
        LEFT JOIN wkndot_reviews wr
            ON wr.task_id = t.id AND wr.week_start = $1::date
        WHERE u.role = 'Doer'
        ${doerClause}
        GROUP BY u.id, u.name
        HAVING COUNT(t.id) > 0
        ORDER BY u.name
    `, params);

    return result.rows.map(row => {

        const totalDue = Number(row.total_due);
        const completed = Number(row.completed);
        const negative = Number(row.negative);
        const revised = Number(row.revised);

        const scores = computeWkndotScores({ totalDue, completed, negative, revised });

        return {
            doer_id: row.doer_id,
            doer_name: row.doer_name,
            total_due: totalDue,
            completed: completed,
            completed_on_time: completed,
            negative: negative,
            non_negative: Number(row.non_negative),
            pending_review: Number(row.pending_review),
            open_tasks: Number(row.open_tasks),
            revised_tasks: revised,
            wkndot_percentage: scores.greenScore,
            negative_rate: scores.actualRedScore,
            green_score: scores.greenScore,
            actual_red_score: scores.actualRedScore,
            revision_red_score: scores.revisionRedScore,
            final_red_score: scores.finalRedScore,
            avg_delay: row.avg_delay !== null ? Number(row.avg_delay) : null,
            max_delay: row.max_delay !== null ? Number(row.max_delay) : null
        };
    });
}

app.get("/api/wkndot/tasks", async (req, res) => {

    try {

        const weekParams = requireWeekParams(req, res);
        if (!weekParams) return;

        const rows = await fetchWkndotTasks(
            weekParams.week_start,
            weekParams.week_end,
            req.query.doer_id
        );

        res.json(rows);

    } catch (error) {

        console.error("WKNDOT TASKS ERROR:", error);

        res.status(500).json({
            error: "Failed to fetch WKNDOT tasks",
            detail: error.message
        });

    }

});

app.get("/api/wkndot/decision", async (req, res) => {

    try {

        const { task_id, week_start } = req.query;

        if (!task_id || !week_start) {
            return res.status(400).json({
                error: "task_id and week_start are required"
            });
        }

        const result = await pool.query(`
            SELECT decision AS review_status
            FROM wkndot_reviews
            WHERE task_id = $1 AND week_start = $2::date
        `, [task_id, week_start]);

        if (result.rows.length === 0) {
            return res.json({ review_status: null });
        }

        res.json(result.rows[0]);

    } catch (error) {

        console.error("WKNDOT DECISION ERROR:", error);

        res.status(500).json({
            error: "Failed to fetch WKNDOT decision",
            detail: error.message
        });

    }

});

app.post("/api/wkndot/review", async (req, res) => {

    try {

        const { task_id, week_start, week_end, review_status } = req.body;

        const normalizedDecision = normalizeWkndotDecision(review_status);

        if (!task_id || !week_start || !week_end || !normalizedDecision) {
            return res.status(400).json({
                error: "task_id, week_start, week_end and a valid review_status ('Negative' or 'Non-Negative') are required"
            });
        }

        // SAME membership fragment as summary/tasks: $1 = week_start,
        // $2 = week_end, $3 = task id. Also checks the week itself is a
        // real Monday..Saturday pair.
        const check = await pool.query(`
            SELECT
                (
                    EXTRACT(ISODOW FROM $1::date) = 1
                    AND $2::date = $1::date + 5
                    AND ${WKNDOT_IN_WEEK_SQL_FINAL}
                ) AS in_week
            FROM tasks t
            WHERE t.id = $3
        `, [week_start, week_end, task_id]);

        if (check.rows.length === 0) {
            return res.status(404).json({ error: "Task not found" });
        }

        if (!check.rows[0].in_week) {
            return res.status(400).json({
                error: "This task does not belong to the given WKNDOT week"
            });
        }

        const review = await saveWkndotDecision(pool, task_id, week_start, week_end, normalizedDecision);

        res.json({
            success: true,
            message: "WKNDOT decision saved",
            review
        });

    } catch (error) {

        console.error("WKNDOT REVIEW SAVE ERROR:", error);

        res.status(500).json({
            error: "Failed to save WKNDOT decision",
            detail: error.message
        });

    }

});

app.get("/api/wkndot/summary", async (req, res) => {

    try {

        const weekParams = requireWeekParams(req, res);
        if (!weekParams) return;

        const rows = await fetchWkndotSummary(
            weekParams.week_start,
            weekParams.week_end,
            req.query.doer_id
        );

        res.json(rows);

    } catch (error) {

        console.error("WKNDOT SUMMARY ERROR:", error);

        res.status(500).json({
            error: "Failed to fetch WKNDOT summary",
            detail: error.message
        });

    }

});

app.get("/api/wkndot/report", async (req, res) => {

    try {

        const weekParams = requireWeekParams(req, res);
        if (!weekParams) return;

        const { week_start, week_end } = weekParams;
        const { doer_id } = req.query;

        const summary = await fetchWkndotSummary(week_start, week_end, doer_id);

        const tasks = doer_id
            ? await fetchWkndotTasks(week_start, week_end, doer_id)
            : [];

        res.json({ week_start, week_end, summary, tasks });

    } catch (error) {

        console.error("WKNDOT REPORT ERROR:", error);

        res.status(500).json({
            error: "Failed to build WKNDOT report",
            detail: error.message
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

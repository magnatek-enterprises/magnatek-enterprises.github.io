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
// Every WKNDOT query below (tasks list, summary, report) is built
// from these four fragments, so no endpoint can drift into its own
// private definition. All of them assume the query aliases the
// tasks table as "t" and passes the review week as
//   $1 = week_start (Monday), $2 = week_end (Saturday).
//
// WKNDOT DATE (which week a task belongs to):
//   COALESCE(original_planned_date, planned_date)
//   - never-revised tasks have original_planned_date = NULL, so
//     planned_date is used
//   - revised tasks keep their ORIGINAL date, so they stay in the
//     week they were originally committed to, however far
//     planned_date has since been pushed out
//
// COMPLETED FOR THIS WEEK (with grace period):
//   status = 'Completed' AND updated_at::date <= week_end + 2 days
//   i.e. anytime in the week, or on either of the first two days
//   after it. Completion date is the stored updated_at (set by
//   PUT /api/tasks/:id/done) - never today's date.
//
// DELAY (days):
//   updated_at::date - WKNDOT date, only meaningful when positive.
// ---------------------------------------------------------

const WKNDOT_GRACE_DAYS = 2;

const WKNDOT_DATE_SQL = `COALESCE(t.original_planned_date, t.planned_date)`;

const WKNDOT_COMPLETED_SQL =
    `(t.status = 'Completed' AND t.updated_at::date <= ($2::date + ${WKNDOT_GRACE_DAYS}))`;

const WKNDOT_DELAY_SQL = `(t.updated_at::date - ${WKNDOT_DATE_SQL})`;

const WKNDOT_COMPLETED_LATE_SQL =
    `(${WKNDOT_COMPLETED_SQL} AND ${WKNDOT_DELAY_SQL} > 0)`;

// ---------------------------------------------------------
// WKNDOT SCORING
//
// Green Score = completed / total tasks for the week.
//
// Red Score:
//   actualRedScore   = negative / totalDue * 100
//   revisionRedScore = revisedTasks / totalDue * 100
//   finalRedScore    = MAX(actualRedScore, revisionRedScore)
//
// The revision component is purely task-count based: the number
// of tasks in the week that have been revised at least once
// (tasks.total_revisions > 0, one row per task - a task revised 3
// times still counts once) divided by the total tasks in that same
// week. There is no fixed threshold, so 3 revised tasks weigh
// differently out of 10 tasks than out of 20.
//
// >>> NEEDS CONFIRMATION: the "MAX(actual, revision)" combination
// >>> on the finalRedScore line below is carried over unchanged
// >>> from the previous server.js. If the intended rule is to ADD
// >>> the two, or to weight them, this is the one line to change.
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


        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const chosenDate = new Date(planned_date + "T00:00:00");

        if (chosenDate < today) {

            return res.status(400).json({
                error: "Planned date cannot be in the past"
            });

        }


        const task_code =
            Math.random().toString(36).substring(2, 9);

        const finalPriority = normalizePriority(priority);
        const actual_date = extractLeadingDate(task);


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
//
// Only marks the task Completed and stamps updated_at. It does NOT
// write a WKNDOT review: whether a completed task is Negative or
// Non-Negative is a human decision (wkndot_reviews via
// POST /api/wkndot/review), and until someone decides, WKNDOT
// reports it as "Pending Review". WKNDOT recognises the completion
// on its own from status + updated_at.
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

        console.error(
            "MARK TASK DONE ERROR:",
            error
        );

        res.status(500).json({

            error: "Failed to complete task",

            detail: error.message

        });

    }

});

// ===============================
// GET SINGLE TASK (detail)
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
// ===============================

app.put("/api/tasks/:id/revise", async (req, res) => {

    const client = await pool.connect();

    try {

        const { id } = req.params;

        const {
            planned_date,
            revision_text,
            wkndot_decision
        } = req.body;


        if (!planned_date) {

            client.release();

            return res.status(400).json({
                error: "A new planned date is required"
            });

        }


        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const chosenDate = new Date(planned_date + "T00:00:00");

        if (chosenDate < today) {

            client.release();

            return res.status(400).json({
                error: "Planned date cannot be in the past"
            });

        }


        await client.query("BEGIN");

        const taskResult = await client.query(`
            SELECT
                id,
                user_id,
                total_revisions,
                planned_date,
                original_planned_date,
                status
            FROM tasks
            WHERE id = $1
            FOR UPDATE
        `, [id]);


        if (taskResult.rows.length === 0) {

            await client.query("ROLLBACK");
            client.release();

            return res.status(404).json({
                error: "Task not found"
            });

        }

        const currentTask = taskResult.rows[0];

        const originalDate = currentTask.original_planned_date || currentTask.planned_date;


        const weekResult = await client.query(`
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

            // Keyed on (task_id, week_start) only - week_end is fully
            // determined by week_start for a Mon-Sat week (it's
            // always week_start + 5 days), so it is never part of
            // the identity of a WKNDOT decision.
            const existing = await client.query(`
                SELECT decision
                FROM wkndot_reviews
                WHERE task_id = $1 AND week_start = $2
            `, [id, taskWeekStart]);

            if (existing.rows.length > 0) {

                wkndotOutcome = existing.rows[0].decision;

            } else {

                const normalizedDecision = normalizeWkndotDecision(wkndot_decision);

                if (!normalizedDecision) {

                    await client.query("ROLLBACK");
                    client.release();

                    return res.status(409).json({
                        error: "A WKNDOT decision is required for this revision",
                        wkndot_required: true,
                        week_start: toISODate(taskWeekStart),
                        week_end: toISODate(taskWeekEnd)
                    });

                }

                try {

                    await client.query(`
                        INSERT INTO wkndot_reviews
                            (task_id, week_start, week_end, decision)
                        VALUES
                            ($1, $2, $3, $4)
                        ON CONFLICT (task_id, week_start)
                        DO UPDATE SET
                            decision = EXCLUDED.decision,
                            week_end = EXCLUDED.week_end,
                            updated_at = CURRENT_TIMESTAMP
                    `, [id, taskWeekStart, taskWeekEnd, normalizedDecision]);

                    wkndotOutcome = normalizedDecision;

                } catch (wkndotInsertError) {

                    // Safety net: a genuine 23505 (unique_violation)
                    // is treated as "someone already decided this" and
                    // the stored decision is reused, instead of failing
                    // the whole revision over WKNDOT bookkeeping.
                    if (wkndotInsertError.code === "23505") {

                        const retry = await client.query(`
                            SELECT decision FROM wkndot_reviews WHERE task_id = $1 AND week_start = $2
                        `, [id, taskWeekStart]);

                        wkndotOutcome = retry.rows.length > 0 ? retry.rows[0].decision : normalizedDecision;

                    } else {

                        throw wkndotInsertError;

                    }

                }

            }

        }


        const newRevisionNumber =
            currentTask.total_revisions + 1;


        await client.query(`
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


        const result = await client.query(`
            UPDATE tasks
            SET
                planned_date = $1,
                total_revisions = $2,
                status = 'Week Shifted',
                original_planned_date = COALESCE(original_planned_date, $4),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $3
            RETURNING *
        `, [
            planned_date,
            newRevisionNumber,
            id,
            currentTask.planned_date
        ]);


        await client.query("COMMIT");

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
// All queries here use the shared definitions (WKNDOT_DATE_SQL,
// WKNDOT_COMPLETED_SQL, ...) declared above with
//   $1 = week_start, $2 = week_end (and $3 = doer id when given).
// ===============================

function requireWeekParams(req, res) {
    const { week_start, week_end } = req.query;
    if (!week_start || !week_end) {
        res.status(400).json({ error: "week_start and week_end are required (YYYY-MM-DD)" });
        return null;
    }
    return { week_start, week_end };
}

// One row per task belonging to the week. Per-task fields:
//   original_planned_date : the WKNDOT date (COALESCE'd), so it is
//                           never null for never-revised tasks
//   planned_date          : current (possibly revised) planned date
//   completed_on_time     : counts as COMPLETED for this week
//                           (completed within week + 2-day grace);
//                           name kept for API compatibility
//   completed_in_window   : same value, clearer name
//   pending_review        : completed for this week, no decision yet
//   delay_days            : final delay once Completed (if late)
//   currently_delayed_days: live delay while not yet Completed
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
            ${WKNDOT_DATE_SQL} AS original_planned_date,
            ${WKNDOT_DATE_SQL} AS wkndot_date,
            t.planned_date,
            t.status,
            t.priority,
            t.total_revisions,
            t.updated_at,
            wr.decision AS review_status,
            ${WKNDOT_COMPLETED_SQL} AS completed_on_time,
            ${WKNDOT_COMPLETED_SQL} AS completed_in_window,
            ${WKNDOT_COMPLETED_LATE_SQL} AS completed_late,
            (${WKNDOT_COMPLETED_SQL} AND wr.decision IS NULL) AS pending_review,
            CASE
                WHEN t.status = 'Completed' AND ${WKNDOT_DELAY_SQL} > 0
                    THEN ${WKNDOT_DELAY_SQL}
            END AS delay_days,
            CASE
                WHEN t.status != 'Completed'
                    THEN GREATEST((CURRENT_DATE - ${WKNDOT_DATE_SQL})::int, 0)
            END AS currently_delayed_days
        FROM tasks t
        JOIN users u ON t.user_id = u.id
        LEFT JOIN wkndot_reviews wr
            ON wr.task_id = t.id AND wr.week_start = $1::date
        WHERE ${WKNDOT_DATE_SQL} BETWEEN $1::date AND $2::date
        ${doerClause}
        ORDER BY u.name, ${WKNDOT_DATE_SQL}, t.id
    `, params);

    return result.rows;
}

// One row per doer with at least one task in the week.
//   total_due          : tasks belonging to the week
//   completed_on_time  : completed within week + grace (also
//                        returned as "completed")
//   negative / non_negative : review decisions on VALID COMPLETED
//                        tasks only, so that always
//                        completed = negative + non_negative + pending_review
//   pending_review     : valid completed tasks with no review yet
//                        (never open/unfinished tasks)
//   open_tasks         : not completed for this week
//   revised_tasks      : tasks with total_revisions > 0
//   avg_delay/max_delay: over tasks completed within the window
//                        that finished after their WKNDOT date
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
            COUNT(*) FILTER (
                WHERE ${WKNDOT_COMPLETED_SQL} AND wr.decision = 'Negative'
            ) AS negative,
            COUNT(*) FILTER (
                WHERE ${WKNDOT_COMPLETED_SQL} AND wr.decision = 'Non-Negative'
            ) AS non_negative,
            COUNT(*) FILTER (
                WHERE ${WKNDOT_COMPLETED_SQL} AND wr.decision IS NULL
            ) AS pending_review,
            COUNT(*) FILTER (WHERE NOT ${WKNDOT_COMPLETED_SQL}) AS open_tasks,
            COUNT(*) FILTER (WHERE t.total_revisions > 0) AS revised,
            ROUND(AVG(
                CASE WHEN ${WKNDOT_COMPLETED_LATE_SQL} THEN ${WKNDOT_DELAY_SQL} END
            ), 1) AS avg_delay,
            MAX(
                CASE WHEN ${WKNDOT_COMPLETED_LATE_SQL} THEN ${WKNDOT_DELAY_SQL} END
            ) AS max_delay
        FROM users u
        JOIN tasks t
            ON t.user_id = u.id
           AND ${WKNDOT_DATE_SQL} BETWEEN $1::date AND $2::date
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

        const { greenScore, actualRedScore, revisionRedScore, finalRedScore } =
            computeWkndotScores({ totalDue, completed, negative, revised });

        return {
            doer_id: row.doer_id,
            doer_name: row.doer_name,
            total_due: totalDue,
            completed,
            completed_on_time: completed,
            negative,
            non_negative: Number(row.non_negative),
            pending_review: Number(row.pending_review),
            open_tasks: Number(row.open_tasks),
            revised_tasks: revised,
            wkndot_percentage: greenScore,
            negative_rate: actualRedScore,
            green_score: greenScore,
            actual_red_score: actualRedScore,
            revision_red_score: revisionRedScore,
            final_red_score: finalRedScore,
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

        console.error(error);

        res.status(500).json({
            error: "Failed to fetch WKNDOT tasks",
            detail: error.message
        });

    }

});

app.get("/api/wkndot/decision", async (req, res) => {

    try {

        const { task_id, week_start, week_end } = req.query;

        if (!task_id || !week_start || !week_end) {
            return res.status(400).json({
                error: "task_id, week_start and week_end are required"
            });
        }

        const result = await pool.query(`
            SELECT decision AS review_status
            FROM wkndot_reviews
            WHERE task_id = $1 AND week_start = $2
        `, [task_id, week_start]);

        if (result.rows.length === 0) {
            return res.json({ review_status: null });
        }

        res.json(result.rows[0]);

    } catch (error) {

        console.error(error);

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

        // The task must belong to the given week by the same WKNDOT
        // date definition used everywhere else, so a decision can
        // never be filed under the wrong week.
        const taskResult = await pool.query(`
            SELECT
                t.id,
                (${WKNDOT_DATE_SQL} BETWEEN $2::date AND $3::date) AS in_week
            FROM tasks t
            WHERE t.id = $1
        `, [task_id, week_start, week_end]);

        if (taskResult.rows.length === 0) {
            return res.status(404).json({ error: "Task not found" });
        }

        if (!taskResult.rows[0].in_week) {
            return res.status(400).json({
                error: "This task does not belong to the given WKNDOT week (based on its original planned date)"
            });
        }

        let review;

        try {

            const result = await pool.query(`
                INSERT INTO wkndot_reviews
                    (task_id, week_start, week_end, decision)
                VALUES
                    ($1, $2, $3, $4)
                ON CONFLICT (task_id, week_start)
                DO UPDATE SET
                    decision = EXCLUDED.decision,
                    week_end = EXCLUDED.week_end,
                    updated_at = CURRENT_TIMESTAMP
                RETURNING task_id, week_start, week_end, decision AS review_status
            `, [task_id, week_start, week_end, normalizedDecision]);

            review = result.rows[0];

        } catch (wkndotInsertError) {

            // Same (task_id, week_start) upsert as in the revise
            // route, with the same defensive fallback for a genuine
            // 23505 race.
            if (wkndotInsertError.code === "23505") {

                const retry = await pool.query(`
                    SELECT task_id, week_start, week_end, decision AS review_status
                    FROM wkndot_reviews
                    WHERE task_id = $1 AND week_start = $2
                `, [task_id, week_start]);

                review = retry.rows[0];

            } else {

                throw wkndotInsertError;

            }

        }

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

        console.error(error);

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

        res.json({
            week_start,
            week_end,
            summary,
            tasks
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "Failed to build WKNDOT report",
            detail: error.message
        });

    }

});


// ===============================
// GET TASKS (general purpose, filterable)
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

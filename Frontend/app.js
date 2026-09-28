const API = "https://delegation-system-1.onrender.com";

let allTasks = [];
let revisingTaskId = null;

let dashboardRange = { from: null, to: null };
let doerHistoryState = { id: null, name: null, from: null, to: null };

// Cached list of doers (id, name, phone) - used by the Tasks/Daily
// Pending doer filters and the WhatsApp feature.
let doersCache = [];

// Current Tasks-view filter state. status defaults to "Pending" to
// match the previous behaviour of this screen.
let taskFilters = {
    status: "Pending",
    doerId: "",
    priority: "All",
    due: null,
    range: { from: null, to: null }
};

let dailyPendingState = {
    doerId: null,
    doerName: null,
    doerPhone: null,
    tasks: []
};

// ---- WKNDOT state ----

let wkndotWeeks = [];               // list of { start, end, label } offered in the week select
let wkndotState = {
    weekStart: null,
    weekEnd: null,
    doerId: "",                     // "" = All Doers
    doerName: "All Doers",
    summary: [],
    tasks: []
};

// State for the Revise modal's mid-week WKNDOT prompt. Reset every
// time the modal opens (see reviseTask()).
let reviseWkndotState = {
    required: false,
    weekStart: null,
    weekEnd: null,
    existingDecision: null,   // already decided earlier this week - just display it
    chosenDecision: null      // user's choice for a brand-new decision
};


// =====================================================
// PAGE LOAD
// =====================================================

document.addEventListener("DOMContentLoaded", () => {

    // Block past dates on the Add Task calendar.
    const plannedDateInput = document.getElementById("plannedDate");
    if (plannedDateInput) {
        plannedDateInput.min = todayISO();
    }

    // Block past dates on the Revise modal calendar.
    const reviseDateInput = document.getElementById("reviseDateInput");
    if (reviseDateInput) {
        reviseDateInput.min = todayISO();
    }

    loadUsers();
    loadDoerFilterOptions();

    // Dashboard defaults to the current week (Monday - Sunday, IST).
    dashboardRange = computeRangeForKey("thisWeek");
    updateShowingLabel("dashboardShowingLabel", dashboardRange);
    loadDashboard();

    // Tasks view defaults to All Time / Pending, matching the
    // previous behaviour (Pending only) but with no date restriction.
    taskFilters.range = computeRangeForKey("allTime");

    // Close any modal on backdrop click or Escape.
    document.querySelectorAll(".modal-overlay").forEach(overlay => {
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) overlay.classList.remove("show");
        });
    });

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            document.querySelectorAll(".modal-overlay.show").forEach(overlay => {
                overlay.classList.remove("show");
            });
        }
    });
});


// =====================================================
// DATE / TIMEZONE HELPERS (Asia/Kolkata)
// =====================================================

// Returns {y, m, d} for "today" as it currently is in Asia/Kolkata,
// regardless of the visitor's own device timezone.
function getISTDateParts() {
    const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    });
    const parts = fmt.formatToParts(new Date());
    const get = (type) => Number(parts.find(p => p.type === type).value);
    return { y: get("year"), m: get("month"), d: get("day") };
}

// A UTC-midnight Date object representing today's IST calendar date.
// From here on we only do whole-day arithmetic on it, so using UTC
// getters/setters keeps it stable regardless of the browser's own
// timezone.
function istTodayAsUTCDate() {
    const { y, m, d } = getISTDateParts();
    return new Date(Date.UTC(y, m - 1, d));
}

function addDaysUTC(date, days) {
    const d = new Date(date);
    d.setUTCDate(d.getUTCDate() + days);
    return d;
}

function toISODateStr(date) {
    return date.toISOString().split("T")[0];
}

function todayISO() {
    return toISODateStr(istTodayAsUTCDate());
}

// Monday of the week containing `date` (Mon-Sun weeks, never Sun-Sat).
function mondayOfWeek(date) {
    const day = date.getUTCDay(); // 0 = Sun, 1 = Mon, ... 6 = Sat
    const offsetFromMonday = (day + 6) % 7;
    return addDaysUTC(date, -offsetFromMonday);
}

// ---- WKNDOT week helper (Mon-Sat, deliberately separate from the
// Mon-Sun week used everywhere else in this file) ----
//
// Returns { start, end } as "YYYY-MM-DD" strings for the
// Monday-Saturday WKNDOT week containing `date`. mondayOfWeek()
// above already finds the correct Monday regardless of which kind
// of week it's used for - only the end of the week differs (+5
// days here, instead of +6 for a Mon-Sun week).
function wkndotWeekOf(date) {
    const mon = mondayOfWeek(date);
    const sat = addDaysUTC(mon, 5);
    return { start: toISODateStr(mon), end: toISODateStr(sat) };
}

// Parses a "YYYY-MM-DD" (optionally with a trailing "Txx:xx:xx...")
// date string into a UTC-midnight Date, for use with wkndotWeekOf().
function parseISODateUTC(value) {
    const datePart = String(value).split("T")[0];
    const [y, m, d] = datePart.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
}

// Human label for a WKNDOT week, e.g. "21 Sep – 26 Sep 2026".
function formatWkndotWeekLabel(start, end) {
    const startDate = new Date(start);
    const endDate = new Date(end);
    const startStr = startDate.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
    const endStr = endDate.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    return `${startStr} – ${endStr}`;
}

function computeRangeForKey(key) {

    const today = istTodayAsUTCDate();

    switch (key) {

        case "today":
            return { from: toISODateStr(today), to: toISODateStr(today) };

        case "thisWeek": {
            const mon = mondayOfWeek(today);
            const sun = addDaysUTC(mon, 6);
            return { from: toISODateStr(mon), to: toISODateStr(sun) };
        }

        case "lastWeek": {
            const thisMon = mondayOfWeek(today);
            const lastMon = addDaysUTC(thisMon, -7);
            const lastSun = addDaysUTC(lastMon, 6);
            return { from: toISODateStr(lastMon), to: toISODateStr(lastSun) };
        }

        case "thisMonth": {
            const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
            const last = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
            return { from: toISODateStr(first), to: toISODateStr(last) };
        }

        case "lastMonth": {
            const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
            const last = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
            return { from: toISODateStr(first), to: toISODateStr(last) };
        }

        case "thisYear": {
            const first = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
            const last = new Date(Date.UTC(today.getUTCFullYear(), 11, 31));
            return { from: toISODateStr(first), to: toISODateStr(last) };
        }

        case "lastYear": {
            const first = new Date(Date.UTC(today.getUTCFullYear() - 1, 0, 1));
            const last = new Date(Date.UTC(today.getUTCFullYear() - 1, 11, 31));
            return { from: toISODateStr(first), to: toISODateStr(last) };
        }

        case "allTime":
        default:
            return { from: null, to: null };
    }
}

function formatDate(value) {
    if (!value) return "—";
    return new Date(value).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric"
    });
}

function formatDateTime(value) {
    if (!value) return "—";
    return new Date(value).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric"
    });
}

// Historical rows can have actual_date / priority as NULL. This is
// intentional (see project rules) - always render NULL as "—",
// never invent a value.
function formatDateOrDash(value) {
    return value ? formatDate(value) : "—";
}

function priorityOrDash(value) {
    return value || null;
}

function updateShowingLabel(elementId, range) {
    const el = document.getElementById(elementId);
    if (!el) return;

    if (!range.from || !range.to) {
        el.textContent = "Showing: All Time";
        return;
    }

    el.textContent = `Showing: ${formatDate(range.from)} – ${formatDate(range.to)}`;
}

function buildRangeQuery(range) {
    if (!range.from || !range.to) return "";
    return `?from=${range.from}&to=${range.to}`;
}


// =====================================================
// GENERAL HELPERS
// =====================================================

function escapeHTML(text) {
    const div = document.createElement("div");
    div.textContent = text ?? "";
    return div.innerHTML;
}

function initials(name) {
    if (!name) return "?";
    return name
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map(w => w[0].toUpperCase())
        .join("");
}

function isOverdue(task) {
    return task.status === "Pending" && task.planned_date && task.planned_date.split("T")[0] < todayISO();
}

function isDueToday(task) {
    return task.status === "Pending" && task.planned_date && task.planned_date.split("T")[0] === todayISO();
}

// Status badges. Completed = green, Week Shifted = yellow, Pending
// = red. Overdue gets its own visually stronger red treatment so it
// is never confused with a plain Pending task.
function statusBadge(task) {
    if (task.status === "Completed") {
        return `<span class="badge completed">Completed</span>`;
    }
    if (task.status === "Week Shifted") {
        return `<span class="badge week-shifted">Week Shifted</span>`;
    }
    if (isOverdue(task)) {
        return `<span class="badge overdue">⚠ Overdue</span>`;
    }
    if (isDueToday(task)) {
        return `<span class="badge due-today">Due Today</span>`;
    }
    return `<span class="badge pending">Pending</span>`;
}

// Priority is visually separate from status (a small square chip,
// not a status pill) so the two never get confused. Historical NULL
// priority always renders as "—", never guessed at.
function priorityBadge(priority) {
    if (!priority) {
        return `<span class="priority-chip none">—</span>`;
    }
    const cls = priority.toLowerCase();
    return `<span class="priority-chip ${cls}">${escapeHTML(priority)}</span>`;
}

function showToast(message, type = "default") {
    const stack = document.getElementById("toastStack");
    if (!stack) return;

    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;

    stack.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transition = "opacity 0.2s ease";
        setTimeout(() => toast.remove(), 200);
    }, 3200);
}

function emptyState(title, desc) {
    return `
        <div class="state-block">
            <div class="state-title">${escapeHTML(title)}</div>
            ${desc ? `<div class="state-desc">${escapeHTML(desc)}</div>` : ""}
        </div>
    `;
}

function errorState(title, desc) {
    return `
        <div class="state-block error">
            <div class="state-title">${escapeHTML(title)}</div>
            ${desc ? `<div class="state-desc">${escapeHTML(desc)}</div>` : ""}
        </div>
    `;
}


// =====================================================
// VIEW SWITCHING
// =====================================================

function showView(viewId, button) {

    document.querySelectorAll(".view").forEach(view => {
        view.classList.remove("active");
    });

    document.getElementById(viewId).classList.add("active");

    document.querySelectorAll(".nav-link").forEach(link => {
        link.classList.remove("active");
    });

    if (button) button.classList.add("active");

    if (viewId === "tasks") {
        loadTasks();
    }

    if (viewId === "followUp") {
        loadTodayTasks();
    }

    if (viewId === "dashboard") {
        loadDashboard();
    }

    if (viewId === "dailyPending") {
        loadDoerFilterOptions();
    }

    if (viewId === "wkndot") {
        loadDoerFilterOptions();
        initWkndotViewIfNeeded();
    }
}


// =====================================================
// LOAD USERS (Add Task doer dropdown)
// =====================================================

async function loadUsers() {

    const select = document.getElementById("doerSelect");
    if (!select) return;

    try {

        const response = await fetch(`${API}/api/users`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const users = await response.json();

        select.innerHTML = `<option value="">Select Doer</option>`;

        users.forEach(user => {
            const option = document.createElement("option");
            option.value = user.id;
            option.textContent = user.name;
            select.appendChild(option);
        });

    } catch (error) {

        console.error("Failed to load users:", error);
        select.innerHTML = `<option value="">Unable to load doers</option>`;
        showToast("Couldn't load the doer list. Check your connection and try again.", "error");

    }
}


// =====================================================
// LOAD DOERS (Task filter + Daily Pending selector)
// =====================================================

async function loadDoerFilterOptions() {

    const taskDoerFilter = document.getElementById("taskDoerFilter");
    const dailyPendingSelect = document.getElementById("dailyPendingDoerSelect");

    // Already loaded - do NOT rebuild the <select> options again.
    // Rebuilding them resets whichever option is currently selected
    // back to the first one, which would silently wipe out a Doer
    // filter the user had already chosen on the Tasks page (or on
    // Daily Pending) the next time this function is called from
    // another view.
    if (doersCache.length > 0) {
        return;
    }

    try {

        const response = await fetch(`${API}/api/doers`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        doersCache = await response.json();
        populateDoerSelects();

    } catch (error) {

        console.error("Failed to load doers:", error);

        if (taskDoerFilter) taskDoerFilter.innerHTML = `<option value="">All Doers</option>`;
        if (dailyPendingSelect) dailyPendingSelect.innerHTML = `<option value="">Unable to load doers</option>`;

        const wkndotDoerSelect = document.getElementById("wkndotDoerSelect");
        if (wkndotDoerSelect) wkndotDoerSelect.innerHTML = `<option value="">All Doers</option>`;

    }
}

function populateDoerSelects() {

    const taskDoerFilter = document.getElementById("taskDoerFilter");
    const dailyPendingSelect = document.getElementById("dailyPendingDoerSelect");
    const wkndotDoerSelect = document.getElementById("wkndotDoerSelect");

    if (taskDoerFilter) {
        taskDoerFilter.innerHTML = `<option value="">All Doers</option>` +
            doersCache.map(d => `<option value="${d.id}">${escapeHTML(d.name)}</option>`).join("");
    }

    if (dailyPendingSelect) {
        dailyPendingSelect.innerHTML = `<option value="">Select a doer…</option>` +
            doersCache.map(d => `<option value="${d.id}">${escapeHTML(d.name)}</option>`).join("");
    }

    if (wkndotDoerSelect) {
        wkndotDoerSelect.innerHTML = `<option value="">All Doers</option>` +
            doersCache.map(d => `<option value="${d.id}">${escapeHTML(d.name)}</option>`).join("");
    }
}


// =====================================================
// ADD TASK
// =====================================================

async function addTask() {

    const user_id = document.getElementById("doerSelect").value;
    const planned_date = document.getElementById("plannedDate").value;
    const task = document.getElementById("taskDescription").value.trim();
    const priority = document.getElementById("prioritySelect").value;
    const message = document.getElementById("addMessage");
    const btn = document.getElementById("addTaskBtn");

    message.classList.remove("show", "success", "error");

    if (!user_id || !planned_date || !task) {
        message.textContent = "Please select a doer, a planned date, and describe the task.";
        message.classList.add("show", "error");
        return;
    }

    if (planned_date < todayISO()) {
        message.textContent = "Planned date cannot be in the past.";
        message.classList.add("show", "error");
        return;
    }

    btn.disabled = true;
    btn.textContent = "Adding…";

    try {

        const response = await fetch(`${API}/api/tasks`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user_id, task, planned_date, priority })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "Failed to add task");
        }

        message.textContent = "Task added successfully.";
        message.classList.add("show", "success");

        document.getElementById("doerSelect").value = "";
        document.getElementById("plannedDate").value = "";
        document.getElementById("taskDescription").value = "";
        document.getElementById("prioritySelect").value = "Medium";

        showToast("Task added successfully.", "success");

    } catch (error) {

        console.error("ADD TASK ERROR:", error);
        message.textContent = error.message;
        message.classList.add("show", "error");

    } finally {

        btn.disabled = false;
        btn.textContent = "Add Task";

    }
}


// =====================================================
// TASKS VIEW - FILTERS
// =====================================================

function onTaskFiltersChange() {

    taskFilters.status = document.getElementById("taskStatusFilter").value;
    taskFilters.doerId = document.getElementById("taskDoerFilter").value;
    taskFilters.priority = document.getElementById("taskPriorityFilter").value;

    // A manual filter change always means "show me this exact set",
    // so any Due Today / Overdue quick-filter from a dashboard card
    // click is cleared.
    taskFilters.due = null;

    updateTasksPageSub();
    loadTasks();
}

function onTaskRangeChange() {

    const key = document.getElementById("taskRangeSelect").value;
    const customWrap = document.getElementById("taskCustomRange");

    if (key === "custom") {
        customWrap.classList.add("show");
        return;
    }

    customWrap.classList.remove("show");

    taskFilters.range = computeRangeForKey(key);
    loadTasks();
}

function applyTaskCustomRange() {

    const from = document.getElementById("taskFromInput").value;
    const to = document.getElementById("taskToInput").value;

    if (!from || !to) {
        showToast("Please choose both a from and a to date.", "error");
        return;
    }

    if (from > to) {
        showToast("The from date must be before the to date.", "error");
        return;
    }

    taskFilters.range = { from, to };
    loadTasks();
}

function updateTasksPageSub() {

    const sub = document.getElementById("tasksPageSub");
    if (!sub) return;

    if (taskFilters.due === "today") {
        sub.textContent = "Tasks due today.";
    } else if (taskFilters.due === "overdue") {
        sub.textContent = "Overdue tasks across the team.";
    } else if (taskFilters.status === "All") {
        sub.textContent = "All tasks across the team.";
    } else {
        sub.textContent = `${taskFilters.status} tasks across the team.`;
    }
}

// Sets the Tasks-view filters to match a dashboard card and switches
// to that view. Counts always come from the API - nothing here is
// hardcoded.
function onStatCardClick(card) {

    // Every card lands on the Tasks page at All Time. The dashboard's
    // own date range (whatever period is currently selected there,
    // e.g. "This Week") is a reporting filter for the dashboard only
    // and must never be carried over - otherwise a card showing
    // "Pending: 259" could take you to a filtered Tasks view that
    // only shows a handful of this week's rows, which looks like the
    // filters are broken.
    taskFilters.due = null;
    taskFilters.doerId = "";
    taskFilters.priority = "All";
    taskFilters.range = { from: null, to: null };

    switch (card) {
        case "Total":
            taskFilters.status = "All";
            break;
        case "Completed":
            taskFilters.status = "Completed";
            break;
        case "Pending":
            taskFilters.status = "Pending";
            break;
        case "WeekShifted":
            taskFilters.status = "Week Shifted";
            break;
        case "DueToday":
            taskFilters.status = "Pending";
            taskFilters.due = "today";
            break;
        case "Overdue":
            taskFilters.status = "Pending";
            taskFilters.due = "overdue";
            break;
    }

    // Reflect the new state back into the Tasks view controls.
    const statusSelect = document.getElementById("taskStatusFilter");
    const doerSelect = document.getElementById("taskDoerFilter");
    const prioritySelect = document.getElementById("taskPriorityFilter");
    const rangeSelect = document.getElementById("taskRangeSelect");
    const customWrap = document.getElementById("taskCustomRange");

    if (statusSelect) statusSelect.value = taskFilters.status;
    if (doerSelect) doerSelect.value = "";
    if (prioritySelect) prioritySelect.value = "All";
    if (rangeSelect) {
        rangeSelect.value = taskFilters.range.from ? "custom" : "allTime";
    }
    if (customWrap) customWrap.classList.remove("show");

    document.querySelectorAll(".stat-card").forEach(el => el.classList.remove("active"));
    const activeCard = document.querySelector(`.stat-card[data-card="${card}"]`);
    if (activeCard) activeCard.classList.add("active");

    updateTasksPageSub();

    const tasksNav = document.querySelector('.nav-link[data-view="tasks"]');
    showView("tasks", tasksNav);
}


// =====================================================
// LOAD TASKS (Tasks view)
// =====================================================

function buildTaskQuery() {

    const params = new URLSearchParams();

    params.set("status", taskFilters.status || "Pending");

    if (taskFilters.doerId) params.set("doer_id", taskFilters.doerId);
    if (taskFilters.priority && taskFilters.priority !== "All") params.set("priority", taskFilters.priority);
    if (taskFilters.due) params.set("due", taskFilters.due);

    if (!taskFilters.due && taskFilters.range && taskFilters.range.from && taskFilters.range.to) {
        params.set("from", taskFilters.range.from);
        params.set("to", taskFilters.range.to);
    }

    return `?${params.toString()}`;
}

async function loadTasks() {

    const table = document.getElementById("taskTable");

    try {

        const response = await fetch(`${API}/api/tasks${buildTaskQuery()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        allTasks = await response.json();
        filterTasks();

    } catch (error) {

        console.error("Failed to fetch tasks:", error);

        if (table) {
            table.innerHTML = `<tr><td colspan="9">${errorState(
                "Couldn't load tasks",
                "Check your connection and try again."
            )}</td></tr>`;
        }

    }
}


// =====================================================
// DISPLAY TASKS (table)
// =====================================================

function displayTasks(tasks) {

    const table = document.getElementById("taskTable");
    if (!table) return;

    if (!tasks || tasks.length === 0) {
        table.innerHTML = `<tr><td colspan="9">${emptyState(
            "No tasks found",
            "Nothing matches the current filters."
        )}</td></tr>`;
        return;
    }

    table.innerHTML = "";

    tasks.forEach(task => {

        const row = document.createElement("tr");
        const doerName = task.name || task.doer_name || "";
        const code = task.task_code || task.id;

        row.innerHTML = `
            <td class="mono" data-label="Task ID">${escapeHTML(code)}</td>
            <td data-label="Doer">${escapeHTML(doerName)}</td>
            <td data-label="Task">${escapeHTML(task.task || "")}</td>
            <td data-label="Actual Date">${formatDateOrDash(task.actual_date)}</td>
            <td data-label="Planned Date">${formatDate(task.planned_date)}</td>
            <td data-label="Priority">${priorityBadge(task.priority)}</td>
            <td class="mono" data-label="Revisions">${Number(task.total_revisions || 0)}</td>
            <td data-label="Status">${statusBadge(task)}</td>
            <td data-label="Actions">
                <div class="cell-actions">
                    <button class="action-btn done-btn" onclick="markDone(${task.id})">Done</button>
                    <button class="action-btn revise-btn" onclick="reviseTask(${task.id})">Revise</button>
                    <button class="action-btn history-btn" onclick="openRevisionHistory(${task.id}, '${escapeHTML(code)}', '${escapeHTML(doerName)}')">History</button>
                </div>
            </td>
        `;

        table.appendChild(row);

    });
}


// =====================================================
// SEARCH (applied on top of whatever the server returned)
// =====================================================

function filterTasks() {

    const taskText = document.getElementById("searchTask").value.toLowerCase();

    // Doer/status/priority/date are already applied server-side by
    // buildTaskQuery() + loadTasks(). This only ever narrows further
    // by task text within whatever the API already returned - it
    // never re-filters by doer, so it can't undo or conflict with
    // the Doer dropdown.
    const filtered = allTasks.filter(task => {
        const taskDescription = (task.task || "").toLowerCase();
        return taskDescription.includes(taskText);
    });

    displayTasks(filtered);
}


// =====================================================
// MARK DONE
// =====================================================

async function markDone(id) {

    if (!confirm("Mark this task as completed?")) return;

    try {

        const response = await fetch(`${API}/api/tasks/${id}/done`, { method: "PUT" });
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "Failed to complete task");
        }

        showToast("Task marked as completed.", "success");

        loadTasks();
        loadTodayTasks();

    } catch (error) {

        console.error("MARK DONE ERROR:", error);
        showToast(error.message, "error");

    }
}


// =====================================================
// REVISE TASK (modal)
//
// UPDATED for WKNDOT mid-week task shifting: before showing the
// modal, this now looks up the task's original_planned_date and
// checks whether it falls inside the current Monday-Saturday
// WKNDOT week. If it does, a WKNDOT section appears in the modal -
// either the two decision buttons (if nothing has been decided for
// this task+week yet) or a read-only note showing the decision
// already made earlier this week (never asked twice).
// =====================================================

function resetReviseWkndotState() {
    reviseWkndotState = {
        required: false,
        weekStart: null,
        weekEnd: null,
        existingDecision: null,
        chosenDecision: null
    };
    const section = document.getElementById("reviseWkndotSection");
    if (section) section.style.display = "none";
}

async function reviseTask(id) {

    revisingTaskId = id;

    const dateInput = document.getElementById("reviseDateInput");
    const noteInput = document.getElementById("reviseNoteInput");

    dateInput.min = todayISO();
    dateInput.value = "";
    noteInput.value = "";

    resetReviseWkndotState();

    document.getElementById("reviseModal").classList.add("show");

    setTimeout(() => dateInput.focus(), 50);

    // Fetch the task's original commitment date and check it
    // against the current WKNDOT week. Any failure here just means
    // the modal behaves like a plain revision (no WKNDOT prompt) -
    // the server still enforces the requirement authoritatively on
    // save, so this is a UX nicety, not the source of truth.
    try {

        const response = await fetch(`${API}/api/tasks/${id}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const task = await response.json();
        const originalDate = task.original_planned_date || task.planned_date;

        if (!originalDate) return;

        const taskWeek = wkndotWeekOf(parseISODateUTC(originalDate));
        const currentWeek = wkndotWeekOf(istTodayAsUTCDate());

        if (taskWeek.start !== currentWeek.start) return;

        reviseWkndotState.required = true;
        reviseWkndotState.weekStart = taskWeek.start;
        reviseWkndotState.weekEnd = taskWeek.end;

        const decisionResponse = await fetch(
            `${API}/api/wkndot/decision?task_id=${id}&week_start=${taskWeek.start}&week_end=${taskWeek.end}`
        );

        if (decisionResponse.ok) {
            const decision = await decisionResponse.json();
            if (decision && decision.review_status) {
                reviseWkndotState.existingDecision = decision.review_status;
            }
        }

        renderReviseWkndotSection();

    } catch (error) {

        console.error("REVISE WKNDOT PRE-CHECK ERROR:", error);

    }
}

function renderReviseWkndotSection() {

    const section = document.getElementById("reviseWkndotSection");
    if (!section || !reviseWkndotState.required) return;

    const weekLabel = formatWkndotWeekLabel(reviseWkndotState.weekStart, reviseWkndotState.weekEnd);

    if (reviseWkndotState.existingDecision) {

        const decisionLabel = reviseWkndotState.existingDecision === "Negative"
            ? "Marked as Negative for this week"
            : "Marked as Do Not Mark As Negative for this week";

        section.innerHTML = `
            <div class="wkndot-midweek-label">WKNDOT for this week (${weekLabel})</div>
            <p class="wkndot-midweek-copy">This task already has a WKNDOT decision for this week - it won't be asked again.</p>
            <div class="wkndot-existing-chip ${reviseWkndotState.existingDecision === "Negative" ? "negative" : "non-negative"}">${decisionLabel}</div>
        `;

    } else {

        section.innerHTML = `
            <div class="wkndot-midweek-label">WKNDOT for this week (${weekLabel})</div>
            <p class="wkndot-midweek-copy">This task's original commitment falls in the current week and is being shifted before it's done. How should this be treated?</p>
            <div class="wkndot-choice-row">
                <button type="button" class="wkndot-choice-btn negative" id="wkndotChoiceNegative" onclick="selectMidWeekWkndotDecision('Negative')">Mark as Negative for this week</button>
                <button type="button" class="wkndot-choice-btn non-negative" id="wkndotChoiceNonNegative" onclick="selectMidWeekWkndotDecision('Non-Negative')">Do not mark as Negative</button>
            </div>
        `;

    }

    section.style.display = "block";
}

function selectMidWeekWkndotDecision(decision) {

    reviseWkndotState.chosenDecision = decision;

    const negativeBtn = document.getElementById("wkndotChoiceNegative");
    const nonNegativeBtn = document.getElementById("wkndotChoiceNonNegative");

    if (negativeBtn) negativeBtn.classList.toggle("selected", decision === "Negative");
    if (nonNegativeBtn) nonNegativeBtn.classList.toggle("selected", decision === "Non-Negative");
}

function closeReviseModal() {
    document.getElementById("reviseModal").classList.remove("show");
    revisingTaskId = null;
    resetReviseWkndotState();
}

async function submitRevise() {

    if (!revisingTaskId) return;

    const newDate = document.getElementById("reviseDateInput").value;
    const revisionText = document.getElementById("reviseNoteInput").value.trim();
    const btn = document.getElementById("reviseSaveBtn");

    if (!newDate) {
        showToast("Please choose a new planned date.", "error");
        return;
    }

    if (newDate < todayISO()) {
        showToast("Planned date cannot be in the past.", "error");
        return;
    }

    // A decision is only needed when WKNDOT applies AND nothing has
    // already been decided for this task+week this week.
    if (reviseWkndotState.required && !reviseWkndotState.existingDecision && !reviseWkndotState.chosenDecision) {
        showToast("Please choose how this week's WKNDOT should be treated before saving.", "error");
        return;
    }

    const body = {
        planned_date: newDate,
        revision_text: revisionText || ""
    };

    if (reviseWkndotState.required && !reviseWkndotState.existingDecision) {
        body.wkndot_decision = reviseWkndotState.chosenDecision;
    }

    btn.disabled = true;
    btn.textContent = "Saving…";

    try {

        const response = await fetch(`${API}/api/tasks/${revisingTaskId}/revise`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });

        const data = await response.json();

        if (!response.ok) {

            // The server independently re-checked WKNDOT and found a
            // decision is required but wasn't sent - reflects the
            // prompt so the user can still choose without losing
            // their date/note, then let them retry.
            if (data.wkndot_required) {
                reviseWkndotState.required = true;
                reviseWkndotState.weekStart = data.week_start;
                reviseWkndotState.weekEnd = data.week_end;
                renderReviseWkndotSection();
                showToast("Please choose how this week's WKNDOT should be treated.", "error");
                return;
            }

            throw new Error(data.error || "Failed to revise task");
        }

        showToast("Task revised successfully.", "success");

        closeReviseModal();
        loadTasks();
        loadTodayTasks();

        // If the WKNDOT view has already loaded data for the
        // relevant week, refresh it so the new decision shows up
        // immediately instead of looking stale.
        if (data.wkndot && data.wkndot.required && wkndotState.weekStart === data.wkndot.week_start) {
            loadWkndotData();
        }

    } catch (error) {

        console.error("REVISE ERROR:", error);
        showToast(error.message, "error");

    } finally {

        btn.disabled = false;
        btn.textContent = "Save Revision";

    }
}


// =====================================================
// REVISION HISTORY (modal)
// =====================================================

async function openRevisionHistory(taskId, taskCode, doerName) {

    const modal = document.getElementById("revisionHistoryModal");
    const meta = document.getElementById("revisionHistoryTaskMeta");
    const list = document.getElementById("revisionHistoryList");

    meta.textContent = doerName ? `Task #${taskCode} · ${doerName}` : `Task #${taskCode}`;
    list.innerHTML = `<div class="state-block"><div class="state-title">Loading…</div></div>`;

    modal.classList.add("show");

    try {

        const response = await fetch(`${API}/api/tasks/${taskId}/revisions`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const revisions = await response.json();

        if (!revisions || revisions.length === 0) {
            list.innerHTML = emptyState("No revisions yet.", "This task has not been revised.");
            return;
        }

        list.innerHTML = revisions.map(rev => `
            <div class="revision-item">
                <div class="rv-top">
                    <span class="rv-number">Revision ${rev.revision_number}</span>
                    <span class="rv-date">${formatDate(rev.revision_date)}</span>
                </div>
                <div class="rv-planned">Planned Date: ${rev.planned_date ? formatDate(rev.planned_date) : "—"}</div>
                ${rev.revision_text ? `<div class="rv-note">Note: ${escapeHTML(rev.revision_text)}</div>` : ""}
            </div>
        `).join("");

    } catch (error) {

        console.error("REVISION HISTORY ERROR:", error);
        list.innerHTML = errorState("Couldn't load revision history", "Check your connection and try again.");

    }
}

function closeRevisionHistoryModal() {
    document.getElementById("revisionHistoryModal").classList.remove("show");
}


// =====================================================
// TODAY'S TASKS (Follow Up)
// =====================================================

async function loadTodayTasks() {

    const container = document.getElementById("todayTasks");
    if (!container) return;

    try {

        const response = await fetch(`${API}/api/tasks/today`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const tasks = await response.json();

        if (!tasks || tasks.length === 0) {
            container.innerHTML = emptyState("No tasks for today", "Nothing is planned for today yet.");
            return;
        }

        container.innerHTML = "";

        tasks.forEach(task => {

            const card = document.createElement("div");
            card.className = "task-card";

            card.innerHTML = `
                <div class="task-card-top">
                    <div class="task-doer">
                        <div class="avatar">${escapeHTML(initials(task.name))}</div>
                        <div>
                            <div class="task-doer-name">${escapeHTML(task.name || "")}</div>
                            <div class="task-code">#${escapeHTML(task.task_code || task.id)}</div>
                        </div>
                    </div>
                    ${statusBadge(task)}
                </div>

                <p class="task-desc">${escapeHTML(task.task || "")}</p>

                <div class="task-card-foot">
                    <span class="task-meta">${priorityBadge(task.priority)} · ${Number(task.total_revisions || 0)} revision${Number(task.total_revisions || 0) === 1 ? "" : "s"}</span>
                    <div class="task-actions">
                        <button class="action-btn done-btn" onclick="markDone(${task.id})">Done</button>
                        <button class="action-btn revise-btn" onclick="reviseTask(${task.id})">Revise</button>
                    </div>
                </div>
            `;

            container.appendChild(card);

        });

    } catch (error) {

        console.error("TODAY TASK ERROR:", error);
        container.innerHTML = errorState("Couldn't load today's tasks", "Check your connection and try again.");

    }
}


// =====================================================
// DASHBOARD DATE FILTER
// =====================================================

function onDashboardRangeChange() {

    const key = document.getElementById("dashboardRangeSelect").value;
    const customWrap = document.getElementById("dashboardCustomRange");

    if (key === "custom") {
        customWrap.classList.add("show");
        return;
    }

    customWrap.classList.remove("show");

    dashboardRange = computeRangeForKey(key);
    updateShowingLabel("dashboardShowingLabel", dashboardRange);
    loadDashboard();
}

function applyDashboardCustomRange() {

    const from = document.getElementById("dashboardFromInput").value;
    const to = document.getElementById("dashboardToInput").value;

    if (!from || !to) {
        showToast("Please choose both a from and a to date.", "error");
        return;
    }

    if (from > to) {
        showToast("The from date must be before the to date.", "error");
        return;
    }

    dashboardRange = { from, to };
    updateShowingLabel("dashboardShowingLabel", dashboardRange);
    loadDashboard();
}


// =====================================================
// DASHBOARD
// =====================================================

async function loadDashboard() {

    const refreshBtn = document.getElementById("dashboardRefreshBtn");
    if (refreshBtn) refreshBtn.classList.add("spinning");

    const rangeQuery = buildRangeQuery(dashboardRange);

    try {

        const [summaryRes, doersRes, revisionsRes, priorityRes] = await Promise.all([
            fetch(`${API}/api/dashboard/summary${rangeQuery}`),
            fetch(`${API}/api/dashboard/doers${rangeQuery}`),
            fetch(`${API}/api/dashboard/revisions${rangeQuery}`),
            fetch(`${API}/api/dashboard/priority`)
        ]);

        if (!summaryRes.ok || !doersRes.ok || !revisionsRes.ok || !priorityRes.ok) {
            throw new Error("One or more dashboard requests failed");
        }

        const summary = await summaryRes.json();
        const doers = await doersRes.json();
        const revisions = await revisionsRes.json();
        const priority = await priorityRes.json();

        renderSummary(summary);
        renderTasksByDoerChart(doers);
        renderStatusDonut(summary);
        renderRevisionStats(revisions);
        renderPriorityLists(priority);
        renderDoerPerformance(doers);

    } catch (error) {

        console.error("DASHBOARD ERROR:", error);
        showToast("Couldn't load the dashboard. Check your connection and try again.", "error");

    } finally {

        if (refreshBtn) refreshBtn.classList.remove("spinning");

    }
}

function renderSummary(summary) {
    document.getElementById("statTotal").textContent = summary.total ?? 0;
    document.getElementById("statCompleted").textContent = summary.completed ?? 0;
    document.getElementById("statPending").textContent = summary.pending ?? 0;

    const weekShiftedEl = document.getElementById("statWeekShifted");
    if (weekShiftedEl) weekShiftedEl.textContent = summary.week_shifted ?? 0;

    document.getElementById("statDueToday").textContent = summary.due_today ?? 0;
    document.getElementById("statOverdue").textContent = summary.overdue ?? 0;
}

function renderDoerPerformance(doers) {

    const list = document.getElementById("doerPerformanceList");

    if (!doers || doers.length === 0) {
        list.innerHTML = emptyState("No doers yet", "Add doers on the backend to see performance here.");
        return;
    }

    list.innerHTML = doers.map(d => `
        <div class="doer-row">
            <button class="doer-name-link" onclick="openDoerHistory(${d.id}, '${escapeHTML(d.name).replace(/'/g, "\\'")}')">
                <div class="avatar">${escapeHTML(initials(d.name))}</div>
                <span>${escapeHTML(d.name)}</span>
            </button>
            <div class="doer-stat" data-label="Assigned">${d.total_assigned}</div>
            <div class="doer-stat" data-label="Completed">${d.completed}</div>
            <div class="doer-stat" data-label="Pending">${d.pending}</div>
            <div class="progress-cell">
                <div class="progress-track">
                    <div class="progress-fill" style="width:${d.completion_percentage}%"></div>
                </div>
                <div class="progress-pct">${d.completion_percentage}%</div>
            </div>
        </div>
    `).join("");
}

function renderTasksByDoerChart(doers) {

    const wrap = document.getElementById("tasksByDoerChart");

    const withTasks = (doers || []).filter(d => d.total_assigned > 0);

    if (withTasks.length === 0) {
        wrap.innerHTML = emptyState("No task data yet", "Charts will appear once tasks are assigned for this period.");
        return;
    }

    const maxTotal = Math.max(...withTasks.map(d => d.total_assigned));

    wrap.innerHTML = withTasks.map(d => {
        const completedPct = (d.completed / maxTotal) * 100;
        const pendingPct = (d.pending / maxTotal) * 100;
        return `
            <div class="bar-row">
                <div class="bar-label" title="${escapeHTML(d.name)}">${escapeHTML(d.name)}</div>
                <div class="bar-track">
                    <div class="bar-fill-completed" style="width:${completedPct}%"></div>
                    <div class="bar-fill-pending" style="width:${pendingPct}%"></div>
                </div>
                <div class="bar-total">${d.total_assigned}</div>
            </div>
        `;
    }).join("");
}

function renderStatusDonut(summary) {

    const wrap = document.getElementById("statusDonutWrap");

    const completed = summary.completed || 0;
    const pending = summary.pending || 0;
    const total = completed + pending;

    if (total === 0) {
        wrap.innerHTML = emptyState("No task data yet", "The chart will appear once tasks exist for this period.");
        return;
    }

    const r = 58;
    const circumference = 2 * Math.PI * r;
    const completedLen = (completed / total) * circumference;

    wrap.innerHTML = `
        <div class="donut-wrap">
            <svg viewBox="0 0 148 148" width="148" height="148">
                <circle cx="74" cy="74" r="${r}" fill="none" stroke="#c8102e" stroke-width="16" />
                <circle cx="74" cy="74" r="${r}" fill="none" stroke="#12805c" stroke-width="16"
                    stroke-dasharray="${completedLen} ${circumference - completedLen}"
                    stroke-dashoffset="0"
                    transform="rotate(-90 74 74)" />
            </svg>
            <div class="donut-center">
                <span class="n">${total}</span>
                <span class="l">Total</span>
            </div>
        </div>
        <div class="legend">
            <div class="legend-item">
                <span class="legend-dot" style="background:#12805c;"></span>
                Completed <span class="legend-val">${completed}</span>
            </div>
            <div class="legend-item">
                <span class="legend-dot" style="background:#c8102e;"></span>
                Pending <span class="legend-val">${pending}</span>
            </div>
        </div>
    `;
}

function renderRevisionStats(revisions) {

    const wrap = document.getElementById("revisionStats");

    wrap.innerHTML = `
        <div class="revision-stat">
            <div class="rv-val">${revisions.never_revised ?? 0}</div>
            <div class="rv-label">Never Revised</div>
        </div>
        <div class="revision-stat">
            <div class="rv-val">${revisions.revised ?? 0}</div>
            <div class="rv-label">Revised at Least Once</div>
        </div>
        <div class="revision-stat">
            <div class="rv-val">${revisions.avg_revisions ?? 0}</div>
            <div class="rv-label">Avg. Revisions / Task</div>
        </div>
    `;
}

function renderPriorityLists(priority) {

    const dueTodayList = document.getElementById("dueTodayList");
    const overdueList = document.getElementById("overdueList");
    const dueTodayCount = document.getElementById("dueTodayCount");
    const overdueCount = document.getElementById("overdueCount");

    const dueToday = priority.due_today || [];
    const overdue = priority.overdue || [];

    dueTodayCount.textContent = dueToday.length ? `${dueToday.length} task${dueToday.length === 1 ? "" : "s"}` : "";
    overdueCount.textContent = overdue.length ? `${overdue.length} task${overdue.length === 1 ? "" : "s"}` : "";

    dueTodayList.innerHTML = dueToday.length
        ? dueToday.map(priorityItem).join("")
        : emptyState("Nothing due today", "Today's follow-up list is clear.");

    overdueList.innerHTML = overdue.length
        ? overdue.map(priorityItem).join("")
        : emptyState("No overdue tasks", "Everything is on schedule.");
}

function priorityItem(task) {
    return `
        <div class="priority-item">
            <div class="p-left">
                <div class="p-doer">${escapeHTML(task.doer_name || "")}</div>
                <div class="p-task">${escapeHTML(task.task || "")}</div>
            </div>
            <div class="p-date">${priorityBadge(task.priority)} · ${formatDate(task.planned_date)}</div>
        </div>
    `;
}


// =====================================================
// DOER HISTORY (modal)
// =====================================================

function openDoerHistory(id, name) {

    doerHistoryState = { id, name, from: null, to: null };

    document.getElementById("doerHistoryName").textContent = name;
    document.getElementById("doerHistoryRangeSelect").value = "allTime";
    document.getElementById("doerHistoryCustomRange").classList.remove("show");
    updateShowingLabel("doerHistoryShowing", { from: null, to: null });

    document.getElementById("doerHistoryModal").classList.add("show");

    loadDoerHistory();
}

function closeDoerHistoryModal() {
    document.getElementById("doerHistoryModal").classList.remove("show");
}

function onDoerHistoryRangeChange() {

    const key = document.getElementById("doerHistoryRangeSelect").value;
    const customWrap = document.getElementById("doerHistoryCustomRange");

    if (key === "custom") {
        customWrap.classList.add("show");
        return;
    }

    customWrap.classList.remove("show");

    const range = computeRangeForKey(key);
    doerHistoryState.from = range.from;
    doerHistoryState.to = range.to;

    updateShowingLabel("doerHistoryShowing", range);
    loadDoerHistory();
}

function applyDoerHistoryCustomRange() {

    const from = document.getElementById("doerHistoryFromInput").value;
    const to = document.getElementById("doerHistoryToInput").value;

    if (!from || !to) {
        showToast("Please choose both a from and a to date.", "error");
        return;
    }

    if (from > to) {
        showToast("The from date must be before the to date.", "error");
        return;
    }

    doerHistoryState.from = from;
    doerHistoryState.to = to;

    updateShowingLabel("doerHistoryShowing", { from, to });
    loadDoerHistory();
}

async function loadDoerHistory() {

    const summaryWrap = document.getElementById("doerHistorySummary");
    const tableWrap = document.getElementById("doerHistoryTable");

    summaryWrap.innerHTML = `<div class="state-block"><div class="state-title">Loading…</div></div>`;
    tableWrap.innerHTML = `<tr><td colspan="8"><div class="state-block"><div class="state-title">Loading…</div></div></td></tr>`;

    const rangeQuery = buildRangeQuery({ from: doerHistoryState.from, to: doerHistoryState.to });

    try {

        const response = await fetch(`${API}/api/dashboard/doers/${doerHistoryState.id}/history${rangeQuery}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();

        renderDoerHistorySummary(data.summary);
        renderDoerHistoryTable(data.tasks);

    } catch (error) {

        console.error("DOER HISTORY ERROR:", error);
        summaryWrap.innerHTML = errorState("Couldn't load this doer's history", "Check your connection and try again.");
        tableWrap.innerHTML = "";

    }
}

function renderDoerHistorySummary(summary) {

    const wrap = document.getElementById("doerHistorySummary");

    wrap.innerHTML = `
        <div class="stat-card total">
            <div class="stat-label">Total Tasks</div>
            <div class="stat-value">${summary.total}</div>
        </div>
        <div class="stat-card completed">
            <div class="stat-label">Completed</div>
            <div class="stat-value">${summary.completed}</div>
        </div>
        <div class="stat-card pending">
            <div class="stat-label">Pending</div>
            <div class="stat-value">${summary.pending}</div>
        </div>
        <div class="stat-card week-shifted">
            <div class="stat-label">Week Shifted</div>
            <div class="stat-value">${summary.week_shifted ?? 0}</div>
        </div>
        <div class="stat-card pending">
            <div class="stat-label">Revised</div>
            <div class="stat-value">${summary.revised}</div>
        </div>
        <div class="stat-card overdue">
            <div class="stat-label">Overdue</div>
            <div class="stat-value">${summary.overdue}</div>
        </div>
    `;
}

function renderDoerHistoryTable(tasks) {

    const table = document.getElementById("doerHistoryTable");

    if (!tasks || tasks.length === 0) {
        table.innerHTML = `<tr><td colspan="8">${emptyState(
            "No tasks in this period",
            "Try a different date range."
        )}</td></tr>`;
        return;
    }

    table.innerHTML = tasks.map(task => `
        <tr>
            <td class="mono" data-label="Task ID">${escapeHTML(task.task_code || task.id)}</td>
            <td data-label="Task">${escapeHTML(task.task || "")}</td>
            <td data-label="Assigned Date">${formatDateTime(task.created_at)}</td>
            <td data-label="Planned Date">${formatDate(task.planned_date)}</td>
            <td data-label="Priority">${priorityBadge(task.priority)}</td>
            <td data-label="Status">${statusBadge(task)}</td>
            <td class="mono" data-label="Revisions">${Number(task.total_revisions || 0)}</td>
            <td data-label="Last Updated">${formatDateTime(task.updated_at)}</td>
        </tr>
    `).join("");
}


// =====================================================
// DAILY PENDING TASKS
// =====================================================

async function onDailyPendingDoerChange() {

    const select = document.getElementById("dailyPendingDoerSelect");
    const doerId = select.value;

    const emptyBlock = document.getElementById("dailyPendingEmpty");
    const content = document.getElementById("dailyPendingContent");

    if (!doerId) {
        emptyBlock.style.display = "block";
        content.style.display = "none";
        return;
    }

    const doer = doersCache.find(d => String(d.id) === String(doerId));

    dailyPendingState.doerId = doerId;
    dailyPendingState.doerName = doer ? doer.name : "";
    dailyPendingState.doerPhone = doer ? doer.phone : "";

    emptyBlock.style.display = "none";
    content.style.display = "block";

    document.getElementById("dailyPendingDoerName").textContent = dailyPendingState.doerName;
    document.getElementById("dailyPendingTable").innerHTML =
        `<tr><td colspan="6"><div class="state-block"><div class="state-title">Loading…</div></div></td></tr>`;
    document.getElementById("whatsappPreview").value = "";

    try {

        const params = new URLSearchParams({ status: "Pending", doer_id: doerId });
        const response = await fetch(`${API}/api/tasks?${params.toString()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const tasks = await response.json();
        dailyPendingState.tasks = tasks;

        renderDailyPendingTable(tasks);
        document.getElementById("whatsappPreview").value = buildWhatsAppMessage(tasks);

        const count = document.getElementById("dailyPendingCount");
        count.textContent = tasks.length ? `${tasks.length} pending task${tasks.length === 1 ? "" : "s"}` : "";

    } catch (error) {

        console.error("DAILY PENDING ERROR:", error);
        document.getElementById("dailyPendingTable").innerHTML =
            `<tr><td colspan="6">${errorState("Couldn't load pending tasks", "Check your connection and try again.")}</td></tr>`;

    }
}

function renderDailyPendingTable(tasks) {

    const table = document.getElementById("dailyPendingTable");

    if (!tasks || tasks.length === 0) {
        table.innerHTML = `<tr><td colspan="6">${emptyState(
            "No pending tasks",
            "This doer has no pending tasks right now."
        )}</td></tr>`;
        return;
    }

    table.innerHTML = tasks.map(task => `
        <tr>
            <td class="mono" data-label="Task ID">${escapeHTML(task.task_code || task.id)}</td>
            <td data-label="Actual Date">${formatDateOrDash(task.actual_date)}</td>
            <td data-label="Task">${escapeHTML(task.task || "")}</td>
            <td data-label="Planned Date">${formatDate(task.planned_date)}</td>
            <td data-label="Priority">${priorityBadge(task.priority)}</td>
            <td data-label="Status">${statusBadge(task)}</td>
        </tr>
    `).join("");
}

// Builds a clean, practical WhatsApp message from the doer's
// pending tasks, sorted High -> Medium -> Low (historical
// NULL-priority tasks, if any, come last with no bracket label).
function buildWhatsAppMessage(tasks) {

    if (!tasks || tasks.length === 0) {
        return `Daily Pending Tasks\n\nNo pending tasks right now. 🎉`;
    }

    const lines = tasks.map((task, index) => {
        const label = task.priority ? `[${task.priority.toUpperCase()}] ` : "";
        return `${index + 1}. ${label}${task.task || ""}`;
    });

    return `Daily Pending Tasks\n\n${lines.join("\n")}`;
}

function copyWhatsAppMessage() {

    const textarea = document.getElementById("whatsappPreview");

    if (!textarea.value) {
        showToast("There's no message to copy yet.", "error");
        return;
    }

    textarea.select();
    textarea.setSelectionRange(0, 99999);

    navigator.clipboard.writeText(textarea.value)
        .then(() => showToast("Message copied.", "success"))
        .catch(() => {
            // Fallback for browsers without clipboard API access.
            try {
                document.execCommand("copy");
                showToast("Message copied.", "success");
            } catch (err) {
                showToast("Couldn't copy automatically - please copy manually.", "error");
            }
        });
}

// Normalizes a stored phone number into a wa.me-compatible digit
// string. Assumes a 10-digit Indian mobile number needs the +91
// country code prefixed; leaves already-prefixed numbers untouched.
function normalizePhoneForWhatsApp(phone) {

    if (!phone) return null;

    const digits = phone.replace(/\D/g, "");

    if (digits.length === 10) return `91${digits}`;
    if (digits.length > 10) return digits;

    return null;
}

function openWhatsApp() {

    const message = document.getElementById("whatsappPreview").value;

    if (!message) {
        showToast("There's no message to send yet.", "error");
        return;
    }

    const phone = normalizePhoneForWhatsApp(dailyPendingState.doerPhone);

    const encoded = encodeURIComponent(message);
    const url = phone
        ? `https://wa.me/${phone}?text=${encoded}`
        : `https://wa.me/?text=${encoded}`;

    if (!phone) {
        showToast("No valid phone number on file - opening WhatsApp without a recipient.", "default");
    }

    window.open(url, "_blank");
}


// =====================================================
// WKNDOT (Weekly Work Not Done On Time)
//
// Monday-Saturday weeks only (see wkndotWeekOf() near the top of
// this file) - deliberately separate from the Dashboard's own
// Monday-Sunday "This Week" filter.
// =====================================================

// Builds the last N Monday-Saturday weeks (most recent first) for
// the week <select>, and works out which one should be selected by
// default: the most recently COMPLETED week. If today is Sun/Sat
// (i.e. the current Mon-Sat week has already run its course), that
// week is the default; otherwise (Mon-Fri, mid-week) the default is
// last week - exactly the "Monday morning review" scenario in the
// spec, where reviewing on Monday 28 Sep defaults to 21-26 Sep.
function buildWkndotWeekOptions() {

    const today = istTodayAsUTCDate();
    const currentWeek = wkndotWeekOf(today);
    const weekdayUTC = today.getUTCDay(); // 0 = Sun ... 6 = Sat

    const currentWeekIsComplete = weekdayUTC === 6 || weekdayUTC === 0;

    const mostRecentMonday = currentWeekIsComplete
        ? mondayOfWeek(today)
        : addDaysUTC(mondayOfWeek(today), -7);

    const weeks = [];

    for (let i = 0; i < 12; i++) {
        const mon = addDaysUTC(mostRecentMonday, -7 * i);
        const sat = addDaysUTC(mon, 5);
        const start = toISODateStr(mon);
        const end = toISODateStr(sat);
        weeks.push({ start, end, label: formatWkndotWeekLabel(start, end) });
    }

    wkndotWeeks = weeks;
    return { defaultWeek: weeks[0], currentWeek };
}

let wkndotViewInitialized = false;

function initWkndotViewIfNeeded() {

    if (wkndotViewInitialized) return;
    wkndotViewInitialized = true;

    const { defaultWeek } = buildWkndotWeekOptions();

    const weekSelect = document.getElementById("wkndotWeekSelect");
    if (weekSelect) {
        weekSelect.innerHTML = wkndotWeeks.map(w =>
            `<option value="${w.start}|${w.end}">${w.label}</option>`
        ).join("");
        weekSelect.value = `${defaultWeek.start}|${defaultWeek.end}`;
    }

    wkndotState.weekStart = defaultWeek.start;
    wkndotState.weekEnd = defaultWeek.end;
    wkndotState.doerId = "";
    wkndotState.doerName = "All Doers";

    loadWkndotData();
}

function onWkndotWeekChange() {

    const weekSelect = document.getElementById("wkndotWeekSelect");
    const [start, end] = weekSelect.value.split("|");

    wkndotState.weekStart = start;
    wkndotState.weekEnd = end;

    loadWkndotData();
}

function onWkndotDoerChange() {

    const doerSelect = document.getElementById("wkndotDoerSelect");
    const doerId = doerSelect.value;
    const doer = doersCache.find(d => String(d.id) === String(doerId));

    wkndotState.doerId = doerId;
    wkndotState.doerName = doerId ? (doer ? doer.name : "") : "All Doers";

    loadWkndotData();
}

function buildWkndotQuery() {
    const params = new URLSearchParams({
        week_start: wkndotState.weekStart,
        week_end: wkndotState.weekEnd
    });
    if (wkndotState.doerId) params.set("doer_id", wkndotState.doerId);
    return `?${params.toString()}`;
}

async function loadWkndotData() {

    if (!wkndotState.weekStart || !wkndotState.weekEnd) return;

    const summaryWrap = document.getElementById("wkndotSummaryWrap");
    const tasksWrap = document.getElementById("wkndotTasksWrap");
    const weekHeading = document.getElementById("wkndotWeekHeading");
    const doerHeading = document.getElementById("wkndotDoerHeading");
    const weekLabel = formatWkndotWeekLabel(wkndotState.weekStart, wkndotState.weekEnd);

    if (weekHeading) weekHeading.textContent = weekLabel;
    if (doerHeading) doerHeading.textContent = wkndotState.doerName;

    const printWeek = document.getElementById("wkndotPrintWeek");
    const printDoer = document.getElementById("wkndotPrintDoer");
    const printGenerated = document.getElementById("wkndotPrintGenerated");
    if (printWeek) printWeek.textContent = weekLabel;
    if (printDoer) printDoer.textContent = wkndotState.doerName;
    if (printGenerated) printGenerated.textContent = formatDate(todayISO());

    if (summaryWrap) summaryWrap.innerHTML = `<div class="state-block"><div class="state-title">Loading…</div></div>`;
    if (tasksWrap) tasksWrap.innerHTML = "";

    try {

        const summaryResponse = await fetch(`${API}/api/wkndot/summary${buildWkndotQuery()}`);
        if (!summaryResponse.ok) throw new Error(`HTTP ${summaryResponse.status}`);
        wkndotState.summary = await summaryResponse.json();

        if (wkndotState.doerId) {

            const tasksResponse = await fetch(`${API}/api/wkndot/tasks${buildWkndotQuery()}`);
            if (!tasksResponse.ok) throw new Error(`HTTP ${tasksResponse.status}`);
            wkndotState.tasks = await tasksResponse.json();

            renderWkndotSingleDoer();

        } else {

            wkndotState.tasks = [];
            renderWkndotAllDoers();

        }

    } catch (error) {

        console.error("WKNDOT LOAD ERROR:", error);
        if (summaryWrap) summaryWrap.innerHTML = errorState("Couldn't load WKNDOT data", "Check your connection and try again.");
        if (tasksWrap) tasksWrap.innerHTML = "";

    }
}

function wkndotStatCard(label, value, cls) {
    return `
        <div class="stat-card ${cls || ""}">
            <div class="stat-label">${escapeHTML(label)}</div>
            <div class="stat-value">${value}</div>
        </div>
    `;
}

function renderWkndotAllDoers() {

    const summaryWrap = document.getElementById("wkndotSummaryWrap");
    const tasksWrap = document.getElementById("wkndotTasksWrap");
    if (tasksWrap) tasksWrap.innerHTML = "";

    const rows = wkndotState.summary;

    if (!rows || rows.length === 0) {
        summaryWrap.innerHTML = emptyState("No tasks due this week", "No doer had a task whose original commitment fell in this week.");
        return;
    }

    const totalDue = rows.reduce((sum, r) => sum + r.total_due, 0);
    const totalOnTime = rows.reduce((sum, r) => sum + r.completed_on_time, 0);
    const totalNegative = rows.reduce((sum, r) => sum + r.negative, 0);
    const totalPending = rows.reduce((sum, r) => sum + r.pending_review, 0);

    summaryWrap.innerHTML = `
        <div class="summary-grid cols-6 section-gap wkndot-print-summary">
            ${wkndotStatCard("Total Tasks Due", totalDue, "total")}
            ${wkndotStatCard("Completed On Time", totalOnTime, "completed")}
            ${wkndotStatCard("Negative", totalNegative, "overdue")}
            ${wkndotStatCard("Pending Review", totalPending, "week-shifted")}
        </div>

        <div class="table-wrapper wkndot-print-table">
            <table>
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Doer</th>
                        <th>Tasks Due</th>
                        <th>Completed</th>
                        <th>Negative</th>
                        <th>Non-Negative</th>
                        <th>Pending</th>
                        <th>WKNDOT %</th>
                        <th>Avg Delay</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map((r, i) => `
                        <tr>
                            <td data-label="#" class="mono">${i + 1}</td>
                            <td data-label="Doer">${escapeHTML(r.doer_name)}</td>
                            <td data-label="Tasks Due" class="mono">${r.total_due}</td>
                            <td data-label="Completed" class="mono">${r.completed_on_time}</td>
                            <td data-label="Negative" class="mono">${r.negative}</td>
                            <td data-label="Non-Negative" class="mono">${r.non_negative}</td>
                            <td data-label="Pending" class="mono">${r.pending_review}</td>
                            <td data-label="WKNDOT %" class="mono">${r.wkndot_percentage}%</td>
                            <td data-label="Avg Delay" class="mono">${r.avg_delay !== null ? r.avg_delay + "d" : "—"}</td>
                        </tr>
                    `).join("")}
                </tbody>
            </table>
        </div>
    `;
}

function renderWkndotSingleDoer() {

    const summaryWrap = document.getElementById("wkndotSummaryWrap");
    const tasksWrap = document.getElementById("wkndotTasksWrap");

    const row = wkndotState.summary && wkndotState.summary[0];

    if (!row) {
        summaryWrap.innerHTML = emptyState("No tasks due this week", `${escapeHTML(wkndotState.doerName)} has no task whose original commitment fell in this week.`);
        tasksWrap.innerHTML = "";
        return;
    }

    summaryWrap.innerHTML = `
        <div class="summary-grid cols-6 section-gap wkndot-print-summary">
            ${wkndotStatCard("Total Tasks Due", row.total_due, "total")}
            ${wkndotStatCard("Completed On Time", row.completed_on_time, "completed")}
            ${wkndotStatCard("Negative", row.negative, "overdue")}
            ${wkndotStatCard("Non-Negative", row.non_negative, "week-shifted")}
            ${wkndotStatCard("Pending Review", row.pending_review, "pending")}
            ${wkndotStatCard("WKNDOT %", row.wkndot_percentage + "%", "completed")}
        </div>
        <p class="card-hint wkndot-print-summary">Negative Rate: <strong>${row.negative_rate}%</strong> · Avg Delay: <strong>${row.avg_delay !== null ? row.avg_delay + " days" : "—"}</strong> · Max Delay: <strong>${row.max_delay !== null ? row.max_delay + " days" : "—"}</strong></p>
    `;

    renderWkndotTaskList(wkndotState.tasks);
}

function wkndotTaskStatusBlock(task) {

    if (task.completed_on_time) {
        return `<span class="badge completed">Completed On Time</span>`;
    }

    if (task.review_status === "Negative") {
        return `<span class="wkndot-decided-chip negative">Negative${task.decided_mid_week ? " (mid-week)" : ""}</span>`;
    }

    if (task.review_status === "Non-Negative") {
        return `<span class="wkndot-decided-chip non-negative">Non-Negative${task.decided_mid_week ? " (mid-week)" : ""}</span>`;
    }

    return `
        <div class="wkndot-review-actions">
            <button type="button" class="wkndot-choice-btn negative small" onclick="submitWkndotReview(${task.id}, 'Negative')">Negative</button>
            <button type="button" class="wkndot-choice-btn non-negative small" onclick="submitWkndotReview(${task.id}, 'Non-Negative')">Non-Negative</button>
        </div>
    `;
}

function wkndotDelayText(task) {
    if (task.status === "Completed") {
        return task.delay_days ? `${task.delay_days}d late` : "On time";
    }
    return task.currently_delayed_days ? `Currently delayed ${task.currently_delayed_days}d` : "Not yet due to be late";
}

function renderWkndotTaskList(tasks) {

    const tasksWrap = document.getElementById("wkndotTasksWrap");
    if (!tasksWrap) return;

    if (!tasks || tasks.length === 0) {
        tasksWrap.innerHTML = emptyState("No tasks in this week", "Nothing was originally due in this window.");
        return;
    }

    tasksWrap.innerHTML = `
        <div class="table-wrapper wkndot-print-table">
            <table>
                <thead>
                    <tr>
                        <th>Task ID</th>
                        <th>Task</th>
                        <th>Original Due</th>
                        <th>Current Planned</th>
                        <th>Status</th>
                        <th>Delay</th>
                        <th>WKNDOT</th>
                    </tr>
                </thead>
                <tbody>
                    ${tasks.map(task => `
                        <tr>
                            <td data-label="Task ID" class="mono">${escapeHTML(task.task_code || task.id)}</td>
                            <td data-label="Task">${escapeHTML(task.task || "")}</td>
                            <td data-label="Original Due">${formatDate(task.original_planned_date)}</td>
                            <td data-label="Current Planned">${formatDate(task.planned_date)}</td>
                            <td data-label="Status">${statusBadge(task)}</td>
                            <td data-label="Delay">${wkndotDelayText(task)}</td>
                            <td data-label="WKNDOT">${wkndotTaskStatusBlock(task)}</td>
                        </tr>
                    `).join("")}
                </tbody>
            </table>
        </div>
    `;
}

async function submitWkndotReview(taskId, reviewStatus) {

    try {

        const response = await fetch(`${API}/api/wkndot/review`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                task_id: taskId,
                week_start: wkndotState.weekStart,
                week_end: wkndotState.weekEnd,
                review_status: reviewStatus
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "Failed to save WKNDOT decision");
        }

        showToast(`Marked as ${reviewStatus}.`, "success");
        loadWkndotData();

    } catch (error) {

        console.error("WKNDOT REVIEW ERROR:", error);
        showToast(error.message, "error");

    }
}

function printWkndotReport() {
    window.print();
}

// A lightweight CSV export (opens fine in Excel) so a workable
// export exists without pulling in a spreadsheet library - Print /
// PDF stays the primary, fully-styled report per the brief.
function exportWkndotCSV() {

    const weekLabel = formatWkndotWeekLabel(wkndotState.weekStart, wkndotState.weekEnd);
    let rows = [];

    if (wkndotState.doerId) {

        rows.push(["Task ID", "Doer", "Task", "Original Due", "Current Planned", "Status", "Delay (days)", "WKNDOT"]);

        wkndotState.tasks.forEach(task => {
            const wkndotVal = task.completed_on_time
                ? "Completed On Time"
                : (task.review_status || "Pending Review");
            const delay = task.status === "Completed" ? (task.delay_days || 0) : (task.currently_delayed_days || 0);

            rows.push([
                task.task_code || task.id,
                task.doer_name || "",
                task.task || "",
                task.original_planned_date ? task.original_planned_date.split("T")[0] : "",
                task.planned_date ? task.planned_date.split("T")[0] : "",
                task.status || "",
                delay,
                wkndotVal
            ]);
        });

    } else {

        rows.push(["#", "Doer", "Tasks Due", "Completed", "Negative", "Non-Negative", "Pending", "WKNDOT %", "Avg Delay"]);

        wkndotState.summary.forEach((r, i) => {
            rows.push([
                i + 1,
                r.doer_name,
                r.total_due,
                r.completed_on_time,
                r.negative,
                r.non_negative,
                r.pending_review,
                r.wkndot_percentage + "%",
                r.avg_delay !== null ? r.avg_delay : ""
            ]);
        });

    }

    const csv = rows.map(row =>
        row.map(cell => {
            const value = String(cell ?? "");
            return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
        }).join(",")
    ).join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `WKNDOT ${weekLabel.replace(/\s/g, "")} ${wkndotState.doerName.replace(/\s/g, "-")}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

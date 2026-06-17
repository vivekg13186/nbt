"""Cron-style scheduling for flow runs.

Two parts live here:

  * a tiny, dependency-free **cron parser/matcher** for the classic 5-field
    syntax ``minute hour day-of-month month day-of-week`` supporting ``*``,
    lists (``1,2``), ranges (``1-5``), steps (``*/5``, ``0-30/10``) and the
    convenience macros ``@hourly``/``@daily``/``@weekly``/``@monthly``/
    ``@yearly``; and

  * :class:`FlowScheduler`, a background thread that wakes on each minute
    boundary and runs every enabled schedule whose cron matches the current
    minute (server local time). Schedules are persisted in the database, so
    they survive restarts (unlike listeners, which are armed in-memory).

Day-of-month and day-of-week follow standard cron semantics: when *both* are
restricted (neither is ``*``) a tick matches if *either* field matches.
Day-of-week is 0-6 with Sunday = 0 (7 is also accepted as Sunday).
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta

_MACROS = {
    "@yearly": "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
    "@monthly": "0 0 1 * *",
    "@weekly": "0 0 * * 0",
    "@daily": "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@hourly": "0 * * * *",
}

# (min, max) inclusive bounds for each of the five fields. Day-of-week allows
# 7 (== Sunday) on input; it is folded to 0 after parsing.
_BOUNDS = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)]
_FIELD_NAMES = ("minute", "hour", "day-of-month", "month", "day-of-week")


class CronError(ValueError):
    """The cron expression is malformed."""


def _parse_field(field: str, lo: int, hi: int, name: str) -> set[int]:
    values: set[int] = set()
    for part in field.split(","):
        part = part.strip()
        if not part:
            raise CronError(f"empty term in {name} field")
        step = 1
        if "/" in part:
            base, _, step_s = part.partition("/")
            try:
                step = int(step_s)
            except ValueError:
                raise CronError(f"bad step {step_s!r} in {name} field")
            if step <= 0:
                raise CronError(f"step must be positive in {name} field")
        else:
            base = part
        if base == "*":
            start, end = lo, hi
        elif "-" in base:
            a, _, b = base.partition("-")
            try:
                start, end = int(a), int(b)
            except ValueError:
                raise CronError(f"bad range {base!r} in {name} field")
        else:
            try:
                start = end = int(base)
            except ValueError:
                raise CronError(f"bad value {base!r} in {name} field")
        if start > end:
            raise CronError(f"range {base!r} is reversed in {name} field")
        if start < lo or end > hi:
            raise CronError(
                f"{name} value out of range ({lo}-{hi}): {base!r}")
        values.update(range(start, end + 1, step))
    return values


class _Cron:
    """A parsed 5-field cron expression with a per-minute match test."""

    __slots__ = ("minute", "hour", "dom", "month", "dow",
                 "dom_restricted", "dow_restricted")

    def __init__(self, expr: str):
        text = (expr or "").strip()
        if text in _MACROS:
            text = _MACROS[text]
        fields = text.split()
        if len(fields) != 5:
            raise CronError(
                "cron must have 5 fields "
                "(minute hour day-of-month month day-of-week) "
                "or a macro like @daily")
        sets = []
        for raw, (lo, hi), nm in zip(fields, _BOUNDS, _FIELD_NAMES):
            sets.append(_parse_field(raw, lo, hi, nm))
        self.minute, self.hour, self.dom, self.month, self.dow = sets
        # fold day-of-week 7 -> 0 (both mean Sunday)
        if 7 in self.dow:
            self.dow.discard(7)
            self.dow.add(0)
        self.dom_restricted = fields[2].strip() != "*"
        self.dow_restricted = fields[4].strip() != "*"

    def matches(self, dt: datetime) -> bool:
        if dt.minute not in self.minute:
            return False
        if dt.hour not in self.hour:
            return False
        if dt.month not in self.month:
            return False
        dow = (dt.weekday() + 1) % 7  # Python Mon=0 -> cron Sun=0
        dom_ok = dt.day in self.dom
        dow_ok = dow in self.dow
        # standard cron: if both day fields are restricted, OR them
        if self.dom_restricted and self.dow_restricted:
            return dom_ok or dow_ok
        return dom_ok and dow_ok


def parse_cron(expr: str) -> _Cron:
    """Validate and parse a cron expression (raises CronError)."""
    return _Cron(expr)


def cron_matches(expr: str, dt: datetime) -> bool:
    """True if `dt` (to the minute) matches the cron expression."""
    return parse_cron(expr).matches(dt)


def cron_next(expr: str, after: datetime | None = None,
              horizon_days: int = 366) -> datetime | None:
    """Next datetime (to the minute) at or after `after` that matches `expr`,
    or None if nothing matches within `horizon_days`."""
    cron = parse_cron(expr)
    base = (after or datetime.now()).replace(second=0, microsecond=0)
    cur = base + timedelta(minutes=1)
    limit = base + timedelta(days=horizon_days)
    while cur <= limit:
        if cron.matches(cur):
            return cur
        cur += timedelta(minutes=1)
    return None


class FlowScheduler:
    """Runs persisted schedules on their cron cadence (server local time).

    A single daemon thread wakes each minute and fires every enabled schedule
    whose cron matches the current minute. Each fire runs in its own worker
    thread; a schedule that is still running when its next tick arrives is
    skipped (so a slow flow never piles up). Schedules are read from the
    database every tick, so edits/enables take effect without a restart.
    """

    def __init__(self, engine, db, log=None, media=None,
                 register=None, unregister=None):
        self.engine = engine
        self.db = db
        self.log = log or (lambda *_a, **_k: None)
        self.media = media
        # register(exec_id, cancel_event, flow_id) / unregister(cancel_event):
        # let the server expose scheduled runs to its cancel registry.
        self._register = register
        self._unregister = unregister

        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._running: set[str] = set()  # schedule ids mid-run (anti-overlap)

    # ---------------- lifecycle ----------------
    def start(self):
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, name="nbt-scheduler", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        t = self._thread
        if t is not None:
            t.join(timeout=2.0)
        self._thread = None

    # ---------------- loop ----------------
    def _loop(self):
        # fire once for the current minute on startup, then align to the
        # top of each following minute.
        while not self._stop.is_set():
            now = datetime.now().replace(second=0, microsecond=0)
            self._tick(now)
            # sleep until just past the next minute boundary
            delay = 60 - datetime.now().second + 0.25
            self._stop.wait(delay)

    def _tick(self, now: datetime):
        try:
            schedules = self.db.list_schedules(enabled_only=True)
        except Exception:
            return
        for sched in schedules:
            try:
                if cron_matches(sched["cron"], now):
                    self._fire(sched)
            except CronError:
                continue  # skip a broken expression rather than crash the loop

    def _fire(self, sched: dict):
        sid = sched["id"]
        with self._lock:
            if sid in self._running:
                self.log(f"[cron] skip '{self._label(sched)}' "
                         "(previous run still in progress)")
                return
            self._running.add(sid)
        threading.Thread(
            target=self._execute, args=(sched,), daemon=True).start()

    # ---------------- execution ----------------
    def run_now(self, schedule_id: str):
        """Run a schedule's flow immediately (synchronous). Returns
        (exec_id, status, error) or raises ValueError if unknown."""
        sched = self.db.get_schedule(schedule_id)
        if sched is None:
            raise ValueError("schedule not found")
        with self._lock:
            self._running.add(schedule_id)
        return self._execute(sched)

    def _execute(self, sched: dict):
        sid = sched["id"]
        try:
            flow = self.db.get_flow(sched["flow_id"])
            if flow is None:
                self.log(f"[cron] '{self._label(sched)}': flow missing, "
                         "disabling schedule")
                self.db.set_schedule_enabled(sid, False)
                return None, "error", "flow not found"
            env_name, env_vars = None, None
            if sched.get("environment"):
                env = self.db.get_environment_by_name(sched["environment"])
                if env is not None:
                    env_name, env_vars = env["name"], env["vars"]
            self.log(f"[cron] run '{flow['name']}'"
                     + (f" (env {env_name})" if env_name else ""))
            cancel = threading.Event()

            def on_start(eid):
                if self._register:
                    self._register(eid, cancel, flow["id"])

            exec_id, status, error = self.engine.execute(
                flow["id"], flow["name"], flow["graph"],
                environment=env_name, env_vars=env_vars,
                log=self.log, media=self.media,
                cancel=cancel, on_start=on_start)
            try:
                self.db.set_schedule_result(sid, time.time(), status, exec_id)
            except Exception:
                pass
            self.log(f"[cron] {flow['name']}: {str(status).upper()} "
                     f"(exec {exec_id})")
            if self._unregister:
                self._unregister(cancel)
            return exec_id, status, error
        finally:
            with self._lock:
                self._running.discard(sid)

    @staticmethod
    def _label(sched: dict) -> str:
        return sched.get("flow_name") or sched.get("flow_id") or "?"

package net.focusbro.app.focuslock;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The ONE copy of routine data (spec r4 §4): the routine, and today's completion, in app-private storage that is excluded from
 * backup and device transfer (res/xml/focuslock_*_rules.xml). Completion is kept for TODAY ONLY: the first read on a new local
 * date drops the old day's state (AL-P2: retain only what the active routine needs). "Turn routine off" deletes everything
 * (AL-P4). The storage is behind Kv so the rules run as plain JVM tests.
 */
public final class RoutineStore {

    /** A tiny key-value view: SharedPreferences in the app, a map in tests. */
    public interface Kv {
        String get(String key);
        void putAll(Map<String, String> values);
        void clear();
    }

    /** SharedPreferences file name; the backup rules exclude exactly this file. */
    public static final String PREFS = "focuslock";
    static final String VERSION = "1";

    private final Kv kv;

    public RoutineStore(Kv kv) {
        this.kv = kv;
    }

    public void save(Routine r) {
        // A new routine starts with no completion: earlier ticks never count for it (spec r4 §5.9).
        kv.clear();
        Map<String, String> m = new HashMap<>();
        m.put("v", VERSION);
        m.put("hh", Integer.toString(r.hour));
        m.put("mm", Integer.toString(r.minute));
        m.put("n", Integer.toString(r.steps.size()));
        for (int i = 0; i < r.steps.size(); i++) {
            Routine.Step s = r.steps.get(i);
            m.put("k" + i, s.kind == Routine.Kind.TODAY_LIST ? "today-list" : "manual");
            m.put("l" + i, s.label);
        }
        kv.putAll(m);
    }

    /** The saved routine, or null when off. A missing, unknown-version or corrupt store reads as OFF and is cleared: never a crash. */
    public Routine load() {
        if (kv.get("v") == null) return null;
        try {
            if (!VERSION.equals(kv.get("v"))) throw new IllegalArgumentException("version");
            int n = Integer.parseInt(kv.get("n"));
            List<String[]> steps = new ArrayList<>();
            for (int i = 0; i < n; i++) steps.add(new String[] {kv.get("k" + i), kv.get("l" + i)});
            return Routine.of(Integer.parseInt(kv.get("hh")), Integer.parseInt(kv.get("mm")), steps);
        } catch (RuntimeException e) {
            kv.clear();
            return null;
        }
    }

    /** "Turn routine off": deletes the routine and every completion. Re-enabling starts empty. */
    public void disable() {
        kv.clear();
    }

    /** Today's done flags, one per step; old days are dropped first. Empty when off. */
    public boolean[] doneToday(String today) {
        Routine r = load();
        if (r == null) return new boolean[0];
        roll(today);
        boolean[] done = new boolean[r.steps.size()];
        for (int i = 0; i < done.length; i++) done[i] = "1".equals(kv.get("d" + i));
        return done;
    }

    public boolean skippedToday(String today) {
        if (load() == null) return false;
        roll(today);
        return "1".equals(kv.get("skip"));
    }

    /** The page reported a today-list tick (no text, no date: the date is stamped here). Ignored when off or when no such step. */
    public boolean ticked(String today) {
        Routine r = load();
        if (r == null) return false;
        for (int i = 0; i < r.steps.size(); i++) {
            if (r.steps.get(i).kind == Routine.Kind.TODAY_LIST) return mark(today, i);
        }
        return false;
    }

    /** A manual step done on the NATIVE screen. The web channel has no way to call this (spec r4 §3.1.4). */
    public boolean completeManual(String today, int index) {
        Routine r = load();
        if (r == null || index < 0 || index >= r.steps.size() || r.steps.get(index).kind != Routine.Kind.MANUAL) return false;
        return mark(today, index);
    }

    /** "Skip today": no nudge and nothing owed today. Native only. */
    public void skipToday(String today) {
        if (load() == null) return;
        roll(today);
        Map<String, String> m = new HashMap<>();
        m.put("day", today);
        m.put("skip", "1");
        kv.putAll(m);
    }

    private boolean mark(String today, int index) {
        roll(today);
        Map<String, String> m = new HashMap<>();
        m.put("day", today);
        m.put("d" + index, "1");
        kv.putAll(m);
        return true;
    }

    /** A stored day that is not today (earlier OR later: a clock change) drops its completion and skip (AL-S2). */
    private void roll(String today) {
        String day = kv.get("day");
        if (day == null || day.equals(today)) return;
        Routine r = load();
        Map<String, String> m = new HashMap<>();
        m.put("day", today);
        m.put("skip", "");
        if (r != null) for (int i = 0; i < r.steps.size(); i++) m.put("d" + i, "");
        kv.putAll(m);
    }
}

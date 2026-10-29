package net.focusbro.app.focuslock;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * APP-LOCK1 S0 (mechanism A, spec r4): a morning routine. Nothing on the phone is ever blocked; the routine is a nudge with a
 * native screen and an always-available skip and off. This class is the bounded, validated shape (Arch PF-G1 condition: bound
 * the setRoutine input). It holds no time-of-day state and no completion: those live in RoutineStore, today only.
 */
public final class Routine {

    /** A step is a real signal from the today list, or the person's own "I did it". Nothing else exists in S0. */
    public enum Kind { TODAY_LIST, MANUAL }

    public static final class Step {
        public final Kind kind;
        /** The person's own words for a manual step (shown only on the native screen); empty for TODAY_LIST. */
        public final String label;

        Step(Kind kind, String label) {
            this.kind = kind;
            this.label = label;
        }
    }

    public static final int MAX_STEPS = 3;
    public static final int MAX_LABEL = 60;

    public final int hour;
    public final int minute;
    public final List<Step> steps;

    private Routine(int hour, int minute, List<Step> steps) {
        this.hour = hour;
        this.minute = minute;
        this.steps = Collections.unmodifiableList(steps);
    }

    /**
     * Validate a routine from untrusted input (the web page). Throws IllegalArgumentException with a short reason on anything
     * outside the bounds: hour 0-23, minute 0-59, 1-3 steps, at most one TODAY_LIST step, manual labels 1-60 printable chars.
     */
    public static Routine of(int hour, int minute, List<String[]> rawSteps) {
        if (hour < 0 || hour > 23) throw new IllegalArgumentException("hour");
        if (minute < 0 || minute > 59) throw new IllegalArgumentException("minute");
        if (rawSteps == null || rawSteps.isEmpty() || rawSteps.size() > MAX_STEPS) throw new IllegalArgumentException("steps");
        List<Step> steps = new ArrayList<>();
        boolean todayList = false;
        for (String[] raw : rawSteps) {
            if (raw == null || raw.length != 2 || raw[0] == null) throw new IllegalArgumentException("step");
            if ("today-list".equals(raw[0])) {
                if (todayList) throw new IllegalArgumentException("today-list twice");
                todayList = true;
                steps.add(new Step(Kind.TODAY_LIST, ""));
            } else if ("manual".equals(raw[0])) {
                steps.add(new Step(Kind.MANUAL, label(raw[1])));
            } else {
                throw new IllegalArgumentException("kind");
            }
        }
        return new Routine(hour, minute, steps);
    }

    private static String label(String s) {
        if (s == null) throw new IllegalArgumentException("label");
        String t = s.trim();
        if (t.isEmpty() || t.length() > MAX_LABEL) throw new IllegalArgumentException("label length");
        for (int i = 0; i < t.length(); i++) {
            if (Character.isISOControl(t.charAt(i))) throw new IllegalArgumentException("label control char");
        }
        return t;
    }
}

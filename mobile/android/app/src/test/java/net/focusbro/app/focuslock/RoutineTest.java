package net.focusbro.app.focuslock;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.Test;

/** Bounds on the routine the page may set (Arch PF-G1: bound setRoutine input). Each rejection is a case. */
public class RoutineTest {

    private static List<String[]> steps(String[]... s) {
        return Arrays.asList(s);
    }

    @Test
    public void validRoutine() {
        Routine r = Routine.of(7, 30, steps(new String[] {"today-list", ""}, new String[] {"manual", " 10 minutes outside "}));
        assertEquals(2, r.steps.size());
        assertEquals("10 minutes outside", r.steps.get(1).label);
    }

    @Test
    public void rejectsOutOfBounds() {
        String[] ok = {"manual", "walk"};
        assertThrows(IllegalArgumentException.class, () -> Routine.of(24, 0, steps(ok)));
        assertThrows(IllegalArgumentException.class, () -> Routine.of(-1, 0, steps(ok)));
        assertThrows(IllegalArgumentException.class, () -> Routine.of(7, 60, steps(ok)));
        assertThrows(IllegalArgumentException.class, () -> Routine.of(7, 0, Collections.emptyList()));
        assertThrows(IllegalArgumentException.class, () -> Routine.of(7, 0, steps(ok, ok, ok, ok)));
        assertThrows(IllegalArgumentException.class, () -> Routine.of(7, 0, steps(new String[] {"health", "x"})));
        assertThrows(IllegalArgumentException.class, () -> Routine.of(7, 0, steps(new String[] {"today-list", ""}, new String[] {"today-list", ""})));
        assertThrows(IllegalArgumentException.class, () -> Routine.of(7, 0, steps(new String[] {"manual", "   "})));
        assertThrows(IllegalArgumentException.class, () -> Routine.of(7, 0, steps(new String[] {"manual", new String(new char[61]).replace('\0', 'a')})));
        assertThrows(IllegalArgumentException.class, () -> Routine.of(7, 0, steps(new String[] {"manual", "line\nbreak"})));
    }
}

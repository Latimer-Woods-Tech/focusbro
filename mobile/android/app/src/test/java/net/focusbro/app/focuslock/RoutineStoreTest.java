package net.focusbro.app.focuslock;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import org.junit.Test;

/** The one store's lifecycle (spec r4 §4, §5.4, §5.7, §5.9, §5.11; AL-P2/P4, AL-S2). */
public class RoutineStoreTest {

    private static Routine routine() {
        return Routine.of(7, 0, Arrays.asList(new String[] {"today-list", ""}, new String[] {"manual", "stretch"}));
    }

    @Test
    public void saveLoadAndTodayOnlyCompletion() {
        MemKv kv = new MemKv();
        RoutineStore s = new RoutineStore(kv);
        s.save(routine());
        assertEquals(7, s.load().hour);
        assertTrue(s.ticked("2026-10-29"));
        assertArrayEquals(new boolean[] {true, false}, s.doneToday("2026-10-29"));
        // Same-day replay changes nothing (§5.11).
        assertTrue(s.ticked("2026-10-29"));
        assertArrayEquals(new boolean[] {true, false}, s.doneToday("2026-10-29"));
        // The next local day starts empty (§5.11 expiry).
        assertArrayEquals(new boolean[] {false, false}, s.doneToday("2026-10-30"));
    }

    @Test
    public void clockChangeNeverCompletes() {
        RoutineStore s = new RoutineStore(new MemKv());
        s.save(routine());
        s.ticked("2026-10-29");
        // Clock moved BACK a day: the stored day is not today, so nothing counts (AL-S2, §5.7).
        assertArrayEquals(new boolean[] {false, false}, s.doneToday("2026-10-28"));
        // ...and moving forward again does not resurrect it.
        assertArrayEquals(new boolean[] {false, false}, s.doneToday("2026-10-29"));
    }

    @Test
    public void offDropsTicksAndDeletesEverything() {
        MemKv kv = new MemKv();
        RoutineStore s = new RoutineStore(kv);
        assertFalse("a tick while off is dropped, not queued", s.ticked("2026-10-29"));
        assertTrue(kv.map.isEmpty());
        s.save(routine());
        s.ticked("2026-10-29");
        s.disable();
        assertTrue("off deletes the routine AND today's completion (AL-P4)", kv.map.isEmpty());
        s.save(routine());
        assertArrayEquals("re-enabling starts empty; earlier ticks never count (§5.9)", new boolean[] {false, false}, s.doneToday("2026-10-29"));
    }

    @Test
    public void manualOnlyThroughCompleteManual() {
        RoutineStore s = new RoutineStore(new MemKv());
        s.save(routine());
        assertFalse("index 0 is the today-list step, not manual", s.completeManual("2026-10-29", 0));
        assertFalse(s.completeManual("2026-10-29", 5));
        assertTrue(s.completeManual("2026-10-29", 1));
        assertArrayEquals(new boolean[] {false, true}, s.doneToday("2026-10-29"));
    }

    @Test
    public void skipIsTodayOnly() {
        RoutineStore s = new RoutineStore(new MemKv());
        s.save(routine());
        s.skipToday("2026-10-29");
        assertTrue(s.skippedToday("2026-10-29"));
        assertFalse(s.skippedToday("2026-10-30"));
    }

    @Test
    public void corruptOrFutureStoreReadsOffNeverThrows() {
        MemKv kv = new MemKv();
        kv.map.put("v", "2");
        assertNull("an unknown version is OFF and is cleared (§5.4)", new RoutineStore(kv).load());
        assertTrue(kv.map.isEmpty());
        kv.map.put("v", "1");
        kv.map.put("n", "two");
        assertNull(new RoutineStore(kv).load());
        kv.map.put("v", "1");
        kv.map.put("n", "1");
        kv.map.put("hh", "99");
        kv.map.put("mm", "0");
        kv.map.put("k0", "manual");
        kv.map.put("l0", "x");
        assertNull("an out-of-bounds stored routine is OFF too", new RoutineStore(kv).load());
    }
}

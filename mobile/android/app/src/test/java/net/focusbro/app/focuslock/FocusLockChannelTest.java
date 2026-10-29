package net.focusbro.app.focuslock;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

/**
 * The web channel's caller contract and its narrow op list (spec r4 §3.1, jc-security #34903/#35090). The emulator negatives
 * in §5.12 (foreign iframe, forced fallback, listener registration throwing, generic legacy-bridge call) need a WebView and
 * are NOT in this JVM suite; they are named as unrun in the PR body.
 */
public class FocusLockChannelTest {

    private final FocusLockChannel.Clock day = () -> "2026-10-29";

    @Test
    public void acceptsOnlyTheExactOriginInTheMainFrame() {
        assertTrue(FocusLockChannel.accept(true, "https://focusbro.net"));
        assertFalse("a subframe, even same-origin (§5.12c)", FocusLockChannel.accept(false, "https://focusbro.net"));
        assertFalse("Capacitor's local origin (jc-security #35090)", FocusLockChannel.accept(true, "https://localhost"));
        assertFalse(FocusLockChannel.accept(true, "http://focusbro.net"));
        assertFalse(FocusLockChannel.accept(true, "https://www.focusbro.net"));
        assertFalse(FocusLockChannel.accept(true, "https://focusbro.net:8443"));
        assertFalse(FocusLockChannel.accept(true, "https://focusbro.net.evil.example"));
        assertFalse(FocusLockChannel.accept(true, null));
    }

    @Test
    public void webCanSetReadAndTickOnly() throws Exception {
        RoutineStore s = new RoutineStore(new MemKv());
        assertFalse(new JSONObject(FocusLockChannel.handle("{\"op\":\"status\"}", s, day, null)).getBoolean("on"));
        String set = "{\"op\":\"setRoutine\",\"hour\":7,\"minute\":15,\"steps\":[{\"kind\":\"today-list\"},{\"kind\":\"manual\",\"label\":\"stretch\"}]}";
        int[] changed = {0};
        JSONObject on = new JSONObject(FocusLockChannel.handle(set, s, day, () -> changed[0]++));
        assertTrue(on.getBoolean("on"));
        assertEquals(1, changed[0]);
        assertFalse("labels never go back to the page", on.toString().contains("stretch"));
        JSONObject t = new JSONObject(FocusLockChannel.handle("{\"op\":\"ticked\"}", s, day, null));
        assertTrue(t.getJSONArray("steps").getJSONObject(0).getBoolean("done"));
    }

    @Test
    public void webCannotDoNativeOnlyActions() throws Exception {
        RoutineStore s = new RoutineStore(new MemKv());
        s.save(Routine.of(7, 0, java.util.Arrays.asList(new String[] {"manual", "stretch"})));
        for (String op : new String[] {"completeManual", "skipToday", "disable", "", "STATUS"}) {
            JSONObject r = new JSONObject(FocusLockChannel.handle("{\"op\":\"" + op + "\",\"index\":0}", s, day, null));
            assertEquals(op, "unknown-op", r.getString("error"));
        }
        assertFalse("the manual step is still not done", s.doneToday("2026-10-29")[0]);
        assertFalse(s.skippedToday("2026-10-29"));
        assertTrue("the routine is still on", s.load() != null);
    }

    @Test
    public void malformedOversizedOrOutOfBoundsInputIsRefused() throws Exception {
        RoutineStore s = new RoutineStore(new MemKv());
        assertEquals("invalid", new JSONObject(FocusLockChannel.handle("not json", s, day, null)).getString("error"));
        assertEquals("invalid", new JSONObject(FocusLockChannel.handle("{\"op\":\"setRoutine\",\"hour\":25,\"minute\":0,\"steps\":[{\"kind\":\"today-list\"}]}", s, day, null)).getString("error"));
        String five = "{\"op\":\"setRoutine\",\"hour\":7,\"minute\":0,\"steps\":[{\"kind\":\"manual\",\"label\":\"a\"},{\"kind\":\"manual\",\"label\":\"b\"},{\"kind\":\"manual\",\"label\":\"c\"},{\"kind\":\"manual\",\"label\":\"d\"},{\"kind\":\"manual\",\"label\":\"e\"}]}";
        assertEquals("invalid", new JSONObject(FocusLockChannel.handle(five, s, day, null)).getString("error"));
        StringBuilder big = new StringBuilder("{\"op\":\"status\",\"pad\":\"");
        while (big.length() < FocusLockChannel.MAX_MESSAGE + 1) big.append('x');
        big.append("\"}");
        assertEquals("too-large", new JSONObject(FocusLockChannel.handle(big.toString(), s, day, null)).getString("error"));
        assertTrue("nothing was saved by any refused request", s.load() == null);
    }
}

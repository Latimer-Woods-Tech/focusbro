package net.focusbro.app.focuslock;

import android.net.Uri;
import android.webkit.WebView;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The ONLY web path into APP-LOCK1 (spec r4 §3.1, jc-security #34903/#35090, Arch PF-G1). Nothing is reachable through
 * Capacitor's generic bridge (FocusLockInstaller declares no plugin methods): that bridge allows https://localhost as well as
 * focusbro.net (Capacitor 8.5.2 Bridge.java:236-255) and silently falls back to the legacy JavaScript-interface bridge when its
 * own listener fails (MessageHandler.java:35-39). This channel is its own WebMessageListener, registered for exactly https://focusbro.net, and it answers
 * main-frame messages only. If the feature is missing or registration throws, there is NO web path at all (fail closed); the
 * native routine screen, skip and off keep working.
 *
 * The page may only: read status, set the routine, and report a today-list tick. It can never mark a manual step done, skip
 * or turn the routine off (those are native-screen actions).
 */
public final class FocusLockChannel {

    public static final String OBJECT_NAME = "focusLockNative";
    public static final String ORIGIN = "https://focusbro.net";
    /** Largest message the page may send; anything bigger is refused before parsing. */
    public static final int MAX_MESSAGE = 4096;

    /** Today's local date as YYYY-MM-DD, injected so tests control the clock. */
    public interface Clock {
        String today();
    }

    private FocusLockChannel() {}

    /** True only for a main-frame message from exactly https://focusbro.net (no http, no subdomain, no localhost, no port). */
    public static boolean accept(boolean isMainFrame, String sourceOrigin) {
        return isMainFrame && ORIGIN.equals(sourceOrigin);
    }

    /**
     * Install the channel on the app's WebView. Returns false (and installs nothing) when the WebView cannot authenticate the
     * calling frame: the page then sees no `focusLockNative` object and the routine is native-only.
     */
    public static boolean install(WebView webView, RoutineStore store, Clock clock, Runnable onChange) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false;
        try {
            WebViewCompat.addWebMessageListener(webView, OBJECT_NAME, Collections.singleton(ORIGIN),
                (WebView view, WebMessageCompat message, Uri sourceOrigin, boolean isMainFrame, JavaScriptReplyProxy reply) -> {
                    if (!accept(isMainFrame, sourceOrigin == null ? null : sourceOrigin.toString())) return;
                    reply.postMessage(handle(message.getData(), store, clock, onChange));
                });
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    /** One request from the page, already origin- and frame-checked. Always answers with a small JSON object. */
    public static String handle(String data, RoutineStore store, Clock clock, Runnable onChange) {
        if (data == null || data.length() > MAX_MESSAGE) return error("too-large");
        try {
            JSONObject req = new JSONObject(data);
            String op = req.optString("op", "");
            switch (op) {
                case "status":
                    return status(store, clock);
                case "setRoutine": {
                    JSONArray raw = req.getJSONArray("steps");
                    List<String[]> steps = new ArrayList<>();
                    for (int i = 0; i < raw.length() && i <= Routine.MAX_STEPS; i++) {
                        JSONObject s = raw.getJSONObject(i);
                        steps.add(new String[] {s.optString("kind", ""), s.optString("label", "")});
                    }
                    store.save(Routine.of(req.getInt("hour"), req.getInt("minute"), steps));
                    if (onChange != null) onChange.run();
                    return status(store, clock);
                }
                case "ticked":
                    // A dateless event: the date is stamped natively (spec r4 §2.7, jc-privacy #34901).
                    store.ticked(clock.today());
                    return status(store, clock);
                default:
                    // completeManual, skipToday, disable and anything else are NOT web operations.
                    return error("unknown-op");
            }
        } catch (JSONException | IllegalArgumentException e) {
            return error("invalid");
        }
    }

    private static String status(RoutineStore store, Clock clock) throws JSONException {
        Routine r = store.load();
        JSONObject out = new JSONObject();
        out.put("available", true);
        out.put("on", r != null);
        if (r != null) {
            boolean[] done = store.doneToday(clock.today());
            JSONArray steps = new JSONArray();
            for (int i = 0; i < r.steps.size(); i++) {
                JSONObject s = new JSONObject();
                s.put("kind", r.steps.get(i).kind == Routine.Kind.TODAY_LIST ? "today-list" : "manual");
                s.put("done", done[i]);
                steps.put(s);
            }
            out.put("hour", r.hour);
            out.put("minute", r.minute);
            out.put("steps", steps);
            out.put("skipped", store.skippedToday(clock.today()));
        }
        return out.toString();
    }

    private static String error(String reason) {
        return "{\"available\":true,\"error\":\"" + reason + "\"}";
    }
}

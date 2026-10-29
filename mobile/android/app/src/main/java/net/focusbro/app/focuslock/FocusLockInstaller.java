package net.focusbro.app.focuslock;

import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Installs FocusLockChannel at the right moment and does nothing else. It declares NO plugin method, so Capacitor's generic
 * bridge has no FocusLock route at all (jc-security #35090). It exists only because Capacitor runs plugin load() hooks before
 * it loads the page (Bridge.java: registerAllPlugins, then loadWebView); a WebMessageListener added after the page started
 * loading would not reach that document.
 */
@CapacitorPlugin(name = "FocusLockInstaller")
public final class FocusLockInstaller extends Plugin {
    @Override
    public void load() {
        RoutineStore store = Prefs.store(getContext());
        FocusLockChannel.install(getBridge().getWebView(), store, Prefs::today, () -> {
            Routine routine = store.load();
            if (routine != null) RoutineAlarm.schedule(getContext(), routine);
        });
    }
}

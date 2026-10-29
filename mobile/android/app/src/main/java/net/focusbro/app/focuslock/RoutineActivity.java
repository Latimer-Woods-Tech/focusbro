package net.focusbro.app.focuslock;

import android.app.Activity;
import android.graphics.Typeface;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * The native routine screen (spec r4 §2). No network, no WebView: it works offline, after a reboot and with every optional
 * permission denied, and it is the only place a manual step is marked done or the routine is skipped or turned off. Opened by
 * the routine notification or the launcher shortcut (res/xml/shortcuts.xml). Nothing on the phone is blocked, ever.
 */
public final class RoutineActivity extends Activity {

    private RoutineStore store;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        store = Prefs.store(this);
        render();
    }

    private void render() {
        String today = Prefs.today();
        Routine r = store.load();
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        col.setPadding(pad, pad, pad, pad);
        col.addView(text(r == null ? "Morning routine is off." : "Your morning routine", 22, true));
        if (r == null) {
            col.addView(text("Turn it on from FocusBro's settings when you want it. Nothing is blocked either way.", 16, false));
        } else {
            boolean[] done = store.doneToday(today);
            if (store.skippedToday(today)) col.addView(text("Skipped for today. See you tomorrow.", 16, false));
            for (int i = 0; i < r.steps.size(); i++) {
                Routine.Step s = r.steps.get(i);
                String name = s.kind == Routine.Kind.TODAY_LIST ? "Tick one task on your today list" : s.label;
                col.addView(text((done[i] ? "✓ " : "○ ") + name, 18, false));
                if (s.kind == Routine.Kind.MANUAL && !done[i]) {
                    final int index = i;
                    col.addView(button("I did it", () -> store.completeManual(Prefs.today(), index)));
                }
            }
            col.addView(button("Skip today", () -> store.skipToday(Prefs.today())));
            col.addView(button("Turn routine off", () -> {
                store.disable();
                RoutineAlarm.cancel(this);
            }));
        }
        ScrollView scroll = new ScrollView(this);
        scroll.addView(col);
        setContentView(scroll);
    }

    private TextView text(String s, int sp, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, 0, 0, (int) (12 * getResources().getDisplayMetrics().density));
        return t;
    }

    private Button button(String label, Runnable action) {
        Button b = new Button(this);
        b.setText(label);
        b.setGravity(Gravity.CENTER);
        b.setMinHeight((int) (48 * getResources().getDisplayMetrics().density));
        b.setOnClickListener(v -> {
            action.run();
            render();
        });
        return b;
    }
}

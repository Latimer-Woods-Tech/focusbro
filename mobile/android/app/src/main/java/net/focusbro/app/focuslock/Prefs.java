package net.focusbro.app.focuslock;

import android.content.Context;
import android.content.SharedPreferences;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.Map;

/** Android glue: the SharedPreferences-backed store and the local date. Kept tiny; the rules live in RoutineStore. */
public final class Prefs {

    private Prefs() {}

    public static RoutineStore store(Context context) {
        SharedPreferences sp = context.getApplicationContext().getSharedPreferences(RoutineStore.PREFS, Context.MODE_PRIVATE);
        return new RoutineStore(new RoutineStore.Kv() {
            @Override
            public String get(String key) {
                return sp.getString(key, null);
            }

            @Override
            public void putAll(Map<String, String> values) {
                SharedPreferences.Editor e = sp.edit();
                for (Map.Entry<String, String> v : values.entrySet()) e.putString(v.getKey(), v.getValue());
                e.commit();
            }

            @Override
            public void clear() {
                sp.edit().clear().commit();
            }
        });
    }

    /** Today's LOCAL date, YYYY-MM-DD. */
    public static String today() {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
    }
}

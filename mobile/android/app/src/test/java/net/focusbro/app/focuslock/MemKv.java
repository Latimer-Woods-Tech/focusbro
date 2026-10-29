package net.focusbro.app.focuslock;

import java.util.HashMap;
import java.util.Map;

/** In-memory RoutineStore.Kv for JVM tests. */
final class MemKv implements RoutineStore.Kv {
    final Map<String, String> map = new HashMap<>();

    @Override
    public String get(String key) {
        return map.get(key);
    }

    @Override
    public void putAll(Map<String, String> values) {
        map.putAll(values);
    }

    @Override
    public void clear() {
        map.clear();
    }
}

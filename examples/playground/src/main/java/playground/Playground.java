package playground;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Small sample program used as an analysis target for the Tai-e bug finders
 * (dropped-exception, clone-idiom, dead-code, null-pointer, division-by-zero).
 *
 * <p>The code intentionally exercises the patterns those detectors look for,
 * but every path is written defensively so that the program is free of the
 * defects the analyzers report.</p>
 */
public final class Playground {

    private Playground() {
    }

    /**
     * Returns the integer average of the positive values in {@code values}.
     * Divides only when at least one value was accumulated, so the divisor can
     * never be zero.
     */
    public static int averageOfPositive(int[] values) {
        if (values == null) {
            return 0;
        }
        long sum = 0L;
        int count = 0;
        for (int value : values) {
            if (value > 0) {
                sum += value;
                count++;
            }
        }
        if (count == 0) {
            return 0;
        }
        return (int) (sum / count);
    }

    /**
     * Returns a lowercase copy of the trimmed {@code text}, or an empty string
     * when the input is {@code null}.
     */
    public static String normalize(String text) {
        if (text == null) {
            return "";
        }
        String trimmed = text.trim();
        return trimmed.toLowerCase();
    }

    /**
     * A null-safe element lookup. Out-of-range or {@code null} inputs yield
     * {@code null} instead of an exception.
     */
    public static String elementAt(List<String> items, int index) {
        if (items == null || index < 0 || index >= items.size()) {
            return null;
        }
        return items.get(index);
    }

    /**
     * Appends {@code items} after filtering out {@code null} entries. The input
     * list is never mutated, so it is safe to pass an immutable list.
     */
    public static List<String> withSuffix(List<String> items, String suffix) {
        if (items == null) {
            return Collections.emptyList();
        }
        String effectiveSuffix = suffix == null ? "" : suffix;
        List<String> result = new ArrayList<>(items.size());
        for (String item : items) {
            if (item != null) {
                result.add(item + effectiveSuffix);
            }
        }
        return result;
    }

    /**
     * Looks up a configuration value by key, falling back to a default instead
     * of dropping the lookup failure silently.
     */
    public static int parseConfigValue(String raw, int fallback) {
        if (raw == null) {
            return fallback;
        }
        try {
            return Integer.parseInt(raw.trim());
        } catch (NumberFormatException ex) {
            // Recover with the caller-supplied default, but never silently drop
            // the failure: it is logged together with its cause.
            System.out.println("parseConfigValue: using fallback for '" + raw + "': " + ex.getMessage());
            return fallback;
        }
    }

    /**
     * Counts the processed entries and reports them through a logger-like
     * sink. Uses {@code ++} rather than {@code x = x + 1} so the clone-idiom
     * check has nothing to report.
     */
    public static int countEntries(List<String> items) {
        int processed = 0;
        if (items == null) {
            return processed;
        }
        for (String item : items) {
            if (item != null && !item.isEmpty()) {
                processed++;
            }
        }
        return processed;
    }

    public static void main(String[] args) {
        int[] samples = {3, -1, 8, 0, 5};
        System.out.println("average=" + averageOfPositive(samples));
        System.out.println("normalize=" + normalize("  Hello World  "));
        System.out.println("normalize(null)='" + normalize(null) + "'");

        List<String> names = new ArrayList<>();
        names.add("alpha");
        names.add(null);
        names.add("beta");
        System.out.println("elementAt(1)=" + elementAt(names, 1));
        System.out.println("elementAt(null,0)=" + elementAt(null, 0));
        System.out.println("withSuffix=" + withSuffix(names, "-x"));
        System.out.println("parseConfigValue=" + parseConfigValue("42", 0));
        System.out.println("parseConfigValue(bad)=" + parseConfigValue("oops", -1));
        System.out.println("countEntries=" + countEntries(names));
    }
}

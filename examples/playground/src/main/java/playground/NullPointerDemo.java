package playground;

import java.util.Objects;

/**
 * Sample program that demonstrates null-safe handling of lookups that may
 * return {@code null}. Every method checks its inputs (and the results of
 * lookups) before dereferencing them, so no path dereferences a null
 * reference.
 */
public final class NullPointerDemo {

    private NullPointerDemo() {
    }

    /** Naive lookup that returns {@code null} for an unknown key. */
    public static String lookup(String[] table, int index) {
        if (table == null || index < 0 || index >= table.length) {
            return null;
        }
        return table[index];
    }

    /**
     * Returns the length of the entry at {@code index}, or {@code -1} when the
     * entry is missing. The lookup result is checked before use.
     */
    public static int lengthOfMissingEntry() {
        String[] table = {"alpha", "beta"};
        String value = lookup(table, 5); // out of range -> null
        if (value == null) {
            return -1;
        }
        return value.length();
    }

    /** Holder whose {@code name} field always has a non-null default value. */
    static final class Holder {
        String name = "";

        Holder() {
        }

        Holder(String name) {
            this.name = name == null ? "" : name;
        }

        int nameLength() {
            return name.length();
        }
    }

    /**
     * Returns the trimmed greeting, or an empty string when no greeting was
     * supplied. A whitespace-only greeting trims to the empty string.
     */
    public static String greeting(boolean present) {
        String greeting = present ? "  Hello  " : null;
        if (greeting == null) {
            return "";
        }
        return greeting.trim();
    }

    /** Keeps the historical entry point: trims a greeting that is now built. */
    public static String brokenGreeting() {
        return greeting(false);
    }

    public static void main(String[] args) {
        System.out.println("lengthOfMissingEntry=" + lengthOfMissingEntry());
        System.out.println("holderNameLength=" + new Holder().nameLength());
        System.out.println("holderNameLength(given)=" + new Holder("abc").nameLength());
        System.out.println("greeting(present)='" + greeting(true) + "'");
        System.out.println("greeting(absent)='" + Objects.requireNonNull(brokenGreeting()) + "'");
    }
}

package example;

/** The same source remains reachable, but only a safe constant reaches the sink. */
public class Main {
    public static void main(String[] args) {
        String input = args.length == 0 ? "demo-input" : args[0];
        String untrusted = source(input);
        String forwarded = relay(untrusted);
        sink("fixed-safe-value");
    }

    public static String source(String input) {
        return input;
    }

    public static String relay(String value) {
        return value;
    }

    public static void sink(String value) {
        System.out.println(value);
    }
}
